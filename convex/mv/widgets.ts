/**
 * 2026-07-12 cost audit — generic widget MV refreshers (table `mv_widgets`,
 * reader helpers in convex/lib/widget_mv.ts).
 *
 * Two tiers:
 *
 *  FAST (hourly, via mv/master.refreshFast) — compute-once-share-many:
 *    `computeFast` is ONE internalQuery that collects confirmed reservations
 *    + items + listing_photos + pricing_catalog a single time and derives
 *    the Out-of-Stock panel AND the Health issue scan for all 5 account
 *    scopes in-memory. Read cost ≈ one confirmed-collect per hour instead
 *    of two fat live scans per poller write per open tab.
 *
 *  SLOW (daily, via mv/master.refreshSlow) — wrap-and-cache:
 *    sell / price recommendations, bundle rankings (3 windows) and the tax
 *    year summaries call their live public queries with `_bypassMv: true`
 *    per variant and store the exact payload. These windows (30/90/365d,
 *    tax years) move slowly; daily staleness is invisible in the widgets.
 *
 * Writes content-skip (payload-identical rebuilds only re-stamp
 * generatedAt), so subscribed tabs re-read one small row per refresh tick
 * at most.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { anyApi } from "convex/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";
import { nearbyCalendarDates, type ImminentHandoffCandidate } from "../lib/imminent_handoffs";
import { OOS_CANONICAL_LOOKAHEAD_DAYS } from "../items";
import {buildStockForecast} from "../lib/stock_forecast";
import type {StockForecastSnapshot} from "../../src/lib/stock-forecast";
import { computeHealthIssues, type HealthIssue } from "../health";
import { CANONICAL_BUNDLE_WINDOWS } from "../bundles";
import { defaultStartYear } from "../tax";

const SLUG_VARIANTS: Array<{ key: string; arg: string | null }> = [
  { key: ACCOUNT_ALL, arg: null },
  ...ACCOUNTS.map((s) => ({ key: s, arg: s })),
];

/** Tax-year selector depth (mirrors tax.listAvailableTaxYears default). */
const TAX_YEARS_CACHED = 4;

// ──────────────────────────────────────────────────────────────
// Write (content-skip)
// ──────────────────────────────────────────────────────────────

/**
 * Payload compare ignoring a top-level volatile `generatedAt` (the tax
 * summary embeds one), so unchanged data never re-pushes payload bytes.
 */
function stableForCompare(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const { generatedAt: _g, ...rest } = payload as Record<string, unknown>;
    return JSON.stringify(rest);
  }
  return JSON.stringify(payload);
}

export const writeWidget = internalMutation({
  args: { key: v.string(), payload: v.any(), generatedAt: v.number() },
  handler: async (ctx, { key, payload, generatedAt }) => {
    const existing = await ctx.db
      .query("mv_widgets")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (!existing) {
      await ctx.db.insert("mv_widgets", { key, payload, generatedAt });
      return { ok: true, inserted: true };
    }
    if (stableForCompare(existing.payload) === stableForCompare(payload)) {
      // Data unchanged — keep the age gate warm without re-shipping payload.
      await ctx.db.patch(existing._id, { generatedAt });
      return { ok: true, skipped: true };
    }
    await ctx.db.patch(existing._id, { payload, generatedAt });
    return { ok: true, updated: true };
  },
});

// ──────────────────────────────────────────────────────────────
// FAST tier — OOS + Health, one shared read set, 5 slugs each.
// ──────────────────────────────────────────────────────────────

export const computeFast = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    oos: Record<string, StockForecastSnapshot>;
    health: Record<string, { issues: HealthIssue[] }>;
  }> => {
    // Share the bounded confirmed source and inventory with Health. The
    // forecast also loads ongoing and paid website pending allocations;
    // its own clock projection decides which periods actually overlap.
    const confirmed = await ctx.db
      .query("reservations")
      .withIndex("by_status", (q) => q.eq("status", "confirmed"))
      .take(2001);
    const items = await ctx.db.query("items").withIndex("by_canonical_name").take(2001);

    // Build the actual shared physical forecast once. Account variants
    // retain their cache identities but cannot invent separate equipment.
    const shared=await buildStockForecast(ctx,OOS_CANONICAL_LOOKAHEAD_DAYS,{items,confirmed});
    const oos:Record<string,StockForecastSnapshot>={};
    for(const {key} of SLUG_VARIANTS)oos[key]=shared;

    // ── Health issue scan ──
    const photos = await ctx.db.query("listing_photos").collect();
    const pricing = await ctx.db.query("pricing_catalog").collect();
    const cutoff365 = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const confirmed365 = confirmed.filter((r) => (r.start_date ?? "") >= cutoff365);
    const health: Record<string, { issues: HealthIssue[] }> = {};
    for (const { key, arg } of SLUG_VARIANTS) {
      health[key] = {
        issues: computeHealthIssues({
          items,
          photos,
          pricing,
          reservations: confirmed365,
          accountSlug: arg,
        }),
      };
    }

    return { oos, health };
  },
});

