"use node";

/**
 * Phase 3a / Wave 2b — R2 snapshot writers moved from Trigger.dev to Convex
 * internalAction. Saves one HTTP round-trip per cron tick (no ConvexHttpClient
 * needed — actions call queries via `ctx.runQuery` in-process) and removes
 * Trigger run-minute usage for these 4 schedules.
 *
 * Source-of-truth logic mirrors src/trigger/snapshot-*.ts. While those Trigger
 * tasks remain registered, they short-circuit when SNAPSHOTS_VIA_CONVEX=1
 * (set on the Trigger project env) so we don't double-write to R2.
 *
 * R2 key naming is preserved (intel_rankings, daily_briefing, top_renters,
 * inventory_overview). Envelope is `wrapSnapshot({generatedAt, data})`.
 */
import { internalAction } from "./_generated/server";
import { api } from "./_generated/api";
import {
  wrapSnapshot,
  putAggregateIndex,
  getAggregateIndex,
} from "../src/lib/r2-cold-storage";

// CONVEX_CLOUD_URL is auto-injected by Convex into every action runtime.
// CONVEX_URL / NEXT_PUBLIC_CONVEX_URL are NOT set in prod env, so without
// the CONVEX_CLOUD_URL fallback `fetch("/api/query", ...)` threw a URL
// parse error inside snapshotInventoryOverview (only handler that issues
// HTTP queries; the other 3 use ctx.runQuery and were unaffected).
const CONVEX_URL =
  process.env.CONVEX_URL ??
  process.env.NEXT_PUBLIC_CONVEX_URL ??
  process.env.CONVEX_CLOUD_URL ??
  "";

// ════════════════════════════════════════════════════════════════════════════
// 1. snapshotIntelRankings — every 4h
// ════════════════════════════════════════════════════════════════════════════

export const snapshotIntelRankings = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    ok: boolean;
    rowCount: number;
    payloadBytes: number;
    durationMs: number;
  }> => {
    const startedAt = Date.now();
    console.log("snapshot-intel-rankings: starting");

    const [roiRanking, topEarners30d]: [unknown, unknown] = await Promise.all([
      ctx.runQuery(api.intel.getItemROIRanking, {}),
      ctx.runQuery(api.mv.top_earners.get, {}),
    ]);

    const data = { roiRanking, topEarners30d };
    const payload = wrapSnapshot(data, "convex");
    const payloadBytes = JSON.stringify(payload).length;

    await putAggregateIndex("intel_rankings", payload);

    const durationMs = Date.now() - startedAt;
    const rowCount = Array.isArray(roiRanking) ? roiRanking.length : 0;
    console.log("snapshot-intel-rankings: done", {
      rowCount,
      payloadBytes,
      durationMs,
    });

    return { ok: true, rowCount, payloadBytes, durationMs };
  },
});

// ════════════════════════════════════════════════════════════════════════════
// 2. snapshotDailyBriefing — every 10m
// ════════════════════════════════════════════════════════════════════════════

export const snapshotDailyBriefing = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    | { ok: false; reason: string }
    | { ok: true; rowSize: number; durationMs: number }
  > => {
    const startedAt = Date.now();
    console.log("snapshot-daily-briefing: starting");

    const briefing: unknown = await ctx.runQuery(api.mv.daily_briefing.get, {});

    if (briefing === null) {
      console.warn(
        "snapshot-daily-briefing: MV not yet computed, skipping R2 write",
      );
      return { ok: false, reason: "mv_null" };
    }

    const payload = wrapSnapshot(briefing, "convex");
    const rowSize = JSON.stringify(payload).length;

    await putAggregateIndex("daily_briefing", payload);

    const durationMs = Date.now() - startedAt;
    console.log("snapshot-daily-briefing: done", { rowSize, durationMs });

    return { ok: true, rowSize, durationMs };
  },
});

// ════════════════════════════════════════════════════════════════════════════
// 3. snapshotTopRenters — every 6h
// ════════════════════════════════════════════════════════════════════════════

const TR_LOOKBACK_DAYS = 90;
const TR_LIMIT_90D = 50;
const TR_OUTPUT_CAP = 100;
import { OWNER_SHARE as TR_NET_FALLBACK_RATIO } from "./lib/revenue_attribution";

