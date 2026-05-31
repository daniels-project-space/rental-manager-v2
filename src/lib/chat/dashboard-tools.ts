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
import { api } from "../../../convex/_generated/api";

/**
 * The grounding contract shared by both system prompts. Each widget prepends
 * its own persona/voice; this block carries the non-negotiable rules + the
 * authoritative tool list so neither widget can drift from the other.
 */
export const DASHBOARD_GROUNDING_RULES = `You have full read-only access to the live operational data via the tools below. ALWAYS call a tool before answering a data question; never guess at numbers. If a user's question is ambiguous between two tools, call both. Cite every number with its unit (£, %, items, days).

These tools read the SAME data the dashboard tiles render, so your numbers MUST match the tiles exactly. All revenue/earnings figures are NET take-home (after Hygglo ~36% fees) unless a field name says otherwise.

Tools:
  query_active_rentals   — rentals active NOW (the "Active Rentals" tile): total = ongoing + upcoming
  query_revenue          — revenue & earnings, all NET take-home, matching the dashboard revenue tiles exactly
  query_conflicts        — REAL overbooking conflicts (qty-aware, dismissals applied) — the dashboard's true count
  query_catalog          — inventory worth, out-of-stock, sell recommendations, qty drift (items/catalog cards)
  query_issues           — operational alerts: untracked, out-of-stock, qty drift, missed/denied revenue, insurance, capacity gaps, below-minimum
  query_utilization      — item utilization ranking (the "Item Utilization" card)
  query_pending          — new booking requests awaiting your accept/decline (decision inbox, not the tile's pending)
  query_funnel           — reservation conversion funnel for last N days
  query_calendar         — weekly calendar view (booked/free/partial)
  query_due_returns      — items overdue or due-soon for return
  query_recent_activity  — last N rental events (newest first)
  query_top_earners      — top items by ROI ranking
  query_smart_buys       — Smart-Buy ranking — items the model thinks Daniel should acquire`;

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
};

/** One rental row from the Active Rentals drawer (mv.stats_drawer.getRentals). */
type RentalRow = {
  item_names_summary?: string;
  renter_name?: string;
  start_date?: string;
  end_date?: string;
  net_gbp?: number;
};

function fetchDrawer(convex: ConvexHttpClient): Promise<DrawerData> {
  return cached("drawer:all", () =>
    convex.query(api.dashboard.getStatsDrawerData, { accountSlug: null }),
  ) as Promise<DrawerData>;
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
    query_conflicts: tool({
      description:
        "REAL overbooking conflicts, matching the dashboard's Critical Alerts. QTY-AWARE: only flags an item " +
        "when concurrent confirmed/tracked bookings exceed that item's quantity, with dismissed conflicts removed. " +
        "Returns { count, conflicts: [{ item, qty, overlap_count, start, end }] }. `count` is the TRUE conflict " +
        "count — do NOT inflate it; an item with qty 3 and 2 overlapping bookings is NOT a conflict.",
      inputSchema: z.object({}),
      execute: async () => {
        const d = await fetchDrawer(convex);
        const list = Array.isArray(d.conflicts) ? d.conflicts : [];
        return {
          count: list.length,
          conflicts: list.slice(0, 25).map((c) => ({
            item: c.item_canonical,
            qty: c.qty,
            overlap_count: c.overlap_count,
            start: c.conflict_start,
            end: c.conflict_end,
          })),
        };
      },
    }),
    query_active_rentals: tool({
      description:
        "Rentals active RIGHT NOW — matches the dashboard 'Active Rentals' tile. Returns counts " +
        "{ total, ongoing_count, upcoming_count, pending_verification } AND the REAL lists `ongoing` and " +
        "`upcoming` (each rental = { item, renter, start, end, net_gbp }). `ongoing` = items OUT right now " +
        "(start <= today <= end); `upcoming` = confirmed but not started yet. When asked what's out / happening " +
        "today, list the `ongoing` array verbatim. NEVER invent rentals, renters, dates or amounts — if a list " +
        "is empty, say there are none.",
      inputSchema: z.object({}),
      execute: async () => {
        const [d, rentalsRaw] = await Promise.all([
          fetchDrawer(convex),
          cached("rentals:list", () => convex.query(api.mv.stats_drawer.getRentals, {})),
        ]);
        const a = d.active ?? {};
        const groups =
          (rentalsRaw as unknown as {
            rentals?: { ongoing?: RentalRow[]; upcoming?: RentalRow[] };
          })?.rentals ?? {};
        const slim = (x: RentalRow) => ({
          item: x.item_names_summary,
          renter: x.renter_name,
          start: x.start_date,
          end: x.end_date,
          net_gbp: x.net_gbp,
        });
        return {
          total: a.total,
          ongoing_count: a.ongoing_count,
          upcoming_count: a.upcoming_count,
          pending_verification: a.pending_count,
          ongoing: (groups.ongoing ?? []).map(slim),
          upcoming: (groups.upcoming ?? []).slice(0, 15).map(slim),
        };
      },
    }),

    query_revenue: tool({
      description:
        "Revenue & earnings — ALL NET take-home (after Hygglo ~36% fees), pulled from the dashboard so they " +
        "match the revenue tiles exactly. Fields: month_confirmed_net_gbp = month-to-date confirmed revenue " +
        "(the 'Month Confirmed' tile — use this for 'this month's revenue / take-home'); current_earnings_net_gbp = " +
        "earned so far this month, gated by actual pickup; expected_monthly_net_gbp = projected month total " +
        "('Expected Monthly' tile); target_gbp + pct_of_target; earnings_today_net_gbp / earnings_week_net_gbp = " +
        "today's / this week's net earnings ('Earnings Today' tile).",
      inputSchema: z.object({}),
      execute: async () => {
        const d = await fetchDrawer(convex);
        const m = d.monthly ?? {};
        const e = d.earnings ?? {};
        const c = d.confirmed ?? {};
        return {
          month_confirmed_net_gbp: c.month_revenue ?? m.confirmed_revenue,
          current_earnings_net_gbp: m.current_earnings,
          expected_monthly_net_gbp: m.projected,
          target_gbp: m.target_gbp,
          pct_of_target: m.pct_of_target,
          earnings_today_net_gbp: e.today,
          earnings_week_net_gbp: e.week,
        };
      },
    }),
    query_utilization: tool({
      description:
        "Item utilization ranking, matching the dashboard 'Item Utilization' card. Returns rows of " +
        "{ name, utilization (0-1 fraction), idle_cost_per_week, replacement_cost_gbp }, lowest-utilization first.",
      inputSchema: z.object({}),
      execute: async () =>
        cached("util:ranking", () =>
          convex.query(api.dashboard_insights.getItemUtilizationRanking, { accountSlug: null }),
        ),
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
        "problems'. Returns overbooking conflicts, untracked rentals, out-of-stock, qty drift, missed & denied " +
        "revenue (NET £), open insurance claims, and capacity-gap / below-minimum / voluntary-deny alerts. All " +
        "counts are the true dashboard figures.",
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
    query_top_earners: tool({
      description: "Top items by ROI ranking.",
      inputSchema: z.object({
        limit: z.number().min(1).max(30).optional(),
      }),
      execute: async ({ limit }: { limit?: number }) => {
        const l = limit ?? 10;
        return cached(`roi:${l}`, () =>
          convex.query(api.intel.getItemROIRanking, { limit: l }),
        );
      },
    }),
    query_smart_buys: tool({
      description: "Items the Smart-Buy model thinks Daniel should acquire next.",
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
  };
}
