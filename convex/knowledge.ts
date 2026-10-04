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
import type { QueryCtx } from "./_generated/server";

async function knowledgeAccount(ctx: QueryCtx, args: {threadId?:string;accountSlug?:string}) {
  let account = args.accountSlug?.trim().toLowerCase();
  if (args.threadId !== undefined) {
    const conversation = await ctx.db.query("conversations")
      .withIndex("by_thread", q => q.eq("thread_id", args.threadId!)).first();
    const nativeAccount = conversation?.account_slug?.trim().toLowerCase();
    if (!nativeAccount || (account !== undefined && account !== nativeAccount)) return null;
    account = nativeAccount;
  }
  return account !== undefined && !(ACCOUNT_SLUGS as readonly string[]).includes(account) ? null : account;
}

function memoryAppliesToAccount(tags: string[] | undefined, account: string | undefined) {
  const accounts = (tags ?? []).map(tag => tag.trim().toLowerCase())
    .filter(tag => (ACCOUNT_SLUGS as readonly string[]).includes(tag));
  return account === undefined || accounts.length === 0 || accounts.includes(account);
}

export const search = query({
  args: {
    query: v.string(),
    scope: v.optional(v.string()),       // "all" | "rule" | "memory" | "operational" | "template" | "faq"
    limit: v.optional(v.number()),
    threadId: v.optional(v.string()),
    accountSlug: v.optional(v.string()),
  },
  handler: async (ctx, { query: q, scope, limit, threadId, accountSlug }) => {
    const account = await knowledgeAccount(ctx, {threadId, accountSlug});
    if (account === null) return [];
    const rules = await ctx.db.query("rules").collect();
    const memories = await ctx.db.query("memories").collect();
    const accountRecord = account !== undefined && rules.some(rule => rule.account_id)
      ? await ctx.db.query("accounts").withIndex("by_slug", q => q.eq("slug", account)).first()
      : null;
    return rankKnowledge(
      q,
      rules.filter(r => account === undefined || !r.account_id || r.account_id === accountRecord?._id).map((r) => ({
        _id: String(r._id),
        rule_kind: r.rule_kind,
        rule_body: r.rule_body,
        category: r.category ?? null,
        priority: r.priority ?? null,
        enabled: r.enabled,
      })),
      memories.filter(m => memoryAppliesToAccount(m.tags, account)).map((m) => ({
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
    const account = await knowledgeAccount(ctx, {threadId, accountSlug});
    if (account === null) return missing();
    const identity = (value: string) => value.normalize("NFC").trim()
      .replace(/^template:\s*/i, "").replace(/\s+/g, " ").toLowerCase();
    const wanted = identity(name);
    if (!wanted) return missing();
    const rows = await ctx.db.query("memories")
      .withIndex("by_scope", q => q.eq("scope", "template")).collect();
    const matches = rows.filter(row => {
      if (identity(row.title ?? "") !== wanted || !row.content.trim()) return false;
      return memoryAppliesToAccount(row.tags, account);
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
