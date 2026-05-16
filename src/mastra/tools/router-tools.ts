/**
 * Router tools — Wave 2.
 *
 * Twelve coarse-grained tools that REPLACE the historical 68-tool surface
 * when the env flag MASTRA_ROUTER_TOOLS=on is set. Each router tool fans
 * the call out to one or more existing implementations in
 * `dashboard-tools.ts` (we DO NOT reimplement business logic — that lives
 * in `src/mastra/data/*` and is unchanged).
 *
 * Design contract: /tmp/wfo-phase1/design_hydration_interface.md
 * Wave 1 impl report: /tmp/wfo-phase1/implement_hydration_layer.md
 *
 * Each router tool:
 *   - Accepts the Mastra execution context, pulls a `HydrationLayer` from
 *     `requestContext.get("hydration")` (Mastra v1 calls runtimeContext
 *     `requestContext`). The HydrationLayer module is loaded lazily so
 *     this file stays compilable while Wave 1 hydration is in flight;
 *     when the layer is unavailable we degrade gracefully (no T1/T2/T3
 *     caches, but freshness metadata still flows via the data-layer
 *     envelopes).
 *   - Uses a flat Zod input schema (no nested unions >500 chars).
 *   - Wraps results in the existing `ToolEnvelope<T>` shape via `wrap()`.
 *   - Carries a description that explicitly tells the LLM about the
 *     `include` parameter and that results are cached within the turn.
 *
 * Mutation gating: `READ_ONLY_MODE` plus per-op `HYGGLO_UI_LIVE_*` flags
 * live inside the data-layer implementations we delegate to. We do NOT
 * relax those gates here.
 *
 * Hygglo date math: never touched here — preserved by every underlying
 * data-layer function.
 */
import "server-only";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { wrap, type ToolEnvelope } from "../lib/tool-envelope";
import * as data from "@/mastra/data";

// ── Hydration accessor (duck-typed; resilient to layer absence) ─────────

/**
 * Minimal duck-typed view of the HydrationLayer surface this file needs.
 * Kept structural so we are NOT tightly coupled to the hydration module's
 * shape during Wave 2 — if the layer is unavailable we simply skip the
 * cache-aware path and rely on the data layer's existing envelopes.
 */
interface HydrationDuck {
  items: {
    getAll: () => Promise<{ data: unknown; meta: HydrationMetaDuck }>;
    getByIds?: (ids: string[]) => Promise<{ data: unknown; meta: HydrationMetaDuck }>;
  };
  pricing_catalog: { getAll: () => Promise<{ data: unknown; meta: HydrationMetaDuck }> };
  bundles: { getAll: () => Promise<{ data: unknown; meta: HydrationMetaDuck }> };
  bundle_items: { getAll: () => Promise<{ data: unknown; meta: HydrationMetaDuck }> };
  renters?: {
    getByIds?: (ids: string[]) => Promise<{ data: unknown; meta: HydrationMetaDuck }>;
  };
  loadSnapshot: (
    name:
      | "by_item"
      | "by_renter"
      | "by_month"
      | "totals"
      | "intel_rankings"
      | "daily_briefing"
      | "top_renters"
      | "inventory_overview",
  ) => Promise<{ data: unknown; meta: HydrationMetaDuck }>;
  invalidate?: (
    key:
      | "items"
      | "pricing_catalog"
      | "bundles"
      | "bundle_items"
      | "all",
  ) => void;
  invalidateSnapshot?: (key: string) => void;
  /**
   * Phase W3b — generic per-turn memoizer. Mirrors the
   * `HydrationLayer.memoQuery` signature so router tools can dedup
   * arbitrary Convex queries (e.g. reservation_vision side-table reads)
   * without minting new entity-fetcher entries on the layer.
   */
  memoQuery?: <T>(
    fnRef: unknown,
    args: Record<string, unknown> | undefined,
    runner: () => Promise<T>,
    opts?: { table?: string },
  ) => Promise<{ data: T; meta: HydrationMetaDuck }>;
}

interface HydrationMetaDuck {
  source?: {
    tier?: number;
    table?: string;
    fetchedAt?: number;
    cached?: boolean;
  };
  lastSyncedAt?: number | null;
  staleMinutes?: number | null;
  coverageRatio?: number;
  caveats?: string[];
}

/**
 * Pull the per-turn HydrationLayer from Mastra's request context.
 * Returns null when the route has not been wired through the
 * `makeHydrationRuntimeContext()` factory — every tool below treats that
 * as a degraded path and falls back to direct data-layer calls.
 */
function hydrationFromCtx(ctxArg: unknown): HydrationDuck | null {
  const ctx = ctxArg as
    | {
        requestContext?: { get?: (k: string) => unknown };
        runtimeContext?: { get?: (k: string) => unknown };
      }
    | undefined;
  const bag = ctx?.requestContext ?? ctx?.runtimeContext;
  if (!bag || typeof bag.get !== "function") return null;
  const layer = bag.get("hydration");
  if (!layer || typeof layer !== "object") return null;
  return layer as HydrationDuck;
}

/**
 * Build a sync_state-shaped object from a HydrationMetaDuck so we can
 * reuse the existing `wrap()` contract (which keys off `syncState`).
 */
function syncFromMeta(meta: HydrationMetaDuck | undefined) {
  if (!meta || typeof meta.lastSyncedAt !== "number") return null;
  return {
    _id: "synthetic",
    _creationTime: 0,
    source: meta.source?.table ?? "hydration",
    lastRunAt: meta.lastSyncedAt,
    lastRunSucceeded: true,
  };
}

