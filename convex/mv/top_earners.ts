/**
 * MV: top_earners_30d
 *
 * Refresh interval: every 15 min. Heavier compute (joins items × reservations)
 * and tolerates moderate staleness — earnings change slowly over a 30-day window.
 *
 * For each item: gross/net 30d, rental count, 7-day utilisation %.
 * Top 20 per account by gross.
 *
 * ── Shared-collect entry point ────────────────────────────────────────────
 * `computeTopEarners(reservations, items, ...)` is the pure entry point used
 * by `convex/mv/master.ts` — the shared-collect orchestrator passes its
 * pre-fetched 30-day reservation window + items table so the MVs don't each
 * re-query.
 *
 * ── W2a: Incremental rebuild ─────────────────────────────────────────────
 * The cron path is now "skip-when-clean": we still read the windowed slice
 * (already indexed via `by_start_date` — drops ~1767 rows → ~80 rows), but
 * if NO reservation in that slice has mutated since the last `generatedAt`
 * we short-circuit without recomputing or writing.
 *
 * Freshness signal: `reservations.last_polled_at` — bumped by the poller on
 * every upsert, including status/price/date changes. A reservation that
 * "just left the 30-day window" is captured because the window-shrink check
 * compares the persisted MV's last `cutoff` against the new `cutoff`: if it
 * moved, we MUST rebuild even when no row mutated (rows that were inside
 * yesterday may be outside today).
 *
 * `force: true` bypasses both checks (manual recovery / cold start).
 *
 * The aggregation logic itself is unchanged from the full rebuild —
 * delta-merging item rollups against an existing `rows[]` would need a
 * per-item snapshot we don't have. The win is wall-clock + DB-bandwidth on
 * the (common) clean-window case, not in the rebuild path.
 */
import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { getAccountSlugs, upsertSingleton, isoDaysAgo, todayISO, ACCOUNT_ALL } from "./_helpers";
import { OWNER_SHARE } from "./constants";
import { isPaid } from "../order_step_semantics";

type ItemLike = {
  name_canonical: string;
  qty: number;
  aliases?: string[];
};

type ReservationLike = {
  status: string;
  start_date?: string;
  end_date?: string;
  pickup_date?: string;
  account_slug?: string;
  order_step?: string;
  gross_paid_gbp?: number;
  net_to_owner_gbp?: number;
  last_polled_at?: number;
  items?: Array<{ item_name: string }>;
};

export type TopEarnerRow = {
  itemName: string;
  gross30dGbp: number;
  net30dGbp: number;
  rentalCount: number;
  utilizationPct: number;
};

export type TopEarnersAccountRow = {
  account: string;
  generatedAt: number;
  rows: TopEarnerRow[];
};

/**
 * Pure aggregation — extracted so the parity test can exercise it without
 * a Convex db. Identical math to the legacy in-mutation logic.
 */
