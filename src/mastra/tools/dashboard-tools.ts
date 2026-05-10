import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const stub = (name: string) => ({
  ok: true as const,
  stub: true as const,
  tool: name,
  message: "Real handler scheduled for Phase B-3",
});

const blocked = (name: string) => ({
  ok: false as const,
  stub: true as const,
  tool: name,
  message: "BLOCKED: READ_ONLY_MODE — ALLOW_HYGGLO_SEND is false.",
});

export const checkCompatibility = createTool({
  id: "check_compatibility",
  description: "Detect mount/accessory conflicts and missing essentials in an item list.",
  inputSchema: z.object({
    items: z.array(z.string()).describe("Item names to check for compatibility"),
  }),
  execute: async (input) => stub(`check_compatibility (${input.items.join(", ")})`),
});

export const lookupPricing = createTool({
  id: "lookup_pricing",
  description: "Get daily rate and multi-day totals for a rental item.",
  inputSchema: z.object({
    itemName: z.string(),
    days: z.number().int().min(1),
  }),
  execute: async () => stub("lookup_pricing"),
});

export const getDashboardStats = createTool({
  id: "get_dashboard_stats",
  description: "Live today/week/month earnings, active rental counts, and pending decisions.",
  inputSchema: z.object({}),
  execute: async () => stub("get_dashboard_stats"),
});

export const getPendingRentals = createTool({
  id: "get_pending_rentals",
  description: "Fetch pending rental requests awaiting accept/decline decision.",
  inputSchema: z.object({}),
  execute: async () => stub("get_pending_rentals"),
});

export const readConversation = createTool({
  id: "read_conversation",
  description: "Read Hygglo message thread for a rental. Search by rental ID or keyword.",
  inputSchema: z.object({
    search: z.string(),
  }),
  execute: async () => stub("read_conversation"),
});

export const sendCorrection = createTool({
  id: "send_correction",
  description: "Send correction to renter on Hygglo. Currently blocked by READ_ONLY_MODE.",
  inputSchema: z.object({
    rentalId: z.string(),
    message: z.string(),
  }),
  execute: async () => blocked("send_correction"),
});

export const getDailyBriefing = createTool({
  id: "get_daily_briefing",
  description: "Full status briefing: revenue, active/upcoming/pending rentals, schedule, recent activity.",
  inputSchema: z.object({}),
  execute: async () => stub("get_daily_briefing"),
});

export const getBusinessIntelligence = createTool({
  id: "get_business_intelligence",
  description: "Purchase recommendations, demand signals, denied-rental patterns, investment analysis.",
  inputSchema: z.object({}),
  execute: async () => stub("get_business_intelligence"),
});

export const checkAvailability = createTool({
  id: "check_availability",
  description: "Check item availability for dates. Suggests alternatives when unavailable.",
  inputSchema: z.object({
    itemName: z.string(),
    startDate: z.string().describe("YYYY-MM-DD"),
    endDate: z.string().describe("YYYY-MM-DD"),
  }),
  execute: async () => stub("check_availability"),
});

export const searchRules = createTool({
  id: "search_rules",
  description: "Search active business rules by keyword.",
  inputSchema: z.object({ query: z.string() }),
  execute: async () => stub("search_rules"),
});

export const updateRule = createTool({
  id: "update_rule",
  description: "Edit a rule field. Requires confirmation. Only scheduling/timing rules allowed.",
  inputSchema: z.object({
    ruleId: z.string(),
    field: z.enum(["content", "priority", "active"]),
    value: z.string(),
  }),
  execute: async () => stub("update_rule"),
});

export const searchMemories = createTool({
  id: "search_memories",
  description: "Search business memory store by keyword.",
  inputSchema: z.object({ query: z.string() }),
  execute: async () => stub("search_memories"),
});

export const updateMemory = createTool({
  id: "update_memory",
  description: "Edit memory content by ID. Requires confirmation.",
  inputSchema: z.object({
    memoryId: z.string(),
    newContent: z.string(),
  }),
  execute: async () => stub("update_memory"),
});

// All 13 tools — referenced by agent registration
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
};
