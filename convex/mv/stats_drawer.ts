/**
 * MV: mv_stats_drawer (phase 7d, 2026-05-24)
 *
 * Wraps the 16-card getStatsDrawerData megaquery in a per-account cache.
 * Refresher runs the existing internal handler for each slug + stores the
 * full payload as v.any(). Dashboard subscriptions read a single indexed
 * row instead of re-running the 8-collect + 16-card compute on every
 * reservation mutation.
 *
 * Checked by master.refreshFast hourly; the cross-account "all" rebuild is
 * throttled to one attempt every six hours. Per-account rows refresh separately.
 *
 * Cold-start fallback: the public getStatsDrawerData query in
 * convex/dashboard.ts falls back to the internal live compute for the
 * first cron tick after deploy.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, query } from "../owner_functions";
import { internal } from "../_generated/api";
import { anyApi } from "convex/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";
import { londonTime } from "../lib/effectiveDates";

/**
 * Standalone refresher — direct invocation path (manual ops, cold-start
 * population). The hot path lives in master.refreshFast which calls this
 * action's `refreshAll` helper directly to avoid the extra action hop.
 */
export const refresh = internalAction({
  args: {
    force: v.optional(v.boolean()),
    scope: v.optional(v.union(
      v.literal("all"),
      v.literal("accounts"),
      v.literal("both"),
      v.literal("all_and_account"),
    )),
    accountSlug: v.optional(v.string()),
  },
  handler: async (ctx, { force, scope, accountSlug }): Promise<{ ok: true; written: number; durationMs: number; skipped?: number }> => {
    return await refreshAll(ctx, force, scope ?? "both", accountSlug);
  },
});

/**
 * Copy the current-year tax total into the existing stats snapshots. The slow
 * MV batch already collects the full reservations source for other aggregates,
 * so this projection adds only a few bounded writes and removes that annual
 * document set from every hourly stats refresh.
 */
export const writeTaxYearSnapshot = internalMutation({
  args: {
    year: v.number(),
    generatedAt: v.number(),
    currentYearEarnings: v.array(v.object({ account: v.string(), grossGbp: v.number() })),
  },
  handler: async (ctx, { year, generatedAt, currentYearEarnings }) => {
    const totals = new Map(currentYearEarnings.map(({ account, grossGbp }) => [account, grossGbp]));
    let updated = 0;
    for (const account of [ACCOUNT_ALL, ...ACCOUNTS]) {
      const row = await ctx.db
        .query("mv_stats_drawer")
        .withIndex("by_account", (q) => q.eq("account", account))
        .first();
      if (!row) continue;
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const priorTax = payload.tax && typeof payload.tax === "object"
        ? payload.tax as Record<string, unknown>
        : {};
      await ctx.db.patch(row._id, {
        payload: {
          ...payload,
          tax: {
            ...priorTax,
            snapshot_year: year,
            current_year_earnings_gbp: totals.get(account) ?? 0,
            generated_at: generatedAt,
          },
        },
      });
      updated += 1;
    }
    return { updated, year };
  },
});

const ALL_STATS_REFRESH_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * The all-account stats refresh is the only path that runs the large
 * cross-account dashboard query. Keep it on the same six-hour freshness
 * budget as the account drill-down snapshots, and persist the attempt before
 * running the query so a read-limit failure cannot trigger another full scan
 * on the next hourly master tick.
 */
export const tryStartAllRefresh = internalMutation({
  args: {
    account: v.string(),
    now: v.number(),
    force: v.boolean(),
  },
  handler: async (ctx, { account, now, force }) => {
    const existing = await ctx.db
      .query("mv_stats_drawer_refresh_state")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (!force && existing && now - existing.lastAttemptAt < ALL_STATS_REFRESH_MIN_INTERVAL_MS) {
      return false;
    }
    if (existing) {
      await ctx.db.patch(existing._id, { lastAttemptAt: now });
    } else {
      await ctx.db.insert("mv_stats_drawer_refresh_state", { account, lastAttemptAt: now });
    }
    return true;
  },
});

/**
 * Shared compute used by both the standalone refresh action and the master
 * refreshFast orchestrator. Calls the live getStatsDrawerData per account
 * and writes the payloads in a single mutation per account.
 *
 * Pass 8a (2026-05-25) — skip-when-clean: before re-running the heavy live
 * handler (which collects 8 tables and runs ~3MB of computation per
 * account), check whether any reservation has mutated since the last MV
 * write. The live handler dominates by reading the reservations table,
 * so a quiet hour with zero poller writes can short-circuit the entire
 * refresh. Targets the ~576MB/day of cron-driven bandwidth this MV was
 * adding when it ran the full handler every hour.
 */