interface TopSpendersRow {
  renterId: string | null;
  displayName: string;
  email: string | null;
  rentalCount: number;
  grossGbp: number;
  netGbp: number;
  blacklisted: boolean;
}

interface TopSpendersResult {
  ok: boolean;
  lookbackDays: number | null;
  rows: TopSpendersRow[];
}

interface ByRenterEntry {
  totalGross: number;
  rentalCount: number;
  firstDate?: string;
  lastDate?: string;
  totalNet?: number;
  email?: string;
  displayName?: string;
}

type ByRenterIndex = Record<string, ByRenterEntry>;

interface TopRenterRow {
  renterId: string | null;
  displayName: string;
  email: string | null;
  rentalCount: number;
  grossGbp: number;
  netGbp: number;
  blacklisted: boolean;
}

interface TopRentersData {
  lookbackDays: number;
  rows: TopRenterRow[];
}

export const snapshotTopRenters = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    ok: boolean;
    rowCount: number;
    payloadBytes: number;
    durationMs: number;
  }> => {
    const startedAt = Date.now();
    console.log("snapshot-top-renters: starting");

    const [spenders90dRaw, byRenterLifetime]: [unknown, ByRenterIndex | null] =
      await Promise.all([
        ctx.runQuery(api.intel.getTopSpenders, {
          days: TR_LOOKBACK_DAYS,
          limit: TR_LIMIT_90D,
        }),
        getAggregateIndex<ByRenterIndex>("by_renter"),
      ]);

    const spenders90d = spenders90dRaw as unknown as TopSpendersResult;
    const lifetime: ByRenterIndex = byRenterLifetime ?? {};

    const merged = new Map<string, TopRenterRow>();

    // Pass 1: 90d rows (authoritative for monetary + recency)
    for (const r of spenders90d.rows) {
      const key = r.renterId ?? r.displayName.trim().toLowerCase();
      merged.set(key, {
        renterId: r.renterId,
        displayName: r.displayName,
        email: r.email,
        rentalCount: r.rentalCount,
        grossGbp: r.grossGbp,
        netGbp: r.netGbp,
        blacklisted: r.blacklisted,
      });
    }

    // Pass 2: lifetime-only rows
    for (const [nameKey, entry] of Object.entries(lifetime)) {
      const normKey = nameKey.trim().toLowerCase();
      if (merged.has(normKey)) continue;
      const alreadyCovered = Array.from(merged.values()).some(
        (row) => row.displayName.trim().toLowerCase() === normKey,
      );
      if (alreadyCovered) continue;

      const gross = entry.totalGross ?? 0;
      const net = entry.totalNet ?? gross * TR_NET_FALLBACK_RATIO;
      merged.set(normKey, {
        renterId: null,
        displayName: entry.displayName ?? nameKey,
        email: entry.email ?? null,
        rentalCount: entry.rentalCount ?? 0,
        grossGbp: Math.round(gross * 100) / 100,
        netGbp: Math.round(net * 100) / 100,
        blacklisted: false,
      });
    }

    // Pass 3: enrich id-keyed rows missing email/name
    for (const [key, row] of merged.entries()) {
      if (row.email && row.displayName) continue;
      const normName = row.displayName.trim().toLowerCase();
      const lifetimeEntry = lifetime[normName] ?? lifetime[row.displayName];
      if (lifetimeEntry) {
        merged.set(key, {
          ...row,
          email: row.email ?? lifetimeEntry.email ?? null,
          displayName:
            row.displayName || lifetimeEntry.displayName || row.displayName,
        });
      }
    }

    const rows: TopRenterRow[] = Array.from(merged.values())
      .sort((a, b) => b.grossGbp - a.grossGbp)
      .slice(0, TR_OUTPUT_CAP);

    const data: TopRentersData = { lookbackDays: TR_LOOKBACK_DAYS, rows };
    const payload = wrapSnapshot(data, "convex");
    const payloadBytes = JSON.stringify(payload).length;

    await putAggregateIndex("top_renters", payload);

    const durationMs = Date.now() - startedAt;
    console.log("snapshot-top-renters: done", {
      rowCount: rows.length,
      payloadBytes,
      durationMs,
    });

    return { ok: true, rowCount: rows.length, payloadBytes, durationMs };
  },
});

