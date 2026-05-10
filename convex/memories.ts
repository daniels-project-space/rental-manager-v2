import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// B-3: search memories by keyword
export const search = query({
  args: { query: v.string(), scope: v.optional(v.string()) },
  handler: async (ctx, { query: rawQ, scope }) => {
    let rows = await ctx.db.query("memories").collect();
    if (scope) rows = rows.filter((r) => r.scope === scope);
    const lq = rawQ.toLowerCase();
    const matched = rows.filter(
      (r) =>
        r.content.toLowerCase().includes(lq) ||
        (r.tags ?? []).some((t) => t.toLowerCase().includes(lq))
    );
    if (matched.length === 0) {
      return { results: [], message: "No memories match (memories table may be empty — seed pending)" };
    }
    return {
      results: matched.slice(0, 20).map((r) => ({
        id: r._id,
        scope: r.scope,
        content: r.content,
        tags: r.tags,
      })),
    };
  },
});

// B-3: upsert memory (insert if no id, update if provided)
export const upsert = mutation({
  args: {
    id: v.optional(v.id("memories")),
    scope: v.string(),
    content: v.string(),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { id, scope, content, tags }) => {
    const now = Date.now();
    if (id) {
      const existing = await ctx.db.get(id);
      if (!existing) throw new Error("Memory not found: " + id);
      const old_content = existing.content;
      await ctx.db.patch(id, { content, scope, tags, updated_at: now });
      await ctx.db.insert("audit_log", {
        table_name: "memories",
        actor: "dashboard-chat",
        op: "update",
        note: "Updated via dashboard chat",
        source_file: "memories.ts:upsert",
        ts: now,
      });
      return { ok: true, action: "updated" as const, id, old_content, new_content: content };
    }
    const newId = await ctx.db.insert("memories", {
      scope,
      content,
      tags,
      source: "manual",
      created_at: now,
    });
    await ctx.db.insert("audit_log", {
      table_name: "memories",
      actor: "dashboard-chat",
      op: "insert",
      note: "Inserted via dashboard chat",
      source_file: "memories.ts:upsert",
      ts: now,
    });
    return { ok: true, action: "inserted" as const, id: newId };
  },
});