/** Pull primitive fields out of any envelope-like value (defensive). */
function envFields(v: unknown): {
  data: unknown;
  lastSyncedAt: number | null;
  caveats: string[];
  coverageRatio?: number;
} {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: {
      data: unknown;
      lastSyncedAt: number | null;
      caveats: string[];
      coverageRatio?: number;
    } = {
      data: "data" in o ? o.data : v,
      lastSyncedAt:
        typeof o.lastSyncedAt === "number" || o.lastSyncedAt === null
          ? (o.lastSyncedAt as number | null)
          : null,
      caveats: Array.isArray(o.caveats) ? (o.caveats as string[]) : [],
    };
    if (typeof o.coverageRatio === "number") out.coverageRatio = o.coverageRatio;
    return out;
  }
  return { data: v, lastSyncedAt: null, caveats: [] };
}

// ── Common cache-discipline notice (appended to every tool description) ─

const CACHE_NOTE =
  " Results are cached within the turn — do NOT re-call this tool with the same arguments in the same turn; reuse the previous response.";

// ── 1. query_inventory ──────────────────────────────────────────────────

const includeInventory = z
  .array(z.enum(["pricing", "bundles", "stats"]))
  .optional()
  .describe(
    "Optional related graphs to co-fetch: 'pricing' adds pricing_catalog, 'bundles' adds bundles + bundle_items, 'stats' adds utilization snapshot.",
  );

export const queryInventory = createTool({
  id: "query_inventory",
  description:
    "Unified inventory read. Returns the full items catalogue plus optional related graphs. " +
    "`filter` is a case-insensitive substring on item.name; `include` controls co-fetched graphs: 'pricing' = pricing_catalog rows, 'bundles' = bundles + bundle_items, 'stats' = utilization snapshot." +
    CACHE_NOTE,
  inputSchema: z.object({
    filter: z
      .string()
      .optional()
      .describe("Case-insensitive substring on item.name. Omit for full catalogue."),
    include: includeInventory,
  }),
  execute: async (input, ctx) => {
    const { filter, include } = input as {
      filter?: string;
      include?: Array<"pricing" | "bundles" | "stats">;
    };
    const hydrate = hydrationFromCtx(ctx);
    const include_ = include ?? [];
    let items: unknown[] = [];
    let meta: HydrationMetaDuck | undefined;
    if (hydrate) {
      const r = await hydrate.items.getAll();
      items = Array.isArray(r.data) ? (r.data as unknown[]) : [];
      meta = r.meta;
    }
    const filtered = filter
      ? items.filter((r) => {
          const o = r as Record<string, unknown>;
          const name = typeof o.name === "string" ? o.name.toLowerCase() : "";
          return name.includes(filter.toLowerCase());
        })
      : items;
    const co: Record<string, unknown> = {};
    if (hydrate && include_.includes("pricing")) {
      const p = await hydrate.pricing_catalog.getAll();
      co.pricing = p.data;
    }
    if (hydrate && include_.includes("bundles")) {
      const [b, bi] = await Promise.all([
        hydrate.bundles.getAll(),
        hydrate.bundle_items.getAll(),
      ]);
      co.bundles = b.data;
      co.bundle_items = bi.data;
    }
    if (include_.includes("stats")) {
      try {
        // Phase 1c: prefer inventory_overview snapshot; fall through to live
        // utilization snapshot when unavailable.
        let statsFromSnapshot = false;
        if (hydrate) {
          try {
            const snap = await hydrate.loadSnapshot("inventory_overview");
            const unavailable = (snap.meta?.caveats ?? []).some((c) =>
              c.includes("snapshot_unavailable_inventory_overview"),
            );
            if (snap.data && !unavailable) {
              co.stats = snap.data;
              co.stats_source = "r2.inventory_overview";
              statsFromSnapshot = true;
            }
          } catch {
            /* fall through */
          }
        }
        if (!statsFromSnapshot) {
          co.stats = await data.intelligence.getUtilizationSnapshot({});
        }
      } catch (err) {
        co.stats_error = err instanceof Error ? err.message : String(err);
      }
    }
    return wrap({
      data: { items: filtered, ...co },
      source: hydrate ? "convex.items.static" : "convex.items",
      syncState: syncFromMeta(meta),
      extraCaveats: meta?.caveats ?? (hydrate ? [] : ["hydration layer unavailable"]),
    });
  },
});

// ── 2. query_orders ─────────────────────────────────────────────────────

const orderInclude = z
  .array(z.enum(["renter", "items", "denials", "vision", "booking_times"]))
  .optional()
  .describe(
    "Optional co-fetched graphs: 'renter' joins renter row, 'items' joins inventory, 'denials' joins recent denial events, 'vision' joins vision AI inspections, 'booking_times' adds pickup/return timestamps.",
  );

