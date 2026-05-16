/**
 * Trigger.dev scheduled task: snapshot top renters to R2.
 *
 * Runs every 6 hours. Reads in parallel:
 *   - intel.getTopSpenders (90-day window, up to 50)
 *   - R2 by_renter lifetime aggregate index
 *
 * Merges both sources, dedupes by renterId, caps at top 100 by gross.
 * R2 key: cold/v1/indexes/top_renters.json
 */
import { schedules, logger } from "@trigger.dev/sdk/v3";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import {
  wrapSnapshot,
  putAggregateIndex,
  getAggregateIndex,
} from "../lib/r2-cold-storage";

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "";

const LOOKBACK_DAYS = 90;
const LIMIT_90D = 50;
const OUTPUT_CAP = 100;
const NET_FALLBACK_RATIO = 0.64;

// Shape returned by intel.getTopSpenders
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

// Shape stored in R2 by_renter index (keyed by renter_name string)
interface ByRenterEntry {
  totalGross: number;
  rentalCount: number;
  firstDate?: string;
  lastDate?: string;
  // optional fields that may have been added by later writers
  totalNet?: number;
  email?: string;
  displayName?: string;
}

type ByRenterIndex = Record<string, ByRenterEntry>;

// Output row shape
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

export const snapshotTopRentersTask = schedules.task({
  id: "snapshot-top-renters",
  cron: "0 */6 * * *",
  run: async () => {
    if (process.env.SNAPSHOTS_VIA_CONVEX === "1") {
      logger.info("SNAPSHOTS_VIA_CONVEX=1, deferring to Convex internalAction");
      return { skipped: true, reason: "convex-action" };
    }
    const startedAt = Date.now();
    logger.info("snapshot-top-renters: starting");

    const convex = new ConvexHttpClient(CONVEX_URL);

    // ── Parallel fetch ────────────────────────────────────────────────────
    let spenders90d: TopSpendersResult;
    let byRenterLifetime: ByRenterIndex | null;

    try {
      [spenders90d, byRenterLifetime] = await Promise.all([
        convex.query(api.intel.getTopSpenders, {
          days: LOOKBACK_DAYS,
          limit: LIMIT_90D,
        }) as Promise<TopSpendersResult>,
        getAggregateIndex<ByRenterIndex>("by_renter"),
      ]);
    } catch (err) {
      logger.error("snapshot-top-renters: fetch failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const lifetime = byRenterLifetime ?? {};

    // ── Merge ─────────────────────────────────────────────────────────────
    // Primary map keyed by renterId (non-null) or displayName (fallback)
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

    // Pass 2: lifetime-only rows (present in by_renter but not in 90d window)
    for (const [nameKey, entry] of Object.entries(lifetime)) {
      // Attempt to match an existing row by display name
      const normKey = nameKey.trim().toLowerCase();
      // Check if already covered by a 90d row (by name fallback key)
      if (merged.has(normKey)) continue;
      // Also check if any 90d row has a matching displayName (id-keyed rows)
      const alreadyCovered = Array.from(merged.values()).some(
        (row) => row.displayName.trim().toLowerCase() === normKey,
      );
      if (alreadyCovered) continue;

      const gross = entry.totalGross ?? 0;
      const net = entry.totalNet ?? gross * NET_FALLBACK_RATIO;
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

    // Pass 3: for id-keyed 90d rows missing email/name, try lifetime lookup
    for (const [key, row] of merged.entries()) {
      if (row.email && row.displayName) continue;
      // Try lookup by display name in lifetime
      const normName = row.displayName.trim().toLowerCase();
      const lifetimeEntry = lifetime[normName] ?? lifetime[row.displayName];
      if (lifetimeEntry) {
        merged.set(key, {
          ...row,
          email: row.email ?? lifetimeEntry.email ?? null,
          displayName: row.displayName || lifetimeEntry.displayName || row.displayName,
        });
      }
    }

    // ── Sort + cap ────────────────────────────────────────────────────────
    const rows: TopRenterRow[] = Array.from(merged.values())
      .sort((a, b) => b.grossGbp - a.grossGbp)
      .slice(0, OUTPUT_CAP);

    // ── Write ─────────────────────────────────────────────────────────────
    const data: TopRentersData = { lookbackDays: LOOKBACK_DAYS, rows };
    const payload = wrapSnapshot(data);
    const payloadBytes = JSON.stringify(payload).length;

    try {
      await putAggregateIndex("top_renters", payload);
    } catch (err) {
      logger.error("snapshot-top-renters: R2 write failed", {
        error: err instanceof Error ? err.message : String(err),
        rowCount: rows.length,
        payloadBytes,
      });
      throw err;
    }

    const durationMs = Date.now() - startedAt;
    logger.info("snapshot-top-renters: done", {
      rowCount: rows.length,
      payloadBytes,
      durationMs,
    });
  },
});
