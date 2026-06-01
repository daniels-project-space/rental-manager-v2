/**
 * Shared dashboard chat grounding — single source of truth for BOTH chat
 * surfaces:
 *   - src/app/api/chat/route.ts        ("AI Assistant" widget)
 *   - src/app/api/walle/chat/route.ts  (WallE bot widget)
 *
 * WHY THIS EXISTS (2026-05-31):
 *   The two routes had drifted: the assistant exposed 10 read-only Convex
 *   query tools and forced a tool call for every data question, while WallE
 *   exposed only 5 tools AND injected a pre-rendered metrics "snapshot" that
 *   it was told to prefer over fresh tool calls. Result: WallE answered
 *   headline questions from a stale, independently-computed blob and
 *   fabricated anything outside its 5 tools. Pulling the tool registry and
 *   the grounding contract into one module guarantees the two widgets answer
 *   from the same live data with the same discipline — and stops the surfaces
 *   diverging again.
 *
 * TOOL CONTRACT: every tool here is READ-ONLY (Convex `query` only — never
 * `mutation`/`action` that writes). Adding a write tool requires explicit
 * Daniel approval. Reviewers: reject PRs that introduce mutations here.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { api } from "../../../convex/_generated/api";

// The income-pie functions are recent additions that the committed
// `convex/_generated/api` lags behind (the perf-passes work keeps it stale), so
// referencing them through the typed `api` object breaks the local build. They
// are deployed on prod and power the dashboard income pie, so reference them by
// name — robust against generated-api drift, identical behaviour at runtime.
const getRentalVolumeByCategoryRef = makeFunctionReference<"query">(
  "dashboard:getRentalVolumeByCategory",
);
const getRentalVolumeKindBreakdownRef = makeFunctionReference<"query">(
  "dashboard:getRentalVolumeKindBreakdown",
);

/**
 * The grounding contract shared by both system prompts. Each widget prepends
 * its own persona/voice; this block carries the non-negotiable rules + the
 * authoritative tool list so neither widget can drift from the other.
 */
export const DASHBOARD_GROUNDING_RULES = `GROUNDING — read this before every answer.

The LIVE DASHBOARD SNAPSHOT below the persona is the ONLY data you have without calling a tool. It contains EXACTLY: the active-rentals count, the ongoing and upcoming rental list (each with renter, pickup + return date/time/method and £net), today's pickups/deliveries and returns, month-to-date NET revenue & earnings vs target, today's and this-week's earnings, overbooking conflicts, the count of pending requests, and stock / out-of-stock / untracked / insurance counts. QUOTE THESE DIRECTLY — never recompute, re-derive or override them. All money is NET take-home (after Hygglo ~36% fees).

For ANYTHING NOT in that list you MUST call the matching tool and answer ONLY from what it returns this turn. You do NOT know — and must NEVER guess, estimate, extrapolate, or recall from earlier — any of: per-item earnings, an item's utilization %, idle cost, inventory worth, what to buy or sell, revenue trends, the conversion funnel, missed/denied revenue, catalog / out-of-stock detail, due returns, recent activity, or tax/KPIs. Stating any such figure without having called its tool this turn is fabrication — the single worst thing you can do here. In particular there is NO utilization percentage anywhere except the value query_utilization returns for the handful of idle-ranked items; never invent an "X% rented" figure, and never quote a per-item £ amount from memory.

If a tool didn't give you a number, say you don't have it rather than inventing one. Cite every number with its unit (£, %, items, days) and the window it covers. Respect each tool's stated sort order and field meanings; don't re-rank or recompute (e.g. "Idle Inventory" is ranked by idle £/week, not utilization; per-item income is already cost-proportional; "best earner" = most NET income).

Sanity-check a figure before you state it. A percentage or rate is 0–100%; if a tool returns a rate above 100%, a negative count, or two metrics that should differ but come back essentially identical (e.g. missed vs denied revenue to the penny), that is almost certainly a DATA GLITCH — say so plainly and give the raw figure, do NOT present it as a real result or invent a business reason for it. Also treat "overdue returns" with care: the list can include old rentals that were physically returned but never marked, so describe a long overdue list as "may include unreconciled past rentals" rather than asserting that much gear is genuinely out.

Worked example — for "should I buy another X / is X worth getting / how is X doing / what should I buy", call query_item_earnings (window 30 or 365) for X's real NET income, query_utilization for its idle cost/utilization, and query_smart_buys for unmet-demand picks, THEN reason from those numbers. Never answer a buy/sell/performance question from the snapshot alone.

Drill-down tools:
  query_item_earnings    — per-item income, cost-proportional (the income pie's method; NET); 'best earner' / 'how much did item X make'; window 30/90/365
  query_income_distribution — income split across categories (the income pie; NET); window 30/90/365
  query_catalog          — inventory worth, out-of-stock items list, sell recommendations, qty drift
  query_issues           — missed/denied revenue, qty drift, capacity gaps, below-minimum, voluntary-deny
  query_utilization      — Idle Inventory: items costing the most while idle (sorted by idle £/week)
  query_due_returns      — items overdue or due-soon for return
  query_pending          — the full list of booking requests awaiting your accept/decline
  query_recent_activity  — last N rental events (newest first)
  query_funnel           — reservation conversion funnel for last N days
  query_calendar         — weekly calendar (booked/free/partial)
  query_smart_buys       — NEW items to acquire (unmet demand, ROI-sorted)
  query_revenue_trend    — weekly NET revenue trend
  query_status           — UK tax estimate, business-intel KPIs, scanner, vacation, AI-Boost (£0 by design)`;

