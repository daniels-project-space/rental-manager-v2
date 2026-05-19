/**
 * Phase 5b backfill — patches Phase 5a's `weekly_metrics` rows with the
 * advanced metric fields owned by 5b:
 *
 *   capacity_denied_count / voluntary_denied_count / marketing_only_denied_count
 *   capacity_denied_estimated_gbp / voluntary_… / marketing_only_…
 *   unique_renters / repeat_renter_count / new_renter_count
 *   avg_response_time_minutes
 *   top_co_rented_canonicals
 *   substitutes_booked_after_denial
 *
 * Behaviour:
 *   - Reads the 5a-created rows by index `by_week_account_granularity` and
 *     patches them in-place. If 5a hasn't created a row yet, the slice is
 *     skipped and reported.
 *   - Idempotent: re-runs overwrite the same fields with fresh values.
 *   - Batched per `(start_week, end_week)` chunk to stay under Convex's
 *     action time/read limits.
 *   - Optional `accounts` arg to scope to a single slug.
 *
 * Cron entry (crons.ts) calls `backfillAdvancedBatch({})` weekly to refresh
 * the just-finished week.
 */

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  buildCommitmentMap,
  diagnoseDenialCapacity,
  isCompletedCommitting,
} from "./lib/capacity_gap";
import {
  computeRenterMetrics,
  computeAvgResponseTime,
  groupMessagesByThread,
} from "./lib/customer_metrics";
import {
  computeCoRentedPairs,
  computeSubstitutionsAfterDenial,
} from "./lib/co_occurrence";

// ────────────────────────────────────────────────────────────────────────────
// Week-boundary helpers (ISO Monday-anchored).
// ────────────────────────────────────────────────────────────────────────────

function weekStartOf(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const delta = (dow + 6) % 7; // Monday offset
  d.setUTCDate(d.getUTCDate() - delta);
  return d.toISOString().slice(0, 10);
}

function weekEndOf(weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

function addWeeks(weekStart: string, n: number): string {
  const d = new Date(weekStart + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────────────
// Internal queries — fetched in chunks by the action.
// ────────────────────────────────────────────────────────────────────────────

export const _listAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("accounts").collect();
    return rows.map((a) => a.slug);
  },
});

export const _firstResWeek = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Earliest start_date among non-obsolete reservations — the floor we
    // backfill back to.
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_start_date")
      .order("asc")
      .take(50);
    for (const r of rows) {
      if (r.start_date) return r.start_date;
    }
    return null;
  },
});

/**
 * Fetch the slice of data needed to compute a single (week × account)'s
 * 5b metrics. Returns:
 *   - reservationsInWeek      : start_date inside [week_start, week_end]
 *   - allHistoryForRenters    : every reservation up to week_end (for
 *                                first-rental anchoring + substitution window)
 *   - completedCovering       : completed/confirmed rentals whose
 *                                [start_date, end_date] overlaps the week
 *                                (for capacity commitment map)
 *   - messagesByThread        : grouped hygglo_messages for the threads in
 *                                reservationsInWeek
 *   - priceByName             : pricing_catalog lookup
 *   - itemRows                : items (qty, is_marketing_only, kind)
 */
