/**
 * snapshot-inventory-overview — Trigger.dev scheduled writer.
 *
 * Runs every 12 hours. Parallel-fetches:
 *   1. All items rows (items:listAll via Convex HTTP API)
 *   2. Pricing catalog (pricing_catalog:listAll — for daily_price_max)
 *   3. Revenue ranking for last 30 days (items:getItemRevenueRanking)
 *
 * Joins by name_canonical and writes a denormalised inventory snapshot to R2
 * at cold/v1/indexes/inventory_overview.json.
 *
 * Output shape:
 *   { totalItems, totalQty, items: InventoryOverviewItem[] }
 *
 * Each item row:
 *   { itemId, nameCanonical, kind, qty, status, acquisitionCostGbp,
 *     dailyPriceMax, gross30dGbp, rentalCount30d, utilizationPct30d }
 */
import { schedules, logger } from "@trigger.dev/sdk/v3";
import {
  putAggregateIndex,
  wrapSnapshot,
} from "../lib/r2-cold-storage";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

// ── Raw Convex types ─────────────────────────────────────────────────────────

interface RawItem {
  _id: string;
  name_canonical: string;
  kind: string;
  qty: number;
  status: string;
  acquisition_cost_gbp?: number;
  is_marketing_only?: boolean;
}

interface RawPricingRow {
  item_name_canonical: string;
  daily_price_max: number;
  is_bundle?: boolean;
  marketing_only?: boolean;
}

interface RevenueRankingRow {
  name: string;          // canonical name (cleaned — no " [kind]" suffix)
  totalRevenue: number;
  rentalCount: number;
  avgValue: number;
  totalDays: number;
}

// ── Output type ──────────────────────────────────────────────────────────────

export interface InventoryOverviewItem {
  itemId: string;
  nameCanonical: string;
  kind: string;
  qty: number;
  status: string;
  acquisitionCostGbp: number | null;
  dailyPriceMax: number | null;
  gross30dGbp: number;
  rentalCount30d: number;
  utilizationPct30d: number;
}

export interface InventoryOverview {
  totalItems: number;
  totalQty: number;
  items: InventoryOverviewItem[];
}

// ── Convex HTTP helpers ──────────────────────────────────────────────────────

async function convexQuery<T>(path: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  if (!res.ok) {
    throw new Error(`Convex HTTP error ${res.status} for ${path}`);
  }
  const data = (await res.json()) as {
    status: string;
    value?: T;
    errorMessage?: string;
  };
  if (data.status !== "success") {
    throw new Error(`Convex query ${path} failed: ${data.errorMessage}`);
  }
  return data.value as T;
}

// ── Scheduled task ───────────────────────────────────────────────────────────