export const queryOrders = createTool({
  id: "query_orders",
  description:
    "Unified orders read. Filter by `status` ('pending'|'confirmed'|'overdue'|'obsolete'|'all') and `window` ('today'|'week'|'month'|'upcoming'). `include` controls fan-out: renter, items, denials, vision, booking_times." +
    CACHE_NOTE,
  inputSchema: z.object({
    status: z.enum(["pending", "confirmed", "overdue", "obsolete", "all"]).optional(),
    window: z.enum(["today", "week", "month", "upcoming"]).optional(),
    account: z.enum(["dbcinema", "leo"]).optional(),
    include: orderInclude,
  }),
  execute: async (input, _ctx) => {
    const { status, window, account, include } = input as {
      status?: "pending" | "confirmed" | "overdue" | "obsolete" | "all";
      window?: "today" | "week" | "month" | "upcoming";
      account?: "leo" | "dbcinema";
      include?: Array<"renter" | "items" | "denials" | "vision" | "booking_times">;
    };
    const want = status ?? "pending";
    let primary: unknown;
    if (want === "pending") {
      primary = await data.rentals.getPendingRentals({ account });
    } else if (want === "overdue") {
      primary = await data.intel.getOverdueReturns({});
    } else if (want === "obsolete") {
      primary = await data.rentals.getObsoleteOrders({ account });
    } else {
      primary = await data.rentals.getOrderPipeline({ account });
    }
    const pf = envFields(primary);
    const include_ = include ?? [];
    const co: Record<string, unknown> = {};
    // H2: Gate every co-fetch on a non-empty primary result set. Empty
    // → skip fan-out entirely (no point loading renters for zero orders).
    const primaryRows: Array<Record<string, unknown>> = Array.isArray(pf.data)
      ? (pf.data as Array<Record<string, unknown>>)
      : pf.data && typeof pf.data === "object"
        ? ([pf.data] as Array<Record<string, unknown>>)
        : [];
    const hasRows = primaryRows.length > 0;

    if (include_.includes("denials") && hasRows) {
      try {
        co.denials = await data.demand.getTop({});
      } catch (err) {
        co.denials_error = err instanceof Error ? err.message : String(err);
      }
    }
    // H3: renter fan-out — batch-load distinct renter ids via hydration.
    if (include_.includes("renter") && hasRows) {
      try {
        const hydrate = hydrationFromCtx(_ctx);
        const renterIds = [
          ...new Set(
            primaryRows
              .map((r) => (r.renter_id ?? r.renterId) as string | undefined)
              .filter((x): x is string => typeof x === "string" && x.length > 0),
          ),
        ];
        if (renterIds.length > 0 && hydrate?.renters?.getByIds) {
          const env = await hydrate.renters.getByIds(renterIds);
          co.renter = env.data;
        } else if (renterIds.length > 0) {
          // Fallback: degrade gracefully when hydration is unavailable.
          co.renter_ids = renterIds;
        }
      } catch (err) {
        co.renter_error = err instanceof Error ? err.message : String(err);
      }
    }
    // H3: items fan-out — collect distinct item_ids from resolved_items[]
    // (set by Trigger item-resolver), batch-load via hydration.items.
    if (include_.includes("items") && hasRows) {
      try {
        const hydrate = hydrationFromCtx(_ctx);
        const itemIds = [
          ...new Set(
            primaryRows.flatMap((r) => {
              const ri = r.resolved_items;
              if (!Array.isArray(ri)) return [] as string[];
              return ri
                .map((it: unknown) => {
                  if (it && typeof it === "object") {
                    const o = it as Record<string, unknown>;
                    return (o.item_id ?? o.itemId) as string | undefined;
                  }
                  return undefined;
                })
                .filter((x): x is string => typeof x === "string" && x.length > 0);
            }),
          ),
        ];
        if (itemIds.length > 0 && hydrate?.items?.getByIds) {
          const env = await hydrate.items.getByIds(itemIds);
          co.items = env.data;
        } else if (itemIds.length > 0) {
          co.item_ids = itemIds;
        }
      } catch (err) {
        co.items_error = err instanceof Error ? err.message : String(err);
      }
    }
    // H3: vision — Trigger vision-resolver already wrote per-line image_url
    // into resolved_items[]. Phase W3b: prefer the reservation_vision side
    // table; fall back to reservation.resolved_items when the side-table
    // row is missing (dual-write rollout — not every row mirrored yet).
    // Side-table fetch is shared with booking_times branch below.
    let sideMap: Map<string, unknown[]> | null = null;
    if ((include_.includes("vision") || include_.includes("booking_times")) && hasRows) {
      try {
        const hydrate = hydrationFromCtx(_ctx);
        const reservationIds = primaryRows
          .map((r) => (r._id ?? r.id ?? r.order_id) as string | undefined)
          .filter((x): x is string => typeof x === "string" && x.length > 0);
        if (reservationIds.length > 0) {
          const { getConvex } = await import("@/mastra/data/client");
          const { anyApi } = await import("convex/server");
          const convex = getConvex();
          const runner = async () => {
            return (await convex.query(
              anyApi.reservation_vision.publicGetReservationVisionBatch,
              { reservation_ids: reservationIds },
            )) as Array<{
              reservation_id: string;
              resolved_items?: unknown[];
            } | null>;
          };
          const rows = hydrate?.memoQuery
            ? ((
                await hydrate.memoQuery(
                  "reservation_vision.publicGetReservationVisionBatch",
                  { reservation_ids: reservationIds },
                  runner,
                  { table: "reservations" },
                )
              ).data as Array<{
                reservation_id: string;
                resolved_items?: unknown[];
              } | null>)
            : await runner();
          sideMap = new Map<string, unknown[]>();
          for (const row of rows ?? []) {
            if (row && Array.isArray(row.resolved_items)) {
              sideMap.set(String(row.reservation_id), row.resolved_items);
            }
          }
        }
      } catch (err) {
        // Side-table read failure → fall through to legacy column path.
        co.vision_side_table_error =
          err instanceof Error ? err.message : String(err);
      }
    }
    if (include_.includes("vision") && hasRows) {
      try {
        co.vision = primaryRows.map((r) => {
          const id = (r._id ?? r.id ?? r.order_id) as string | undefined;
          const sideHit = id && sideMap ? sideMap.get(id) : undefined;
          const source: unknown[] = Array.isArray(sideHit)
            ? sideHit
            : Array.isArray(r.resolved_items)
              ? (r.resolved_items as unknown[])
              : [];
          return {
            order_id: id as unknown,
            resolved_items: source.map((it) => {
              if (it && typeof it === "object") {
                const o = it as Record<string, unknown>;
                return {
                  item_id: o.item_id ?? o.itemId,
                  image_url: o.image_url ?? o.imageUrl,
                  vision_source: o.vision_source ?? o.visionSource,
                };
              }
              return null;
            }),
            vision_source_table: sideHit ? "reservation_vision" : "reservations",
          };
        });
      } catch (err) {
        co.vision_error = err instanceof Error ? err.message : String(err);
      }
    }
    // H3: booking_times — Trigger booking-time extractor populates
    // extracted_pickup_time / extracted_return_time on the row. Pluck.
    // Phase W3b: pickup/return timestamps still live on the reservations row;
    // resolved_items is the only column moving. We still expose
    // `vision_source_table` here so consumers know which path was used in
    // case they want to cross-reference.
    if (include_.includes("booking_times") && hasRows) {
      try {
        co.booking_times = primaryRows.map((r) => {
          const id = (r._id ?? r.id ?? r.order_id) as string | undefined;
          const sideHit = id && sideMap ? sideMap.get(id) : undefined;
          return {
            order_id: id as unknown,
            pickup_time: r.extracted_pickup_time ?? r.extractedPickupTime ?? null,
            return_time: r.extracted_return_time ?? r.extractedReturnTime ?? null,
            vision_source_table: sideHit ? "reservation_vision" : "reservations",
          };
        });
      } catch (err) {
        co.booking_times_error = err instanceof Error ? err.message : String(err);
      }
    }
    return wrap({
      data: { window: window ?? "week", status: want, primary: pf.data, ...co },
      source: "convex.orders",
      extraCaveats: pf.caveats,
      syncState:
        pf.lastSyncedAt !== null
          ? {
              _id: "synthetic",
              _creationTime: 0,
              source: "convex.orders",
              lastRunAt: pf.lastSyncedAt,
              lastRunSucceeded: true,
            }
          : null,
    });
  },
});

