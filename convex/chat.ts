import { query, action } from "./_generated/server";
import { v } from "convex/values";

/**
 * W21 AI Chat — shell stub only (Phase 5.3).
 * Full agent with tools is Phase 5.6.
 */
export const getStubMessages = query({
  args: {},
  handler: async (_ctx) => {
    return [] as Array<{ role: "user" | "assistant"; content: string }>;
  },
});

export const sendStub = action({
  args: { message: v.string() },
  handler: async (_ctx, _args): Promise<string> => {
    return "Full AI assistant coming in phase 5.6.";
  },
});
