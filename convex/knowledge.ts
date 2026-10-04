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
import { query, internalQueryOf } from "./owner_functions";
import { v } from "convex/values";
import { rankKnowledge } from "./lib/knowledge_search";
import { ACCOUNT_SLUGS } from "./lib/reservations/accounts";

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

/** Exact template identity; discovery belongs to search_knowledge. */
export const getTemplate = query({
  args: {
    name: v.string(),
    accountSlug: v.optional(v.string()),
    threadId: v.optional(v.string()),
  },
  handler: async (ctx, { name, accountSlug, threadId }) => {
    const missing = () => ({ found: false as const, name, content: null, lastModified: null });
    let account = accountSlug?.trim().toLowerCase();
    if (threadId !== undefined) {
      const conversation = await ctx.db.query("conversations")
        .withIndex("by_thread", q => q.eq("thread_id", threadId)).first();
      const nativeAccount = conversation?.account_slug?.trim().toLowerCase();
      if (!nativeAccount || (account !== undefined && account !== nativeAccount)) return missing();
      account = nativeAccount;
    }
    if (account !== undefined && !(ACCOUNT_SLUGS as readonly string[]).includes(account)) return missing();
    const identity = (value: string) => value.normalize("NFC").trim()
      .replace(/^template:\s*/i, "").replace(/\s+/g, " ").toLowerCase();
    const wanted = identity(name);
    if (!wanted) return missing();
    const rows = await ctx.db.query("memories")
      .withIndex("by_scope", q => q.eq("scope", "template")).collect();
    const matches = rows.filter(row => {
      if (identity(row.title ?? "") !== wanted || !row.content.trim()) return false;
      const accountTags = (row.tags ?? []).map(tag => tag.trim().toLowerCase())
        .filter(tag => (ACCOUNT_SLUGS as readonly string[]).includes(tag));
      return account === undefined || accountTags.length === 0 || accountTags.includes(account);
    });
    // Conflicting exact records need review, never arbitrary row-order selection.
    if (matches.length !== 1) return missing();
    const match = matches[0];
    return { found: true as const, name: match.title!, content: match.content,
      lastModified: match.updated_at ?? match._creationTime };
  },
});

// Privileged caller counterpart; shares the original handler and validators.
export const __service_search = internalQueryOf(search);
