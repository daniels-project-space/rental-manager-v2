import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// B-3: search rules by keyword
export const search = query({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { query: rawQ, limit = 20 }) => {
    const rows = await ctx.db.query("rules").collect();
    const lq = rawQ.toLowerCase();
    const matched = rows.filter(
      (r) =>
        r.enabled &&
        (r.rule_body.toLowerCase().includes(lq) || r.rule_kind.toLowerCase().includes(lq))
    );
    if (matched.length === 0) return { results: [], message: "No rules match" };
    return {
      results: matched.slice(0, limit).map((r) => ({
        id: r._id,
        rule_kind: r.rule_kind,
        rule_body: r.rule_body,
      })),
      message: matched.length + " rule(s) matched",
    };
  },
});

// B-3: update rule content (write op; agent confirms first)
export const update = mutation({
  args: {
    id: v.id("rules"),
    new_content: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { id, new_content, reason }) => {
    const rule = await ctx.db.get(id);
    if (!rule) throw new Error("Rule not found: " + id);
    const old_content = rule.rule_body;
    await ctx.db.patch(id, { rule_body: new_content });
    await ctx.db.insert("audit_log", {
      table_name: "rules",
      actor: "dashboard-chat",
      op: "update",
      note: reason ?? "Updated via dashboard chat",
      source_file: "rules.ts:update",
      ts: Date.now(),
    });
    return { ok: true, old_content, new_content };
  },
});
