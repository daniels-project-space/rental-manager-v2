/**
 * MV: mv_calendar (2026-07-09)
 *
 * Wraps the DEFAULT (current-week / today) views of getWeeklyCalendar +
 * getCalendarStrip in a cache. Both are LIVE reactive queries bounded by a
 * `by_start_date` window (~750 rows / ~1.4 MB per run). They re-run on EVERY
 * 5-min poller write × every open dashboard tab — an unbounded, per-tab drain.
 * This replaces that with a bounded 30-min cron + a single indexed row read,
 * so the cost no longer scales with open tabs/devices.
 *
 * WHAT IS CACHED — only the *current* anchor:
 *   weekly:<slug>  → getWeeklyCalendar(slug, weekStartDate = this Monday, London)
 *   strip:<slug>   → getCalendarStrip(slug, startDate = today London, days = 7)
 * slug ∈ { "all" (=accountSlug null), ...each accounts.slug }.
 *
 * Week-navigation (±7) and the chat tool (raw-UTC, non-Monday anchor) request a
 * DIFFERENT anchor → the reader's anchor-equality guard misses → live fallback.
 * So we NEVER serve a stale/mismatched calendar; a miss just costs the (cheap)
 * live scan. The server anchor is computed with the same londonToday()/getMondayOf
 * the client inlines, so the current-view request hits.
 *
 * FRESHNESS (calendar tolerates ≤~30-45 min staleness — rentals span days):
 *   • new confirmed booking / new hold → a new row → dirtySince trips → rebuild.
 *   • chat-negotiated pickup/return TIME → the extractor bumps
 *     times_extracted_at → dirtySince trips → rebuild on the next tick (added
 *     2026-07-12; previously waited on the backstop, so times looked stuck).
 *   • other status edits on EXISTING rows (no new row) → covered by the age
 *     backstop. The poller re-stamps reservations.last_polled_at every cycle,
 *     but that is NOT counted as dirty (we probe Convex _creationTime only),
 *     which is what lets overnight/quiet ticks skip.
 * No forced-refresh kicks (unlike reply_queue) — the calendar has no optimistic
 * client updates and tolerates the cron lag; keeps the blast radius small.
 *
 * Mirrors mv/reply_queue.ts + mv/stats_drawer.ts.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, query } from "../_generated/server";
import { api } from "../_generated/api";
import { anyApi } from "convex/server";
import { londonToday } from "../lib/effectiveDates";

const STRIP_DAYS = 7;

// Rebuild at least this often even with no new row, so status/date edits on
// existing reservations (which don't insert a row) reconcile. Bounds worst-case
// staleness of the calendar between genuine-activity rebuilds.
const CALENDAR_BACKSTOP_MS = 45 * 60 * 1000;

/**
 * Monday (YYYY-MM-DD) of the week containing `ymd`. Byte-for-byte twin of the
 * inline getMondayOf in src/components/dashboard/WeeklyCalendar.tsx (and
 * CalendarStrip.tsx `mondayOf`) — MUST match so the reader's anchor-equality
 * check hits the cache instead of falling to live.
 */
function getMondayOf(ymd: string): string {
  const d = new Date(ymd + "T00:00:00Z");
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

export const refresh = internalAction({
  // `force` bypasses skip-when-clean (manual/verification runs).
  args: { force: v.optional(v.boolean()) },
  handler: async (
    ctx,
    { force },
  ): Promise<{ ok: true; written: number; skipped: number; durationMs: number }> => {
    return await refreshAll(ctx, force ?? false);
  },
});

export async function refreshAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  force = false,
): Promise<{ ok: true; written: number; skipped: number; durationMs: number }> {
  const startedAt = Date.now();

  // Skip-when-clean: probe the "all" weekly row's generatedAt as the reference.
  if (!force) {
    const prior = await ctx.runQuery(anyApi.mv.calendar.get, { key: "weekly:all" });
    const priorGen: number = prior?.generatedAt ?? 0;
    if (priorGen > 0) {
      const age = startedAt - priorGen;
      const dirty: boolean = await ctx.runQuery(anyApi.mv.calendar.dirtySince, {
        sinceMs: priorGen,
      });
      if (!dirty && age < CALENDAR_BACKSTOP_MS) {
        return { ok: true, written: 0, skipped: 1, durationMs: Date.now() - startedAt };
      }
    }
  }

  const slugs: Array<string | null> = await ctx.runQuery(
    anyApi.mv.calendar.refreshSlugs,
    {},
  );
  const weekAnchor = getMondayOf(londonToday());
  const stripAnchor = londonToday();

  let written = 0;
  for (const slug of slugs) {
    const keySlug = slug ?? "all";

    // Weekly — run the live handler once (bypass MV to avoid self-recursion).
    const weekly = await ctx.runQuery(api.calendar.getWeeklyCalendar, {
      accountSlug: slug,
      weekStartDate: weekAnchor,
      _bypassMv: true,
    });
    await ctx.runMutation(anyApi.mv.calendar.write, {
      key: `weekly:${keySlug}`,
      anchor: weekAnchor,
      payload: weekly,
      generatedAt: startedAt,
    });
    written++;

    // Strip.
    const strip = await ctx.runQuery(api.calendar.getCalendarStrip, {
      accountSlug: slug,
      startDate: stripAnchor,
      days: STRIP_DAYS,
      _bypassMv: true,
    });
    await ctx.runMutation(anyApi.mv.calendar.write, {
      key: `strip:${keySlug}`,
      anchor: stripAnchor,
      days: STRIP_DAYS,
      payload: strip,
      generatedAt: startedAt,
    });
    written++;
  }

  return { ok: true, written, skipped: 0, durationMs: Date.now() - startedAt };
}