export async function refreshAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  force: boolean = false,
  // 2026-07-07 cost split — the live compute reads ~15 tables (reservations 365d
  // + renters + denials + ai_decision + …) and was run 5× (once per slug) EVERY
  // hour: the dominant refresher bandwidth. Now the fast cron refreshes only the
  // "all" default view hourly; a separate 6h cron refreshes the 4 per-account rows
  // (drill-down views tolerate ≤6h staleness; their live-critical fields — claim
  // stage, scanner, conflicts, insurance — are already read-time overlays).
  scope: "all" | "accounts" | "both" | "all_and_account" = "both",
  accountSlug?: string,
): Promise<{ ok: true; written: number; durationMs: number; skipped: number }> {
  const startedAt = Date.now();
  const allSlugs: Array<{ key: string; arg: string | null }> = [
    { key: ACCOUNT_ALL, arg: null },
    ...ACCOUNTS.map((s) => ({ key: s, arg: s })),
  ];
  if (scope === "all_and_account" &&
      (!accountSlug || !allSlugs.some((s) => s.key === accountSlug && s.key !== ACCOUNT_ALL))) {
    throw new Error("all_and_account refresh needs a configured non-all accountSlug");
  }
  const slugs = scope === "all"
    ? allSlugs.filter((s) => s.key === ACCOUNT_ALL)
    : scope === "accounts"
      ? allSlugs.filter((s) => s.key !== ACCOUNT_ALL)
      : scope === "all_and_account"
        ? allSlugs.filter((s) => s.key === ACCOUNT_ALL || s.key === accountSlug)
        : allSlugs;

  let slugsToRefresh = slugs;
  let skippedByGate = 0;
  // Any scope containing the all-account row must share the same attempt gate.
  // The daily "both" schedule and operator "all_and_account" scope otherwise
  // bypass the guard used by refreshFast and can repeat the same read-limit
  // failure around a failed all-account refresh.
  if (slugs.some(({ key }) => key === ACCOUNT_ALL)) {
    const canRefresh = await ctx.runMutation(anyApi.mv.stats_drawer.tryStartAllRefresh, {
      account: ACCOUNT_ALL,
      now: startedAt,
      force: force ?? false,
    });
    if (!canRefresh) {
      slugsToRefresh = slugs.filter(({ key }) => key !== ACCOUNT_ALL);
      skippedByGate = slugs.length - slugsToRefresh.length;
      // A pure all-account refresh has nothing left to do. Combined scopes
      // continue refreshing their per-account snapshots.
      if (slugsToRefresh.length === 0) {
        return { ok: true, written: 0, skipped: skippedByGate, durationMs: Date.now() - startedAt };
      }
    }
  }

  // Read the prior generatedAt for each row. Use the lowest across accounts
  // as the staleness cutoff — if ANY account has stale data, we re-run.
  const priorRows = await Promise.all(
    slugsToRefresh.map(({ key }) =>
      ctx.runQuery(anyApi.mv.stats_drawer.get, { account: key }),
    ),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priorGeneratedAts: number[] = priorRows.map((r: any) => r?.generatedAt ?? 0);
  const earliestPriorGen = Math.min(...priorGeneratedAts);
  // Cold start (any row missing) → must rebuild.
  const isColdStart = priorGeneratedAts.some((g) => g === 0);
  if (!force && !isColdStart) {
    // Date-driven metrics (active / ongoing / upcoming counts, today/week
    // earnings) shift with the CALENDAR even when NO reservation mutates — a
    // rental flips upcoming→ongoing→completed purely because today's date
    // crossed its start/end, with zero DB writes. So a "clean" but previous-day
    // (or simply old) snapshot is still stale. ONLY consider skipping when the
    // snapshot is from the same London day AND recent; otherwise always rebuild.
    // (This is why the MV could sit ~6 days stale: no mutations, so the old
    // mutation-only probe skipped every rebuild indefinitely.)
    const sameDay =
      new Date(earliestPriorGen).toLocaleDateString("en-CA", { timeZone: "Europe/London" }) ===
      new Date(startedAt).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
    const recent = startedAt - earliestPriorGen < 6 * 60 * 60 * 1000;
    const sameRevenueDay = new Date(earliestPriorGen).toISOString().slice(0, 10) ===
      new Date(startedAt).toISOString().slice(0, 10);
    if (sameDay && sameRevenueDay && recent) {
      // A same-day agreed pickup crosses upcoming -> ongoing without a DB
      // mutation. Inspect only the small cached drawer arrays before skipping.
      const todayLondon = new Date(startedAt).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
      const timeLondon = londonTime(new Date(startedAt));
      type UpcomingRow = { pickup_date?: string | null; start_date?: string | null; pickup_time?: string | null };
      type CachedRentals = { rentals?: { upcoming?: UpcomingRow[] } } | null;
      const cachedRentals = await Promise.all(slugsToRefresh.map(({ key }) =>
        ctx.runQuery(anyApi.mv.stats_drawer.getRentals, { account: key }) as Promise<CachedRentals>,
      ));
      const crossedPickup = cachedRentals.some((row) =>
        (row?.rentals?.upcoming ?? []).some((r) =>
          (r.pickup_date ?? r.start_date) === todayLondon &&
          typeof r.pickup_time === "string" && r.pickup_time <= timeLondon,
        ),
      );
      // Same-day & recent: only skip if no reservation mutated since the last
      // write (the indexed max(last_polled_at) probe catches inserts AND status
      // changes on any rental, not just future-dated ones).
      const isDirty: boolean = await ctx.runQuery(
        anyApi.mv.stats_drawer.hasReservationMutationsSince,
        { sinceMs: earliestPriorGen },
      );
      if (!isDirty && !crossedPickup) {
        return { ok: true, written: 0, skipped: slugs.length, durationMs: Date.now() - startedAt };
      }
    }
  }

  let written = 0;
  for (const { key, arg } of slugsToRefresh) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fullPayload: any = await ctx.runQuery(internal.dashboard.__service_getStatsDrawerData, {
      accountSlug: arg,
      _bypassMv: true,
    });
    // Pass 10b (2026-05-25) — split the fat rentals arrays out of the
    // payload before the main MV write. The 4 arrays (active.rentals,
    // ongoing.rentals, upcoming.rentals, confirmed.rentals) accounted for
    // ~72KB of the 78KB total. They're only read by drawer drill-downs,
    // so we cache them in mv_stats_drawer_rentals and fetch on-demand.
    const rentalsSplit = {
      active: fullPayload?.active?.rentals ?? [],
      ongoing: fullPayload?.ongoing?.rentals ?? [],
      upcoming: fullPayload?.upcoming?.rentals ?? [],
      confirmed: fullPayload?.confirmed?.rentals ?? [],
    };
    const trimmed = {
      ...fullPayload,
      active: { ...(fullPayload?.active ?? {}), rentals: undefined },
      ongoing: { ...(fullPayload?.ongoing ?? {}), rentals: undefined },
      upcoming: { ...(fullPayload?.upcoming ?? {}), rentals: undefined },
      confirmed: { ...(fullPayload?.confirmed ?? {}), rentals: undefined },
    };
    // Drop the undefined `rentals` keys cleanly so they don't appear in
    // the stored JSON.
    for (const card of ["active", "ongoing", "upcoming", "confirmed"] as const) {
      if (trimmed[card]) delete trimmed[card].rentals;
    }
    await ctx.runMutation(anyApi.mv.stats_drawer.write, {
      account: key,
      payload: trimmed,
      generatedAt: startedAt,
    });
    await ctx.runMutation(anyApi.mv.stats_drawer.writeRentals, {
      account: key,
      rentals: rentalsSplit,
      generatedAt: startedAt,
    });
    written += 1;
  }
  return { ok: true, written, skipped: skippedByGate, durationMs: Date.now() - startedAt };
}