export const snapshotInventoryOverviewTask = schedules.task({
  id: "snapshot-inventory-overview",
  cron: "0 */12 * * *",
  maxDuration: 120,
  run: async (_payload, { ctx }) => {
    if (process.env.SNAPSHOTS_VIA_CONVEX === "1") {
      logger.info("SNAPSHOTS_VIA_CONVEX=1, deferring to Convex internalAction");
      return { skipped: true, reason: "convex-action" };
    }
    const startMs = Date.now();
    logger.info("snapshot-inventory-overview: starting", { runId: ctx.run.id });

    // ── 1. Parallel fetch ──────────────────────────────────────────────────
    const [items, pricingRows, revenueRanking] = await Promise.all([
      convexQuery<RawItem[]>("items:listAll", {}).catch((err: unknown) => {
        // listAll may not exist — fall back to listForReconcile which returns
        // all items (different shape: {_id, name, aliases, qty}).
        // We prefer listAll (full row); listForReconcile is the fallback.
        logger.warn("snapshot-inventory-overview: items:listAll failed, trying items:listForReconcile", {
          err: String(err),
        });
        return null;
      }),
      convexQuery<RawPricingRow[]>("pricing_catalog:listAll", {}).catch((err: unknown) => {
        logger.warn("snapshot-inventory-overview: pricing_catalog:listAll failed — dailyPriceMax will be null", {
          err: String(err),
        });
        return [] as RawPricingRow[];
      }),
      convexQuery<RevenueRankingRow[]>("items:getItemRevenueRanking", {
        accountSlug: null,
        days: 30,
      }),
    ]);

    // If primary items fetch failed, try the reconcile path which at minimum
    // returns _id + name + qty. We cannot proceed without items.
    let allItems: RawItem[];
    if (items === null) {
      // listForReconcile shape: {_id, name, aliases, qty}
      interface ReconcileItem { _id: string; name: string; qty: number }
      const reconcile = await convexQuery<ReconcileItem[]>("items:listForReconcile", {}).catch((err2: unknown) => {
        logger.error("snapshot-inventory-overview: both items queries failed — aborting", {
          err: String(err2),
        });
        throw new Error(`Cannot fetch items: ${String(err2)}`);
      });
      // Normalise to RawItem shape (kind/status unknown, fill defaults)
      allItems = reconcile.map((r) => ({
        _id: r._id,
        name_canonical: r.name,
        kind: "unknown",
        qty: r.qty,
        status: "active",   // listForReconcile only includes non-archived items
        acquisition_cost_gbp: undefined,
      }));
    } else {
      allItems = items;
    }

    logger.info("snapshot-inventory-overview: fetched", {
      itemCount: allItems.length,
      pricingRowCount: (pricingRows as RawPricingRow[]).length,
      revenueRowCount: revenueRanking.length,
    });

    // ── 2. Build lookup maps ───────────────────────────────────────────────

    // Pricing: best (highest updated_at) daily_price_max per canonical name.
    // Mirror the dedup logic from items.ts getPriceRecommendations.
    const priceMaxByName = new Map<string, number>();
    for (const p of pricingRows as RawPricingRow[]) {
      if (p.is_bundle || p.marketing_only) continue;
      const existing = priceMaxByName.get(p.item_name_canonical);
      if (existing === undefined || p.daily_price_max > existing) {
        priceMaxByName.set(p.item_name_canonical, p.daily_price_max);
      }
    }

    // Revenue: keyed by cleaned canonical name (getItemRevenueRanking strips
    // " [kind]" suffixes before returning, so keys should match name_canonical
    // directly for LLM-resolved rows).
    const revenueByName = new Map<string, RevenueRankingRow>();
    for (const row of revenueRanking) {
      revenueByName.set(row.name, row);
    }

    // ── 3. Join ────────────────────────────────────────────────────────────

    const LOOKBACK_DAYS = 30;
    const overviewItems: InventoryOverviewItem[] = allItems
      .filter((i) => !i.is_marketing_only)
      .map((i) => {
        const rev = revenueByName.get(i.name_canonical);
        const rentalDays = rev?.totalDays ?? 0;
        const utilizationPct =
          LOOKBACK_DAYS > 0 ? Math.round((rentalDays / LOOKBACK_DAYS) * 10000) / 100 : 0;

        return {
          itemId: i._id,
          nameCanonical: i.name_canonical,
          kind: i.kind,
          qty: i.qty,
          status: i.status,
          acquisitionCostGbp: i.acquisition_cost_gbp ?? null,
          dailyPriceMax: priceMaxByName.get(i.name_canonical) ?? null,
          gross30dGbp: Math.round((rev?.totalRevenue ?? 0) * 100) / 100,
          rentalCount30d: rev?.rentalCount ?? 0,
          utilizationPct30d: utilizationPct,
        };
      });

    const totalQty = overviewItems.reduce((s, i) => s + i.qty, 0);

    const data: InventoryOverview = {
      totalItems: overviewItems.length,
      totalQty,
      items: overviewItems,
    };

    // ── 4. Write to R2 ─────────────────────────────────────────────────────

    const key = await putAggregateIndex("inventory_overview", wrapSnapshot(data));
    const durationMs = Date.now() - startMs;
    const sizeBytes = JSON.stringify(wrapSnapshot(data)).length;

    logger.info("snapshot-inventory-overview: complete", {
      rowCount: overviewItems.length,
      totalQty,
      sizeBytes,
      durationMs,
      r2Key: key,
    });

    return {
      ok: true,
      rowCount: overviewItems.length,
      totalQty,
      sizeBytes,
      durationMs,
    };
  },
});