/**
 * Matches user questions whose answer is NOT in the headline snapshot (per-item
 * earnings, utilization/idle, buy/sell, trends, issues, catalog, funnel, tax…).
 * Both chat routes force `toolChoice:'required'` on the first step when this
 * matches, so DeepSeek-chat (toolChoice:auto) can't answer from the snapshot
 * alone and confabulate the numbers — it ignored the prompt's "never invent"
 * rule on a bad roll. Deliberately broad: a false positive costs one extra
 * grounded tool call; a false negative risks a fabricated figure. Shared here
 * so the two surfaces can't drift.
 */
export const ANALYTICAL_INTENT =
  /\b(buy|buying|bought|purchas|invest|acqui|sell|selling|sold|worth|earn|earning|income|profit|roi|return on|best|worst|top|how much (did|does|has)|per[- ]?item|utili[sz]|idle|unused|sitting|under[- ]?used|trend|growing|declin|missed|denied|lost|capacity|below[- ]?min|funnel|conver|catalog|inventor|out[- ]?of[- ]?stock|overdue|due (back|return)|tax|kpi|recommend|should i)\b/i;

// ── Module-scoped 60s TTL cache (Phase 7b, 2026-05-24) ──────────────────────
// Saves re-fetching aggregated data within a single multi-step LLM turn AND
// across concurrent chat turns landing within 60s of each other. Applied only
// to read-only aggregates that don't change minute-to-minute. Live state
// (pending, due_returns) is intentionally uncached so Daniel sees the freshest
// action queue. Shared across both chat routes — same Convex aggregates, so a
// shared cache is correct and cheaper.
type CacheEntry = { value: unknown; exp: number };
const TOOL_CACHE = new Map<string, CacheEntry>();
const TOOL_CACHE_TTL_MS = 60_000;

/** Hygglo take-home ≈ 64% of gross. The income-pie queries
 *  (getRentalVolumeByCategory / getRentalVolumeKindBreakdown) return
 *  GROSS-attributed revenue, so per-item / per-category figures are × this to
 *  report NET take-home (the distribution / ranking is identical either way). */
const OWNER_SHARE = 0.64;

async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = TOOL_CACHE.get(key);
  if (hit && hit.exp > now) return hit.value as T;
  const fresh = await fetcher();
  TOOL_CACHE.set(key, { value: fresh, exp: now + TOOL_CACHE_TTL_MS });
  // Opportunistic GC: drop the oldest 25% of entries once the map crosses 200.
  if (TOOL_CACHE.size > 200) {
    const oldest = [...TOOL_CACHE.entries()]
      .sort((a, b) => a[1].exp - b[1].exp)
      .slice(0, 50);
    for (const [k] of oldest) TOOL_CACHE.delete(k);
  }
  return fresh;
}