export const _fetchWeekSlice = internalQuery({
  args: {
    account_slug: v.string(),
    week_start: v.string(),
    week_end: v.string(),
  },
  handler: async (ctx, { account_slug, week_start, week_end }) => {
    // 1. reservationsInWeek
    const allInRange = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", week_start))
      .collect();
    const reservationsInWeek = allInRange.filter(
      (r) =>
        r.account_slug === account_slug &&
        r.start_date &&
        r.start_date >= week_start &&
        r.start_date <= week_end,
    );

    // 2. allHistoryForRenters — anchor up to week_end (substitution window
    //    extends 60d forward, so we also need rentals after week_end).
    const substitutionLimit = addDaysISO(week_end, 60);
    const allHistoryForRenters = await ctx.db
      .query("reservations")
      .withIndex("by_account_slug", (q) => q.eq("account_slug", account_slug))
      .collect();
    const allHistoryBounded = allHistoryForRenters.filter(
      (r) => r.start_date && r.start_date <= substitutionLimit,
    );

    // 3. completedCovering — confirmed/completed rentals whose date range
    //    overlaps [week_start, week_end]. We include the +30d window since
    //    expandDateRange caps at 31 days; this keeps the commitment map
    //    accurate even for cross-week rentals.
    const completedCovering = allHistoryBounded.filter(
      (r) =>
        isCompletedCommitting(r) &&
        r.start_date &&
        r.end_date &&
        // overlap test: rental.start <= weekEnd && rental.end >= weekStart
        r.start_date <= week_end &&
        r.end_date >= week_start,
    );

    // 4. messages for threads in reservationsInWeek
    const threadIds = new Set<string>();
    for (const r of reservationsInWeek) {
      if (r.hygglo_order_id) threadIds.add(r.hygglo_order_id);
    }
    const messagesArr: Array<Doc<"hygglo_messages">> = [];
    for (const tid of threadIds) {
      const msgs = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_thread", (q) => q.eq("thread_id", tid))
        .collect();
      for (const m of msgs) messagesArr.push(m);
    }

    // 5. pricing catalog (small table)
    const pricing = await ctx.db.query("pricing_catalog").collect();
    const priceByName = new Map<string, number>(
      pricing.map((p) => [p.item_name_canonical, p.daily_price_min] as const),
    );

    // 6. items table
    const items = await ctx.db.query("items").collect();

    return {
      reservationsInWeek,
      allHistoryBounded,
      completedCovering,
      messagesArr,
      pricingPairs: Array.from(priceByName.entries()),
      items,
    };
  },
});

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────────────
// Patch mutations — keyed by index lookup.
// ────────────────────────────────────────────────────────────────────────────

export const _patchGlobalRow = internalMutation({
  args: {
    week_start: v.string(),
    account_slug: v.string(),
    capacity_denied_count: v.number(),
    voluntary_denied_count: v.number(),
    marketing_only_denied_count: v.number(),
    capacity_denied_estimated_gbp: v.number(),
    voluntary_denied_estimated_gbp: v.number(),
    marketing_only_denied_estimated_gbp: v.number(),
    // Phase 5c — split out of voluntary, not double-counted.
    below_minimum_threshold_denied_count: v.number(),
    below_minimum_threshold_denied_estimated_gbp: v.number(),
    unique_renters: v.number(),
    repeat_renter_count: v.number(),
    new_renter_count: v.number(),
    avg_response_time_minutes: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("weekly_metrics")
      .withIndex("by_week_account_granularity", (q) =>
        q
          .eq("week_start", args.week_start)
          .eq("account_slug", args.account_slug)
          .eq("granularity", "global"),
      )
      .first();
    if (!row) return { ok: false, reason: "no_5a_row" };
    const { week_start: _w, account_slug: _a, ...patch } = args;
    await ctx.db.patch(row._id, { ...patch, computed_at: Date.now() });
    return { ok: true };
  },
});

