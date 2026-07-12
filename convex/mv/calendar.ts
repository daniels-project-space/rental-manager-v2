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
 * SELECTIVE REBUILD (2026-07-12): a rebuild used to run computeLive 10×
 * (weekly+strip × all 5 slugs) whenever ANY change tripped the probe. The
 * dirty probe now also attributes the changed rows to account slugs; when ALL
 * of them belong to ONE known slug, only ["all", thatSlug] is rebuilt (4 live
 * runs instead of 10 — a single account's new booking can't change another
 * account's view). Multi-account / unknown-slug dirt, the 45-min age
 * backstop, and `force` still rebuild every slug, and a meta:last_full_rebuild
 * marker guarantees a FULL rebuild at least every backstop window even under
 * a sustained single-account stream (probe-invisible edits to other accounts
 * would otherwise never reconcile).
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

/** Bookkeeping row: generatedAt = last time EVERY slug was rebuilt. Selective
 *  rebuilds (below) bump weekly:all's generatedAt, so weekly:all age can no
 *  longer bound how stale a NON-rebuilt slug's row is — this marker can. */
const META_LAST_FULL_KEY = "meta:last_full_rebuild";

export async function refreshAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  force = false,
): Promise<{ ok: true; written: number; skipped: number; durationMs: number }> {
  const startedAt = Date.now();

  // Selective-rebuild target (2026-07-12). Non-null ⇒ every dirty marker since
  // the last build belongs to this ONE account slug, so only its two views —
  // plus the cross-account "all" views, which any change affects — can differ.
  // Null ⇒ rebuild all slugs, exactly as before.
  let dirtySlugOnly: string | null = null;

  // Skip-when-clean: probe the "all" weekly row's generatedAt as the reference.
  if (!force) {
    const prior = await ctx.runQuery(anyApi.mv.calendar.get, { key: "weekly:all" });
    const priorGen: number = prior?.generatedAt ?? 0;
    if (priorGen > 0) {
      const age = startedAt - priorGen;
      const probe: { dirty: boolean; slugs: string[] | null } = await ctx.runQuery(
        anyApi.mv.calendar.dirtySince,
        { sinceMs: priorGen },
      );
      if (!probe.dirty && age < CALENDAR_BACKSTOP_MS) {
        return { ok: true, written: 0, skipped: 1, durationMs: Date.now() - startedAt };
      }
      // Selective only when the rebuild is DIRT-triggered (not the age
      // backstop — that exists to reconcile probe-INVISIBLE edits, which
      // carry no slug information, so it must rebuild everything) AND the
      // probe attributed every changed row to exactly one slug. Extra guard:
      // a full rebuild must have happened within the backstop window —
      // selective rebuilds bump weekly:all's generatedAt, so without this a
      // sustained single-account stream of new rows would postpone the other
      // slugs' backstop reconciliation indefinitely.
      if (
        probe.dirty &&
        age < CALENDAR_BACKSTOP_MS &&
        probe.slugs &&
        probe.slugs.length === 1
      ) {
        const lastFull = await ctx.runQuery(anyApi.mv.calendar.get, {
          key: META_LAST_FULL_KEY,
        });
        const lastFullAt: number = lastFull?.generatedAt ?? 0;
        if (lastFullAt > 0 && startedAt - lastFullAt < CALENDAR_BACKSTOP_MS) {
          dirtySlugOnly = probe.slugs[0];
        }
      }
    }
  }

  const allSlugs: Array<string | null> = await ctx.runQuery(
    anyApi.mv.calendar.refreshSlugs,
    {},
  );
  // A dirty slug not in the accounts table is "unknown" → full rebuild.
  const selective = dirtySlugOnly !== null && allSlugs.includes(dirtySlugOnly);
  const slugs: Array<string | null> = selective ? [null, dirtySlugOnly] : allSlugs;
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

  // Stamp full rebuilds (payload varies each write so the content-skip in
  // `write` never swallows the generatedAt bump). Not counted in `written` —
  // that tracks view payloads.
  if (!selective) {
    await ctx.runMutation(anyApi.mv.calendar.write, {
      key: META_LAST_FULL_KEY,
      anchor: weekAnchor,
      payload: { at: startedAt },
      generatedAt: startedAt,
    });
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

/** Rows read per dirty probe. The newest row alone can't prove all changes
 *  belong to one account, so each probe reads up to this many newest rows; if
 *  the LAST one is still newer than the cutoff there may be more changed rows
 *  beyond the window → slug attribution is abandoned (full rebuild). */
const DIRTY_PROBE_ROWS = 10;

/**
 * Skip-when-clean probe. `dirty` is true if (a) a new reservation or
 * calendar_hold row landed, or (b) a booking-time extraction patched
 * pickup/return date+time onto an existing reservation, since the MV was last
 * built. Uses Convex `_creationTime` (real wall-clock, assigned on insert,
 * never re-stamped) for (a), and the `times_extracted_at` stamp for (b) —
 * deliberately NOT reservations.last_polled_at (the poller re-stamps it every
 * 5-min cycle even when nothing changed, which would keep the probe
 * permanently dirty). Other status edits on existing rows (no new row, no
 * extraction) are handled by refreshAll's age backstop, not this probe.
 *
 * `slugs` (2026-07-12, selective rebuild): the distinct account_slug values of
 * the changed rows — or null when attribution is unreliable (any changed row
 * with a missing slug, or a probe window that may not have reached the oldest
 * changed row). refreshAll rebuilds just ["all", slug] when slugs is exactly
 * one known slug. Three indexed `.take(10)` reads — no table scan; the first
 * row of each probe is what `.first()` returned before, so `dirty` is
 * unchanged.
 */
export const dirtySince = query({
  args: { sinceMs: v.number() },
  handler: async (
    ctx,
    { sinceMs },
  ): Promise<{ dirty: boolean; slugs: string[] | null }> => {
    let dirty = false;
    // False once any changed row's slug is unknowable OR a probe window may
    // have missed older changed rows — either way slug-scoping is unsafe.
    let complete = true;
    const slugSet = new Set<string>();

    const noteRow = (slug: string | undefined) => {
      dirty = true;
      if (typeof slug === "string" && slug.length > 0) slugSet.add(slug);
      else complete = false;
    };

    const resRows = await ctx.db
      .query("reservations")
      .withIndex("by_creation_time")
      .order("desc")
      .take(DIRTY_PROBE_ROWS);
    for (const r of resRows) {
      if (r._creationTime <= sinceMs) break; // desc order — rest are older
      noteRow((r as { account_slug?: string }).account_slug);
    }
    if (
      resRows.length === DIRTY_PROBE_ROWS &&
      resRows[DIRTY_PROBE_ROWS - 1]._creationTime > sinceMs
    ) {
      complete = false;
    }

    const holdRows = await ctx.db
      .query("calendar_holds")
      .withIndex("by_creation_time")
      .order("desc")
      .take(DIRTY_PROBE_ROWS);
    for (const h of holdRows) {
      if (h._creationTime <= sinceMs) break;
      noteRow((h as { account_slug?: string }).account_slug);
    }
    if (
      holdRows.length === DIRTY_PROBE_ROWS &&
      holdRows[DIRTY_PROBE_ROWS - 1]._creationTime > sinceMs
    ) {
      complete = false;
    }

    // Booking-time extraction (2026-07-12): the LLM extractor
    // (extract_booking_times_q.setTimes) PATCHES pickup/return date+time onto an
    // EXISTING reservation and bumps `times_extracted_at` — WITHOUT inserting a
    // row or touching _creationTime, so the two probes above miss it. Absent this,
    // a chat-negotiated pickup/return time only reached the calendar via the
    // 45-min backstop ("times not updating"). Newest times_extracted_at = the
    // "any extraction since?" signal. Mirrors mv/stats_drawer.ts
    // hasReservationMutationsSince. Desc order puts stamped rows first and
    // unstamped (undefined sorts lowest) last, so break-on-unstamped is safe.
    const extractedRows = await ctx.db
      .query("reservations")
      .withIndex("by_times_extracted_at")
      .order("desc")
      .take(DIRTY_PROBE_ROWS);
    for (const r of extractedRows) {
      const stamp = (r as { times_extracted_at?: number }).times_extracted_at;
      if (typeof stamp !== "number" || stamp <= sinceMs) break;
      noteRow((r as { account_slug?: string }).account_slug);
    }
    if (extractedRows.length === DIRTY_PROBE_ROWS) {
      const lastStamp = (
        extractedRows[DIRTY_PROBE_ROWS - 1] as { times_extracted_at?: number }
      ).times_extracted_at;
      if (typeof lastStamp === "number" && lastStamp > sinceMs) complete = false;
    }

    // dirty && complete ⇒ slugSet is non-empty (every dirty row either added
    // its slug or flipped `complete`).
    return { dirty, slugs: dirty && complete ? [...slugSet] : null };
  },
});
