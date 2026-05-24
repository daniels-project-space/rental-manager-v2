/**
 * MV: daily_briefing
 *
 * Refresh interval: every 5 min (most-stale-sensitive — drives chat
 * "what happened today" answers). One row per account slug.
 *
 * Computes today's earnings, active rentals, pending requests, overdue
 * returns, top 3 items today, and a pre-rendered narrative.
 *
 * Reuses denormalised reservation fields — never recomputes platform fees;
 * trusts `gross_paid_gbp` / `net_to_owner_gbp` from poller.
 *
 * ── Shared-collect entry point ────────────────────────────────────────────
 * `computeDailyBriefing(reservations, ...)` is the pure entry point used by
 * `convex/mv/master.ts` — the shared-collect orchestrator passes its
 * pre-fetched 90-day reservation window so the MVs don't each re-query.
 *
 * ── W2a: Incremental rebuild ─────────────────────────────────────────────
 * The daily_briefing buckets (today's earnings, active rentals, pending,
 * overdue, top items today) are not easily delta-merged against a stored
 * `rows[]` because they're flat rolled-up scalars without per-reservation
 * provenance. The incremental form is therefore **skip-when-clean**:
 *
 *   - Read existing singleton's `generatedAt` + recorded `cutoffISO`
 *   - If `force=false`, the window cutoff is unchanged, AND no windowed
 *     reservation has `last_polled_at >= generatedAt`, return without
 *     writing.
 *   - Else: full rebuild as before.
 *
 * Notes on date-rollover: `todayISO()` is part of the cutoff (cutoff =
 * today - 90d). When the date rolls over the cutoff changes, forcing a
 * rebuild — which is the desired behavior (a new "today" means
 * `todayEarningsGbp` resets).
 *
 * `force: true` bypasses both checks.
 */
import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { getAccountSlugs, upsertSingleton, todayISO, isoDaysAgo, ACCOUNT_ALL } from "./_helpers";
import { isPaid } from "../order_step_semantics";

type ItemTotal = { name: string; gbp: number; count: number };

type ReservationLike = {
  status: string;
  start_date?: string;
  end_date?: string;
  pickup_date?: string;
  account_slug?: string;
  order_step?: string;
  gross_paid_gbp?: number;
  last_polled_at?: number;
  items?: Array<{ item_name: string }>;
};

export type BriefingForAccount = {
  todayEarningsGbp: number;
  activeRentalsCount: number;
  pendingRequestsCount: number;
  overdueReturnsCount: number;
  topItemsToday: ItemTotal[];
  summary: string;
};

export type DailyBriefingAccountRow = BriefingForAccount & {
  account: string;
  generatedAt: number;
};

/**
 * Pure aggregation — extracted so the parity test can exercise it without
 * a Convex db.
 */
export function computeBriefingForAccount(args: {
  account: string;
  reservations: ReservationLike[];
  today: string;
}): BriefingForAccount {
  const { account, reservations, today } = args;
  const scoped = account === ACCOUNT_ALL ? reservations : reservations.filter((r) => r.account_slug === account);

  const effectiveDate = (r: { start_date?: string; pickup_date?: string }) =>
    r.pickup_date ?? r.start_date;

  // REVENUE-SUM CANON (order_step_semantics.ts): today's earnings count
  // only realised cash. APPROVED / FUNDS_RESERVED rows carry poller-
  // populated gross_paid_gbp but the renter hasn't funded escrow — they
  // would inflate "Today: £X from N rentals" with would-pay money. The
  // dated-today guard does NOT block them on its own (audit 2026-05-23
  // found 7 unpaid rows summing £450 dated today across both accounts).
  // v1-imported rows have no order_step but trustworthy status="completed"
  // — accept via the v1-legacy escape hatch (mirrors isPaidWithV1Legacy
  // in predicates.ts).
  const isRealisedRow = (r: ReservationLike): boolean => {
    if (r.order_step) return isPaid(r.order_step);
    return r.status === "confirmed" || r.status === "completed";
  };
  const earnedToday = scoped.filter(
    (r) =>
      r.status !== "cancelled" &&
      r.status !== "declined" &&
      isRealisedRow(r) &&
      effectiveDate(r) === today,
  );
  const todayEarningsGbp = earnedToday.reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);

  const confirmed = scoped.filter(
    (r) => r.status === "confirmed" && r.start_date !== undefined && r.end_date !== undefined,
  );
  const activeRentalsCount = confirmed.filter(
    (r) => (r.start_date as string) <= today && (r.end_date as string) >= today,
  ).length;
  const overdueReturnsCount = confirmed.filter((r) => (r.end_date as string) < today).length;
  const pendingRequestsCount = scoped.filter((r) => r.status === "pending_review").length;

  // Top items by gbp earned today
  const itemMap = new Map<string, ItemTotal>();
  for (const r of earnedToday) {
    const itemCount = (r.items ?? []).length || 1;
    const perItemGbp = (r.gross_paid_gbp ?? 0) / itemCount;
    for (const it of r.items ?? []) {
      const existing = itemMap.get(it.item_name);
      if (existing) {
        existing.gbp += perItemGbp;
        existing.count += 1;
      } else {
        itemMap.set(it.item_name, { name: it.item_name, gbp: perItemGbp, count: 1 });
      }
    }
  }
  const topItemsToday = [...itemMap.values()].sort((a, b) => b.gbp - a.gbp).slice(0, 3);

  const summary =
    todayEarningsGbp > 0
      ? `Today: £${todayEarningsGbp.toFixed(0)} from ${earnedToday.length} rental${earnedToday.length === 1 ? "" : "s"}. ` +
        `${activeRentalsCount} active, ${pendingRequestsCount} pending, ${overdueReturnsCount} overdue.`
      : `No earnings today yet. ${activeRentalsCount} active rentals, ${pendingRequestsCount} pending requests` +
        (overdueReturnsCount > 0 ? `, ${overdueReturnsCount} overdue returns.` : ".");

  return {
    todayEarningsGbp,
    activeRentalsCount,
    pendingRequestsCount,
    overdueReturnsCount,
    topItemsToday,
    summary,
  };
}

