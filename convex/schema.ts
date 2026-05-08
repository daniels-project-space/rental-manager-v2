import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Phase 0 stub schema. Full schema (15 tables) lands in Phase 1+.
// The READ-ONLY safety rail lives on the `settings` singleton row.
export default defineSchema({
  settings: defineTable({
    ALLOW_HYGGLO_SEND: v.boolean(),
    read_only_mode: v.boolean(),
    polling_interval_ms: v.number(),
    escalate_to_sonnet: v.boolean(),
  }),
});