export const _patchItemRow = internalMutation({
  args: {
    week_start: v.string(),
    account_slug: v.string(),
    item_id: v.id("items"),
    capacity_denied_count: v.number(),
    voluntary_denied_count: v.number(),
    marketing_only_denied_count: v.number(),
    capacity_denied_estimated_gbp: v.number(),
    voluntary_denied_estimated_gbp: v.number(),
    marketing_only_denied_estimated_gbp: v.number(),
    // Phase 5c — split out of voluntary, not double-counted.
    below_minimum_threshold_denied_count: v.number(),
    below_minimum_threshold_denied_estimated_gbp: v.number(),
    top_co_rented_canonicals: v.array(v.string()),
    substitutes_booked_after_denial: v.array(
      v.object({ canonical_name: v.string(), count: v.number() }),
    ),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("weekly_metrics")
      .withIndex("by_week_item", (q) =>
        q.eq("week_start", args.week_start).eq("item_id", args.item_id),
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("account_slug"), args.account_slug),
          q.eq(q.field("granularity"), "item"),
        ),
      )
      .first();
    if (!row) return { ok: false, reason: "no_5a_row" };
    const { week_start: _w, account_slug: _a, item_id: _i, ...patch } = args;
    await ctx.db.patch(row._id, { ...patch, computed_at: Date.now() });
    return { ok: true };
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Top-level action: process one week per call, returns next_week pointer.
// ────────────────────────────────────────────────────────────────────────────

export const backfillAdvancedBatch = action({
  args: {
    start_week: v.optional(v.string()),
    end_week: v.optional(v.string()),
    accounts: v.optional(v.array(v.string())),
    weeks_per_batch: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { start_week, end_week, accounts, weeks_per_batch },
  ): Promise<{
    weeks_processed: number;
    next_week: string | null;
    rows_patched_global: number;
    rows_patched_item: number;
    skipped_no_5a_row: number;
    accounts_processed: string[];
  }> => {
    const limit = Math.max(1, weeks_per_batch ?? 1);

    // Resolve start_week — explicit > floor from data.
    let cursor: string;
    if (start_week) {
      cursor = weekStartOf(start_week);
    } else {
      const earliest: string | null = await ctx.runQuery(
        internal.admin_backfill_weekly_metrics_5b._firstResWeek,
        {},
      );
      if (!earliest) {
        return {
          weeks_processed: 0,
          next_week: null,
          rows_patched_global: 0,
          rows_patched_item: 0,
          skipped_no_5a_row: 0,
          accounts_processed: [],
        };
      }
      cursor = weekStartOf(earliest);
    }

    // Resolve end_week — default = last fully-finished week (today-7).
    const todayISO = new Date().toISOString().slice(0, 10);
    const defaultEnd = weekStartOf(addDaysISO(todayISO, -7));
    const stop = end_week ? weekStartOf(end_week) : defaultEnd;

    const slugs: string[] =
      accounts && accounts.length > 0
        ? accounts
        : await ctx.runQuery(
            internal.admin_backfill_weekly_metrics_5b._listAccounts,
            {},
          );

    let weeks_processed = 0;
    let rows_patched_global = 0;
    let rows_patched_item = 0;
    let skipped_no_5a_row = 0;

    while (cursor <= stop && weeks_processed < limit) {
      const weekStart = cursor;
      const weekEnd = weekEndOf(weekStart);

      for (const slug of slugs) {
        const slice = await ctx.runQuery(
          internal.admin_backfill_weekly_metrics_5b._fetchWeekSlice,
          { account_slug: slug, week_start: weekStart, week_end: weekEnd },
        );

        // Build resources from slice
        const priceByName = new Map<string, number>(slice.pricingPairs as any);
        const itemById = new Map<string, Doc<"items">>(
          slice.items.map((it: Doc<"items">) => [String(it._id), it]),
        );

        // Commitment map from completedCovering
        const commitMap = buildCommitmentMap(slice.completedCovering as any);

        // Stub ctx for diagnoseDenialCapacity (avoids per-row db.get)
        const stubCtx = {
          db: { get: async (id: any) => itemById.get(String(id)) ?? null },
        } as any;

        // ── Per-row counters (global) ────────────────────────────
        const denials = (slice.reservationsInWeek as Array<Doc<"reservations">>).filter(
          (r) => {
            if (!r.is_obsolete) return false;
            const actor = r.reclassified_outcome ?? r.denial_actor;
            return actor === "owner_denied";
          },
        );

        let capCount = 0,
          volCount = 0,
          mktCount = 0,
          belowMinCount = 0;
        let capGbp = 0,
          volGbp = 0,
          mktGbp = 0,
          belowMinGbp = 0;
        const denialDiagnoses: Array<{
          res_id: string;
          cause: string;
          loss: number;
          items: Array<{ item_id: string; canonical: string; classification: string }>;
        }> = [];

        for (const d of denials) {
          const diag = await diagnoseDenialCapacity(
            stubCtx,
            d,
            commitMap,
            priceByName,
          );
          // count rules. NOTE Phase 5c: voluntary_denied_count/_gbp
          // EXCLUDES rows whose cause is `below_minimum_threshold` — those
          // are bucketed separately so the splits don't double-count.
          if (diag.cause === "capacity" || diag.cause === "mixed") {
            capCount += 1;
            capGbp += diag.estimated_loss_gbp;
          } else if (diag.cause === "voluntary") {
            volCount += 1;
            volGbp += diag.estimated_loss_gbp;
          } else if (diag.cause === "marketing_only") {
            mktCount += 1;
            mktGbp += diag.estimated_loss_gbp;
          } else if (diag.cause === "below_minimum_threshold") {
            belowMinCount += 1;
            belowMinGbp += diag.estimated_loss_gbp;
          }
          denialDiagnoses.push({
            res_id: String(d._id),
            cause: diag.cause,
            loss: diag.estimated_loss_gbp,
            // Phase 5c: when reservation-level cause is
            // `below_minimum_threshold`, propagate that to each item's
            // bucket so the per-item rollup matches the global rollup.
            // Otherwise keep the structural per-item classification.
            items: diag.per_item_diagnosis.map((p) => ({
              item_id: String(p.item_id ?? ""),
              canonical: p.canonical_name,
              classification:
                diag.cause === "below_minimum_threshold" &&
                p.classification === "voluntary"
                  ? "below_minimum_threshold"
                  : p.classification,
            })),
          });
        }

        // ── Renter metrics ───────────────────────────────────────
        const rm = computeRenterMetrics(
          slice.reservationsInWeek as any,
          slice.allHistoryBounded as any,
          weekStart,
        );

        // ── Response time ────────────────────────────────────────
        const byThread = groupMessagesByThread(slice.messagesArr as any);
        const art = computeAvgResponseTime(
          slice.reservationsInWeek as any,
          byThread,
        );

        // ── Patch global row ─────────────────────────────────────
        const patchedGlobal = await ctx.runMutation(
          internal.admin_backfill_weekly_metrics_5b._patchGlobalRow,
          {
            week_start: weekStart,
            account_slug: slug,
            capacity_denied_count: capCount,
            voluntary_denied_count: volCount,
            marketing_only_denied_count: mktCount,
            capacity_denied_estimated_gbp: round2(capGbp),
            voluntary_denied_estimated_gbp: round2(volGbp),
            marketing_only_denied_estimated_gbp: round2(mktGbp),
            below_minimum_threshold_denied_count: belowMinCount,
            below_minimum_threshold_denied_estimated_gbp: round2(belowMinGbp),
            unique_renters: rm.unique_renters,
            repeat_renter_count: rm.repeat_renter_count,
            new_renter_count: rm.new_renter_count,
            avg_response_time_minutes: round2(art.avg_response_time_minutes),
          },
        );
        if (patchedGlobal.ok) rows_patched_global += 1;
        else skipped_no_5a_row += 1;

        // ── Per-item rows ────────────────────────────────────────
        // Item set = items that appear in any denial in-week OR any rental
        // in-week (for co-occurrence). Reduces patches to items 5a would
        // have created a row for.
        const itemSet = new Set<string>();
        for (const r of slice.reservationsInWeek as Array<Doc<"reservations">>) {
          for (const x of r.expanded_items ?? []) {
            if (x.item_id) itemSet.add(String(x.item_id));
          }
        }
        for (const d of denials) {
          for (const x of d.expanded_items ?? []) {
            if (x.item_id) itemSet.add(String(x.item_id));
          }
        }

        // Per-item denial counters from denialDiagnoses
        const perItemCap = new Map<string, number>();
        const perItemVol = new Map<string, number>();
        const perItemMkt = new Map<string, number>();
        const perItemBelowMin = new Map<string, number>();
        const perItemCapGbp = new Map<string, number>();
        const perItemVolGbp = new Map<string, number>();
        const perItemMktGbp = new Map<string, number>();
        const perItemBelowMinGbp = new Map<string, number>();
        for (const dx of denialDiagnoses) {
          const n = dx.items.length || 1;
          const share = dx.loss / n;
          for (const it of dx.items) {
            if (!it.item_id) continue;
            itemSet.add(it.item_id);
            if (it.classification === "capacity_gap") {
              perItemCap.set(it.item_id, (perItemCap.get(it.item_id) ?? 0) + 1);
              perItemCapGbp.set(
                it.item_id,
                (perItemCapGbp.get(it.item_id) ?? 0) + share,
              );
            } else if (it.classification === "voluntary") {
              perItemVol.set(it.item_id, (perItemVol.get(it.item_id) ?? 0) + 1);
              perItemVolGbp.set(
                it.item_id,
                (perItemVolGbp.get(it.item_id) ?? 0) + share,
              );
            } else if (it.classification === "marketing_only") {
              perItemMkt.set(it.item_id, (perItemMkt.get(it.item_id) ?? 0) + 1);
              perItemMktGbp.set(
                it.item_id,
                (perItemMktGbp.get(it.item_id) ?? 0) + share,
              );
            } else if (it.classification === "below_minimum_threshold") {
              perItemBelowMin.set(
                it.item_id,
                (perItemBelowMin.get(it.item_id) ?? 0) + 1,
              );
              perItemBelowMinGbp.set(
                it.item_id,
                (perItemBelowMinGbp.get(it.item_id) ?? 0) + share,
              );
            }
          }
        }

        // Substitution map (computed once, looked up per item)
        const subMap = computeSubstitutionsAfterDenial(
          denials,
          slice.allHistoryBounded as any,
          60,
        );

        for (const idStr of itemSet) {
          // Co-rented pairs against the slug's history (bounded)
          const coRented = computeCoRentedPairs(
            slice.allHistoryBounded as any,
            idStr as Id<"items">,
            3,
          );
          const subs = (subMap.get(idStr) ?? []).slice(0, 5);

          const patched = await ctx.runMutation(
            internal.admin_backfill_weekly_metrics_5b._patchItemRow,
            {
              week_start: weekStart,
              account_slug: slug,
              item_id: idStr as Id<"items">,
              capacity_denied_count: perItemCap.get(idStr) ?? 0,
              voluntary_denied_count: perItemVol.get(idStr) ?? 0,
              marketing_only_denied_count: perItemMkt.get(idStr) ?? 0,
              capacity_denied_estimated_gbp: round2(
                perItemCapGbp.get(idStr) ?? 0,
              ),
              voluntary_denied_estimated_gbp: round2(
                perItemVolGbp.get(idStr) ?? 0,
              ),
              marketing_only_denied_estimated_gbp: round2(
                perItemMktGbp.get(idStr) ?? 0,
              ),
              below_minimum_threshold_denied_count:
                perItemBelowMin.get(idStr) ?? 0,
              below_minimum_threshold_denied_estimated_gbp: round2(
                perItemBelowMinGbp.get(idStr) ?? 0,
              ),
              top_co_rented_canonicals: coRented.map((c) => c.canonical_name),
              substitutes_booked_after_denial: subs.map((s) => ({
                canonical_name: s.canonical_name,
                count: s.count,
              })),
            },
          );
          if (patched.ok) rows_patched_item += 1;
          else skipped_no_5a_row += 1;
        }
      }

      weeks_processed += 1;
      cursor = addWeeks(weekStart, 1);
    }

    const next_week = cursor <= stop ? cursor : null;

    return {
      weeks_processed,
      next_week,
      rows_patched_global,
      rows_patched_item,
      skipped_no_5a_row,
      accounts_processed: slugs,
    };
  },
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ────────────────────────────────────────────────────────────────────────────
// Sanity-check queries (post-backfill).
// ────────────────────────────────────────────────────────────────────────────

export const topVoluntaryDeniedItems = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const lim = limit ?? 10;
    const rows = await ctx.db
      .query("weekly_metrics")
      .filter((q) => q.eq(q.field("granularity"), "item"))
      .collect();
    const agg = new Map<
      string,
      { canonical: string; count: number; gbp: number }
    >();
    for (const r of rows) {
      if (!r.item_id) continue;
      const key = String(r.item_id);
      const prev = agg.get(key) ?? {
        canonical: r.item_name_canonical ?? "?",
        count: 0,
        gbp: 0,
      };
      prev.count += r.voluntary_denied_count ?? 0;
      prev.gbp += r.voluntary_denied_estimated_gbp ?? 0;
      agg.set(key, prev);
    }
    return Array.from(agg.entries())
      .map(([item_id, v]) => ({ item_id, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, lim);
  },
});

export const topBelowMinimumDeniedItems = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const lim = limit ?? 10;
    const rows = await ctx.db
      .query("weekly_metrics")
      .filter((q) => q.eq(q.field("granularity"), "item"))
      .collect();
    const agg = new Map<
      string,
      { canonical: string; count: number; gbp: number }
    >();
    for (const r of rows) {
      if (!r.item_id) continue;
      const key = String(r.item_id);
      const prev = agg.get(key) ?? {
        canonical: r.item_name_canonical ?? "?",
        count: 0,
        gbp: 0,
      };
      prev.count += r.below_minimum_threshold_denied_count ?? 0;
      prev.gbp += r.below_minimum_threshold_denied_estimated_gbp ?? 0;
      agg.set(key, prev);
    }
    return Array.from(agg.entries())
      .map(([item_id, v]) => ({ item_id, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, lim);
  },
});

export const topCapacityDeniedItems = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const lim = limit ?? 10;
    const rows = await ctx.db
      .query("weekly_metrics")
      .filter((q) => q.eq(q.field("granularity"), "item"))
      .collect();
    const agg = new Map<
      string,
      { canonical: string; count: number; gbp: number }
    >();
    for (const r of rows) {
      if (!r.item_id) continue;
      const key = String(r.item_id);
      const prev = agg.get(key) ?? {
        canonical: r.item_name_canonical ?? "?",
        count: 0,
        gbp: 0,
      };
      prev.count += r.capacity_denied_count ?? 0;
      prev.gbp += r.capacity_denied_estimated_gbp ?? 0;
      agg.set(key, prev);
    }
    return Array.from(agg.entries())
      .map(([item_id, v]) => ({ item_id, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, lim);
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Cron entrypoint — internal wrapper around `backfillAdvancedBatch` so
// crons.ts can use `internal.*` (matches every other cron in this project).
// Refreshes the just-finished week.
// ────────────────────────────────────────────────────────────────────────────

export const cronRefreshLastWeek = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const today = new Date().toISOString().slice(0, 10);
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 7);
    const last = d.toISOString().slice(0, 10);
    await ctx.runAction(
      api.admin_backfill_weekly_metrics_5b.backfillAdvancedBatch,
      { start_week: last, end_week: last, weeks_per_batch: 1 },
    );
  },
});

export const topSubstitutionFlows = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const lim = limit ?? 10;
    const rows = await ctx.db
      .query("weekly_metrics")
      .filter((q) => q.eq(q.field("granularity"), "item"))
      .collect();
    const flows = new Map<string, number>();
    const labelFor = new Map<string, string>();
    for (const r of rows) {
      if (!r.item_id || !r.substitutes_booked_after_denial) continue;
      const fromCanon = r.item_name_canonical ?? String(r.item_id);
      for (const s of r.substitutes_booked_after_denial) {
        const k = `${fromCanon} -> ${s.canonical_name}`;
        flows.set(k, (flows.get(k) ?? 0) + s.count);
        labelFor.set(k, k);
      }
    }
    return Array.from(flows.entries())
      .map(([flow, count]) => ({ flow, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, lim);
  },
});