/**
 * The dashboard's "Active Rentals" tile AND every revenue/earnings tile render
 * from ONE Convex query: `dashboard.getStatsDrawerData`. The chat tools read
 * that exact query (cached 60s) so the chatbot's numbers match the tiles by
 * construction — NET take-home, pickup-gated, deduped — instead of the older
 * `dashboard_insights` gross / start-date logic that drifted from reality.
 */
type DrawerData = {
  active?: {
    total?: number;
    ongoing_count?: number;
    upcoming_count?: number;
    pending_count?: number;
    pending_value_gbp?: number;
  };
  // Live getStatsDrawerData(_bypassMv) returns the rental lists inline (the MV
  // strips them into a separate, staler row). Read them here so the snapshot's
  // list and counts always come from the same live computation.
  ongoing?: { count?: number; rentals?: RentalRow[] };
  upcoming?: { count?: number; rentals?: RentalRow[] };
  monthly?: {
    confirmed_revenue?: number;
    current_earnings?: number;
    projected?: number;
    target_gbp?: number;
    pct_of_target?: number;
    avg_daily_rate?: number;
    days_remaining?: number;
  };
  earnings?: { today?: number; week?: number };
  confirmed?: { month_revenue?: number; month_label?: string };
  conflicts?: Array<{
    item_canonical?: string;
    qty?: number;
    overlap_count?: number;
    conflict_start?: string;
    conflict_end?: string;
    reservations?: unknown[];
  }>;
  untracked?: { count?: number; total_value_gbp?: number };
  out_of_stock?: { count?: number; items?: Array<Record<string, unknown>> };
  inventory_worth?: { total_gbp?: number; by_category?: Array<Record<string, unknown>> };
  sell_reco?: { recommendations?: Array<Record<string, unknown>> };
  qty_drift_count?: number;
  qty_drift_sample?: Array<Record<string, unknown>>;
  missed_revenue?: { total_gbp?: number; items?: unknown[] };
  denied_revenue?: { total_gbp?: number; items?: unknown[] };
  insurance?: {
    open_count?: number;
    open_amount_gbp?: number;
    settled_count_ytd?: number;
    total_count?: number;
  };
  business_intel?: { kpis?: Array<Record<string, unknown>> };
  tax?: { years?: Array<{ year?: number; estimated_tax?: number; gross?: number }> };
  scanner?: {
    last_run_succeeded?: boolean;
    last_scan_source?: string;
    rows_upserted_last?: number;
  };
  vacation?: { active_blocks?: unknown[] };
  ai_boost?: {
    breakdown?: Array<{ label?: string; gbp?: number; weight?: number }>;
    confidence?: string;
  };
};

/** One rental row from the Active Rentals drawer (mv.stats_drawer.getRentals). */
type RentalRow = {
  item_names_summary?: string;
  renter_name?: string;
  account_slug?: string;
  start_date?: string;
  end_date?: string;
  pickup_date?: string;
  pickup_time?: string;
  pickup_method?: string;
  return_date?: string;
  return_time?: string;
  return_method?: string;
  net_gbp?: number;
};

function fetchDrawer(convex: ConvexHttpClient): Promise<DrawerData> {
  // _bypassMv:true → LIVE compute, NOT the hourly `mv_stats_drawer` cache. That
  // cache goes stale for hours: its dirty-probe only scans the 50 most-recent
  // reservations by future start_date, so a status change on a past/ongoing
  // rental (ended/cancelled) never marks it dirty and the rebuild is skipped.
  // The chat MUST reflect the live reservations table (≤5 min behind Hygglo),
  // not an old snapshot. Chat is low-volume so the live compute cost is fine.
  return cached("drawer:live", () =>
    convex.query(api.dashboard.getStatsDrawerData, {
      accountSlug: null,
      _bypassMv: true,
    } as { accountSlug: string | null }),
  ) as Promise<DrawerData>;
}

/**
 * v1-style compute-then-phrase: build ONE live snapshot of the headline
 * dashboard figures as plain text, injected into the chat system prompt so the
 * model quotes trusted numbers instead of choosing among tools and re-deriving
 * them. Everything here is the dashboard's own LIVE value (matches the tiles).
 */