/** Refresh set: ["all" (=accountSlug null), ...each accounts.slug]. Enumerated
 *  live (the account list grows — diogo was added after leo/dbcinema). accounts
 *  is a tiny table (~3 rows). */
export const refreshSlugs = query({
  args: {},
  handler: async (ctx): Promise<Array<string | null>> => {
    const accounts = await ctx.db.query("accounts").collect();
    const slugs = accounts
      .map((a) => a.slug)
      .filter((s): s is string => typeof s === "string" && s.length > 0);
    return [null, ...slugs];
  },
});

export const write = internalMutation({
  args: {
    key: v.string(),
    anchor: v.string(),
    days: v.optional(v.number()),
    payload: v.any(),
    generatedAt: v.number(),
  },
  handler: async (ctx, { key, anchor, days, payload, generatedAt }) => {
    const doc = {
      key,
      anchor,
      payload,
      generatedAt,
      ...(days !== undefined ? { days } : {}),
    };
    const existing = await ctx.db
      .query("mv_calendar")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (existing) {
      // Content-skip: don't re-push an unchanged calendar to subscribed tabs.
      // (Same anchor/day + identical payload ⇒ nothing visibly changed. The
      // 30-min cron would otherwise re-send this row every tick for free.)
      if (
        existing.anchor === anchor &&
        existing.days === days &&
        JSON.stringify(existing.payload) === JSON.stringify(payload)
      ) {
        return { ok: true, skipped: true };
      }
      await ctx.db.patch(existing._id, doc);
    } else {
      await ctx.db.insert("mv_calendar", doc);
    }
    return { ok: true };
  },
});

/** Reader used by refreshAll's skip-check + the getWeeklyCalendar/getCalendarStrip
 *  fast paths (via the by_key index). */
export const get = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    return await ctx.db
      .query("mv_calendar")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
  },
});

/**
 * Skip-when-clean probe. True if (a) a new reservation or calendar_hold row
 * landed, or (b) a booking-time extraction patched pickup/return date+time onto
 * an existing reservation, since the MV was last built. Uses Convex
 * `_creationTime` (real wall-clock, assigned on insert, never re-stamped) for
 * (a), and the `times_extracted_at` stamp for (b) — deliberately NOT
 * reservations.last_polled_at (the poller re-stamps it every 5-min cycle even
 * when nothing changed, which would keep the probe permanently dirty). Other
 * status edits on existing rows (no new row, no extraction) are handled by
 * refreshAll's age backstop, not this probe. Three indexed `.first()` reads —
 * no table scan.
 */
export const dirtySince = query({
  args: { sinceMs: v.number() },
  handler: async (ctx, { sinceMs }): Promise<boolean> => {
    const res = await ctx.db
      .query("reservations")
      .withIndex("by_creation_time")
      .order("desc")
      .first();
    if (res && res._creationTime > sinceMs) return true;

    const hold = await ctx.db
      .query("calendar_holds")
      .withIndex("by_creation_time")
      .order("desc")
      .first();
    if (hold && hold._creationTime > sinceMs) return true;

    // Booking-time extraction (2026-07-12): the LLM extractor
    // (extract_booking_times_q.setTimes) PATCHES pickup/return date+time onto an
    // EXISTING reservation and bumps `times_extracted_at` — WITHOUT inserting a
    // row or touching _creationTime, so the two probes above miss it. Absent this,
    // a chat-negotiated pickup/return time only reached the calendar via the
    // 45-min backstop ("times not updating"). Newest times_extracted_at = the
    // "any extraction since?" signal; one indexed read, no scan. Mirrors
    // mv/stats_drawer.ts hasReservationMutationsSince.
    const extracted = await ctx.db
      .query("reservations")
      .withIndex("by_times_extracted_at")
      .order("desc")
      .first();
    const extractedStamp = (extracted as { times_extracted_at?: number } | null)
      ?.times_extracted_at;
    if (typeof extractedStamp === "number" && extractedStamp > sinceMs) return true;

    return false;
  },
});