// ── 3. query_renter ─────────────────────────────────────────────────────

export const queryRenter = createTool({
  id: "query_renter",
  description:
    "Unified renter profile read. `idOrName` accepts the Hygglo renter id or display name. `include` controls graphs: 'history' = past rentals, 'denials' = denial events, 'facts' = blacklist + flags, 'reviews' = renter reviews, 'ltv' = lifetime spend." +
    CACHE_NOTE,
  inputSchema: z.object({
    idOrName: z.string().describe("Hygglo renter id or display name (case-insensitive)."),
    include: z
      .array(z.enum(["history", "denials", "facts", "reviews", "ltv"]))
      .optional(),
  }),
  execute: async (input, _ctx) => {
    const { idOrName, include } = input as {
      idOrName: string;
      include?: Array<"history" | "denials" | "facts" | "reviews" | "ltv">;
    };
    const include_ = include ?? [];
    const profile = await data.renters.getProfile({ name: idOrName });
    const pf = envFields(profile);
    const co: Record<string, unknown> = {};
    // H2: Gate co-fetch on a non-empty primary result (profile found).
    const primaryRows: Array<Record<string, unknown>> = Array.isArray(pf.data)
      ? (pf.data as Array<Record<string, unknown>>)
      : pf.data && typeof pf.data === "object"
        ? ([pf.data] as Array<Record<string, unknown>>)
        : [];
    const hasRows = primaryRows.length > 0;
    if (include_.includes("facts") && hasRows) {
      try {
        co.facts = await data.renters.checkBlacklist({ name: idOrName });
      } catch (err) {
        co.facts_error = err instanceof Error ? err.message : String(err);
      }
    }
    if (include_.includes("ltv") && hasRows) {
      try {
        // Phase 1c: prefer top_renters snapshot; if the renter is present,
        // use those numbers; else fall through to getTopSpenders.
        const hydrate = hydrationFromCtx(_ctx);
        let ltvFromSnapshot = false;
        if (hydrate) {
          try {
            const snap = await hydrate.loadSnapshot("top_renters");
            const unavailable = (snap.meta?.caveats ?? []).some((c) =>
              c.includes("snapshot_unavailable_top_renters"),
            );
            if (snap.data && !unavailable) {
              const d = snap.data as { rows?: Array<Record<string, unknown>> };
              const rows = Array.isArray(d.rows) ? d.rows : [];
              const needle = idOrName.toLowerCase();
              const match = rows.find((row) => {
                const id = typeof row.renter_id === "string" ? row.renter_id : "";
                const nm = typeof row.renter_name === "string" ? row.renter_name : "";
                return (
                  id.toLowerCase() === needle ||
                  nm.toLowerCase() === needle ||
                  nm.toLowerCase().includes(needle)
                );
              });
              if (match) {
                co.ltv = {
                  source: "r2.top_renters",
                  match,
                  hydrationSource: snap.meta?.source ?? null,
                };
                ltvFromSnapshot = true;
              }
            }
          } catch {
            /* fall through */
          }
        }
        if (!ltvFromSnapshot) {
          co.ltv = await data.intel.getTopSpenders({});
        }
      } catch (err) {
        co.ltv_error = err instanceof Error ? err.message : String(err);
      }
    }
    return wrap({
      data: { query: idOrName, profile: pf.data, ...co },
      source: "convex.renters",
      extraCaveats: pf.caveats,
      syncState:
        pf.lastSyncedAt !== null
          ? {
              _id: "synthetic",
              _creationTime: 0,
              source: "convex.renters",
              lastRunAt: pf.lastSyncedAt,
              lastRunSucceeded: true,
            }
          : null,
    });
  },
});

// ── 4. query_intel ──────────────────────────────────────────────────────

