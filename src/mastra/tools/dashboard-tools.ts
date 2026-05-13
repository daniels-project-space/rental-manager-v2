/**
 * Mastra tool wrappers for the dashboard-chat agent.
 *
 * All business logic lives in `@/mastra/data` — the shared data layer that
 * will be reused by the polling agent (Wave 4) and renter-bot (Wave 5).
 *
 * Each tool below is a thin shim that:
 *   1. Declares the tool id, prose description (used by the intent router),
 *      and Zod input schema.
 *   2. Forwards execute() to the matching data-layer function.
 *
 * Wave 2 changes (Q3 account scoping):
 *   - Every rental/revenue/lost-revenue tool now accepts optional
 *     `account: 'leo' | 'dbcinema'`. Omitted = combined across both accounts
 *     (Wave 1 behaviour preserved exactly).
 *   - 14 new tools added (see "Wave 2 — new tools" section).
 */
import "server-only";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as data from "@/mastra/data";

// Shared zod fragment for optional account scoping (Wave 2 Q3).
const accountField = {
  account: z
    .enum(["dbcinema", "leo"])
    .optional()
    .describe(
      "Limit to one account. Omit to combine both. Pass 'leo' or 'dbcinema' only when the user explicitly mentions which account.",
    ),
};
const accountSuffix =
  " Pass `account: 'leo'` or `account: 'dbcinema'` when the user explicitly mentions which account; omit to combine both.";

// ─────────────────────────────────────────────────────────────────────────
// Group A: Read-only, all data in Convex (Wave 1 — now account-scoped)
// ─────────────────────────────────────────────────────────────────────────

export const getDashboardStats = createTool({
  id: "get_dashboard_stats",
  description:
    "Live today/week/month earnings, active rental counts, pending decisions, plus weekly net-to-owner series and insurance payouts." +
    accountSuffix,
  inputSchema: z.object(accountField),
  execute: async (input: { account?: "leo" | "dbcinema" }) =>
    data.revenue.getDashboardStats(input),
});

export const lookupPricing = createTool({
  id: "lookup_pricing",
  description: "Get daily rate and multi-day totals for a rental item.",
  inputSchema: z.object({
    itemName: z.string(),
    days: z.number().int().min(1).optional(),
  }),
  execute: async (input: { itemName: string; days?: number }) =>
    data.catalog.lookupPricing(input),
});

export const checkAvailability = createTool({
  id: "check_availability",
  description:
    "Check item availability for dates. Returns available qty and next free date if booked.",
  inputSchema: z.object({
    itemName: z.string(),
    startDate: z.string().describe("YYYY-MM-DD"),
    endDate: z.string().describe("YYYY-MM-DD"),
  }),
  execute: async (input: {
    itemName: string;
    startDate: string;
    endDate: string;
  }) => data.catalog.checkAvailability(input),
});

export const getPendingRentals = createTool({
  id: "get_pending_rentals",
  description:
    "Fetch pending rental requests awaiting accept/decline decision." +
    accountSuffix,
  inputSchema: z.object(accountField),
  execute: async (input: { account?: "leo" | "dbcinema" }) =>
    data.rentals.getPendingRentals(input),
});

export const getBusinessIntelligence = createTool({
  id: "get_business_intelligence",
  description:
    "Purchase recommendations, demand signals, denied-rental patterns, investment analysis." +
    accountSuffix,
  inputSchema: z.object(accountField),
  execute: async (input: { account?: "leo" | "dbcinema" }) =>
    data.revenue.getBusinessIntelligence(input),
});

// Group B: Compatibility + reading

export const checkCompatibility = createTool({
  id: "check_compatibility",
  description:
    "Detect mount/accessory conflicts and missing essentials in an item list.",
  inputSchema: z.object({
    items: z.array(z.string()).describe("Item names to check for compatibility"),
  }),
  execute: async (input: { items: string[] }) =>
    data.catalog.checkCompatibility(input),
});