export const write = internalMutation({
  args: {
    account: v.string(),
    payload: v.any(),
    generatedAt: v.number(),
  },
  handler: async (ctx, { account, payload, generatedAt }) => {
    const existing = await ctx.db
      .query("mv_stats_drawer")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (existing) {
      // Content-skip: don't re-push an identical payload to every subscribed tab.
      if (JSON.stringify(existing.payload) === JSON.stringify(payload)) {
        return { ok: true, skipped: true };
      }
      await ctx.db.patch(existing._id, { payload, generatedAt });
    } else {
      await ctx.db.insert("mv_stats_drawer", { account, payload, generatedAt });
    }
    return { ok: true };
  },
});

/** Pass 10b — drawer drill-down rentals lists split into a separate MV
 *  row so always-subscribed dashboard widgets only read the trimmed
 *  headline payload (~6KB vs 78KB). */
export const writeRentals = internalMutation({
  args: {
    account: v.string(),
    rentals: v.any(),
    generatedAt: v.number(),
  },
  handler: async (ctx, { account, rentals, generatedAt }) => {
    const existing = await ctx.db
      .query("mv_stats_drawer_rentals")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (existing) {
      // Content-skip: don't re-push identical drill-down rentals to subscribers.
      if (JSON.stringify(existing.rentals) === JSON.stringify(rentals)) {
        return { ok: true, skipped: true };
      }
      await ctx.db.patch(existing._id, { rentals, generatedAt });
    } else {
      await ctx.db.insert("mv_stats_drawer_rentals", { account, rentals, generatedAt });
    }
    return { ok: true };
  },
});