export const queryIntel = createTool({
  id: "query_intel",
  description:
    "Unified business-intelligence read. `metric` selects which signal to compute. `params` is a flat map forwarded to the underlying intel function — e.g. `{ months: 6 }` or `{ itemName: 'FX3' }`. Pick the smallest metric that answers the question; do not run the full set." +
    CACHE_NOTE,
  inputSchema: z.object({
    metric: z.enum([
      "roi",
      "smart_sell",
      "smart_buy",
      "bundle_profit",
      "denial_signals",
      "churn",
      "utilization",
      "seasonality",
      "yoy",
      "demand_slope",
      "pricing",
    ]),
    params: z
      .record(z.unknown())
      .optional()
      .describe("Optional flat params forwarded to the intel function."),
  }),
  execute: async (input, _ctx) => {
    const { metric, params } = input as {
      metric:
        | "roi"
        | "smart_sell"
        | "smart_buy"
        | "bundle_profit"
        | "denial_signals"
        | "churn"
        | "utilization"
        | "seasonality"
        | "yoy"
        | "demand_slope"
        | "pricing";
      params?: Record<string, unknown>;
    };
    const p = (params ?? {}) as Record<string, unknown>;
    const hydrate = hydrationFromCtx(_ctx);
    // Phase 1c: prefer R2 intel_rankings snapshot for roi / smart_sell /
    // smart_buy / bundle_profit. Falls through on null / missing snapshot.
    if (
      hydrate &&
      (metric === "roi" ||
        metric === "smart_sell" ||
        metric === "smart_buy" ||
        metric === "bundle_profit")
    ) {
      try {
        const snap = await hydrate.loadSnapshot("intel_rankings");
        const unavailable = (snap.meta?.caveats ?? []).some((c) =>
          c.includes("snapshot_unavailable_intel_rankings"),
        );
        if (snap.data && !unavailable) {
          const d = snap.data as {
            roiRanking?: unknown[];
            topEarners30d?: unknown[];
            smartSellRanking?: unknown[];
            smartBuyRanking?: unknown[];
            bundleProfitRanking?: unknown[];
          };
          let slice: unknown = null;
          if (metric === "roi") slice = d.roiRanking ?? d.topEarners30d ?? null;
          else if (metric === "smart_sell") slice = d.smartSellRanking ?? null;
          else if (metric === "smart_buy") slice = d.smartBuyRanking ?? null;
          else if (metric === "bundle_profit") slice = d.bundleProfitRanking ?? null;
          if (slice !== null) {
            const limit =
              typeof p.limit === "number" ? (p.limit as number) : undefined;
            const trimmed =
              Array.isArray(slice) && typeof limit === "number"
                ? slice.slice(0, limit)
                : slice;
            return wrap({
              data: { metric, ranking: trimmed },
              source: "r2.intel_rankings",
              syncState: syncFromMeta(snap.meta),
              extraCaveats: snap.meta?.caveats ?? [],
            });
          }
        }
      } catch {
        /* fall through to live */
      }
    }
    // Phase 1c: prefer top_renters snapshot for churn.
    if (hydrate && metric === "churn") {
      try {
        const snap = await hydrate.loadSnapshot("top_renters");
        const unavailable = (snap.meta?.caveats ?? []).some((c) =>
          c.includes("snapshot_unavailable_top_renters"),
        );
        if (snap.data && !unavailable) {
          return wrap({
            data: { metric, ...(snap.data as Record<string, unknown>) },
            source: "r2.top_renters",
            syncState: syncFromMeta(snap.meta),
            extraCaveats: snap.meta?.caveats ?? [],
          });
        }
      } catch {
        /* fall through to live */
      }
    }
    switch (metric) {
      case "roi":
        return data.intel.getItemROIRanking(
          p as { limit?: number; includeUnknownCost?: boolean },
        );
      case "smart_sell":
        return data.intel.getSmartSellRanking(
          p as { idleDays?: number; limit?: number },
        );
      case "smart_buy":
        return data.intel.getSmartBuyRanking(
          p as { days?: number; limit?: number },
        );
      case "bundle_profit":
        return data.intel.getBundleProfitRanking(p as { days?: number });
      case "denial_signals":
        return data.demand.getTop({});
      case "churn":
        return data.intelligence.getChurnRisk(
          p as Parameters<typeof data.intelligence.getChurnRisk>[0],
        );
      case "utilization":
        return data.intelligence.getUtilizationSnapshot(
          p as Parameters<typeof data.intelligence.getUtilizationSnapshot>[0],
        );
      case "seasonality": {
        const itemName =
          typeof p.itemName === "string" ? (p.itemName as string) : "";
        return data.intel.getItemSeasonality({ itemName });
      }
      case "yoy":
        return data.intel.getItemYoYGrowth(
          p as { itemName?: string; limit?: number },
        );
      case "demand_slope":
        return data.intel.getDemandTrendSlope(
          p as { months?: number; limit?: number },
        );
      case "pricing":
        return data.intel.getPricingSignals(
          p as { lookbackDays?: number; limit?: number },
        );
      default: {
        const never_: never = metric;
        throw new Error(`query_intel: unknown metric "${String(never_)}"`);
      }
    }
  },
});

// ── 5. query_revenue ────────────────────────────────────────────────────

