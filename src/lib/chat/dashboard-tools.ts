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
  query_conflicts        — active double-bookings, not yet dismissed
  query_utilization      — top items by util-delta WoW (>=20% movers)
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
      description: "Active double-bookings (same item, overlapping dates) not yet dismissed.",
      inputSchema: z.object({}),
      execute: async () =>
        cached("conflicts:all", () =>
          convex.query(api.dashboard_insights.getActiveConflicts, {}),
        ),
    }),
    query_active_rentals: tool({
      description:
        "Rentals active RIGHT NOW — matches the dashboard 'Active Rentals' tile exactly. " +
        "Returns { total, ongoing, upcoming, pending_verification, pending_value_gbp }. " +
        "total = ongoing + upcoming. ongoing = currently out on rent; upcoming = confirmed but not started yet. " +
        "pending_verification is the tile's pending count (rentals awaiting verification) — NOT the decision " +
        "inbox; use query_pending for new requests awaiting your accept/decline.",
      inputSchema: z.object({}),
      execute: async () => {
        const d = await fetchDrawer(convex);
        const a = d.active ?? {};
        return {
          total: a.total,
          ongoing: a.ongoing_count,
          upcoming: a.upcoming_count,
          pending_verification: a.pending_count,
          pending_value_gbp: a.pending_value_gbp,
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
      description: "Top item utilization movers week-over-week (filtered to >=20% delta).",
      inputSchema: z.object({}),
      execute: async () =>
        cached("utilization:movers", () =>
          convex.query(api.dashboard_insights.getUtilizationDelta, {}),
        ),
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
