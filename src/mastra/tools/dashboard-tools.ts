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
  description:
    "INTENT-ROUTING: 'pricing', 'rate', 'cost', 'how much', \"what's the rate\", 'what do we charge'. Get daily rate and multi-day totals for a rental item.",
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
    "INTENT-ROUTING: 'is X free', 'is X available', 'booked', 'open on <date>', 'can we rent X on...'. Check item availability for dates. Returns available qty and next free date if booked.",
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
    "INTENT-ROUTING: 'pending', 'awaiting', 'unconfirmed', 'needs approval', 'to confirm', \"what's pending\". Fetch pending rental requests awaiting accept/decline decision." +
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
    "INTENT-ROUTING: 'lost revenue', 'cancelled', 'fell through', 'what got cancelled', 'deals lost', 'obsolete', 'dead deals'. Get cancelled or rejected orders." +
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
    "INTENT-ROUTING: 'pipeline', 'where are we', 'funnel', 'how many requests', 'how many paid', 'pipeline status'. Counts of active orders per order_step — distinguishes requested-but-unpaid from paid-active." +
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
// Wave 3 — thick "intelligence" tools (MV-backed)
//
// Each tool returns the full picture for its surface in ONE call:
//   - numbers (typed scalar block)
//   - summary (narrative)
//   - topInsight (single highest-leverage sentence)
//   - suggestedFollowups (drill-down tool names)
//   - freshness (relative age of underlying MV)
//   - ofRecord (top-N raw rows for follow-up reasoning)
// ─────────────────────────────────────────────────────────────────────────

export const getPurchaseIntelligence = createTool({
  id: "get_purchase_intelligence",
  description:
    "Returns the full purchase-recommendation picture in ONE call: 30-day unmet-demand signals, projected annual upside per item, top insight, and links to deeper drill-down tools. Use when user asks 'what should we buy', 'where's our demand', 'investment recommendations', 'top opportunities', 'gaps in inventory'.",
  inputSchema: z.object({ ...accountField }),
  execute: async (input: { account?: "leo" | "dbcinema" }) =>
    data.intelligence.getPurchaseIntelligence({ account: input.account }),
});

export const getChurnRisk = createTool({
  id: "get_churn_risk",
  description:
    "Returns the full renter-churn picture in ONE call: at-risk renters with lifetime value, days since last rental, risk tier, and pre-rendered reason strings. Use when user asks 'who's at risk of churning', 'top customers we're losing', 'who should we re-engage', 'lapsed renters'.",
  inputSchema: z.object({ ...accountField }),
  execute: async (input: { account?: "leo" | "dbcinema" }) =>
    data.intelligence.getChurnRisk({ account: input.account }),
});

export const getUtilizationSnapshot = createTool({
  id: "get_utilization_snapshot",
  description:
    "Returns the full fleet-utilization picture in ONE call: per-item rented-now count, 7-day utilization %, idle days, and fleet-level rollup. Use when user asks 'what's our utilization', 'fleet usage', 'idle inventory', 'most-rented items', 'underutilized gear'.",
  inputSchema: z.object({ ...accountField }),
  execute: async (input: { account?: "leo" | "dbcinema" }) =>
    data.intelligence.getUtilizationSnapshot({ account: input.account }),
});

// ─────────────────────────────────────────────────────────────────────────
// Wave 4.5 — ai_decision approval tools.
//
// `get_pending_decisions` exposes the queue to the chat agent (shortId
// included so the user can say "approve abc123"). `approve_decision` is the
// action path: gates Hygglo writes through READ_ONLY_MODE and records an
// audit row.
// ─────────────────────────────────────────────────────────────────────────