export const queryRevenue = createTool({
  id: "query_revenue",
  description:
    "Revenue/earnings aggregation. `granularity` ∈ day|week|month, `window` is an integer day-count, `by` ∈ item|bundle|renter|total controls the breakdown. " +
    "Prefers the R2 cold-storage snapshot (e.g. `by_item`) when available — falls through to live Convex." +
    CACHE_NOTE,
  inputSchema: z.object({
    granularity: z.enum(["day", "week", "month"]),
    window: z.number().int().positive(),
    by: z.enum(["item", "bundle", "renter", "total"]).optional(),
    account: z.enum(["dbcinema", "leo"]).optional(),
  }),
  execute: async (input, ctx) => {
    const { granularity, window, by, account } = input as {
      granularity: "day" | "week" | "month";
      window: number;
      by?: "item" | "bundle" | "renter" | "total";
      account?: "leo" | "dbcinema";
    };
    const by_ = by ?? "total";
    const hydrate = hydrationFromCtx(ctx);
    if (hydrate) {
      const snapshotName: "by_item" | "by_renter" | "by_month" | "totals" =
        by_ === "item"
          ? "by_item"
          : by_ === "renter"
            ? "by_renter"
            : by_ === "bundle"
              ? "by_month"
              : "totals";
      try {
        const snap = await hydrate.loadSnapshot(snapshotName);
        if (snap.data !== null && snap.data !== undefined) {
          return wrap({
            data: {
              granularity,
              window,
              by: by_,
              account,
              breakdown: snap.data,
            },
            source: "r2.revenue",
            syncState: syncFromMeta(snap.meta),
            extraCaveats: snap.meta?.caveats ?? [],
          });
        }
      } catch {
        /* fall through to live */
      }
    }
    const period: "week" | "month" | "all" =
      window <= 7 ? "week" : window <= 31 ? "month" : "all";
    const live = await data.revenue.getRevenueSummary({ period, account });
    const lf = envFields(live);
    return wrap({
      data: { granularity, window, by: by_, account, breakdown: lf.data },
      source: "convex.revenue",
      extraCaveats: [...lf.caveats, "r2 snapshot unavailable — using live convex"],
      syncState:
        lf.lastSyncedAt !== null
          ? {
              _id: "synthetic",
              _creationTime: 0,
              source: "convex.revenue",
              lastRunAt: lf.lastSyncedAt,
              lastRunSucceeded: true,
            }
          : null,
    });
  },
});

// ── 6. query_calendar ───────────────────────────────────────────────────

export const queryCalendar = createTool({
  id: "query_calendar",
  description:
    "Calendar / schedule lookup. `window` is an integer day-count, `item_id` (an item id or display name) optionally narrows to a single item's schedule (per-day blocks with pickup_time/return_time + freeAfter/freeUntil)." +
    CACHE_NOTE,
  inputSchema: z.object({
    window: z.number().int().positive(),
    item_id: z.string().optional(),
    account: z.enum(["dbcinema", "leo"]).optional(),
  }),
  execute: async (input, _ctx) => {
    const { window, item_id, account } = input as {
      window: number;
      item_id?: string;
      account?: "leo" | "dbcinema";
    };
    if (item_id) {
      // catalog.getItemSchedule expects { itemName, startDate, endDate }.
      // We synthesise an ISO window centred on today.
      const today = new Date();
      const start = today.toISOString().slice(0, 10);
      const end = new Date(today.getTime() + window * 86400_000)
        .toISOString()
        .slice(0, 10);
      return data.catalog.getItemSchedule({
        itemName: item_id,
        startDate: start,
        endDate: end,
      } as Parameters<typeof data.catalog.getItemSchedule>[0]);
    }
    return data.catalog.checkAvailability({
      items: [],
      days: window,
      account,
    } as unknown as Parameters<typeof data.catalog.checkAvailability>[0]);
  },
});

// ── 7. query_market ─────────────────────────────────────────────────────

export const queryMarket = createTool({
  id: "query_market",
  description:
    "External market intelligence (UK Google via SerpAPI / xAI Grok live search, 24h cached). `term` is a free-text query; `limit` caps results; `bypassCache=true` forces a fresh fetch (costs more)." +
    CACHE_NOTE,
  inputSchema: z.object({
    term: z.string(),
    limit: z.number().int().positive().optional(),
    bypassCache: z.boolean().optional(),
  }),
  execute: async (input, _ctx) => {
    const { term, limit, bypassCache } = input as {
      term: string;
      limit?: number;
      bypassCache?: boolean;
    };
    return data.catalog.getMarketSearch({
      query: term,
      limit,
      bypassCache,
    } as unknown as Parameters<typeof data.catalog.getMarketSearch>[0]);
  },
});

// ── 8. query_chat ───────────────────────────────────────────────────────

export const queryChat = createTool({
  id: "query_chat",
  description:
    "Read a Hygglo conversation thread. `threadIdOrOrderId` accepts either the numeric thread id or a reservation keyword. `limit` caps messages returned." +
    CACHE_NOTE,
  inputSchema: z.object({
    threadIdOrOrderId: z.string(),
    limit: z.number().int().positive().optional(),
  }),
  execute: async (input, _ctx) => {
    const { threadIdOrOrderId } = input as {
      threadIdOrOrderId: string;
      limit?: number;
    };
    return data.conversations.readConversation({
      search: threadIdOrOrderId,
    } as unknown as Parameters<typeof data.conversations.readConversation>[0]);
  },
});

// ── 9. query_alerts ─────────────────────────────────────────────────────