/** Drawer drill-down reader — frontend subscribes to this ONLY when a
 *  stat-card drawer is expanded. Returns the 4 rentals arrays
 *  (active / ongoing / upcoming / confirmed) for the requested account. */
export const getRentals = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? ACCOUNT_ALL;
    const row = await ctx.db
      .query("mv_stats_drawer_rentals")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
    return row;
  },
});

/**
 * Reader — returns the cached payload for an accountSlug (or "all").
 * Returns null when MV not yet populated; callers should fall back to live
 * compute in that case.
 */
export const get = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? ACCOUNT_ALL;
    const row = await ctx.db
      .query("mv_stats_drawer")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
    return row;
  },
});

/**
 * Pass 8a skip-when-clean probe. Returns true if any reservation has been
 * touched (last_polled_at OR _creationTime) since the given ms cutoff —
 * meaning the MV rows are stale and must be rebuilt. The poller bumps
 * last_polled_at on every Hygglo cycle, so this becomes false during quiet
 * hours and most cron ticks short-circuit. One indexed read instead of
 * three 8-table live computes.
 */
export const hasReservationMutationsSince = query({
  args: { sinceMs: v.number() },
  handler: async (ctx, { sinceMs }): Promise<boolean> => {
    // Newest poller patch. last_polled_at is bumped on ANY touched reservation
    // (insert or status change) regardless of its start_date, so the max of it
    // is the true "anything changed?" signal. The previous probe scanned the
    // top-50 by future start_date and therefore MISSED status changes on
    // past/ongoing rentals — leaving the MV (and the dashboard tile) stale for
    // hours. One indexed read of the most-recent stamp.
    const newestPolled = await ctx.db
      .query("reservations")
      .withIndex("by_last_polled_at")
      .order("desc")
      .first();
    const polledStamp = (newestPolled as { last_polled_at?: number } | null)?.last_polled_at;
    if (typeof polledStamp === "number" && polledStamp > sinceMs) return true;
    // Belt-and-braces for rows inserted but not yet poller-stamped.
    const newestCreated = await ctx.db
      .query("reservations")
      .withIndex("by_creation_time")
      .order("desc")
      .first();
    if (newestCreated && newestCreated._creationTime > sinceMs) return true;
    // ── Booking-time extraction staleness (2026-06-02) ──────────────────────
    // A Trigger-driven booking-time extraction (extract_booking_times_q.setTimes)
    // patches pickup_date/return_date/pickup_time/return_time and bumps
    // `times_extracted_at` WITHOUT touching last_polled_at (poller semantics) or
    // _creationTime. So a chat-negotiated date/time change moves the live
    // calendar instantly but, absent this probe, leaves the MV-cached Active tab
    // stale until the next poller cycle. The newest times_extracted_at is the
    // "any extraction since?" signal — one indexed read.
    const newestExtracted = await ctx.db
      .query("reservations")
      .withIndex("by_times_extracted_at")
      .order("desc")
      .first();
    const extractedStamp = (newestExtracted as { times_extracted_at?: number } | null)?.times_extracted_at;
    if (typeof extractedStamp === "number" && extractedStamp > sinceMs) return true;
    // ── Image-bank staleness (Phase 5.4) ───────────────────────────────────
    // A listing_images write changes the IMAGE shown on the rentals tiles but
    // does NOT touch any reservation, so the reservation-only probe above would
    // let the same-UTC-day skip hold a stale image all day. listing_images
    // PATCHES bump `captured_at` (not _creationTime), and there's no captured_at
    // index, so scan this small bounded bank (one row per account×product) for
    // any write newer than the cutoff. image_hints live ON the reservation and
    // are written by the poller alongside last_polled_at, so they're already
    // covered by the polledStamp check above.
    const banks = await ctx.db.query("listing_images").collect();
    for (const b of banks) {
      const cap = (b as { captured_at?: number }).captured_at;
      if (typeof cap === "number" && cap > sinceMs) return true;
      if (b._creationTime > sinceMs) return true;
    }
    return false;
  },
});