export const getPendingDecisions = createTool({
  id: "get_pending_decisions",
  description:
    "List AI decisions awaiting Daniel's approval. Use when user asks 'what's pending', 'what needs my approval', 'show me the AI's suggestions', 'queue', 'what did the AI decide today'. Returns id, shortId (last 6 chars — use this in approve_decision), decision, confidence, suggestedReply, renter name, item, dates." +
    accountSuffix,
  inputSchema: z.object({
    ...accountField,
    limit: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (input: { account?: "leo" | "dbcinema"; limit?: number }) =>
    data.decisions.getPendingDecisions(input),
});

export const approveDecision = createTool({
  id: "approve_decision",
  description:
    "Apply a pending AI decision (accept/decline/send message to renter). Use when the user says 'approve decision X', 'send that reply', 'accept rental N', 'decline N', 'approve with this edit: ...'. Calls Hygglo only if READ_ONLY_MODE is false; otherwise records the approval intent without sending. `decisionId` accepts either the full Convex id or the 6-char shortId from get_pending_decisions.",
  inputSchema: z.object({
    decisionId: z
      .string()
      .describe(
        "Full Convex decision id OR the 6-char shortId surfaced by get_pending_decisions.",
      ),
    modifyReply: z
      .string()
      .optional()
      .describe(
        "If user wants to edit the AI-drafted reply before sending, pass the new text here. Omit to send the AI's draft as-is.",
      ),
    forceDecline: z
      .boolean()
      .optional()
      .describe(
        "Set true when the user explicitly wants to decline the rental instead of approving. Default false = approve.",
      ),
    declineReason: z
      .string()
      .optional()
      .describe(
        "Optional decline reason (only used when forceDecline=true). Defaults to the AI's suggested reply.",
      ),
  }),
  execute: async (input: {
    decisionId: string;
    modifyReply?: string;
    forceDecline?: boolean;
    declineReason?: string;
  }) =>
    data.decisions.applyApproval({
      decisionId: input.decisionId,
      actorSource: "dashboard_chat",
      modifyReply: input.modifyReply,
      forceDecline: input.forceDecline,
      declineReason: input.declineReason,
    }),
});

// ─────────────────────────────────────────────────────────────────────────
// Wave 4.6 — Hygglo UI automation tools (browser-use + shadow mode)
// ─────────────────────────────────────────────────────────────────────────
// All 10 below dispatch through `data.uiActions.*`. Default behaviour:
// shadow mode — bot performs every step end-to-end, screenshots the
// pre-submit state to R2, ABORTS before the final submit click, writes
// an audit row, and returns the screenshot URL. Flip per-action via env
// `HYGGLO_UI_LIVE_<ACTION>=true` to actually submit.

const accountSlug = {
  accountSlug: z
    .enum(["leo", "dbcinema"])
    .describe("Which Hygglo account this order belongs to."),
};

export const acceptOrderUi = createTool({
  id: "accept_order_ui",
  description:
    "INTENT-ROUTING: 'click accept on order X', 'accept via UI', 'use the UI path for accepting'. " +
    "Fallback when REST acceptOrder fails or you want to verify the browser flow. " +
    "Runs in shadow mode by default — captures a screenshot for review without submitting. " +
    "Once HYGGLO_UI_LIVE_ACCEPT=true the bot submits automatically.",
  inputSchema: z.object({
    ...accountSlug,
    orderId: z.string().describe("Hygglo order id."),
  }),
  execute: async (input: { accountSlug: "leo" | "dbcinema"; orderId: string }) =>
    data.uiActions.acceptOrderUi(input),
});

export const declineOrderUi = createTool({
  id: "decline_order_ui",
  description:
    "INTENT-ROUTING: 'click decline via UI', 'decline through the browser'. " +
    "Fallback when REST declineOrder fails. Shadow mode by default — " +
    "flip HYGGLO_UI_LIVE_DECLINE=true to submit.",
  inputSchema: z.object({
    ...accountSlug,
    orderId: z.string(),
    reason: z.string().optional().describe("Optional polite reason shown in confirm modal."),
  }),
  execute: async (input: { accountSlug: "leo" | "dbcinema"; orderId: string; reason?: string }) =>
    data.uiActions.declineOrderUi(input),
});

export const addItemToOrder = createTool({
  id: "add_item_to_order",
  description:
    "INTENT-ROUTING: 'add a Sigma 24-70 to order 123', 'put a battery on this rental', " +
    "'attach the FX3 to the booking'. AI-driven (autocomplete is dynamic). " +
    "Shadow mode by default — flip HYGGLO_UI_LIVE_ADD_ITEM=true to submit.",
  inputSchema: z.object({
    ...accountSlug,
    orderId: z.string(),
    itemName: z.string().describe("Renter-facing item name as it appears in your inventory."),
    quantity: z.number().int().min(1).max(20).optional(),
    days: z.number().int().min(1).max(60).optional(),
  }),
  execute: async (input: {
    accountSlug: "leo" | "dbcinema"; orderId: string; itemName: string;
    quantity?: number; days?: number;
  }) => data.uiActions.addItemToOrder(input),
});

export const removeItemFromOrder = createTool({
  id: "remove_item_from_order",
  description:
    "INTENT-ROUTING: 'remove the V-mount from 123', 'drop the FX3 from this order'. " +
    "Per-row delete icon (recipe). Shadow mode by default — flip HYGGLO_UI_LIVE_REMOVE_ITEM=true.",
  inputSchema: z.object({
    ...accountSlug,
    orderId: z.string(),
    itemName: z.string().describe("Exact item name as listed on the order."),
  }),
  execute: async (input: { accountSlug: "leo" | "dbcinema"; orderId: string; itemName: string }) =>
    data.uiActions.removeItemFromOrder(input),
});

export const applyOrderDiscount = createTool({
  id: "apply_order_discount",
  description:
    "INTENT-ROUTING: 'give 10% off', 'reduce to £200', 'discount this rental'. " +
    "Pass percentOff OR newOwnerEarningsGbp, not both. The bot clicks the displayed £ " +
    "amount, types the new value; Hygglo recomputes platform fees server-side. " +
    "AI-driven (dynamic text element). Shadow mode by default — " +
    "flip HYGGLO_UI_LIVE_APPLY_DISCOUNT=true to submit.",
  inputSchema: z.object({
    ...accountSlug,
    orderId: z.string(),
    percentOff: z.number().min(1).max(100).optional(),
    newOwnerEarningsGbp: z.number().min(1).optional(),
    reason: z.string().optional(),
  }),
  execute: async (input: {
    accountSlug: "leo" | "dbcinema"; orderId: string;
    percentOff?: number; newOwnerEarningsGbp?: number; reason?: string;
  }) => data.uiActions.applyOrderDiscount(input),
});

export const changeOwnerEarnings = createTool({
  id: "change_owner_earnings",
  description:
    "INTENT-ROUTING: 'set my share to £150 on order 123', 'change owner earnings to X'. " +
    "Use when the user wants the owner-share total set explicitly without computing a percent. " +
    "AI-driven. Shadow mode by default — flip HYGGLO_UI_LIVE_CHANGE_OWNER_EARNINGS=true.",
  inputSchema: z.object({
    ...accountSlug,
    orderId: z.string(),
    newGbp: z.number().min(1),
    reason: z.string().optional(),
  }),
  execute: async (input: {
    accountSlug: "leo" | "dbcinema"; orderId: string; newGbp: number; reason?: string;
  }) => data.uiActions.changeOwnerEarnings(input),
});

export const markOrderPickedUp = createTool({
  id: "mark_order_picked_up",
  description:
    "INTENT-ROUTING: 'mark 123 picked up', 'renter has it now', 'collection done'. " +
    "Recipe-driven (stable button). Shadow mode by default — flip HYGGLO_UI_LIVE_MARK_PICKED_UP=true.",
  inputSchema: z.object({
    ...accountSlug,
    orderId: z.string(),
    notes: z.string().optional(),
  }),
  execute: async (input: { accountSlug: "leo" | "dbcinema"; orderId: string; notes?: string }) =>
    data.uiActions.markOrderPickedUp(input),
});

export const markOrderReturned = createTool({
  id: "mark_order_returned",
  description:
    "INTENT-ROUTING: 'returned', 'got it back', 'mark 123 returned'. " +
    "NOTE: damage / insurance claims are a separate flow not in this tool. " +
    "Recipe-driven. Shadow mode by default — flip HYGGLO_UI_LIVE_MARK_RETURNED=true.",
  inputSchema: z.object({
    ...accountSlug,
    orderId: z.string(),
    conditionNotes: z.string().optional().describe("Optional return notes (e.g. 'clean, no damage')."),
  }),
  execute: async (input: { accountSlug: "leo" | "dbcinema"; orderId: string; conditionNotes?: string }) =>
    data.uiActions.markOrderReturned(input),
});

export const leaveRenterReview = createTool({
  id: "leave_renter_review",
  description:
    "INTENT-ROUTING: 'leave a 5 star for John', 'review this rental', 'rate the renter'. " +
    "Recipe-driven (form). Shadow mode by default — flip HYGGLO_UI_LIVE_LEAVE_REVIEW=true.",
  inputSchema: z.object({
    ...accountSlug,
    orderId: z.string(),
    rating: z.number().int().min(1).max(5),
    comment: z.string().optional(),
  }),
  execute: async (input: {
    accountSlug: "leo" | "dbcinema"; orderId: string;
    rating: number; comment?: string;
  }) => data.uiActions.leaveRenterReview({
    accountSlug: input.accountSlug,
    orderId: input.orderId,
    rating: input.rating as 1 | 2 | 3 | 4 | 5,
    comment: input.comment,
  }),
});

export const getPendingShadowActions = createTool({
  id: "get_pending_shadow_actions",
  description:
    "INTENT-ROUTING: 'show me pending UI actions', \"what's queued for review\", " +
    "'list shadow mode runs'. Read-only — lists hygglo_ui_actions rows " +
    "with status='shadow_complete', each with a screenshot URL for Daniel " +
    "to eyeball before flipping live mode.",
  inputSchema: z.object({
    accountSlug: z.enum(["leo", "dbcinema"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (input: { accountSlug?: "leo" | "dbcinema"; limit?: number }) =>
    data.uiActions.getPendingShadowActions(input),
});

// ─────────────────────────────────────────────────────────────────────────
// Wave 4.7 — model auto-upgrade advisories
// ─────────────────────────────────────────────────────────────────────────

export const getModelUpgradeAdvisories = createTool({
  id: "get_model_upgrade_advisories",
  description:
    "Surface pending major-version or SKU-change Grok advisories that require human review (auto-PRs land directly without surfacing here). Use when user asks 'any model upgrades?', 'grok deprecations', 'model advisories', 'is there a newer grok?', or during the monthly status review.",
  inputSchema: z.object({}),
  execute: async () => data.modelUpgrades.getOpenAdvisories(),
});

// ─────────────────────────────────────────────────────────────────────────
// Export map (Wave 1: 15 + Wave 2: 14 + Wave 3: 3 + Wave 4.5: 2 + Wave 4.6: 10 + Wave 4.7: 1 = 45 total)
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
  // Wave 3 — thick intelligence
  get_purchase_intelligence: getPurchaseIntelligence,
  get_churn_risk: getChurnRisk,
  get_utilization_snapshot: getUtilizationSnapshot,
  // Wave 4.5 — ai_decision approval
  get_pending_decisions: getPendingDecisions,
  approve_decision: approveDecision,
  // Wave 4.6 — Hygglo UI automation (browser-use)
  accept_order_ui: acceptOrderUi,
  decline_order_ui: declineOrderUi,
  add_item_to_order: addItemToOrder,
  remove_item_from_order: removeItemFromOrder,
  apply_order_discount: applyOrderDiscount,
  change_owner_earnings: changeOwnerEarnings,
  mark_order_picked_up: markOrderPickedUp,
  mark_order_returned: markOrderReturned,
  leave_renter_review: leaveRenterReview,
  get_pending_shadow_actions: getPendingShadowActions,
  // Wave 4.7 — model auto-upgrade advisories
  get_model_upgrade_advisories: getModelUpgradeAdvisories,
};