export const queryAlerts = createTool({
  id: "query_alerts",
  description:
    "Composite alert feed for the operator: daily briefing (MV), pending shadow actions awaiting approval, and any open model-upgrade advisories." +
    CACHE_NOTE,
  inputSchema: z.object({
    account: z.enum(["dbcinema", "leo"]).optional(),
  }),
  execute: async (input, _ctx) => {
    const { account } = input as { account?: "leo" | "dbcinema" };
    const hydrate = hydrationFromCtx(_ctx);
    // Phase 1c: prefer daily_briefing snapshot for the briefing block.
    // Always fetch shadow + advisories live (small queries).
    let briefingData: unknown = null;
    let briefingMeta: HydrationMetaDuck | undefined;
    let briefingFromSnapshot = false;
    if (hydrate) {
      try {
        const snap = await hydrate.loadSnapshot("daily_briefing");
        const unavailable = (snap.meta?.caveats ?? []).some((c) =>
          c.includes("snapshot_unavailable_daily_briefing"),
        );
        if (snap.data && !unavailable) {
          briefingData = snap.data;
          briefingMeta = snap.meta;
          briefingFromSnapshot = true;
        }
      } catch {
        /* fall through to live */
      }
    }
    const [briefingLive, shadow, advisories] = await Promise.all([
      briefingFromSnapshot
        ? Promise.resolve(null)
        : Promise.resolve(data.rentals.getDailyBriefing({ account })).catch(
            (err) => ({ error: err instanceof Error ? err.message : String(err) }),
          ),
      Promise.resolve(data.uiActions.getPendingShadowActions({})).catch(
        (err) => ({ error: err instanceof Error ? err.message : String(err) }),
      ),
      Promise.resolve(data.modelUpgrades.getOpenAdvisories()).catch(
        (err) => ({ error: err instanceof Error ? err.message : String(err) }),
      ),
    ]);
    const unwrap = (env: unknown): unknown => envFields(env).data;
    return wrap({
      data: {
        daily_briefing: briefingFromSnapshot ? briefingData : unwrap(briefingLive),
        pending_shadow_actions: unwrap(shadow),
        model_upgrade_advisories: unwrap(advisories),
      },
      source: briefingFromSnapshot ? "r2.daily_briefing" : "composite.alerts",
      syncState: briefingFromSnapshot ? syncFromMeta(briefingMeta) : null,
      extraCaveats: briefingFromSnapshot ? briefingMeta?.caveats ?? [] : [],
    });
  },
});

// ── 10. query_compatibility ─────────────────────────────────────────────

export const queryCompatibility = createTool({
  id: "query_compatibility",
  description:
    "Detect mount/accessory conflicts and missing essentials across a list of items. `itemIds` accepts either item ids or display names — the underlying matcher is fuzzy." +
    CACHE_NOTE,
  inputSchema: z.object({
    itemIds: z.array(z.string()).min(1),
  }),
  execute: async (input, _ctx) => {
    const { itemIds } = input as { itemIds: string[] };
    return data.catalog.checkCompatibility({ items: itemIds });
  },
});

// ── 11. read_memory ─────────────────────────────────────────────────────

export const readMemory = createTool({
  id: "read_memory",
  description:
    "Read business memories / notes. Omit `topic` to fetch all; pass a keyword to search by topic / scope." +
    CACHE_NOTE,
  inputSchema: z.object({
    topic: z.string().optional(),
  }),
  execute: async (input, _ctx) => {
    const { topic } = input as { topic?: string };
    return data.memories.searchMemories({
      query: topic ?? "",
    } as unknown as Parameters<typeof data.memories.searchMemories>[0]);
  },
});

// ── 12. mutate ──────────────────────────────────────────────────────────

const MUTATE_OPS = [
  // 9 Trigger-dispatched UI actions (each gated by HYGGLO_UI_LIVE_*)
  "accept_order_ui",
  "decline_order_ui",
  "add_item_to_order",
  "remove_item_from_order",
  "apply_order_discount",
  "change_owner_earnings",
  "mark_order_picked_up",
  "mark_order_returned",
  "leave_renter_review",
  // 4 internal mutations
  "set_item_acquisition_cost",
  "record_denial",
  "update_rule",
  "update_memory",
  // Send-message (gated by READ_ONLY_MODE)
  "send_correction",
  // Decision approval
  "approve_decision",
] as const;

type MutateOp = (typeof MUTATE_OPS)[number];

