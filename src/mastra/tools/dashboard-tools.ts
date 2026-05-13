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
 * Tool return shape is IDENTICAL to the pre-refactor implementation —
 * verified via typecheck. Wave 1 is a pure refactor: zero behaviour change.
 */
import "server-only";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import * as data from "@/mastra/data";

// Group A: Read-only, all data in Convex

export const getDashboardStats = createTool({
  id: "get_dashboard_stats",
  description:
    "Live today/week/month earnings, active rental counts, and pending decisions.",
  inputSchema: z.object({}),
  execute: async () => data.revenue.getDashboardStats(),
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
  description: "Fetch pending rental requests awaiting accept/decline decision.",
  inputSchema: z.object({}),
  execute: async () => data.rentals.getPendingRentals(),
});

export const getBusinessIntelligence = createTool({
  id: "get_business_intelligence",
  description:
    "Purchase recommendations, demand signals, denied-rental patterns, investment analysis.",
  inputSchema: z.object({}),
  execute: async () => data.revenue.getBusinessIntelligence(),
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
    "Full status briefing: revenue, active/upcoming/pending rentals, schedule, recent activity.",
  inputSchema: z.object({}),
  execute: async () => data.rentals.getDailyBriefing(),
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
    "Get cancelled or rejected orders (lost revenue / dead deals). Use when user asks about cancellations, lost revenue, what went obsolete, deals that fell through.",
  inputSchema: z.object({
    sinceDays: z
      .number()
      .optional()
      .describe(
        "Only return orders updated within the last N days (default: all-time)",
      ),
  }),
  execute: async (input: { sinceDays?: number }) =>
    data.rentals.getObsoleteOrders(input),
});

export const getOrderPipeline = createTool({
  id: "get_order_pipeline",
  description:
    "Get counts of active orders per order_step. Useful for 'how many requests are waiting?', 'pipeline status', 'where are we in the funnel?', distinguishing requested-but-unpaid from paid-active.",
  inputSchema: z.object({}),
  execute: async () => data.rentals.getOrderPipeline(),
});

// Export map

export const dashboardTools = {
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
};