export async function refreshFastWidgets(
  ctx: ActionCtx,
): Promise<{ ok: true; written: number }> {
  const startedAt = Date.now();
  // anyApi: this module is new and not yet in the committed _generated api
  // type map (same pattern as mv/investment_scorecard.ts self-references).
  const computed: {
    oos: Record<string, StockForecastSnapshot>;
    health: Record<string, { issues: HealthIssue[] }>;
  } = await ctx.runQuery(anyApi.mv.widgets.computeFast, {});
  let written = 0;
  for (const { key } of SLUG_VARIANTS) {
    await ctx.runMutation(anyApi.mv.widgets.writeWidget, {
      key: `oos:${key}`,
      payload: computed.oos[key],
      generatedAt: startedAt,
    });
    await ctx.runMutation(anyApi.mv.widgets.writeWidget, {
      key: `health:${key}`,
      payload: computed.health[key] ?? { issues: [] },
      generatedAt: startedAt,
    });
    written += 2;
  }
  return { ok: true, written };
}

// ──────────────────────────────────────────────────────────────
// Imminent-handoffs row (5-min tier, driven by mv/reply_queue.refresh)
// ──────────────────────────────────────────────────────────────
//
// replyInbox.getImminentHandoffs was polled every 60s per tab (`_tick`) and
// each execution collected the whole confirmed set (~200KB) to find today's
// ±15-min pickups/returns — ~226MB/day. Now: this row caches TODAY's dated+
// timed candidates (no window filter — the reader applies windowMin and
// computes minutes_away at read time from a ~2KB row). Rebuilt from the
// 5-min reply-queue cron under its own cheap gates.

/** Generic keyed reader (internal — public readers use lib/widget_mv.ts). */
export const get = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    return await ctx.db
      .query("mv_widgets")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
  },
});

const HANDOFFS_KEY = "handoffs";
const HANDOFFS_BACKSTOP_MS = 30 * 60 * 1000;

export type HandoffCandidate = ImminentHandoffCandidate;

/**
 * Dirty probe for the handoffs row: any reservation genuinely changed
 * (last_polled_at only advances on real change post-47205b6), any booking
 * time extracted, or any new row inserted since the last build. Three
 * indexed `.first()` reads.
 */
export const handoffsDirtySince = internalQuery({
  args: { sinceMs: v.number() },
  handler: async (ctx, { sinceMs }): Promise<boolean> => {
    const newest = await ctx.db.query("reservations").order("desc").first();
    if (newest && newest._creationTime > sinceMs) return true;
    const polled = await ctx.db
      .query("reservations")
      .withIndex("by_last_polled_at")
      .order("desc")
      .first();
    if (polled?.last_polled_at && polled.last_polled_at > sinceMs) return true;
    const timed = await ctx.db
      .query("reservations")
      .withIndex("by_times_extracted_at")
      .order("desc")
      .first();
    const timedAt = (timed as { times_extracted_at?: number } | null)?.times_extracted_at;
    if (timedAt && timedAt > sinceMs) return true;
    return false;
  },
});

/**
 * Yesterday/today/tomorrow dated+timed handover candidates across all accounts — the exact
 * candidate derivation from replyInbox.getImminentHandoffs' live loop,
 * minus the windowMin/minutes_away math (read-time concerns).
 */