export const mutate = createTool({
  id: "mutate",
  description:
    "Unified mutation dispatcher. `op` selects the operation, `args` is the flat arg-map for that op. " +
    "UI-action ops (accept_order_ui, decline_order_ui, add_item_to_order, remove_item_from_order, apply_order_discount, change_owner_earnings, mark_order_picked_up, mark_order_returned, leave_renter_review) REQUIRE `args.accountSlug` ('leo'|'dbcinema'). " +
    "Internal ops: set_item_acquisition_cost, record_denial, update_rule, update_memory. Gated ops: send_correction (READ_ONLY_MODE), approve_decision. " +
    "For any destructive change always preview and confirm with the operator before invoking." +
    CACHE_NOTE,
  inputSchema: z.object({
    op: z.enum(MUTATE_OPS),
    args: z
      .record(z.unknown())
      .describe("Flat arg map specific to the chosen op."),
  }),
  execute: async (input, _ctx) => {
    const { op, args } = input as { op: MutateOp; args: Record<string, unknown> };
    // Call the data-layer function directly. READ_ONLY_MODE, HYGGLO_UI_LIVE_*
    // gating, shadow-mode logic, accountSlug validation, MASTER_INVENTORY
    // protection, and Hygglo date math all live INSIDE the data.* functions
    // we forward to — we DO NOT relax those gates here. Each switch arm
    // preserves the exact arg shape the previous dashboard-tools wrapper used
    // (notably: rating narrowing for leave_renter_review, `acquiredDate` →
    // `acquiredAtIso` for set_item_acquisition_cost, `source: "manual"` for
    // record_denial, `actorSource: "dashboard_chat"` for approve_decision).
    let result: unknown;
    switch (op) {
      // ── 9 Trigger-dispatched UI actions (gated by HYGGLO_UI_LIVE_*) ──────
      case "accept_order_ui":
        result = await data.uiActions.acceptOrderUi(
          args as { accountSlug: "leo" | "dbcinema"; orderId: string },
        );
        break;
      case "decline_order_ui":
        result = await data.uiActions.declineOrderUi(
          args as {
            accountSlug: "leo" | "dbcinema";
            orderId: string;
            reason?: string;
          },
        );
        break;
      case "add_item_to_order":
        result = await data.uiActions.addItemToOrder(
          args as {
            accountSlug: "leo" | "dbcinema";
            orderId: string;
            itemName: string;
            quantity?: number;
            days?: number;
          },
        );
        break;
      case "remove_item_from_order":
        result = await data.uiActions.removeItemFromOrder(
          args as {
            accountSlug: "leo" | "dbcinema";
            orderId: string;
            itemName: string;
          },
        );
        break;
      case "apply_order_discount":
        result = await data.uiActions.applyOrderDiscount(
          args as {
            accountSlug: "leo" | "dbcinema";
            orderId: string;
            percentOff?: number;
            newOwnerEarningsGbp?: number;
            reason?: string;
          },
        );
        break;
      case "change_owner_earnings":
        result = await data.uiActions.changeOwnerEarnings(
          args as {
            accountSlug: "leo" | "dbcinema";
            orderId: string;
            newGbp: number;
            reason?: string;
          },
        );
        break;
      case "mark_order_picked_up":
        result = await data.uiActions.markOrderPickedUp(
          args as {
            accountSlug: "leo" | "dbcinema";
            orderId: string;
            notes?: string;
          },
        );
        break;
      case "mark_order_returned":
        result = await data.uiActions.markOrderReturned(
          args as {
            accountSlug: "leo" | "dbcinema";
            orderId: string;
            conditionNotes?: string;
          },
        );
        break;
      case "leave_renter_review": {
        // Preserve rating-type narrowing from the dashboard-tools wrapper.
        const a = args as {
          accountSlug: "leo" | "dbcinema";
          orderId: string;
          rating: number;
          comment?: string;
        };
        result = await data.uiActions.leaveRenterReview({
          accountSlug: a.accountSlug,
          orderId: a.orderId,
          rating: a.rating as 1 | 2 | 3 | 4 | 5,
          comment: a.comment,
        });
        break;
      }
      // ── 4 internal mutations ─────────────────────────────────────────────
      case "set_item_acquisition_cost": {
        // Preserve arg remap: external `acquiredDate` → internal `acquiredAtIso`.
        const a = args as {
          itemName?: string;
          itemId?: string;
          costGbp: number;
          acquiredDate?: string;
          replacementCostGbp?: number;
        };
        result = await data.catalog.setItemAcquisition({
          itemName: a.itemName,
          itemId: a.itemId,
          costGbp: a.costGbp,
          acquiredAtIso: a.acquiredDate,
          replacementCostGbp: a.replacementCostGbp,
        });
        break;
      }
      case "record_denial": {
        // Preserve injected `source: "manual"` tag.
        const a = args as { itemRequested: string; renterName?: string };
        result = await data.lostRevenue.recordDenial({
          ...a,
          source: "manual",
        });
        break;
      }
      case "update_rule":
        result = await data.rules.updateRule(
          args as { ruleId: string; field: string; value: string },
        );
        break;
      case "update_memory":
        result = await data.memories.updateMemory(
          args as { memoryId?: string; newContent: string; scope?: string },
        );
        break;
      // ── send-message (READ_ONLY_MODE gate lives inside data.feedback) ────
      case "send_correction":
        result = await data.feedback.sendCorrection(
          args as { rentalId: string; message: string },
        );
        break;
      // ── decision approval (READ_ONLY_MODE gate inside data.decisions) ────
      case "approve_decision": {
        // Preserve `actorSource: "dashboard_chat"` audit tag.
        const a = args as {
          decisionId: string;
          modifyReply?: string;
          forceDecline?: boolean;
          declineReason?: string;
        };
        result = await data.decisions.applyApproval({
          decisionId: a.decisionId,
          actorSource: "dashboard_chat",
          modifyReply: a.modifyReply,
          forceDecline: a.forceDecline,
          declineReason: a.declineReason,
        });
        break;
      }
      default: {
        const never_: never = op;
        throw new Error(`mutate: unknown op "${String(never_)}"`);
      }
    }
    // H1: Invalidate T1 cache for mutations that touch cached tables.
    // set_item_acquisition_cost writes to the `items` table → bust items cache.
    // update_rule / update_memory write to ai_rules / ai_memories (not T1 cached).
    if (op === "set_item_acquisition_cost") {
      const hydrate = hydrationFromCtx(_ctx);
      if (hydrate && typeof hydrate.invalidate === "function") {
        try {
          hydrate.invalidate("items");
        } catch (err) {
          console.warn("[mutate] hydration.invalidate(items) failed:", err);
        }
      }
      // Phase 1c: also bust the inventory_overview T3 snapshot cache so the
      // next loadSnapshot("inventory_overview") refetches from R2.
      if (hydrate && typeof hydrate.invalidateSnapshot === "function") {
        try {
          hydrate.invalidateSnapshot("inventory_overview");
        } catch (err) {
          console.warn(
            "[mutate] hydration.invalidateSnapshot(inventory_overview) failed:",
            err,
          );
        }
      }
    }
    return result;
  },
});

// ── Registry ────────────────────────────────────────────────────────────

export const routerTools = {
  query_inventory: queryInventory,
  query_orders: queryOrders,
  query_renter: queryRenter,
  query_intel: queryIntel,
  query_revenue: queryRevenue,
  query_calendar: queryCalendar,
  query_market: queryMarket,
  query_chat: queryChat,
  query_alerts: queryAlerts,
  query_compatibility: queryCompatibility,
  read_memory: readMemory,
  mutate,
};

// Re-export the ToolEnvelope type for downstream consumers.
export type { ToolEnvelope };
