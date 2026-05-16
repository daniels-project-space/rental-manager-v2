/**
 * HydrationLayer — Wave 1.
 *
 * Three-tier read-side cache used by dashboard-chat tools and any other
 * Mastra agent execution that needs consistent, freshness-tagged access to
 * static catalog + entity rows + cold-storage snapshots.
 *
 *   T1  static module cache       (5-min TTL, explicit invalidate)
 *   T2  per-turn memoize + batch   (DataLoader-style, dies with instance)
 *   T3  R2 snapshot loader         (5-min TTL, MV-aware fallback chain)
 *
 * Every result is wrapped in a `HydrationResult<T>` carrying a
 * `FreshnessMeta` lineage envelope. Tools convert the meta to the existing
 * `ToolEnvelope` via `tool-envelope.ts → wrap({..., hydrationSource})`.
 *
 * The full design contract lives in
 * /tmp/wfo-phase1/design_hydration_interface.md — open questions /
 * deferred work documented at the bottom of that file.
 */
import { createHash } from "node:crypto";
import { load as dldrLoad, type LoadFn } from "dldr";

// ── Tier source taxonomy ────────────────────────────────────────────────

export type HydrationSourceTier = 1 | 2 | 3;
export type HydrationSourceLabel =
  | "t1.static"
  | "t2.memo"
  | "t2.batch"
  | "t3.r2-snapshot"
  | "t3.r2-then-mv"
  | "convex.live";

export interface HydrationSource {
  tier: HydrationSourceTier;
  label: HydrationSourceLabel;
  table?: string;
  fetchedAt: number;
  cached: boolean;
  ttlExpiresAt?: number;
}

export interface FreshnessMeta {
  source: HydrationSource;
  lastSyncedAt: number | null;
  staleMinutes: number | null;
  coverageRatio?: number;
  caveats: string[];
  fallbackChain?: HydrationSourceLabel[];
}

export interface HydrationResult<T> {
  data: T;
  meta: FreshnessMeta;
}

// ── Static catalog tables (T1) ──────────────────────────────────────────

export type StaticTable =
  | "items"
  | "pricing_catalog"
  | "bundles"
  | "bundle_items";

const T1_TTL_MS = 5 * 60_000;

interface T1Entry {
  data: unknown;
  fetchedAt: number;
  expiresAt: number;
}

// ── Entity tables (T2) ──────────────────────────────────────────────────

export type EntityTable = "renters" | "reservations" | "denials" | "orders";

// ── R2 snapshot indexes (T3) ────────────────────────────────────────────

/**
 * Legacy v1 keys (raw payload, no envelope) + Phase 1c keys (wrapped via
 * `wrapSnapshot` in `r2-cold-storage.ts` → `{generatedAt, data}`).
 *
 * Detection happens at runtime in `loadSnapshot`: presence of a numeric
 * `generatedAt` + a `data` field means the new envelope shape; absence
 * preserves the legacy behavior (data is the payload directly, fetchedAt
 * falls back to `now()`).
 */
export type R2IndexName =
  | "by_item"
  | "by_renter"
  | "by_month"
  | "totals"
  | "intel_rankings"
  | "daily_briefing"
  | "top_renters"
  | "inventory_overview";

/** Snapshot envelope shape produced by `wrapSnapshot<T>` (Phase 1c+). */
interface SnapshotEnvelope<T = unknown> {
  generatedAt: number;
  data: T;
}

function isSnapshotEnvelope(value: unknown): value is SnapshotEnvelope {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { generatedAt?: unknown }).generatedAt === "number" &&
    "data" in (value as Record<string, unknown>)
  );
}

// ── Injectable adapters (test seam) ─────────────────────────────────────

/**
 * Minimal convex-client surface the layer relies on. The real
 * `ConvexHttpClient` from `convex/browser` satisfies this shape; tests
 * substitute a hand-rolled stub.
 */