export function computeTopEarnersForAccount(args: {
  account: string;
  reservations: ReservationLike[];
  items: ItemLike[];
  today: string;
  cutoff: string;
}): TopEarnerRow[] {
  const { account, reservations, items, today, cutoff } = args;

  const capacityByName = new Map<string, number>();
  for (const it of items) {
    capacityByName.set(it.name_canonical, it.qty);
    for (const alias of it.aliases ?? []) {
      if (!capacityByName.has(alias)) capacityByName.set(alias, it.qty);
    }
  }
  const scoped = account === ACCOUNT_ALL
    ? reservations
    : reservations.filter((r) => r.account_slug === account);

  // REVENUE-SUM CANON (order_step_semantics.ts): item rankings reflect
  // realised earnings only. APPROVED / FUNDS_RESERVED rows have poller-
  // populated gross_paid_gbp but the renter hasn't funded escrow — they
  // would inflate the ranking with would-pay money. Past-dated unpaid
  // rows can already exist in the 30d window today (audit 2026-05-23:
  // £1462 across 17 rows). v1-imported rows have no order_step but
  // trustworthy status="completed" — accept via the v1-legacy escape
  // hatch (mirrors isPaidWithV1Legacy in predicates.ts).
  const isRealisedRow = (r: ReservationLike): boolean => {
    if (r.order_step) return isPaid(r.order_step);
    return r.status === "confirmed" || r.status === "completed";
  };
  const earned = scoped.filter((r) => {
    if (r.status === "cancelled" || r.status === "declined") return false;
    if (!isRealisedRow(r)) return false;
    const d = r.pickup_date ?? r.start_date;
    return d !== undefined && d >= cutoff && d <= today;
  });

  type Agg = { gross: number; net: number; count: number; rentDays: number };
  const agg = new Map<string, Agg>();
  for (const r of earned) {
    const itemCount = (r.items ?? []).length || 1;
    const perItemGross = (r.gross_paid_gbp ?? 0) / itemCount;
    const perItemNet =
      r.net_to_owner_gbp !== undefined
        ? r.net_to_owner_gbp / itemCount
        : perItemGross * OWNER_SHARE;
    const startMs = new Date(
      Math.max(new Date(r.start_date ?? cutoff).getTime(), new Date(cutoff).getTime()),
    ).getTime();
    const endMs = new Date(
      Math.min(new Date(r.end_date ?? today).getTime(), new Date(today).getTime()),
    ).getTime();
    const overlapDays = Math.max(0, Math.round((endMs - startMs) / 86_400_000) + 1);

    for (const it of r.items ?? []) {
      const cur = agg.get(it.item_name) ?? { gross: 0, net: 0, count: 0, rentDays: 0 };
      cur.gross += perItemGross;
      cur.net += perItemNet;
      cur.count += 1;
      cur.rentDays += overlapDays;
      agg.set(it.item_name, cur);
    }
  }

  return [...agg.entries()]
    .map(([itemName, a]) => {
      const capacity = capacityByName.get(itemName) ?? 1;
      const utilizationPct = Math.min(
        100,
        Math.round((a.rentDays / Math.max(1, capacity * 30)) * 100),
      );
      return {
        itemName,
        gross30dGbp: Math.round(a.gross * 100) / 100,
        net30dGbp: Math.round(a.net * 100) / 100,
        rentalCount: a.count,
        utilizationPct,
      };
    })
    .sort((a, b) => b.gross30dGbp - a.gross30dGbp)
    .slice(0, 20);
}

/**
 * Decide whether the existing MV is stale (must rebuild) or clean (skip).
 *
 * Stale when ANY of:
 *   - `force`
 *   - no singleton exists yet (cold start)
 *   - the recorded `cutoffISO` doesn't match the current 30-day cutoff
 *   - any windowed reservation has `last_polled_at >= generatedAt`
 *
 * Extracted as a pure function so the parity test can exercise it.
 */
export function shouldRebuildTopEarners(args: {
  force: boolean;
  existing: { generatedAt?: number; cutoffISO?: string } | null;
  currentCutoff: string;
  windowedReservations: ReservationLike[];
}): { rebuild: boolean; reason: string } {
  const { force, existing, currentCutoff, windowedReservations } = args;
  if (force) return { rebuild: true, reason: "force" };
  if (!existing || existing.generatedAt === undefined) {
    return { rebuild: true, reason: "cold_start" };
  }
  if (existing.cutoffISO !== currentCutoff) {
    return { rebuild: true, reason: "window_shifted" };
  }
  const prev = existing.generatedAt;
  for (const r of windowedReservations) {
    if (r.last_polled_at !== undefined && r.last_polled_at >= prev) {
      return { rebuild: true, reason: "row_mutated" };
    }
  }
  return { rebuild: false, reason: "clean" };
}

/**
 * Shared-collect entry point — pure compute over a pre-fetched 30-day
 * reservation window + full items table. Returns one row per account slug.
 * Used by `convex/mv/master.ts` so the orchestrator can amortise the
 * collects across multiple MVs.
 *
 * Does NOT consult any stored singleton — the master pipeline writes
 * unconditionally. For the staleness-aware variant, see `refresh` /
 * `refreshOne` below.
 */
export function computeTopEarners(args: {
  reservations: ReservationLike[];
  items: ItemLike[];
  targetAccount?: string;
  generatedAt?: number;
}): TopEarnersAccountRow[] {
  const { reservations, items, targetAccount } = args;
  const generatedAt = args.generatedAt ?? Date.now();
  const today = todayISO();
  const cutoff = isoDaysAgo(30);
  const targets = targetAccount ? [targetAccount, ACCOUNT_ALL] : getAccountSlugs();
  return targets.map((account) => ({
    account,
    generatedAt,
    rows: computeTopEarnersForAccount({ account, reservations, items, today, cutoff }),
  }));
}