export const readConversation = createTool({
  id: "read_conversation",
  description:
    "Read Hygglo message thread. Input: thread_id (numeric string from Hygglo order).",
  inputSchema: z.object({
    search: z.string().describe("Thread ID (numeric) or reservation keyword"),
  }),
  execute: async (input: { search: string }) =>
    data.conversations.readConversation(input),
});

export const getDailyBriefing = createTool({
  id: "get_daily_briefing",
  description:
    "Full status briefing: revenue, active/upcoming/pending rentals, schedule, recent activity." +
    accountSuffix,
  inputSchema: z.object(accountField),
  execute: async (input: { account?: "leo" | "dbcinema" }) =>
    data.rentals.getDailyBriefing(input),
});

// Group C: Search rules + memories

export const searchRules = createTool({
  id: "search_rules",
  description: "Search active business rules by keyword.",
  inputSchema: z.object({ query: z.string() }),
  execute: async (input: { query: string }) => data.rules.searchRules(input),
});

export const updateRule = createTool({
  id: "update_rule",
  description:
    "Edit a rule content. Requires confirmation. ALWAYS preview and ask before calling.",
  inputSchema: z.object({
    ruleId: z.string().describe("Convex rule _id"),
    field: z.enum(["content", "priority", "active"]),
    value: z.string(),
  }),
  execute: async (input: { ruleId: string; field: string; value: string }) =>
    data.rules.updateRule(input),
});

export const searchMemories = createTool({
  id: "search_memories",
  description: "Search business memory store by keyword.",
  inputSchema: z.object({ query: z.string() }),
  execute: async (input: { query: string }) =>
    data.memories.searchMemories(input),
});

export const updateMemory = createTool({
  id: "update_memory",
  description:
    "Edit memory content by ID or insert new memory. Requires confirmation.",
  inputSchema: z.object({
    memoryId: z
      .string()
      .optional()
      .describe("Convex memory _id -- omit to insert new"),
    newContent: z.string(),
    scope: z.string().optional().default("general"),
  }),
  execute: async (input: {
    memoryId?: string;
    newContent: string;
    scope?: string;
  }) => data.memories.updateMemory(input),
});

// Group D: Blocked (gated by READ_ONLY_MODE / ALLOW_HYGGLO_SEND)

export const sendCorrection = createTool({
  id: "send_correction",
  description:
    "Send correction to renter on Hygglo. Currently blocked by READ_ONLY_MODE.",
  inputSchema: z.object({
    rentalId: z.string(),
    message: z.string(),
  }),
  execute: async (input: { rentalId: string; message: string }) =>
    data.feedback.sendCorrection(input),
});

export const getObsoleteOrders = createTool({
  id: "get_obsolete_orders",
  description:
    "Get cancelled or rejected orders (lost revenue / dead deals). Use when user asks about cancellations, lost revenue, what went obsolete, deals that fell through." +
    accountSuffix,
  inputSchema: z.object({
    ...accountField,
    sinceDays: z
      .number()
      .optional()
      .describe(
        "Only return orders updated within the last N days (default: all-time)",
      ),
  }),
  execute: async (input: {
    sinceDays?: number;
    account?: "leo" | "dbcinema";
  }) => data.rentals.getObsoleteOrders(input),
});

export const getOrderPipeline = createTool({
  id: "get_order_pipeline",
  description:
    "Get counts of active orders per order_step. Useful for 'how many requests are waiting?', 'pipeline status', 'where are we in the funnel?', distinguishing requested-but-unpaid from paid-active." +
    accountSuffix,
  inputSchema: z.object(accountField),
  execute: async (input: { account?: "leo" | "dbcinema" }) =>
    data.rentals.getOrderPipeline(input),
});

// ─────────────────────────────────────────────────────────────────────────
// Wave 2 — new tools (13 reads + 1 write)
// ─────────────────────────────────────────────────────────────────────────

const rangeField = {
  range: z
    .enum(["7d", "30d", "90d", "6m", "1y", "all"])
    .optional()
    .describe("Lookback window (default 30d)"),
};

