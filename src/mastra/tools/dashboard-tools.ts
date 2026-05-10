import "server-only";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

function getConvex(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL not set");
  return new ConvexHttpClient(url);
}

// Group A: Read-only, all data in Convex

export const getDashboardStats = createTool({
  id: "get_dashboard_stats",
  description: "Live today/week/month earnings, active rental counts, and pending decisions.",
  inputSchema: z.object({}),
  execute: async () => {
    const convex = getConvex();
    const stats = await convex.query(anyApi.dashboard.getSummary, { accountSlug: null });
    return {
      ok: true,
      today_revenue: stats.todayRevenue,
      today_rental_count: stats.todayRentalCount,
      weekly_revenue: stats.weeklyRevenue,
      monthly_revenue: stats.monthlyRevenue,
      projected_month_revenue: stats.projectedMonthRevenue,
      active_rentals: stats.activeRentalsCount,
      ongoing: stats.ongoingCount,
      upcoming: stats.upcomingCount,
      overdue: stats.overdueCount,
      items_out: stats.itemsOut,
      available_items: stats.availableItems,
      out_of_stock_count: stats.outOfStockCount,
      denial_rate: stats.denialRate,
      denied_revenue_90d: stats.deniedRevenue,
    };
  },
});

export const lookupPricing = createTool({
  id: "lookup_pricing",
  description: "Get daily rate and multi-day totals for a rental item.",
  inputSchema: z.object({
    itemName: z.string(),
    days: z.number().int().min(1).optional(),
  }),
  execute: async (input: { itemName: string; days?: number }) => {
    const convex = getConvex();
    const items = await convex.query(anyApi.pricing_catalog.lookup, { item_name: input.itemName });
    if (!items || items.length === 0) return { ok: false as const, error: "item_not_found" };
    const row = items[0];
    const rate: number = row.daily_price_min;
    const days = input.days ?? 1;
    let total: number;
    if (days >= 7) total = rate * 5;
    else if (days >= 3) total = rate * 2.5;
    else total = rate * days;
    return {
      ok: true as const,
      item: row.item_name_canonical,
      daily_rate: rate,
      days,
      total: Math.round(total * 100) / 100,
      note: days >= 3 ? "Hygglo multi-day discount applied" : undefined,
    };
  },
});

export const checkAvailability = createTool({
  id: "check_availability",
  description: "Check item availability for dates. Returns available qty and next free date if booked.",
  inputSchema: z.object({
    itemName: z.string(),
    startDate: z.string().describe("YYYY-MM-DD"),
    endDate: z.string().describe("YYYY-MM-DD"),
  }),
  execute: async (input: { itemName: string; startDate: string; endDate: string }) => {
    const convex = getConvex();
    return await convex.query(anyApi.items.checkAvailability, {
      item_name: input.itemName,
      start_date: input.startDate,
      end_date: input.endDate,
    });
  },
});

export const getPendingRentals = createTool({
  id: "get_pending_rentals",
  description: "Fetch pending rental requests awaiting accept/decline decision.",
  inputSchema: z.object({}),
  execute: async () => {
    const convex = getConvex();
    return await convex.query(anyApi.reservations.listPending, {});
  },
});

export const getBusinessIntelligence = createTool({
  id: "get_business_intelligence",
  description: "Purchase recommendations, demand signals, denied-rental patterns, investment analysis.",
  inputSchema: z.object({}),
  execute: async () => {
    const convex = getConvex();
    const [sell, price, insights] = await Promise.all([
      convex.query(anyApi.items.getSellRecommendations, { accountSlug: null }),
      convex.query(anyApi.items.getPriceRecommendations, { accountSlug: null }),
      convex.query(anyApi.ai_insights.getInsights, { accountSlug: null }),
    ]);
    return {
      ok: true as const,
      underutilizedItems: (sell as unknown[]).slice(0, 10),
      priceSuggestions: (price as unknown[]).slice(0, 10),
      insights,
    };
  },
});

// Group B: Compatibility + reading

export const checkCompatibility = createTool({
  id: "check_compatibility",
  description: "Detect mount/accessory conflicts and missing essentials in an item list.",
  inputSchema: z.object({
    items: z.array(z.string()).describe("Item names to check for compatibility"),
  }),
  execute: async (input: { items: string[] }) => {
    const convex = getConvex();
    const { items } = input;
    if (items.length < 2) return { ok: false as const, error: "Provide at least 2 items" };
    const results = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const result = await convex.query(anyApi.items.checkCompat, {
          itemA: items[i],
          itemB: items[j],
        });
        results.push({ pair: [items[i], items[j]], ...result });
      }
    }
    const conflicts = results.filter((r) => !r.compatible);
    const compatible = results.filter((r) => r.compatible);
    return {
      ok: true as const,
      compatible_pairs: compatible.length,
      conflict_pairs: conflicts.length,
      results,
      summary:
        conflicts.length > 0
          ? "CONFLICTS: " + conflicts.map((r) => r.pair.join(" + ") + " -- " + r.reason).join("; ")
          : "All pairs compatible",
    };
  },
});