export interface HydrationConvexClient {
  query(fnRef: unknown, args?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Loader for a single R2 cold-storage index. In production this is wired
 * to `cachedIndex` from `src/lib/r2-cold-storage.ts` (5-min TTL there).
 * Tests inject a fake. Return value is opaque; callers cast at the
 * `loadSnapshot<T>` boundary.
 */
export type R2IndexLoader = (name: R2IndexName) => Promise<unknown>;

/**
 * Materialized-view fallback shim. Wave 1 returns `null` by default
 * (MV layer not yet built); the layer falls straight through to live.
 */
export type MVFallbackLoader = (name: R2IndexName) => Promise<unknown>;

/**
 * Live last-resort fallback. Mirrors a Convex `.collect()` for that
 * conceptual table. Returning `null` triggers an empty-array convex.live
 * result plus a "no data" caveat.
 */
export type LiveFallbackLoader = (name: R2IndexName) => Promise<unknown>;

/**
 * Static table → Convex `query` function reference.
 * Centralised so test stubs can avoid pulling in `convex/_generated/api`.
 */
export interface StaticTableFetchers {
  items: unknown;            // convex query ref returning ItemRow[]
  pricing_catalog: unknown;  // PricingRow[]
  bundles: unknown;          // BundleRow[]
  bundle_items: unknown;     // BundleItemRow[]
}

/**
 * Entity-batch fetchers — DataLoader batches FK collections into a single
 * call. Each fetcher accepts a unique-id list, returns rows in any order.
 */
export interface EntityBatchFetchers {
  renters?: (ids: string[]) => Promise<Array<{ _id?: string; id?: string } & Record<string, unknown>>>;
  reservations?: (ids: string[]) => Promise<Array<{ _id?: string; id?: string } & Record<string, unknown>>>;
  denials?: (ids: string[]) => Promise<Array<{ _id?: string; id?: string } & Record<string, unknown>>>;
  orders?: (ids: string[]) => Promise<Array<{ _id?: string; id?: string } & Record<string, unknown>>>;
}

export interface HydrationLayerOptions {
  convex: HydrationConvexClient;
  /** Override default per-batch ceiling. */
  batchLimit?: number;
  /** Test seam: deterministic clock. */
  now?: () => number;
  /** Override R2 snapshot loader (defaults to r2-cold-storage cachedIndex). */
  r2Loader?: R2IndexLoader;
  /** Optional MV fallback; Wave 1 default returns null. */
  mvLoader?: MVFallbackLoader;
  /** Optional live fallback for T3 chain. */
  liveLoader?: LiveFallbackLoader;
  /** Convex query refs for the four static tables (T1). */
  staticFetchers?: StaticTableFetchers;
  /** Convex batch fetchers for entity tables (T2). */
  entityFetchers?: EntityBatchFetchers;
  /** Sync-state source map: which sync_state.source row backs each table. */
  syncSources?: Partial<Record<StaticTable | EntityTable | "reservations", string>>;
}

// ── Layer surface ───────────────────────────────────────────────────────

/**
 * Sub-API for one static table; mirrors the design spec's `hydrate.items.*`
 * convenience surface while preserving the typed `getStatic` interior.
 */
export interface StaticTableApi<Row> {
  getAll(): Promise<HydrationResult<Row[]>>;
}

export interface EntityTableApi<Row> {
  getByIds(ids: string[]): Promise<HydrationResult<Row[]>>;
}

export interface HydrationLayer {
  // Convenience namespaces (used by Wave 1 callers + tests).
  items: StaticTableApi<Record<string, unknown>>;
  pricing_catalog: StaticTableApi<Record<string, unknown>>;
  bundles: StaticTableApi<Record<string, unknown>>;
  bundle_items: StaticTableApi<Record<string, unknown>>;
  renters: EntityTableApi<Record<string, unknown>>;
  reservations: EntityTableApi<Record<string, unknown>>;
  denials: EntityTableApi<Record<string, unknown>>;
  orders: EntityTableApi<Record<string, unknown>>;

  // Typed core surface.
  getStatic<K extends StaticTable>(
    table: K,
  ): Promise<HydrationResult<Array<Record<string, unknown>>>>;
  loadByIds(
    table: EntityTable,
    ids: string[],
  ): Promise<HydrationResult<Array<Record<string, unknown>>>>;
  memoQuery<T>(
    fnRef: unknown,
    args: Record<string, unknown> | undefined,
    runner: () => Promise<T>,
    opts?: { table?: string },
  ): Promise<HydrationResult<T>>;
  loadSnapshot<T = unknown>(
    name: R2IndexName,
  ): Promise<HydrationResult<T | null>>;

  // Invalidation — T1 only; T2 dies with instance; T3 obeys own TTL.
  invalidate(key: StaticTable | "all"): void;

  /**
   * Hint-only T3 cache buster — clears the layer-local snapshot cache for
   * this key so the next `loadSnapshot(key)` call re-fetches from R2. Note
   * this is purely advisory: the cron writer remains the source of truth
   * and the next read still hits R2 (or its module-scope cache). Useful in
   * tests and post-write fan-out paths to force a stale-cache flush.
   */
  invalidateSnapshot(key: string): void;
}

// ── Module-level T1 cache (shared across instances within a process) ────

const T1_CACHE = new Map<StaticTable, T1Entry>();
// In-flight promise dedup — coalesces concurrent first-fetches so all
// callers within one tick share a single underlying Convex query.
const T1_INFLIGHT = new Map<StaticTable, Promise<T1Entry>>();

// ── Stable hashing utility for T2 memoization ───────────────────────────

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  );
}