export const getTopEarningItems = createTool({
  id: "get_top_earning_items",
  description:
    "INTENT-ROUTING: 'top earners', 'best earners', 'most profitable items', 'highest grossing gear', 'what's making the most money'. Ranked list of items by revenue over a range." +
    accountSuffix,
  inputSchema: z.object({
    ...accountField,
    ...rangeField,
    limit: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (input: {
    range?: string;
    account?: "leo" | "dbcinema";
    limit?: number;
  }) => data.revenue.getTopEarningItems(input),
});

export const getItemEarningsHistory = createTool({
  id: "get_item_earnings_history",
  description:
    "INTENT-ROUTING: 'earnings history for X', 'how much did X make', 'rental history for X', 'how often did X rent'. Per-item revenue + rental-count breakdown." +
    accountSuffix,
  inputSchema: z.object({
    itemName: z.string(),
    ...rangeField,
    ...accountField,
  }),
  execute: async (input: {
    itemName: string;
    range?: string;
    account?: "leo" | "dbcinema";
  }) => data.revenue.getItemEarningsHistory(input),
});

export const getRevenueSummary = createTool({
  id: "get_revenue_summary",
  description:
    "INTENT-ROUTING: 'revenue this week/month', 'lifetime earnings', 'total revenue'. Period-aggregate revenue + booking count." +
    accountSuffix,
  inputSchema: z.object({
    period: z.enum(["week", "month", "all"]),
    ...accountField,
  }),
  execute: async (input: {
    period: "week" | "month" | "all";
    account?: "leo" | "dbcinema";
  }) => data.revenue.getRevenueSummary(input),
});

export const getTopBundles = createTool({
  id: "get_top_bundles",
  description:
    "INTENT-ROUTING: 'top bundles', 'best kit combos', 'most-rented sets', 'which bundles work'. Bundles ranked by total revenue over a range." +
    accountSuffix,
  inputSchema: z.object({
    ...rangeField,
    ...accountField,
    limit: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (input: {
    range?: string;
    account?: "leo" | "dbcinema";
    limit?: number;
  }) => data.revenue.getTopBundles(input),
});

export const getItemCycle = createTool({
  id: "get_item_cycle",
  description:
    "INTENT-ROUTING: 'ROI on X', 'has X paid itself off', 'investment scorecard for X', 'lifetime profit on X'. Returns acquisition cost vs lifetime earnings + ROI %.",
  inputSchema: z.object({
    itemName: z.string(),
  }),
  execute: async (input: { itemName: string }) =>
    data.revenue.getItemCycle(input),
});

export const getTaxSummary = createTool({
  id: "get_tax_summary",
  description:
    "INTENT-ROUTING: 'tax year summary', 'HMRC report', 'fiscal year revenue', 'self-assessment numbers'. Monthly breakdown for UK tax year (6 Apr -> 5 Apr) plus total." +
    accountSuffix,
  inputSchema: z.object({
    taxYear: z
      .number()
      .int()
      .optional()
      .describe(
        "Tax year starting calendar year. Omit for current fiscal year.",
      ),
    ...accountField,
  }),
  execute: async (input: {
    taxYear?: number;
    account?: "leo" | "dbcinema";
  }) => data.revenue.getTaxSummary(input),
});

export const getLostRevenue = createTool({
  id: "get_lost_revenue",
  description:
    "INTENT-ROUTING: 'lost revenue', 'missed revenue', 'how much did we leave on the table', 'idle inventory cost', 'denied rentals value'. Denial losses + idle-gap losses." +
    accountSuffix,
  inputSchema: z.object({ ...rangeField, ...accountField }),
  execute: async (input: {
    range?: string;
    account?: "leo" | "dbcinema";
  }) => data.lostRevenue.getSummary(input),
});

export const getUnmatchedDemand = createTool({
  id: "get_unmatched_demand",
  description:
    "INTENT-ROUTING: 'unmatched demand', 'what renters ask for that we don't have', 'gap analysis', 'requests for missing items'. Items renters asked about but we couldn't supply.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).optional(),
  }),
  execute: async (input: { limit?: number }) =>
    data.lostRevenue.getUnmatchedDemand(input),
});

export const getSubstitutionPatterns = createTool({
  id: "get_substitution_patterns",
  description:
    "INTENT-ROUTING: 'substitution patterns', 'when X was unavailable what did renters take instead', 'fallback gear', 'sub-rental behaviour'. Cross-rental same-customer substitution sequences.",
  inputSchema: z.object({}),
  execute: async () => data.lostRevenue.getSubstitutionPatterns(),
});

export const getPurchaseRecommendations = createTool({
  id: "get_purchase_recommendations",
  description:
    "INTENT-ROUTING: 'what should we buy next', 'purchase recommendations', 'inventory gaps to fill', 'ROI for new gear'. Ranked acquisitions by unmet demand × estimated ROI.",
  inputSchema: z.object({}),
  execute: async () => data.lostRevenue.getPurchaseRecommendations(),
});

export const getRenterProfile = createTool({
  id: "get_renter_profile",
  description:
    "INTENT-ROUTING: 'who is X', 'renter profile for X', 'history of renter X', 'is X a regular'. Returns total spend, rating, rental count, first/last rental.",
  inputSchema: z.object({ name: z.string() }),
  execute: async (input: { name: string }) =>
    data.renters.getProfile(input),
});

export const checkBlacklist = createTool({
  id: "check_blacklist",
  description:
    "INTENT-ROUTING: 'is X blacklisted', 'blocked renters', 'banned customer check', 'do we have a flag on X'. Returns blacklist status + reason if any.",
  inputSchema: z.object({ name: z.string() }),
  execute: async (input: { name: string }) =>
    data.renters.checkBlacklist(input),
});

export const getDemandTop = createTool({
  id: "get_demand_top",
  description:
    "INTENT-ROUTING: 'top requested items', 'what's in demand', 'most-asked-for gear', 'demand signal'. Items renters asked for most often.",
  inputSchema: z.object({
    ...rangeField,
    limit: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (input: { range?: string; limit?: number }) =>
    data.demand.getTop(input),
});

// WRITE TOOL — denial recording (Q1)
export const recordDenial = createTool({
  id: "record_denial",
  description:
    "Record that a renter asked for an item we don't own / declined-due-to-unavailable. Use when user tells you 'renter X wanted Y but we didn't have it'. Feeds get_unmatched_demand and get_purchase_recommendations.",
  inputSchema: z.object({
    itemRequested: z.string(),
    renterName: z.string().optional(),
  }),
  execute: async (input: { itemRequested: string; renterName?: string }) =>
    data.lostRevenue.recordDenial({ ...input, source: "manual" }),
});

// ─────────────────────────────────────────────────────────────────────────
// Export map (Wave 1: 15 keys + Wave 2: 14 new = 29 total)
// ─────────────────────────────────────────────────────────────────────────

export const dashboardTools = {
  // Wave 1
  check_compatibility: checkCompatibility,
  lookup_pricing: lookupPricing,
  get_dashboard_stats: getDashboardStats,
  get_pending_rentals: getPendingRentals,
  read_conversation: readConversation,
  send_correction: sendCorrection,
  get_daily_briefing: getDailyBriefing,
  get_business_intelligence: getBusinessIntelligence,
  check_availability: checkAvailability,
  search_rules: searchRules,
  update_rule: updateRule,
  search_memories: searchMemories,
  update_memory: updateMemory,
  get_obsolete_orders: getObsoleteOrders,
  get_order_pipeline: getOrderPipeline,
  // Wave 2 — reads
  get_top_earning_items: getTopEarningItems,
  get_item_earnings_history: getItemEarningsHistory,
  get_revenue_summary: getRevenueSummary,
  get_top_bundles: getTopBundles,
  get_item_cycle: getItemCycle,
  get_tax_summary: getTaxSummary,
  get_lost_revenue: getLostRevenue,
  get_unmatched_demand: getUnmatchedDemand,
  get_substitution_patterns: getSubstitutionPatterns,
  get_purchase_recommendations: getPurchaseRecommendations,
  get_renter_profile: getRenterProfile,
  check_blacklist: checkBlacklist,
  get_demand_top: getDemandTop,
  // Wave 2 — write
  record_denial: recordDenial,
};
