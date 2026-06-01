/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Admin Backfill — Phase 5a weekly_metrics
 *
 *  Walks every (week × account × granularity × kind|item) and upserts a row
 *  into `weekly_metrics`. Idempotent: the index
 *  `by_week_account_granularity` is queried first; if a matching row exists,
 *  it is PATCHED. Otherwise INSERTED. Phase 5b will patch its own fields on
 *  the same row without colliding.
 *
 *  Why a mutation, not an action: each batch needs to read reservations
 *  (≤4 weeks × ~2 accounts × ~99 items) and write at most a few thousand
 *  weekly_metrics rows. Convex mutation budget = 8s + 16MB which fits a
 *  small batch easily. The driver loops until `next_week == null`.
 *
 *  Driver:
 *    PAT=…
 *    cd /home/ubuntu/rental-manager-v2
 *    while true; do
 *      OUT=$(CONVEX_OVERRIDE_ACCESS_TOKEN="$PAT" ./node_modules/.bin/convex \
 *        run --prod admin_backfill_weekly_metrics:backfillBatch '{}')
 *      NEXT=$(echo "$OUT" | jq -r '.next_week // "null"')
 *      [ "$NEXT" = "null" ] && break
 *    done
 * ──────────────────────────────────────────────────────────────────────────
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
import type { AttributionContext } from "./lib/revenue_attribution";
import {
  computeCapacityMetrics,
  computePricingMetrics,
  computeRevenueMetrics,
  computeVolumeMetrics,
  isoMondayOf,
  isoSundayFromMonday,
  nextMonday,
  type MetricsFilter,
  type ReservationForMetrics,
  type WeekRange,
} from "./lib/weekly_metrics_compute";

const ALGORITHM_VERSION_DEFAULT = "v1";
const DEFAULT_BATCH_WEEKS = 4;

type AccountSlug = string;

// ──────────────────────────────────────────────────────────────────────────
// Backfill cursor singleton — picks up where it left off across batches.
//
// The pattern is: each batch reads `_cursor:weekly_metrics_backfill`, picks
// the next N weeks starting at `cursor.next_week`, runs them, advances the
// cursor. When the cursor passes `cursor.end_week` it returns next_week:null.
// We store this directly in `audit_log` so we don't have to add another
// table for a piece of housekeeping state.
// ──────────────────────────────────────────────────────────────────────────

const CURSOR_TABLE = "audit_log" as const;
const CURSOR_NOTE_TAG = "phase5a_metrics_backfill_cursor";

type BackfillCursor = {
  next_week: string | null;
  end_week: string;
  accounts: string[];
  algorithm_version: string;
};

async function readCursor(
  ctx: { db: { query: (n: typeof CURSOR_TABLE) => { withIndex: (...args: unknown[]) => unknown } } },
): Promise<BackfillCursor | null> {
  // Use a tagged audit_log row by `note` for cursor — we read it directly.
  const rows = await (ctx.db.query(CURSOR_TABLE) as unknown as {
    filter: (fn: (q: { eq: (...args: unknown[]) => unknown; field: (...args: unknown[]) => unknown }) => unknown) => {
      order: (dir: "asc" | "desc") => { take: (n: number) => Promise<Array<Doc<"audit_log">>> };
    };
  })
    .filter((q) => q.eq(q.field("note"), CURSOR_NOTE_TAG))
    .order("desc")
    .take(1);
  if (!rows.length) return null;
  try {
    const blob = rows[0].source_file;
    if (!blob) return null;
    return JSON.parse(blob) as BackfillCursor;
  } catch {
    return null;
  }
}