function fnRefPath(fnRef: unknown): string {
  if (fnRef && typeof fnRef === "object") {
    const obj = fnRef as Record<string, unknown>;
    if (typeof obj.functionPath === "string") return obj.functionPath;
    if (typeof obj._name === "string") return obj._name;
  }
  if (typeof fnRef === "string") return fnRef;
  return String(fnRef);
}

function hashKey(fnRef: unknown, args: unknown): string {
  return createHash("sha1")
    .update(fnRefPath(fnRef) + "::" + stableStringify(args))
    .digest("hex");
}

// ── Factory ─────────────────────────────────────────────────────────────

export function createHydrationLayer(
  opts: HydrationLayerOptions,
): HydrationLayer {
  const now = opts.now ?? (() => Date.now());
  const batchLimit = opts.batchLimit ?? 100;
  const convex = opts.convex;
  const staticFetchers = opts.staticFetchers ?? ({} as StaticTableFetchers);
  const entityFetchers = opts.entityFetchers ?? ({} as EntityBatchFetchers);
  const syncSources = opts.syncSources ?? {};

  // Default R2 loader is wired lazily so unit tests can avoid the import.
  const r2Loader: R2IndexLoader =
    opts.r2Loader ??
    (async (name: R2IndexName) => {
      const mod = await import("../../lib/r2-cold-storage");
      return mod.cachedIndex(name);
    });
  const mvLoader: MVFallbackLoader = opts.mvLoader ?? (async () => null);
  const liveLoader: LiveFallbackLoader = opts.liveLoader ?? (async () => null);

  // T2 per-instance state — dies when this layer instance is GC'd
  // (i.e. when the chat turn's runtimeContext is released).
  const t2Memo = new Map<string, Promise<HydrationResult<unknown>>>();

  // dldr requires a per-instance, per-table batch loader function. Identity
  // of this function is the batch key inside dldr's WeakMap — re-creating it
  // each layer instance is what makes batches die with the turn (no global
  // leakage). Chunking by `batchLimit` happens INSIDE the loader since dldr
  // hands us all deduped keys at once. dldr returns values positionally; we
  // rebuild a lookup by `_id`/`id` from the fetcher rows.
  const t2BatchLoaders: { [K in EntityTable]?: LoadFn<Record<string, unknown> | null, string> } = {};
  const getBatchLoader = (
    table: EntityTable,
  ): LoadFn<Record<string, unknown> | null, string> => {
    const existing = t2BatchLoaders[table];
    if (existing) return existing;
    const fn: LoadFn<Record<string, unknown> | null, string> = async (keys) => {
      const fetcher = entityFetchers[table];
      if (!fetcher) {
        throw new Error(
          `hydration: no entity fetcher configured for "${table}"`,
        );
      }
      const chunks: string[][] = [];
      for (let i = 0; i < keys.length; i += batchLimit) {
        chunks.push(keys.slice(i, i + batchLimit));
      }
      const groups = await Promise.all(chunks.map((chunk) => fetcher(chunk)));
      const flat = groups.flat();
      const lookup = new Map<string, Record<string, unknown>>();
      for (const row of flat) {
        const idKey =
          (typeof row._id === "string" ? row._id : undefined) ??
          (typeof row.id === "string" ? row.id : undefined);
        if (idKey) lookup.set(idKey, row);
      }
      // dldr requires output length == input length. Missing rows → null;
      // loadByIds() filters nulls before resolving.
      return keys.map((k) => lookup.get(k) ?? null);
    };
    t2BatchLoaders[table] = fn;
    return fn;
  };

  // Per-turn cache for sync_state lookups — read once per (turn, source).
  const syncStateCache = new Map<
    string,
    Promise<{ lastRunAt: number; lastRunSucceeded: boolean } | null>
  >();

  async function getSyncState(source: string | undefined) {
    if (!source) return null;
    if (!syncStateCache.has(source)) {
      syncStateCache.set(
        source,
        (async () => {
          try {
            const res = (await convex.query({ functionPath: "sync_state.get" }, {
              source,
            })) as { lastRunAt?: number; lastRunSucceeded?: boolean } | null;
            if (!res || typeof res.lastRunAt !== "number") return null;
            return {
              lastRunAt: res.lastRunAt,
              lastRunSucceeded: res.lastRunSucceeded ?? true,
            };
          } catch {
            return null;
          }
        })(),
      );
    }
    return syncStateCache.get(source)!;
  }

  function buildMeta(
    source: HydrationSource,
    syncState: { lastRunAt: number; lastRunSucceeded: boolean } | null,
    extraCaveats: string[] = [],
    fallbackChain?: HydrationSourceLabel[],
    coverageRatio?: number,
  ): FreshnessMeta {
    const lastSyncedAt = syncState?.lastRunAt ?? null;
    const staleMinutes =
      lastSyncedAt !== null
        ? Math.round((now() - lastSyncedAt) / 60_000)
        : null;
    const caveats: string[] = [];
    if (staleMinutes !== null && staleMinutes > 30) {
      caveats.push(`data ${staleMinutes}m stale`);
    }
    if (lastSyncedAt === null && source.table === "reservations") {
      // Documented limitation — reservations sync_state has table-level
      // fallback only. Surface explicitly per design spec §6.
      caveats.push("reservations freshness sourced from sync_state fallback");
    }
    if (syncState?.lastRunSucceeded === false) {
      caveats.push("last sync failed; data may be stale");
    }
    if (coverageRatio !== undefined && coverageRatio < 1) {
      caveats.push(
        `covers ${Math.round(coverageRatio * 100)}% of expected rows`,
      );
    }
    if (fallbackChain && fallbackChain.length > 1) {
      caveats.push(`fallback chain: ${fallbackChain.join(" → ")}`);
    }
    for (const c of extraCaveats) caveats.push(c);
    const meta: FreshnessMeta = {
      source,
      lastSyncedAt,
      staleMinutes,
      caveats,
    };
    if (coverageRatio !== undefined) meta.coverageRatio = coverageRatio;
    if (fallbackChain) meta.fallbackChain = fallbackChain;
    return meta;
  }

  // ── T1 ────────────────────────────────────────────────────────────────

  async function getStatic<K extends StaticTable>(
    table: K,
  ): Promise<HydrationResult<Array<Record<string, unknown>>>> {
    const ts = now();
    const cached = T1_CACHE.get(table);
    if (cached && cached.expiresAt > ts) {
      const sync = await getSyncState(syncSources[table]);
      return {
        data: cached.data as Array<Record<string, unknown>>,
        meta: buildMeta(
          {
            tier: 1,
            label: "t1.static",
            table,
            fetchedAt: cached.fetchedAt,
            cached: true,
            ttlExpiresAt: cached.expiresAt,
          },
          sync,
        ),
      };
    }
    const fetcher = staticFetchers[table];
    if (!fetcher) {
      throw new Error(`hydration: no static fetcher configured for "${table}"`);
    }
    // Coalesce concurrent first-fetches: all parallel callers within one
    // tick share the same underlying query promise.
    let inflight = T1_INFLIGHT.get(table);
    let isFirst = false;
    if (!inflight) {
      isFirst = true;
      inflight = (async () => {
        try {
          const rows = (await convex.query(fetcher, {})) as Array<
            Record<string, unknown>
          >;
          const fetchedAt = now();
          const entry: T1Entry = {
            data: rows,
            fetchedAt,
            expiresAt: fetchedAt + T1_TTL_MS,
          };
          T1_CACHE.set(table, entry);
          return entry;
        } finally {
          T1_INFLIGHT.delete(table);
        }
      })();
      T1_INFLIGHT.set(table, inflight);
    }
    const entry = await inflight;
    const sync = await getSyncState(syncSources[table]);
    return {
      data: entry.data as Array<Record<string, unknown>>,
      meta: buildMeta(
        {
          tier: 1,
          label: "t1.static",
          table,
          fetchedAt: entry.fetchedAt,
          cached: !isFirst,
          ttlExpiresAt: entry.expiresAt,
        },
        sync,
      ),
    };
  }

  function invalidate(key: StaticTable | "all"): void {
    if (key === "all") {
      T1_CACHE.clear();
      T1_INFLIGHT.clear();
    } else {
      T1_CACHE.delete(key);
      T1_INFLIGHT.delete(key);
    }
  }

  /**
   * Bust the T3 layer-local snapshot cache for `key`. Hint-only: next
   * `loadSnapshot(key)` re-fetches from R2 (which has its own module
   * cache). The cron writer remains the source of truth.
   */
  function invalidateSnapshot(key: string): void {
    t3Cache.delete(key);
  }

  // ── T2 — memoize ──────────────────────────────────────────────────────

  async function memoQuery<T>(
    fnRef: unknown,
    args: Record<string, unknown> | undefined,
    runner: () => Promise<T>,
    opts?: { table?: string },
  ): Promise<HydrationResult<T>> {
    const key = hashKey(fnRef, args ?? {});
    const existing = t2Memo.get(key);
    if (existing) {
      const prior = (await existing) as HydrationResult<T>;
      const sync = await getSyncState(
        opts?.table ? syncSources[opts.table as keyof typeof syncSources] : undefined,
      );
      return {
        data: prior.data,
        meta: buildMeta(
          {
            tier: 2,
            label: "t2.memo",
            table: opts?.table,
            fetchedAt: prior.meta.source.fetchedAt,
            cached: true,
          },
          sync,
        ),
      };
    }
    const promise = (async (): Promise<HydrationResult<unknown>> => {
      const data = await runner();
      const fetchedAt = now();
      const sync = await getSyncState(
        opts?.table ? syncSources[opts.table as keyof typeof syncSources] : undefined,
      );
      return {
        data,
        meta: buildMeta(
          {
            tier: 2,
            label: "t2.memo",
            table: opts?.table,
            fetchedAt,
            cached: false,
          },
          sync,
        ),
      };
    })();
    t2Memo.set(key, promise);
    return promise as Promise<HydrationResult<T>>;
  }

  // ── T2 — DataLoader batch (delegated to dldr) ─────────────────────────
  //
  // Public `loadByIds` signature unchanged. Internally each requested id is
  // dispatched through `dldr.load(loader, id)`. dldr coalesces all calls
  // sharing the same loader fn into one microtask-flushed batch and dedupes
  // identical keys for us. Per-table loader fns live on this instance only,
  // so batches never leak across turns.

  async function loadByIds(
    table: EntityTable,
    ids: string[],
  ): Promise<HydrationResult<Array<Record<string, unknown>>>> {
    const requested = Array.from(new Set(ids));
    if (requested.length === 0) {
      const sync = await getSyncState(syncSources[table]);
      return {
        data: [],
        meta: buildMeta(
          {
            tier: 2,
            label: "t2.batch",
            table,
            fetchedAt: now(),
            cached: false,
          },
          sync,
        ),
      };
    }
    const loader = getBatchLoader(table);
    const rows = await Promise.all(
      requested.map((id) => dldrLoad<Record<string, unknown> | null, string>(loader, id)),
    );
    const ordered = rows.filter(
      (r): r is Record<string, unknown> => r !== null && r !== undefined,
    );
    const sync = await getSyncState(syncSources[table]);
    const fetchedAt = now();
    const coverage =
      requested.length === 0 ? 1 : ordered.length / requested.length;
    return {
      data: ordered,
      meta: buildMeta(
        {
          tier: 2,
          label: "t2.batch",
          table,
          fetchedAt,
          cached: false,
        },
        sync,
        [],
        undefined,
        coverage < 1 ? coverage : undefined,
      ),
    };
  }

  // ── T3 — R2 snapshot loader with fallback chain ───────────────────────

  /**
   * Layer-local snapshot cache. Mirrors the 5-min TTL applied to T1 so
   * repeated `loadSnapshot(key)` calls within one chat turn (or tool fan-
   * out) avoid hammering R2. `invalidateSnapshot(key)` clears the entry —
   * a hint, not a write barrier; the cron remains source of truth.
   */
  interface T3CacheEntry {
    data: unknown;
    fetchedAt: number;
    expiresAt: number;
  }
  const t3Cache = new Map<string, T3CacheEntry>();

  async function loadSnapshot<T = unknown>(
    name: R2IndexName,
  ): Promise<HydrationResult<T | null>> {
    const chain: HydrationSourceLabel[] = [];
    const caveats: string[] = [];
    const fetchedAt0 = now();
    // 0. Layer-local cache hit (5-min TTL).
    const cachedEntry = t3Cache.get(name);
    if (cachedEntry && cachedEntry.expiresAt > fetchedAt0) {
      return {
        data: cachedEntry.data as T,
        meta: buildMeta(
          {
            tier: 3,
            label: "t3.r2-snapshot",
            table: name,
            fetchedAt: cachedEntry.fetchedAt,
            cached: true,
            ttlExpiresAt: cachedEntry.expiresAt,
          },
          null,
          caveats,
        ),
      };
    }
    // 1. R2 cold-storage cachedIndex
    chain.push("t3.r2-snapshot");
    try {
      const r2 = await r2Loader(name);
      if (r2 !== null && r2 !== undefined) {
        // Phase 1c+ envelope: {generatedAt, data} → unwrap and surface
        // `generatedAt` as the canonical fetchedAt. Legacy keys keep
        // their raw payload + now() fallback.
        let payload: unknown = r2;
        let envelopeGeneratedAt: number | null = null;
        if (isSnapshotEnvelope(r2)) {
          envelopeGeneratedAt = r2.generatedAt;
          payload = r2.data;
        }
        const effectiveFetchedAt = envelopeGeneratedAt ?? now();
        t3Cache.set(name, {
          data: payload,
          fetchedAt: effectiveFetchedAt,
          expiresAt: fetchedAt0 + T1_TTL_MS,
        });
        return {
          data: payload as T,
          meta: buildMeta(
            {
              tier: 3,
              label: "t3.r2-snapshot",
              table: name,
              fetchedAt: effectiveFetchedAt,
              cached: true,
              ttlExpiresAt: fetchedAt0 + T1_TTL_MS,
            },
            null,
            caveats,
          ),
        };
      }
      // R2 returned null → snapshot missing
      caveats.push("r2_snapshot_missing");
      caveats.push(`snapshot_unavailable_${name}`);
    } catch (err) {
      caveats.push("r2_unavailable");
      caveats.push(`snapshot_unavailable_${name}`);
      caveats.push(
        `r2 error: ${err instanceof Error ? err.message : String(err)}`,
      );
      // eslint-disable-next-line no-console
      console.warn(
        `[hydration] snapshot_unavailable_${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // 2. MV fallback
    chain.push("t3.r2-then-mv");
    try {
      const mv = await mvLoader(name);
      if (mv !== null && mv !== undefined) {
        return {
          data: mv as T,
          meta: buildMeta(
            {
              tier: 3,
              label: "t3.r2-then-mv",
              table: name,
              fetchedAt: now(),
              cached: false,
            },
            null,
            caveats,
            chain,
          ),
        };
      }
    } catch (err) {
      caveats.push(
        `mv error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // 3. Live last-resort
    chain.push("convex.live");
    try {
      const live = await liveLoader(name);
      return {
        data: (live ?? null) as T | null,
        meta: buildMeta(
          {
            tier: 3,
            label: "convex.live",
            table: name,
            fetchedAt: now(),
            cached: false,
          },
          null,
          caveats,
          chain,
        ),
      };
    } catch (err) {
      caveats.push(
        `live fallback error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        data: null,
        meta: buildMeta(
          {
            tier: 3,
            label: "convex.live",
            table: name,
            fetchedAt: now(),
            cached: false,
          },
          null,
          caveats,
          chain,
        ),
      };
    }
  }

  // ── Static-table namespaces ──────────────────────────────────────────

  const makeStaticApi = <K extends StaticTable>(
    table: K,
  ): StaticTableApi<Record<string, unknown>> => ({
    getAll: () => getStatic(table),
  });

  const makeEntityApi = (
    table: EntityTable,
  ): EntityTableApi<Record<string, unknown>> => ({
    getByIds: (ids: string[]) => loadByIds(table, ids),
  });

  return {
    items: makeStaticApi("items"),
    pricing_catalog: makeStaticApi("pricing_catalog"),
    bundles: makeStaticApi("bundles"),
    bundle_items: makeStaticApi("bundle_items"),
    renters: makeEntityApi("renters"),
    reservations: makeEntityApi("reservations"),
    denials: makeEntityApi("denials"),
    orders: makeEntityApi("orders"),
    getStatic,
    loadByIds,
    memoQuery,
    loadSnapshot,
    invalidate,
    invalidateSnapshot,
  };
}

// Test-only: clear shared T1 cache between tests.
export function __resetT1CacheForTests(): void {
  T1_CACHE.clear();
  T1_INFLIGHT.clear();
}
