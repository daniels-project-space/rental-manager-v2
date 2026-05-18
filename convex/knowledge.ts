/**
 * `knowledge.search` Convex query — backs the agent's `search_knowledge`
 * tool. Free-text search across `rules` + `memories` (V1 rule corpus +
 * V1 memories + gear FAQs + verbatim templates).
 *
 * READ-ONLY. No mutations.
 *
 * Performance note: rules + memories combined are < 200 rows post-seed,
 * so .collect() is acceptable here (vs the 1700+ reservations table
 * which CLAUDE.md forbids scanning). Phase 2+ may swap to an embeddings
 * index if the corpus grows.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";
import { rankKnowledge } from "./lib/knowledge_search";

export const search = query({
  args: {
    query: v.string(),
    scope: v.optional(v.string()),       // "all" | "rule" | "memory" | "operational" | "template" | "faq"
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { query: q, scope, limit }) => {
    const rules = await ctx.db.query("rules").collect();
    const memories = await ctx.db.query("memories").collect();
    return rankKnowledge(
      q,
      rules.map((r) => ({
        _id: String(r._id),
        rule_kind: r.rule_kind,
        rule_body: r.rule_body,
        category: r.category ?? null,
        priority: r.priority ?? null,
        enabled: r.enabled,
      })),
      memories.map((m) => ({
        _id: String(m._id),
        scope: m.scope,
        title: m.title ?? null,
        content: m.content,
        tags: m.tags ?? null,
        priority: m.priority ?? null,
      })),
      { scope, limit },
    );
  },
});

/**
 * Verbatim template fetch by title (or tag match). Used by `get_template`
 * tool — agent identifies the template name via search_knowledge first,
 * then this returns the exact text for inclusion.
 */
export const getTemplate = query({
  args: {
    name: v.string(),
    accountSlug: v.optional(v.string()),   // "dbcinema" | "leo" — filters templates
  },
  handler: async (ctx, { name, accountSlug }) => {
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_scope", (q) => q.eq("scope", "template"))
      .collect();
    const wanted = name.toLowerCase();
    const account = accountSlug?.toLowerCase();
    let best: (typeof rows)[number] | null = null;
    let bestScore = 0;
    for (const r of rows) {
      const title = (r.title ?? "").toLowerCase();
      const tagStr = (r.tags ?? []).join(" ").toLowerCase();
      const hay = `${title} ${tagStr}`;
      // Skip mismatched account when an account is provided AND the
      // template tags name an account.
      if (account) {
        const accountTagPresent =
          tagStr.includes("dbcinema") || tagStr.includes("leo");
        if (accountTagPresent && !tagStr.includes(account)) continue;
      }
      let score = 0;
      for (const t of wanted.split(/\s+/).filter((s) => s.length >= 3)) {
        if (hay.includes(t)) score += 1;
      }
      if (score > bestScore) {
        best = r;
        bestScore = score;
      }
    }
    if (!best) {
      return { found: false as const, name, content: null, lastModified: null };
    }
    return {
      found: true as const,
      name: best.title ?? "(untitled)",
      content: best.content,
      lastModified: best.updated_at ?? best._creationTime,
    };
  },
});