export async function buildLiveSnapshot(convex: ConvexHttpClient): Promise<string> {
  const [d, pendingRaw] = await Promise.all([
    fetchDrawer(convex),
    cached("pending:inbox", () =>
      convex.query(api.reservations.listPendingWithoutDecision, { limit: 500 }),
    ),
  ]);
  const pendingInbox = Array.isArray(pendingRaw) ? pendingRaw.length : 0;
  const a = d.active ?? {};
  const m = d.monthly ?? {};
  const e = d.earnings ?? {};
  const c = d.confirmed ?? {};
  const asOf = new Date().toISOString().slice(0, 16).replace("T", " ");
  const today = asOf.slice(0, 10);
  // net_gbp is NET-to-owner (after Hygglo fees); the per-rental gross/listing
  // price is not in this payload. Each line carries pickup AND return date+time+
  // method so the model never guesses "out today / back today" from start/end.
  const fmt = (x: RentalRow) => {
    const pick = `${x.pickup_date ?? x.start_date ?? "?"}${x.pickup_time ? " " + x.pickup_time : ""}${x.pickup_method ? " (" + x.pickup_method + ")" : ""}`;
    const ret = `${x.return_date ?? x.end_date ?? "?"}${x.return_time ? " " + x.return_time : ""}${x.return_method ? " (" + x.return_method + ")" : ""}`;
    return `${x.item_names_summary ?? "item"} — ${x.renter_name ?? "renter"}${x.account_slug ? ` [${x.account_slug}]` : ""}: pickup ${pick} → return ${ret}, £${x.net_gbp ?? "?"} net`;
  };
  // Lists from the SAME live payload as the counts → always consistent.
  const ongoing = (d.ongoing?.rentals ?? []).map(fmt);
  const upcoming = (d.upcoming?.rentals ?? []).map(fmt);
  // Today's actual pickups/deliveries and returns, keyed off pickup_date /
  // return_date (NOT order_step — every row reads "DELIVERED" so it's useless).
  // A rental whose start_date == today is collected/delivered TODAY (it is NOT
  // "already out" — check pickup_time vs the as-of time above).
  const allActive = [...(d.ongoing?.rentals ?? []), ...(d.upcoming?.rentals ?? [])];
  const ev = (x: RentalRow, t?: string, meth?: string) =>
    `${x.item_names_summary ?? "item"} — ${x.renter_name ?? "renter"}${x.account_slug ? ` [${x.account_slug}]` : ""}, ${t ?? "time TBC"}${meth ? ` via ${meth}` : ""}, £${x.net_gbp ?? "?"} net`;
  const pickupsToday = allActive
    .filter((x) => (x.pickup_date ?? x.start_date) === today)
    .map((x) => ev(x, x.pickup_time, x.pickup_method));
  const returnsToday = allActive
    .filter((x) => (x.return_date ?? x.end_date) === today)
    .map((x) => ev(x, x.return_time, x.return_method));
  const conflicts = Array.isArray(d.conflicts) ? d.conflicts : [];
  return [
    `LIVE DASHBOARD SNAPSHOT (the dashboard's own current figures as of ${asOf} UTC — quote these directly, never recompute or override them):`,
    `- Active rentals: ${a.total ?? 0} total = ${a.ongoing_count ?? 0} ongoing + ${a.upcoming_count ?? 0} upcoming.`,
    ongoing.length ? `  Ongoing (out or going out within their window): ${ongoing.join(" | ")}.` : `  Ongoing: nothing.`,
    upcoming.length ? `  Upcoming: ${upcoming.join(" | ")}.` : `  Upcoming: none.`,
    pickupsToday.length
      ? `- PICKUPS / DELIVERIES TODAY (${today}) — items being collected/delivered today (NOT necessarily out yet; compare the pickup time to the as-of time): ${pickupsToday.join(" | ")}.`
      : `- Pickups/deliveries today: none.`,
    returnsToday.length
      ? `- RETURNS TODAY (${today}) — items coming back today: ${returnsToday.join(" | ")}.`
      : `- Returns today: none.`,
    `- Month-to-date confirmed revenue (NET take-home): £${c.month_revenue ?? m.confirmed_revenue ?? "?"}. Earned so far this month (pickup-gated): £${m.current_earnings ?? "?"}. Target £${m.target_gbp ?? "?"} (${m.pct_of_target ?? "?"}% of target).`,
    `- Earnings: today £${e.today ?? 0} net, this week £${e.week ?? 0} net.`,
    conflicts.length
      ? `- Overbooking conflicts (REAL, qty-aware): ${conflicts.length} — ${conflicts.map((x) => `${x.item_canonical} (qty ${x.qty}, ${x.overlap_count} overlapping) on ${x.conflict_start}`).join("; ")}.`
      : `- Overbooking conflicts: 0.`,
    `- New booking requests awaiting your accept/decline: ${pendingInbox}. Out of stock: ${d.out_of_stock?.count ?? 0}. Untracked rentals: ${d.untracked?.count ?? 0}. Open insurance claims: ${d.insurance?.open_count ?? 0}.`,
  ].join("\n");
}