export const readConversation = createTool({
  id: "read_conversation",
  description: "Read Hygglo message thread. Input: thread_id (numeric string from Hygglo order).",
  inputSchema: z.object({
    search: z.string().describe("Thread ID (numeric) or reservation keyword"),
  }),
  execute: async (input: { search: string }) => {
    const convex = getConvex();
    const messages = await convex.query(anyApi.hygglo.listByThread, { thread_id: input.search });
    if ((messages as unknown[]).length === 0) {
      return { ok: false as const, error: "No messages found for thread: " + input.search };
    }
    return {
      ok: true as const,
      thread_id: input.search,
      message_count: (messages as unknown[]).length,
      messages,
    };
  },
});

export const getDailyBriefing = createTool({
  id: "get_daily_briefing",
  description: "Full status briefing: revenue, active/upcoming/pending rentals, schedule, recent activity.",
  inputSchema: z.object({}),
  execute: async () => {
    const convex = getConvex();
    const today = new Date().toISOString().slice(0, 10);
    const [stats, schedule, pending, activity] = await Promise.all([
      convex.query(anyApi.dashboard.getSummary, { accountSlug: null }),
      convex.query(anyApi.calendar.getCalendarStrip, { accountSlug: null, startDate: today, days: 3 }),
      convex.query(anyApi.reservations.listPending, {}),
      convex.query(anyApi.reservations.getRecentActivity, { accountSlug: null, limit: 5 }),
    ]);
    const attentionNeeded: string[] = [];
    if ((pending as { count: number }).count > 0)
      attentionNeeded.push((pending as { count: number }).count + " pending rental(s) need review");
    if ((stats as { overdueCount: number }).overdueCount > 0)
      attentionNeeded.push((stats as { overdueCount: number }).overdueCount + " overdue return(s)");
    return {
      ok: true as const,
      date: today,
      summary: {
        today_revenue: (stats as { todayRevenue: number }).todayRevenue,
        monthly_revenue: (stats as { monthlyRevenue: number }).monthlyRevenue,
        projected: (stats as { projectedMonthRevenue: number }).projectedMonthRevenue,
        active_rentals: (stats as { activeRentalsCount: number }).activeRentalsCount,
        items_out: (stats as { itemsOut: number }).itemsOut,
      },
      schedule_next_3_days: schedule,
      pending_rentals: pending,
      recent_activity: activity,
      attention_needed: attentionNeeded,
    };
  },
});

// Group C: Search rules + memories

export const searchRules = createTool({
  id: "search_rules",
  description: "Search active business rules by keyword.",
  inputSchema: z.object({ query: z.string() }),
  execute: async (input: { query: string }) => {
    const convex = getConvex();
    return await convex.query(anyApi.rules.search, { query: input.query });
  },
});

export const updateRule = createTool({
  id: "update_rule",
  description: "Edit a rule content. Requires confirmation. ALWAYS preview and ask before calling.",
  inputSchema: z.object({
    ruleId: z.string().describe("Convex rule _id"),
    field: z.enum(["content", "priority", "active"]),
    value: z.string(),
  }),
  execute: async (input: { ruleId: string; field: string; value: string }) => {
    if (input.field !== "content") {
      return { ok: false as const, error: "Only content field updates supported. Use field=content." };
    }
    const convex = getConvex();
    return await convex.mutation(anyApi.rules.update, { id: input.ruleId, new_content: input.value });
  },
});

export const searchMemories = createTool({
  id: "search_memories",
  description: "Search business memory store by keyword.",
  inputSchema: z.object({ query: z.string() }),
  execute: async (input: { query: string }) => {
    const convex = getConvex();
    return await convex.query(anyApi.memories.search, { query: input.query });
  },
});

export const updateMemory = createTool({
  id: "update_memory",
  description: "Edit memory content by ID or insert new memory. Requires confirmation.",
  inputSchema: z.object({
    memoryId: z.string().optional().describe("Convex memory _id -- omit to insert new"),
    newContent: z.string(),
    scope: z.string().optional().default("general"),
  }),
  execute: async (input: { memoryId?: string; newContent: string; scope?: string }) => {
    const convex = getConvex();
    return await convex.mutation(anyApi.memories.upsert, {
      id: input.memoryId,
      scope: input.scope ?? "general",
      content: input.newContent,
    });
  },
});

// Group D: Blocked

export const sendCorrection = createTool({
  id: "send_correction",
  description: "Send correction to renter on Hygglo. Currently blocked by READ_ONLY_MODE.",
  inputSchema: z.object({
    rentalId: z.string(),
    message: z.string(),
  }),
  execute: async () => ({
    ok: false as const,
    blocked: true as const,
    reason: "ALLOW_HYGGLO_SEND=false (master safety rail). Cannot send to renter.",
    message:
      "Read-only mode is active. To compose a correction, paste suggested text here and the operator will send manually.",
  }),
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
};