async function writeCursor(
  ctx: { db: { insert: (table: "audit_log", doc: Record<string, unknown>) => Promise<unknown> } },
  cursor: BackfillCursor,
): Promise<void> {
  await ctx.db.insert("audit_log", {
    table_name: "weekly_metrics",
    actor: "phase5a_backfill",
    op: "insert",
    count: 0,
    source_file: JSON.stringify(cursor),
    note: CURSOR_NOTE_TAG,
    ts: Date.now(),
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────

function makeAttributionCtx(
  items: ReadonlyArray<Doc<"items">>,
  pricing: ReadonlyArray<Doc<"pricing_catalog">>,
): AttributionContext {
  const itemById = new Map<Id<"items">, Doc<"items">>();
  const itemByCanonical = new Map<string, Doc<"items">>();
  for (const it of items) {
    itemById.set(it._id, it);
    itemByCanonical.set(it.name_canonical, it);
  }
  const priceByName = new Map<string, number>();
  for (const p of pricing) {
    if (p.item_name_canonical && p.daily_price_min != null) {
      priceByName.set(p.item_name_canonical, p.daily_price_min);
    }
  }
  return { itemById, itemByCanonical, priceByName };
}

function metricsAreAllZero(m: {
  revenue_gross_gbp?: number;
  rentals_completed?: number;
  rentals_requested?: number;
  unit_days_rented?: number;
}): boolean {
  return (
    (m.revenue_gross_gbp ?? 0) === 0 &&
    (m.rentals_completed ?? 0) === 0 &&
    (m.rentals_requested ?? 0) === 0 &&
    (m.unit_days_rented ?? 0) === 0
  );
}

// ──────────────────────────────────────────────────────────────────────────
// The core "compute and upsert one row" routine
// ──────────────────────────────────────────────────────────────────────────

type CtxLike = {
  db: {
    query: (table: string) => any;
    insert: (table: string, doc: any) => Promise<any>;
    patch: (id: any, doc: any) => Promise<any>;
  };
};

async function upsertRow(
  ctx: CtxLike,
  args: {
    week: WeekRange;
    account_slug: AccountSlug;
    granularity: "global" | "kind" | "item";
    kind?: string;
    item_id?: Id<"items">;
    item_name_canonical?: string;
    algorithm_version: string;
    reservations: ReservationForMetrics[];
    items: ReadonlyArray<Doc<"items">>;
    itemById: Map<Id<"items">, Doc<"items">>;
    attrCtx: AttributionContext;
  },
  options: { skipIfAllZero: boolean },
): Promise<"inserted" | "patched" | "skipped"> {
  const filter: MetricsFilter =
    args.granularity === "global"
      ? { granularity: "global" }
      : args.granularity === "kind"
        ? { granularity: "kind", kind: args.kind! }
        : { granularity: "item", item_id: args.item_id!, kind: args.kind };

  const revenue = computeRevenueMetrics(args.reservations, args.week, filter, args.attrCtx);
  const volume = computeVolumeMetrics(args.reservations, args.week, filter, args.itemById);
  const capacity = computeCapacityMetrics(
    args.reservations,
    args.week,
    filter,
    args.items,
    args.itemById,
  );
  const pricing = computePricingMetrics(
    args.reservations,
    args.week,
    filter,
    args.attrCtx,
    args.itemById,
  );

  // Existing row?
  const existing = await ctx.db
    .query("weekly_metrics")
    .withIndex("by_week_account_granularity", (q: any) =>
      q.eq("week_start", args.week.week_start)
        .eq("account_slug", args.account_slug)
        .eq("granularity", args.granularity),
    )
    .collect();
  let row: Doc<"weekly_metrics"> | undefined;
  for (const r of existing as Doc<"weekly_metrics">[]) {
    if (args.granularity === "global") {
      row = r;
      break;
    }
    if (args.granularity === "kind" && r.kind === args.kind && r.item_id == null) {
      row = r;
      break;
    }
    if (args.granularity === "item" && r.item_id === args.item_id) {
      row = r;
      break;
    }
  }

  const allZero = metricsAreAllZero({
    revenue_gross_gbp: revenue.revenue_gross_gbp,
    rentals_completed: volume.rentals_completed,
    rentals_requested: volume.rentals_requested,
    unit_days_rented: capacity.unit_days_rented,
  });

  if (options.skipIfAllZero && allZero && !row) {
    return "skipped";
  }

  const patch: Partial<Doc<"weekly_metrics">> = {
    // Phase 5a-owned fields. Phase 5b never touches these.
    revenue_gross_gbp: revenue.revenue_gross_gbp,
    revenue_attributed_gbp: revenue.revenue_attributed_gbp,
    revenue_net_gbp: revenue.revenue_net_gbp,
    rentals_completed: volume.rentals_completed,
    rentals_requested: volume.rentals_requested,
    rentals_owner_denied: volume.rentals_owner_denied,
    rentals_renter_cancelled: volume.rentals_renter_cancelled,
    rentals_renter_ghosted: volume.rentals_renter_ghosted,
    rentals_auto_cancelled: volume.rentals_auto_cancelled,
    unit_days_rented: capacity.unit_days_rented,
    unit_days_capacity: capacity.unit_days_capacity,
    utilization_rate: capacity.utilization_rate,
    avg_daily_price_realized: pricing.avg_daily_price_realized,
    avg_rental_duration_days: pricing.avg_rental_duration_days,
    algorithm_version: args.algorithm_version,
    computed_at: Date.now(),
  };

  if (row) {
    await ctx.db.patch(row._id, patch);
    return "patched";
  }
  await ctx.db.insert("weekly_metrics", {
    week_start: args.week.week_start,
    week_end: args.week.week_end,
    account_slug: args.account_slug,
    granularity: args.granularity,
    kind: args.kind,
    item_id: args.item_id,
    item_name_canonical: args.item_name_canonical,
    ...patch,
  });
  return "inserted";
}

// ──────────────────────────────────────────────────────────────────────────
// Backfill batch — mutation
// ──────────────────────────────────────────────────────────────────────────

export const backfillBatch = mutation({
  args: {
    /** Optional override: start (Monday). If absent, uses cursor or earliest. */
    start_week: v.optional(v.string()),
    /** Optional override: end (Monday). If absent, uses cursor or current. */
    end_week: v.optional(v.string()),
    /** Optional explicit account list. */
    accounts: v.optional(v.array(v.string())),
    /** Bump when methodology changes. */
    algorithm_version: v.optional(v.string()),
    /** Don't actually write. */
    dry_run: v.optional(v.boolean()),
    /** Weeks per batch. Default 4. */
    batch_weeks: v.optional(v.number()),
    /** Reset cursor to start_week (or earliest). */
    reset_cursor: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const algoVersion = args.algorithm_version ?? ALGORITHM_VERSION_DEFAULT;
    const dryRun = args.dry_run === true;
    const batchWeeks = Math.max(1, args.batch_weeks ?? DEFAULT_BATCH_WEEKS);

    // ── Resolve account list
    let accountSlugs: string[];
    if (args.accounts && args.accounts.length) {
      accountSlugs = args.accounts;
    } else {
      const allAccounts = await ctx.db.query("accounts").collect();
      accountSlugs = allAccounts.map((a) => a.slug);
    }

    // ── Resolve cursor / start week
    let cursor = args.reset_cursor === true ? null : await readCursor(ctx as any);
    let startWeek = args.start_week ?? cursor?.next_week ?? null;
    let endWeek = args.end_week ?? cursor?.end_week ?? null;

    if (!startWeek || !endWeek) {
      // Earliest real rental date (start_date), NOT _creationTime: reservations
      // were bulk-imported, so _creationTime clusters at ~May 2026 even though
      // actual start_dates span 12+ months. Keying off _creationTime truncated
      // the trend to ~4 weeks. The by_start_date index, asc, gives the earliest
      // real rental; fall back to _creationTime only if start_date is missing.
      const earliestByStart = await ctx.db
        .query("reservations")
        .withIndex("by_start_date")
        .order("asc")
        .first();
      const earliestStart = earliestByStart?.start_date;
      const earliestMonday = earliestStart
        ? isoMondayOf(new Date(`${earliestStart}T00:00:00Z`))
        : isoMondayOf(new Date(earliestByStart?._creationTime ?? Date.now()));
      startWeek = startWeek ?? earliestMonday;
      endWeek = endWeek ?? isoMondayOf(new Date());
    }

    if (startWeek > endWeek) {
      return {
        weeks_processed: 0,
        rows_written: 0,
        rows_skipped: 0,
        log_run_id: "",
        next_week: null,
      };
    }

    // ── Load global item + pricing snapshot once.
    const allItems = (await ctx.db.query("items").collect()) as Doc<"items">[];
    const allPricing = (await ctx.db.query("pricing_catalog").collect()) as Doc<"pricing_catalog">[];
    const itemsByAccount: Record<string, Doc<"items">[]> = {};
    for (const it of allItems) {
      // items has no account_slug today; share across accounts.
      const slug = (it as any).account_slug ?? "_shared";
      (itemsByAccount[slug] ??= []).push(it);
    }
    const itemById = new Map<Id<"items">, Doc<"items">>();
    const itemByCanonical = new Map<string, Doc<"items">>();
    for (const it of allItems) {
      itemById.set(it._id, it);
      itemByCanonical.set(it.name_canonical, it);
    }
    const attrCtx = makeAttributionCtx(allItems, allPricing);

    // ── Distinct kinds across inventory (skip empties).
    const allKinds = new Set<string>();
    for (const it of allItems) if (it.kind) allKinds.add(it.kind);

    const runId = `phase5a-${Date.now().toString(36)}`;
    const run_started_at = Date.now();

    // ── Process up to batchWeeks weeks
    let weeksProcessed = 0;
    let rowsWritten = 0;
    let rowsSkipped = 0;
    let weekCursor = startWeek;
    let lastError: string | null = null;

    while (weekCursor <= endWeek && weeksProcessed < batchWeeks) {
      const week: WeekRange = {
        week_start: weekCursor,
        week_end: isoSundayFromMonday(weekCursor),
      };

      for (const accountSlug of accountSlugs) {
        const runLogId = dryRun
          ? null
          : await ctx.db.insert("metrics_run_log", {
              run_id: runId,
              started_at: Date.now(),
              week_start: week.week_start,
              account_slug: accountSlug,
              rows_written: 0,
            });

        try {
          // Pull reservations touching this week for this account.
          // Use the start_date index, but widen to ±1 week to catch
          // multi-week rentals that span our window.
          const lookbackStart = (() => {
            const ms = Date.parse(`${week.week_start}T00:00:00Z`) - 30 * 86400000;
            return new Date(ms).toISOString().slice(0, 10);
          })();
          const lookaheadEnd = (() => {
            const ms = Date.parse(`${week.week_end}T00:00:00Z`) + 30 * 86400000;
            return new Date(ms).toISOString().slice(0, 10);
          })();

          const reservationsRaw = (await ctx.db
            .query("reservations")
            .withIndex("by_start_date", (q: any) =>
              q.gte("start_date", lookbackStart).lte("start_date", lookaheadEnd),
            )
            .collect()) as Doc<"reservations">[];
          const reservations: ReservationForMetrics[] = reservationsRaw
            .filter((r) => r.account_slug === accountSlug)
            .map(
              (r): ReservationForMetrics => ({
                _id: r._id,
                account_slug: r.account_slug,
                status: r.status,
                is_obsolete: r.is_obsolete,
                start_date: r.start_date,
                end_date: r.end_date,
                duration_days: r.duration_days,
                gross_paid_gbp: r.gross_paid_gbp,
                net_to_owner_gbp: r.net_to_owner_gbp,
                denial_actor: r.denial_actor,
                reclassified_outcome: r.reclassified_outcome,
                hygglo_system_signal: r.hygglo_system_signal,
                obsolete_reason: r.obsolete_reason,
                expanded_items: r.expanded_items,
                resolved_items: r.resolved_items,
                items: r.items,
              }),
            );

          if (dryRun) {
            // Skip writes entirely; only count target rows.
            weeksProcessed += 1;
            continue;
          }

          let written = 0;

          // 1) Global row
          const g = await upsertRow(
            ctx as any,
            {
              week,
              account_slug: accountSlug,
              granularity: "global",
              algorithm_version: algoVersion,
              reservations,
              items: allItems,
              itemById,
              attrCtx,
            },
            { skipIfAllZero: true },
          );
          if (g === "skipped") rowsSkipped += 1;
          else { written += 1; rowsWritten += 1; }

          // 2) Per-kind rows
          for (const k of allKinds) {
            const res = await upsertRow(
              ctx as any,
              {
                week,
                account_slug: accountSlug,
                granularity: "kind",
                kind: k,
                algorithm_version: algoVersion,
                reservations,
                items: allItems,
                itemById,
                attrCtx,
              },
              { skipIfAllZero: true },
            );
            if (res === "skipped") rowsSkipped += 1;
            else { written += 1; rowsWritten += 1; }
          }

          // 3) Per-item rows
          for (const it of allItems) {
            const res = await upsertRow(
              ctx as any,
              {
                week,
                account_slug: accountSlug,
                granularity: "item",
                kind: it.kind,
                item_id: it._id,
                item_name_canonical: it.name_canonical,
                algorithm_version: algoVersion,
                reservations,
                items: allItems,
                itemById,
                attrCtx,
              },
              { skipIfAllZero: true },
            );
            if (res === "skipped") rowsSkipped += 1;
            else { written += 1; rowsWritten += 1; }
          }

          if (runLogId) {
            await ctx.db.patch(runLogId, {
              finished_at: Date.now(),
              rows_written: written,
            });
          }
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          if (runLogId) {
            await ctx.db.patch(runLogId, {
              finished_at: Date.now(),
              errors: lastError,
            });
          }
        }
      }

      weeksProcessed += 1;
      weekCursor = nextMonday(weekCursor);
    }

    // ── Persist cursor for the next batch
    const nextWeek = weekCursor > endWeek ? null : weekCursor;
    if (!dryRun) {
      await writeCursor(ctx as any, {
        next_week: nextWeek,
        end_week: endWeek,
        accounts: accountSlugs,
        algorithm_version: algoVersion,
      });
    }

    return {
      weeks_processed: weeksProcessed,
      rows_written: rowsWritten,
      rows_skipped: rowsSkipped,
      log_run_id: runId,
      next_week: nextWeek,
      run_started_at,
      run_finished_at: Date.now(),
      error: lastError,
    };
  },
});

// ──────────────────────────────────────────────────────────────────────────
// Pagination-safe FULL backfill orchestrator.
//
// backfillBatch with batch_weeks>1 reads many overlapping ±30d reservation
// windows in ONE mutation and blew past Convex's 16MB per-execution read limit
// on the dense recent data. A single week fits comfortably, so this action
// drives the loop — each iteration is a SEPARATE mutation execution with its
// own read budget — advancing the cursor until the range is done.
//
//   npx convex run admin_backfill_weekly_metrics:backfillAll '{}'
//
// Idempotent + cursor-backed: safe to re-run; it resumes where it left off.
// ──────────────────────────────────────────────────────────────────────────
export const backfillAll = internalAction({
  args: {
    start_week: v.optional(v.string()),
    end_week: v.optional(v.string()),
    /** Safety cap on iterations (one week each). Default 120 (~2.3 years). */
    max_weeks: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ weeks: number; rows_written: number; rows_skipped: number; next_week: string | null }> => {
    const cap = Math.max(1, args.max_weeks ?? 120);
    let weeks = 0;
    let rowsWritten = 0;
    let rowsSkipped = 0;
    let nextWeek: string | null = null;
    for (let i = 0; i < cap; i++) {
      const res = (await ctx.runMutation(api.admin_backfill_weekly_metrics.backfillBatch, {
        batch_weeks: 1,
        ...(i === 0
          ? { reset_cursor: true, start_week: args.start_week, end_week: args.end_week }
          : {}),
      })) as { weeks_processed: number; rows_written: number; rows_skipped: number; next_week: string | null };
      weeks += res.weeks_processed ?? 0;
      rowsWritten += res.rows_written ?? 0;
      rowsSkipped += res.rows_skipped ?? 0;
      nextWeek = res.next_week;
      if (!res.next_week) break;
    }
    return { weeks, rows_written: rowsWritten, rows_skipped: rowsSkipped, next_week: nextWeek };
  },
});

// ──────────────────────────────────────────────────────────────────────────
// Single-week cron entry point. Called every Sunday 23:30 UTC.
// Re-computes the just-finished week (Mon..Sun). Idempotent.
// ──────────────────────────────────────────────────────────────────────────

export const recomputeJustFinishedWeek = internalMutation({
  args: {},
  handler: async (ctx) => {
    // "Just finished" = last Monday relative to now()
    const today = new Date();
    const currentMonday = isoMondayOf(today);
    const ms = Date.parse(`${currentMonday}T00:00:00Z`) - 7 * 86400000;
    const previousMonday = new Date(ms).toISOString().slice(0, 10);

    const allAccounts = await ctx.db.query("accounts").collect();
    const accountSlugs = allAccounts.map((a) => a.slug);

    const allItems = (await ctx.db.query("items").collect()) as Doc<"items">[];
    const allPricing = (await ctx.db.query("pricing_catalog").collect()) as Doc<"pricing_catalog">[];
    const itemById = new Map<Id<"items">, Doc<"items">>();
    for (const it of allItems) itemById.set(it._id, it);
    const attrCtx = makeAttributionCtx(allItems, allPricing);
    const allKinds = new Set<string>();
    for (const it of allItems) if (it.kind) allKinds.add(it.kind);

    const week: WeekRange = {
      week_start: previousMonday,
      week_end: isoSundayFromMonday(previousMonday),
    };
    const runId = `phase5a-cron-${Date.now().toString(36)}`;

    let rowsWritten = 0;
    for (const slug of accountSlugs) {
      const lookbackStart = new Date(Date.parse(`${week.week_start}T00:00:00Z`) - 30 * 86400000)
        .toISOString()
        .slice(0, 10);
      const lookaheadEnd = new Date(Date.parse(`${week.week_end}T00:00:00Z`) + 30 * 86400000)
        .toISOString()
        .slice(0, 10);
      const reservationsRaw = (await ctx.db
        .query("reservations")
        .withIndex("by_start_date", (q: any) =>
          q.gte("start_date", lookbackStart).lte("start_date", lookaheadEnd),
        )
        .collect()) as Doc<"reservations">[];
      const reservations = reservationsRaw
        .filter((r) => r.account_slug === slug)
        .map((r): ReservationForMetrics => ({
          _id: r._id,
          account_slug: r.account_slug,
          status: r.status,
          is_obsolete: r.is_obsolete,
          start_date: r.start_date,
          end_date: r.end_date,
          duration_days: r.duration_days,
          gross_paid_gbp: r.gross_paid_gbp,
          net_to_owner_gbp: r.net_to_owner_gbp,
          denial_actor: r.denial_actor,
          reclassified_outcome: r.reclassified_outcome,
          hygglo_system_signal: r.hygglo_system_signal,
          obsolete_reason: r.obsolete_reason,
          expanded_items: r.expanded_items,
          resolved_items: r.resolved_items,
          items: r.items,
        }));

      const logId = await ctx.db.insert("metrics_run_log", {
        run_id: runId,
        started_at: Date.now(),
        week_start: week.week_start,
        account_slug: slug,
        rows_written: 0,
      });

      const g = await upsertRow(
        ctx as any,
        {
          week,
          account_slug: slug,
          granularity: "global",
          algorithm_version: ALGORITHM_VERSION_DEFAULT,
          reservations,
          items: allItems,
          itemById,
          attrCtx,
        },
        { skipIfAllZero: false },
      );
      if (g !== "skipped") rowsWritten += 1;

      for (const k of allKinds) {
        const res = await upsertRow(
          ctx as any,
          {
            week,
            account_slug: slug,
            granularity: "kind",
            kind: k,
            algorithm_version: ALGORITHM_VERSION_DEFAULT,
            reservations,
            items: allItems,
            itemById,
            attrCtx,
          },
          { skipIfAllZero: true },
        );
        if (res !== "skipped") rowsWritten += 1;
      }

      for (const it of allItems) {
        const res = await upsertRow(
          ctx as any,
          {
            week,
            account_slug: slug,
            granularity: "item",
            kind: it.kind,
            item_id: it._id,
            item_name_canonical: it.name_canonical,
            algorithm_version: ALGORITHM_VERSION_DEFAULT,
            reservations,
            items: allItems,
            itemById,
            attrCtx,
          },
          { skipIfAllZero: true },
        );
        if (res !== "skipped") rowsWritten += 1;
      }

      await ctx.db.patch(logId, {
        finished_at: Date.now(),
        rows_written: rowsWritten,
      });
    }

    return { week_start: previousMonday, rows_written: rowsWritten, run_id: runId };
  },
});

// ──────────────────────────────────────────────────────────────────────────
// Sanity check query — read-only summary for the audit script
// ──────────────────────────────────────────────────────────────────────────

export const sanityCheck = query({
  args: {},
  handler: async (ctx) => {
    const all = (await ctx.db.query("weekly_metrics").collect()) as Doc<"weekly_metrics">[];
    const byGranularity: Record<string, number> = {};
    const weekSet = new Set<string>();
    let minWeek = "9999-12-31";
    let maxWeek = "0000-01-01";
    let totalRevenue = 0;

    type WeekAgg = { week: string; revenue: number };
    const globalByWeek = new Map<string, WeekAgg>();
    type ItemAgg = { item_id: string; name: string; revenue: number; util: number; weeks: number };
    const itemAgg = new Map<string, ItemAgg>();
    let ownerDeniedWeeks = 0;

    for (const r of all) {
      byGranularity[r.granularity] = (byGranularity[r.granularity] ?? 0) + 1;
      weekSet.add(r.week_start);
      if (r.week_start < minWeek) minWeek = r.week_start;
      if (r.week_start > maxWeek) maxWeek = r.week_start;
      totalRevenue += r.revenue_gross_gbp ?? 0;

      if (r.granularity === "global") {
        const k = `${r.week_start}|${r.account_slug}`;
        globalByWeek.set(k, {
          week: k,
          revenue: (globalByWeek.get(k)?.revenue ?? 0) + (r.revenue_gross_gbp ?? 0),
        });
        if ((r.rentals_owner_denied ?? 0) > 0) ownerDeniedWeeks += 1;
      }
      if (r.granularity === "item" && r.item_id) {
        const idStr = r.item_id as unknown as string;
        const cur = itemAgg.get(idStr) ?? {
          item_id: idStr,
          name: r.item_name_canonical ?? "?",
          revenue: 0,
          util: 0,
          weeks: 0,
        };
        cur.revenue += r.revenue_gross_gbp ?? 0;
        cur.util += r.utilization_rate ?? 0;
        cur.weeks += 1;
        itemAgg.set(idStr, cur);
      }
    }

    const topWeeks = [...globalByWeek.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);
    const topItemsByRevenue = [...itemAgg.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);
    const topItemsByUtil = [...itemAgg.values()]
      .map((x) => ({ ...x, avg_util: x.weeks > 0 ? x.util / x.weeks : 0 }))
      .sort((a, b) => b.avg_util - a.avg_util)
      .slice(0, 10);

    return {
      total_rows: all.length,
      by_granularity: byGranularity,
      distinct_weeks: weekSet.size,
      min_week: weekSet.size ? minWeek : null,
      max_week: weekSet.size ? maxWeek : null,
      total_revenue_gross_gbp: Math.round(totalRevenue),
      top_weeks_by_revenue: topWeeks,
      top_items_by_revenue: topItemsByRevenue,
      top_items_by_utilization: topItemsByUtil,
      weeks_with_owner_denials: ownerDeniedWeeks,
    };
  },
});