/**
 * Builds the AI SDK v6 tool registry. Caller supplies a ConvexHttpClient so
 * each route can reuse one client per request. This is the ONE place the
 * dashboard tools are defined.
 *
 * NOTE: getPipelineCounts is an internalQuery (not callable from HTTP), so the
 * "pipeline" surface is exposed via getConversionFunnel instead.
 */
export function buildDashboardTools(convex: ConvexHttpClient): Record<string, Tool> {
  return {
    query_utilization: tool({
      description:
        "Idle Inventory — the items COSTING the most money while sitting unused (the dashboard 'Idle Inventory' " +
        "card). Sorted by idle_cost_per_week_gbp DESC (biggest money-drain first); top items only. Each: " +
        "{ name, utilization (0-1 = fraction of time rented), idle_cost_per_week_gbp, replacement_cost_gbp }. " +
        "The top row is the biggest idle-money drain (expensive AND under-used) — it is NOT necessarily the " +
        "single lowest-utilization item. Don't re-rank; report in the order given.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = (await cached("util:ranking", () =>
          convex.query(api.dashboard_insights.getItemUtilizationRanking, { accountSlug: null }),
        )) as unknown as Array<{
          name?: string;
          utilization?: number;
          idle_cost_per_week?: number;
          replacement_cost_gbp?: number;
        }>;
        return {
          items: (Array.isArray(rows) ? rows : []).map((r) => ({
            name: r.name,
            utilization: r.utilization,
            idle_cost_per_week_gbp: r.idle_cost_per_week,
            replacement_cost_gbp: r.replacement_cost_gbp,
          })),
        };
      },
    }),

    query_catalog: tool({
      description:
        "Inventory / catalog snapshot, matching the dashboard cards. Returns { inventory_worth_gbp, " +
        "inventory_by_category, out_of_stock_count, out_of_stock_items, sell_recommendations, qty_drift_count }. " +
        "out_of_stock = items currently held >= their quantity; sell_recommendations = items the dashboard " +
        "suggests selling (low utilization / aged).",
      inputSchema: z.object({}),
      execute: async () => {
        const d = await fetchDrawer(convex);
        return {
          inventory_worth_gbp: d.inventory_worth?.total_gbp,
          inventory_by_category: (d.inventory_worth?.by_category ?? []).slice(0, 25),
          out_of_stock_count: d.out_of_stock?.count,
          out_of_stock_items: (d.out_of_stock?.items ?? []).slice(0, 25),
          sell_recommendations: (d.sell_reco?.recommendations ?? []).slice(0, 25),
          qty_drift_count: d.qty_drift_count,
          qty_drift_sample: (d.qty_drift_sample ?? []).slice(0, 10),
        };
      },
    }),

    query_issues: tool({
      description:
        "Operational issues / alerts, matching the dashboard alert cards. Use for 'what needs attention / any " +
        "problems'. Returns overbooking conflicts, untracked rentals, out-of-stock, qty drift, denied revenue " +
        "(NET £ of requests explicitly DECLINED) and missed revenue (NET £ theoretical idle-capacity opportunity " +
        "— gear sitting unused), open insurance claims, and capacity-gap / below-minimum / voluntary-deny alerts. " +
        "denied_revenue and missed_revenue are DISTINCT, NOT additive: one is turned-away demand, the other is idle " +
        "capacity. NOTE: denied_revenue is a LIFETIME total — the denial history was backfilled on a single import " +
        "date and the records carry no per-event date, so describe it as all-time declined demand, NEVER as 'this " +
        "month' or 'last 30 days'. All other counts are the true dashboard figures.",
      inputSchema: z.object({}),
      execute: async () => {
        const [d, capacityGaps, belowMin, voluntaryDeny] = await Promise.all([
          fetchDrawer(convex),
          cached("cap:gap", () =>
            convex.query(api.dashboard_insights.getCapacityGapAlert, { accountSlug: null }),
          ),
          cached("below:min", () =>
            convex.query(api.dashboard_insights.getBelowMinimumCounter, { accountSlug: null }),
          ),
          cached("vol:deny", () =>
            convex.query(api.dashboard_insights.getVoluntaryDenyHotList, { accountSlug: null }),
          ),
        ]);
        const conflicts = Array.isArray(d.conflicts) ? d.conflicts : [];
        return {
          overbooking_conflicts: conflicts.length,
          untracked_rentals: d.untracked?.count,
          out_of_stock_count: d.out_of_stock?.count,
          qty_drift_count: d.qty_drift_count,
          missed_revenue_gbp: d.missed_revenue?.total_gbp,
          denied_revenue_gbp: d.denied_revenue?.total_gbp,
          open_insurance_claims: d.insurance?.open_count,
          open_insurance_amount_gbp: d.insurance?.open_amount_gbp,
          capacity_gap_count: Array.isArray(capacityGaps) ? capacityGaps.length : capacityGaps,
          below_minimum: belowMin,
          voluntary_deny_count: Array.isArray(voluntaryDeny) ? voluntaryDeny.length : voluntaryDeny,
        };
      },
    }),
    query_pending: tool({
      description:
        "Daniel's DECISION INBOX — new booking requests awaiting his accept/decline (status 'pending_review', " +
        "no AI decision row yet). This is NOT the 'Active Rentals' tile's pending count (that is pending-verification, " +
        "available via query_active_rentals). Returns { total_awaiting_decision, items }. ALWAYS report " +
        "total_awaiting_decision as THE count; `items` is only a capped preview, never the count.",
      inputSchema: z.object({
        sample: z
          .number()
          .min(1)
          .max(50)
          .optional()
          .describe("How many rows to include in the preview list; default 10. Does NOT affect total_awaiting_decision."),
      }),
      execute: async ({ sample }: { sample?: number }) => {
        // Fetch the full pending set (high cap) so total_awaiting_decision is the
        // TRUE count, not a limit artifact. This tool previously returned a bare,
        // limit-capped array with no total — so models reported the cap (e.g. 10)
        // or miscounted (5) while the real number was 17. Returning an explicit
        // total makes both chat widgets report the same correct count.
        const all = await convex.query(api.reservations.listPendingWithoutDecision, { limit: 500 });
        const items = Array.isArray(all) ? all : [];
        return { total_awaiting_decision: items.length, items: items.slice(0, sample ?? 10) };
      },
    }),
    query_funnel: tool({
      description:
        "Reservation conversion funnel for the last N days. Returns bookings / declines / cancellations.",
      inputSchema: z.object({
        days: z.number().min(1).max(180).optional().describe("Lookback days; default 30."),
      }),
      execute: async ({ days }: { days?: number }) => {
        const d = days ?? 30;
        return cached(`funnel:${d}`, () =>
          convex.query(api.reservations.getConversionFunnel, {
            accountSlug: null,
            days: d,
          }),
        );
      },
    }),
    query_calendar: tool({
      description: "Weekly calendar — items booked / partial / free over the next 7 days.",
      inputSchema: z.object({}),
      execute: async () => {
        const weekStartDate = new Date().toISOString().slice(0, 10);
        return cached(`calendar:${weekStartDate}`, () =>
          convex.query(api.calendar.getWeeklyCalendar, {
            accountSlug: null,
            weekStartDate,
          }),
        );
      },
    }),
    query_due_returns: tool({
      description: "Items overdue or due-soon for return.",
      inputSchema: z.object({}),
      execute: async () => convex.query(api.reservations.getDueReturns, { accountSlug: null }),
    }),
    query_recent_activity: tool({
      description: "Newest rental events (status changes, new bookings, etc).",
      inputSchema: z.object({
        limit: z.number().min(1).max(50).optional(),
      }),
      execute: async ({ limit }: { limit?: number }) =>
        convex.query(api.reservations.getRecentActivity, {
          accountSlug: null,
          limit: limit ?? 15,
        }),
    }),
    query_item_earnings: tool({
      description:
        "Per-item income using the dashboard's COST-PROPORTIONAL attribution — the SAME method the income pie " +
        "uses: each rental's income is split across the items in that rental in proportion to each item's " +
        "value/cost (so an expensive camera in a set earns most of that rental, a cheap accessory little). NET " +
        "take-home. This is the CORRECT source for 'who earns the most / how much did item X make' — items are " +
        "sorted by net_gbp desc, each { name, kind, rentals, net_gbp, share_pct }. Args: window_days 30/90/365 " +
        "(default 365 = last 12 months). For 'last month' use 30. There is no exact calendar-month or >365-day " +
        "figure, so state the window you used (e.g. 'over the last year').",
      inputSchema: z.object({
        window_days: z.number().optional().describe("30, 90, or 365. Default 365."),
      }),
      execute: async ({ window_days }: { window_days?: number }) => {
        const days = window_days === 30 || window_days === 90 ? window_days : 365;
        const cat = (await cached(`pie:${days}`, () =>
          convex.query(getRentalVolumeByCategoryRef, { accountSlug: null, days }),
        )) as unknown as { slices?: Array<{ kind?: string }> };
        const kinds = (cat.slices ?? [])
          .map((s) => s.kind)
          .filter((k): k is string => typeof k === "string");
        const breakdowns = await Promise.all(
          kinds.map((kind) =>
            cached(`brk:${days}:${kind}`, () =>
              convex.query(getRentalVolumeKindBreakdownRef, {
                accountSlug: null,
                days,
                kind,
              }),
            ),
          ),
        );
        type Brk = { items?: Array<{ name?: string; count?: number; revenue?: number }> };
        const items: Array<{ name?: string; kind: string; rentals?: number; net_gbp: number }> = [];
        breakdowns.forEach((bRaw, i) => {
          const b = bRaw as unknown as Brk;
          (b.items ?? []).forEach((it) => {
            items.push({
              name: it.name,
              kind: kinds[i],
              rentals: it.count,
              net_gbp: Math.round((it.revenue ?? 0) * OWNER_SHARE * 100) / 100,
            });
          });
        });
        items.sort((a, b) => b.net_gbp - a.net_gbp);
        const totalNet = items.reduce((s, it) => s + it.net_gbp, 0);
        return {
          window_days: days,
          window_note: days === 30 ? "last 30 days" : days === 90 ? "last 90 days" : "last 12 months",
          total_net_gbp: Math.round(totalNet * 100) / 100,
          items: items.map((it) => ({
            name: it.name,
            kind: it.kind,
            rentals: it.rentals,
            net_gbp: it.net_gbp,
            share_pct: totalNet > 0 ? Math.round((it.net_gbp / totalNet) * 1000) / 10 : 0,
          })),
        };
      },
    }),

    query_income_distribution: tool({
      description:
        "Income distribution across CATEGORIES — the dashboard income pie. Uses cost-proportional attribution " +
        "(each rental's income split across its items by item value), NET take-home. Returns categories sorted " +
        "by income (£) DESC: { category, net_gbp, share_pct, rentals }. NOTE: the on-screen pie orders its " +
        "slices by rental COUNT, so the visual slice order can differ — use the £ here for 'which category earns " +
        "most'. Args: window_days 30/90/365 (default 30, matching the pie). For per-ITEM breakdown use " +
        "query_item_earnings.",
      inputSchema: z.object({
        window_days: z.number().optional().describe("30, 90, or 365. Default 30 (matches the pie)."),
      }),
      execute: async ({ window_days }: { window_days?: number }) => {
        const days = window_days === 90 || window_days === 365 ? window_days : 30;
        const cat = (await cached(`pie:${days}`, () =>
          convex.query(getRentalVolumeByCategoryRef, { accountSlug: null, days }),
        )) as unknown as {
          slices?: Array<{ kind?: string; label?: string; revenue?: number; count?: number }>;
        };
        const slices = (cat.slices ?? []).map((s) => ({
          category: s.label ?? s.kind,
          net_gbp: Math.round((s.revenue ?? 0) * OWNER_SHARE * 100) / 100,
          rentals: s.count,
        }));
        const totalNet = slices.reduce((sum, s) => sum + s.net_gbp, 0);
        return {
          window_days: days,
          total_net_gbp: Math.round(totalNet * 100) / 100,
          categories: slices
            .sort((a, b) => b.net_gbp - a.net_gbp)
            .map((s) => ({
              category: s.category,
              net_gbp: s.net_gbp,
              rentals: s.rentals,
              share_pct: totalNet > 0 ? Math.round((s.net_gbp / totalNet) * 1000) / 10 : 0,
            })),
        };
      },
    }),
    query_smart_buys: tool({
      description:
        "Smart-Buy ranking — NEW items to acquire (driven by unmet demand for gear Daniel does NOT already own), " +
        "sorted by first-year ROI DESC. Each: { itemName, recommendation, requestCount, estAnnualNetGbp, " +
        "estDailyRateGbp, firstYearROIPct, estAcquisitionCostGbp }. Use for 'what should I buy'. For 'should I " +
        "buy ANOTHER X' (already owned), use query_item_earnings + query_utilization instead.",
      inputSchema: z.object({
        limit: z.number().min(1).max(30).optional(),
      }),
      execute: async ({ limit }: { limit?: number }) => {
        const l = limit ?? 10;
        return cached(`smart_buys:${l}`, () =>
          convex.query(api.intel.getSmartBuyRanking, { limit: l }),
        );
      },
    }),

    query_revenue_trend: tool({
      description:
        "Weekly NET revenue trend — the revenue sparkline. Returns recent weeks oldest→newest, each " +
        "{ week_start, net_gbp }. Use for 'how is revenue trending / weekly revenue / the last few weeks'.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = (await cached("spark:weekly", () =>
          convex.query(api.dashboard_insights.getWeeklyRevenueSparkline, { accountSlug: null }),
        )) as unknown as Array<{ week_start?: string; revenue_net_gbp?: number }>;
        return {
          weeks: (Array.isArray(rows) ? rows : []).map((r) => ({
            week_start: r.week_start,
            net_gbp: r.revenue_net_gbp,
          })),
        };
      },
    }),

    query_status: tool({
      description:
        "Misc dashboard status: estimated UK tax per year (tax_years: { year, estimated_tax_gbp, gross_gbp }), " +
        "business-intel KPIs (e.g. top unmet demand, renter churn risk), the data-scanner state, vacation " +
        "blocks, and AI-Boost credit. AI Boost is £0 by design (the AI-approval pipeline is unbuilt in dev) — " +
        "report it honestly as £0; do NOT explain it away or inflate it.",
      inputSchema: z.object({}),
      execute: async () => {
        const d = await fetchDrawer(convex);
        const aiCredit = (d.ai_boost?.breakdown ?? []).reduce((s, b) => s + (b.gbp ?? 0), 0);
        return {
          tax_years: (d.tax?.years ?? []).map((y) => ({
            year: y.year,
            estimated_tax_gbp: y.estimated_tax,
            gross_gbp: y.gross,
          })),
          business_intel_kpis: d.business_intel?.kpis ?? [],
          scanner: d.scanner
            ? {
                healthy: d.scanner.last_run_succeeded,
                source: d.scanner.last_scan_source,
                rows_upserted_last_run: d.scanner.rows_upserted_last,
              }
            : undefined,
          vacation_active_blocks: d.vacation?.active_blocks?.length ?? 0,
          ai_boost_credit_gbp: Math.round(aiCredit * 100) / 100,
        };
      },
    }),
  };
}