/**
 * Decide whether the existing daily_briefing singleton must be rebuilt.
 * Stale when ANY of:
 *   - `force`
 *   - no singleton exists yet (cold start)
 *   - recorded `cutoffISO` differs from current 90-day cutoff (window
 *     shifted — also captures date rollover since cutoff = today-90d)
 *   - any windowed reservation has `last_polled_at >= generatedAt`
 *
 * Extracted as a pure function for the parity test.
 */
export function shouldRebuildBriefing(args: {
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
 * Shared-collect entry point — pure compute over a pre-fetched 90-day
 * reservation window. Returns one row per account slug. Used by
 * `convex/mv/master.ts` so the orchestrator can amortise the reservation
 * collect across multiple MVs.
 *
 * Does NOT consult any stored singleton — the master pipeline writes
 * unconditionally. For the staleness-aware variant, see `refresh` /
 * `refreshOne` below.
 */
export function computeDailyBriefing(args: {
  reservations: ReservationLike[];
  targetAccount?: string;
  generatedAt?: number;
}): DailyBriefingAccountRow[] {
  const { reservations, targetAccount } = args;
  const generatedAt = args.generatedAt ?? Date.now();
  const today = todayISO();
  const targets = targetAccount ? [targetAccount, ACCOUNT_ALL] : getAccountSlugs();
  return targets.map((account) => ({
    account,
    generatedAt,
    ...computeBriefingForAccount({ account, reservations, today }),
  }));
}

/**
 * Internal mutation — runs the refresh. Incremental by default; pass
 * `force: true` to bypass the skip-when-clean check.
 */
export const refresh = internalMutation({
  args: {
    account: v.optional(v.string()),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, { account, force }) => {
    const startedAt = Date.now();
    const today = todayISO();
    // 90-day rolling window. daily_briefing reports today's earnings +
    // active rentals (start_date<=today<=end_date) + 'this month' counters.
    // Anything older than 90 days can't appear in those buckets. Indexed
    // read drops ~1767 rows → ~200 rows per refresh.
    const cutoff = isoDaysAgo(90);
    const reservations = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
      .collect();

    const targets = account ? [account, ACCOUNT_ALL] : getAccountSlugs();

    const existingByAccount = new Map<string, { generatedAt?: number; cutoffISO?: string } | null>();
    for (const acc of targets) {
      const existing = await ctx.db
        .query("daily_briefing")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .withIndex("by_account" as any, (q) => q.eq("account", acc))
        .first();
      existingByAccount.set(acc, existing as { generatedAt?: number; cutoffISO?: string } | null);
    }
    const accountsNeedingRebuild = targets.filter((acc) => {
      const decision = shouldRebuildBriefing({
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

    let rowsAffected = 0;
    for (const acc of accountsNeedingRebuild) {
      const computed = computeBriefingForAccount({ account: acc, reservations, today });
      await upsertSingleton(ctx, "daily_briefing", acc, {
        generatedAt: startedAt,
        cutoffISO: cutoff,
        ...computed,
      });
      rowsAffected += 1;
    }

    return { ok: true, rowsAffected, durationMs: Date.now() - startedAt };
  },
});

/**
 * Wave 4 — single-account refresh entry point. Recomputes the targeted
 * account row PLUS the cross-account `"all"` row (changing one account
 * always shifts the aggregate). Honors the same incremental skip path.
 */
export const refreshOne = internalMutation({
  args: {
    account: v.string(),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, { account, force }) => {
    const startedAt = Date.now();
    const today = todayISO();
    const cutoff = isoDaysAgo(90);
    const reservations = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
      .collect();

    const targets = [account, ACCOUNT_ALL];
    const existingByAccount = new Map<string, { generatedAt?: number; cutoffISO?: string } | null>();
    for (const acc of targets) {
      const existing = await ctx.db
        .query("daily_briefing")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .withIndex("by_account" as any, (q) => q.eq("account", acc))
        .first();
      existingByAccount.set(acc, existing as { generatedAt?: number; cutoffISO?: string } | null);
    }
    const accountsNeedingRebuild = targets.filter((acc) => {
      const decision = shouldRebuildBriefing({
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

    let rowsAffected = 0;
    for (const acc of accountsNeedingRebuild) {
      const computed = computeBriefingForAccount({ account: acc, reservations, today });
      await upsertSingleton(ctx, "daily_briefing", acc, {
        generatedAt: startedAt,
        cutoffISO: cutoff,
        ...computed,
      });
      rowsAffected += 1;
    }
    return { ok: true, rowsAffected, durationMs: Date.now() - startedAt };
  },
});

/**
 * Public query — read the latest singleton row for an account.
 * Falls back to `"all"` if no account passed.
 */
export const get = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? ACCOUNT_ALL;
    return await ctx.db
      .query("daily_briefing")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
  },
});