// ════════════════════════════════════════════════════════════════════════════
// 4. snapshotInventoryOverview — every 12h
// ════════════════════════════════════════════════════════════════════════════

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
  name: string;
  totalRevenue: number;
  rentalCount: number;
  avgValue: number;
  totalDays: number;
}

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

// `items:listAll` / `pricing_catalog:listAll` are NOT exported as typed Convex
// queries in this repo. The Trigger version used the Convex HTTP /api/query
// endpoint (accepts string path); `ctx.runQuery` requires a typed
// FunctionReference. We keep the HTTP path for the two missing endpoints so
// the action works whether or not they're later promoted to typed queries.
async function convexHttpQuery<T>(
  path: string,
  args: Record<string, unknown>,
): Promise<T> {
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

export const snapshotInventoryOverview = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    ok: boolean;
    rowCount: number;
    totalQty: number;
    sizeBytes: number;
    durationMs: number;
  }> => {
    const startMs = Date.now();
    console.log("snapshot-inventory-overview: starting");

    const revenueRankingPromise: Promise<RevenueRankingRow[]> = ctx.runQuery(
      api.items.getItemRevenueRanking,
      { accountSlug: null, days: 30 },
    ) as unknown as Promise<RevenueRankingRow[]>;

    const [items, pricingRows, revenueRanking] = await Promise.all([
      convexHttpQuery<RawItem[]>("items:listAll", {}).catch((err: unknown) => {
        console.warn(
          "snapshot-inventory-overview: items:listAll failed, will try items:listForReconcile",
          { err: String(err) },
        );
        return null;
      }),
      convexHttpQuery<RawPricingRow[]>("pricing_catalog:listAll", {}).catch(
        (err: unknown) => {
          console.warn(
            "snapshot-inventory-overview: pricing_catalog:listAll failed — dailyPriceMax will be null",
            { err: String(err) },
          );
          return [] as RawPricingRow[];
        },
      ),
      revenueRankingPromise,
    ]);

    let allItems: RawItem[];
    if (items === null) {
      interface ReconcileItem {
        _id: string;
        name: string;
        qty: number;
      }
      const reconcile = await convexHttpQuery<ReconcileItem[]>(
        "items:listForReconcile",
        {},
      ).catch((err2: unknown) => {
        console.error(
          "snapshot-inventory-overview: both items queries failed — aborting",
          { err: String(err2) },
        );
        throw new Error(`Cannot fetch items: ${String(err2)}`);
      });
      allItems = reconcile.map((r) => ({
        _id: r._id,
        name_canonical: r.name,
        kind: "unknown",
        qty: r.qty,
        status: "active",
        acquisition_cost_gbp: undefined,
      }));
    } else {
      allItems = items;
    }

    console.log("snapshot-inventory-overview: fetched", {
      itemCount: allItems.length,
      pricingRowCount: pricingRows.length,
      revenueRowCount: revenueRanking.length,
    });

    const priceMaxByName = new Map<string, number>();
    for (const p of pricingRows) {
      if (p.is_bundle || p.marketing_only) continue;
      const existing = priceMaxByName.get(p.item_name_canonical);
      if (existing === undefined || p.daily_price_max > existing) {
        priceMaxByName.set(p.item_name_canonical, p.daily_price_max);
      }
    }

    const revenueByName = new Map<string, RevenueRankingRow>();
    for (const row of revenueRanking) {
      revenueByName.set(row.name, row);
    }

    const LOOKBACK_DAYS = 30;
    const overviewItems: InventoryOverviewItem[] = allItems
      .filter((i) => !i.is_marketing_only)
      .map((i) => {
        const rev = revenueByName.get(i.name_canonical);
        const rentalDays = rev?.totalDays ?? 0;
        const utilizationPct =
          LOOKBACK_DAYS > 0
            ? Math.round((rentalDays / LOOKBACK_DAYS) * 10000) / 100
            : 0;

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

    const payload = wrapSnapshot(data, "convex");
    const sizeBytes = JSON.stringify(payload).length;
    const key = await putAggregateIndex("inventory_overview", payload);
    const durationMs = Date.now() - startMs;

    console.log("snapshot-inventory-overview: complete", {
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