export const computeHandoffCandidates = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ date: string; candidates: HandoffCandidate[] }> => {
    const nowDate = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
    const relevantDates = nearbyCalendarDates(nowDate);
    const candidates: HandoffCandidate[] = [];
    for (const st of ["confirmed", "ongoing"]) {
      const rows = await ctx.db
        .query("reservations")
        .withIndex("by_status", (qq) => qq.eq("status", st))
        .collect();
      for (const r of rows) {
        const a = r as Record<string, unknown>;
        if (a.is_obsolete) continue;
        const items = ((a.hygglo_items as Array<{ name: string }> | undefined) ?? [])
          .map((h) => h.name)
          .slice(0, 2);
        const base = {
          thread_id: (a.hygglo_order_id as string) ?? null,
          account_slug: (a.account_slug as string) ?? null,
          renter_name: (a.renter_name as string) ?? "renter",
          items,
        };
        const pd = (a.pickup_date as string) ?? (a.start_date as string);
        const pt = a.pickup_time as string | undefined;
        if (pd && relevantDates.has(pd) && pt) candidates.push({ ...base, kind: "pickup", date: pd, time: pt });
        const rd = (a.return_date as string) ?? (a.end_date as string);
        const rt = a.return_time as string | undefined;
        if (rd && relevantDates.has(rd) && rt) candidates.push({ ...base, kind: "return", date: rd, time: rt });
      }
    }
    return { date: nowDate, candidates };
  },
});

/**
 * Rebuild the 5-min operational rows (handoffs + active conflicts) when
 * needed. Called from mv/reply_queue.refreshAll (5-min cron + user-action
 * kicks). Gates: London date rolled over, a dirty probe hit, or the 30-min
 * age backstop — quiet ticks cost 1 tiny row read + 3 indexed probes.
 *
 * Conflicts ride the same gate because overbooking conflicts change exactly
 * when reservations change: getActiveConflicts' walle-signals cache is only
 * refreshed DAILY, so its 90-min trust window left the WallE widget running
 * a ~1.7MB live scan reactively on every reservation write × tab for most
 * of the day (live usage data, 2026-07-13).
 */
export async function refreshHandoffsWidget(
  ctx: ActionCtx,
  now: number,
): Promise<{ rebuilt: boolean }> {
  const row = await ctx.runQuery(anyApi.mv.widgets.get, { key: HANDOFFS_KEY });
  const nowDate = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  if (row) {
    const age = now - (row.generatedAt ?? 0);
    const sameDay = (row.payload as { date?: string } | null)?.date === nowDate;
    if (sameDay && age < HANDOFFS_BACKSTOP_MS) {
      const dirty: boolean = await ctx.runQuery(anyApi.mv.widgets.handoffsDirtySince, {
        sinceMs: row.generatedAt ?? 0,
      });
      if (!dirty) return { rebuilt: false };
    }
  }
  const payload = await ctx.runQuery(anyApi.mv.widgets.computeHandoffCandidates, {});
  await ctx.runMutation(anyApi.mv.widgets.writeWidget, {
    key: HANDOFFS_KEY,
    payload,
    generatedAt: now,
  });
  const conflicts = await ctx.runQuery(internal.dashboard_insights.__service_getActiveConflicts, {
    _bypassMv: true,
  });
  await ctx.runMutation(anyApi.mv.widgets.writeWidget, {
    key: "conflicts",
    payload: conflicts,
    generatedAt: now,
  });
  return { rebuilt: true };
}

// ──────────────────────────────────────────────────────────────
// SLOW tier — wrap-and-cache sell / price / bundles / tax.
// ──────────────────────────────────────────────────────────────

export async function refreshSlowWidgets(
  ctx: ActionCtx,
): Promise<{ ok: true; written: number }> {
  const startedAt = Date.now();
  let written = 0;
  const write = async (key: string, payload: unknown) => {
    await ctx.runMutation(anyApi.mv.widgets.writeWidget, {
      key,
      payload,
      generatedAt: startedAt,
    });
    written += 1;
  };

  for (const { key, arg } of SLUG_VARIANTS) {
    await write(
      `sell:${key}`,
      await ctx.runQuery(internal.items.__service_getSellRecommendations, {
        accountSlug: arg,
        _bypassMv: true,
      }),
    );
    await write(
      `price:${key}`,
      await ctx.runQuery(internal.items.__service_getPriceRecommendations, {
        accountSlug: arg,
        _bypassMv: true,
      }),
    );
    for (const days of CANONICAL_BUNDLE_WINDOWS) {
      await write(
        `bundles:${key}:${days}`,
        await ctx.runQuery(internal.bundles.__service_getTopBundles, {
          accountSlug: arg,
          days,
          _bypassMv: true,
        }),
      );
    }
  }

  const currentTaxYear = defaultStartYear();
  for (let i = 0; i < TAX_YEARS_CACHED; i++) {
    const y = currentTaxYear - i;
    await write(
      `tax:${y}`,
      await ctx.runQuery(internal.tax.__service_getTaxYearSummary, {
        startYear: y,
        _bypassMv: true,
      }),
    );
  }

  return { ok: true, written };
}