async function recomputeForAccount(
  ctx: MutationCtx,
  account: string,
  startedAt: number,
  reservations: ReservationLike[],
  items: ItemLike[],
  today: string,
  cutoff: string,
): Promise<void> {
  const rows = computeTopEarnersForAccount({ account, reservations, items, today, cutoff });
  await upsertSingleton(ctx, "top_earners_30d", account, {
    generatedAt: startedAt,
    rows,
    cutoffISO: cutoff,
  });
}

export const refresh = internalMutation({
  args: {
    account: v.optional(v.string()),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, { account, force }) => {
    const startedAt = Date.now();
    const today = todayISO();
    const cutoff = isoDaysAgo(30);
    const reservations = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
      .collect();

    const targets = account ? [account, ACCOUNT_ALL] : getAccountSlugs();

    const existingByAccount = new Map<string, { generatedAt?: number; cutoffISO?: string } | null>();
    for (const acc of targets) {
      const existing = await ctx.db
        .query("top_earners_30d")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .withIndex("by_account" as any, (q) => q.eq("account", acc))
        .first();
      existingByAccount.set(acc, existing as { generatedAt?: number; cutoffISO?: string } | null);
    }
    const accountsNeedingRebuild = targets.filter((acc) => {
      const decision = shouldRebuildTopEarners({
        force: force ?? false,
        existing: existingByAccount.get(acc) ?? null,
        currentCutoff: cutoff,
        windowedReservations: acc === ACCOUNT_ALL
          ? reservations
          : reservations.filter((r) => r.account_slug === acc),
      });
      return decision.rebuild;
    });

    if (accountsNeedingRebuild.length === 0) {
      return {
        ok: true,
        rowsAffected: 0,
        durationMs: Date.now() - startedAt,
        skipped: true,
        reason: "clean",
      };
    }

    const items = await ctx.db.query("items").collect();
    let totalAffected = 0;
    for (const acc of accountsNeedingRebuild) {
      await recomputeForAccount(ctx, acc, startedAt, reservations, items, today, cutoff);
      totalAffected += 1;
    }
    return { ok: true, rowsAffected: totalAffected, durationMs: Date.now() - startedAt };
  },
});

/**
 * Wave 4 — single-account variant. Also refreshes the `"all"` aggregate.
 * Honors the same incremental skip path as `refresh`.
 */
export const refreshOne = internalMutation({
  args: {
    account: v.string(),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, { account, force }) => {
    const startedAt = Date.now();
    const today = todayISO();
    const cutoff = isoDaysAgo(30);
    const reservations = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
      .collect();

    const targets = [account, ACCOUNT_ALL];
    const existingByAccount = new Map<string, { generatedAt?: number; cutoffISO?: string } | null>();
    for (const acc of targets) {
      const existing = await ctx.db
        .query("top_earners_30d")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .withIndex("by_account" as any, (q) => q.eq("account", acc))
        .first();
      existingByAccount.set(acc, existing as { generatedAt?: number; cutoffISO?: string } | null);
    }
    const accountsNeedingRebuild = targets.filter((acc) => {
      const decision = shouldRebuildTopEarners({
        force: force ?? false,
        existing: existingByAccount.get(acc) ?? null,
        currentCutoff: cutoff,
        windowedReservations: acc === ACCOUNT_ALL
          ? reservations
          : reservations.filter((r) => r.account_slug === acc),
      });
      return decision.rebuild;
    });

    if (accountsNeedingRebuild.length === 0) {
      return {
        ok: true,
        rowsAffected: 0,
        durationMs: Date.now() - startedAt,
        skipped: true,
        reason: "clean",
      };
    }

    const items = await ctx.db.query("items").collect();
    for (const acc of accountsNeedingRebuild) {
      await recomputeForAccount(ctx, acc, startedAt, reservations, items, today, cutoff);
    }
    return { ok: true, rowsAffected: accountsNeedingRebuild.length, durationMs: Date.now() - startedAt };
  },
});

export const get = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? ACCOUNT_ALL;
    return await ctx.db
      .query("top_earners_30d")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
  },
});
