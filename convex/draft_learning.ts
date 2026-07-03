/**
 * Draft self-improvement — storage + retrieval (V8 runtime).
 *
 * Design principle (Daniel, 2026-07-03): DON'T pile up rules. When the owner
 * sends a reply different from the AI draft, the analyzer (draft_learning_actions)
 * finds the CORE issue and RESOLVES it at the source:
 *   - a wrong FACT (price/kit/availability) is NOT turned into a rule — it's a
 *     data problem the live-listing grounding handles; we skip it here.
 *   - a genuine style/policy preference REFINES an existing lesson where one
 *     exists, and only adds a NEW lesson when it's truly distinct.
 * The lesson set is hard-capped + de-duplicated so it stays small and coherent,
 * and only the few relevant ones are injected per draft.
 */
import { internalQuery, internalMutation, query, mutation } from "./_generated/server";
import { v } from "convex/values";

const MAX_PER_SCOPE = 12; // keep the set small on purpose

function toks(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9']{2,}/g) ?? []));
}
function jaccard(a: string, b: string): number {
  const A = toks(a);
  const B = toks(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export const getDraftText = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();
    return conv?.ai_draft_text ?? null;
  },
});

/** The full (small) lesson set for a scope — the analyzer sees ALL of them so it
 *  can choose to refine one rather than pile on. */
export const forScope = internalQuery({
  args: { account_slug: v.optional(v.string()) },
  handler: async (ctx, { account_slug }) => {
    const all = await ctx.db.query("draft_lessons").collect();
    return all
      .filter((l) => l.account_slug == null || l.account_slug === account_slug)
      .sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))
      .map((l) => ({
        _id: l._id,
        applies_when: l.applies_when,
        lesson: l.lesson,
        tags: l.tags,
        account_slug: l.account_slug ?? null,
      }));
  },
});

/**
 * Consolidation-first upsert. If the analyzer named a lesson to refine, replace
 * it (bump weight). Otherwise merge into the most-similar existing lesson when
 * they clearly overlap; only insert a genuinely new one. Hard-cap the scope.
 */
export const upsert = internalMutation({
  args: {
    account_slug: v.optional(v.string()),
    applies_when: v.string(),
    tags: v.array(v.string()),
    lesson: v.string(),
    draft_mistake: v.optional(v.string()),
    example_sent: v.optional(v.string()),
    refine_id: v.optional(v.id("draft_lessons")),
  },
  handler: async (ctx, a): Promise<{ action: "refined" | "merged" | "inserted" }> => {
    const now = Date.now();

    if (a.refine_id) {
      const cur = await ctx.db.get(a.refine_id);
      if (cur) {
        await ctx.db.patch(a.refine_id, {
          applies_when: a.applies_when,
          tags: a.tags,
          lesson: a.lesson,
          draft_mistake: a.draft_mistake,
          weight: (cur.weight ?? 1) + 1,
          updated_at: now,
        });
        return { action: "refined" };
      }
    }

    const scopeRows = (await ctx.db.query("draft_lessons").collect()).filter(
      (l) => l.account_slug === a.account_slug,
    );
    // Merge into a clearly-overlapping existing lesson instead of adding a dup.
    const candidateText = `${a.applies_when} ${a.tags.join(" ")} ${a.lesson}`;
    let best: { id: (typeof scopeRows)[number]["_id"]; sim: number; weight: number } | null = null;
    for (const r of scopeRows) {
      const sim = jaccard(candidateText, `${r.applies_when} ${(r.tags ?? []).join(" ")} ${r.lesson}`);
      if (!best || sim > best.sim) best = { id: r._id, sim, weight: r.weight ?? 1 };
    }
    if (best && best.sim >= 0.45) {
      await ctx.db.patch(best.id, {
        applies_when: a.applies_when,
        tags: a.tags,
        lesson: a.lesson,
        draft_mistake: a.draft_mistake,
        weight: best.weight + 1,
        updated_at: now,
      });
      return { action: "merged" };
    }

    await ctx.db.insert("draft_lessons", {
      account_slug: a.account_slug,
      applies_when: a.applies_when,
      tags: a.tags,
      lesson: a.lesson,
      draft_mistake: a.draft_mistake,
      weight: 1,
      example_sent: a.example_sent,
      created_at: now,
      updated_at: now,
    });

    // Hard cap: evict the weakest, oldest lessons beyond MAX_PER_SCOPE.
    const after = (await ctx.db.query("draft_lessons").collect()).filter(
      (l) => l.account_slug === a.account_slug,
    );
    if (after.length > MAX_PER_SCOPE) {
      after
        .sort((x, y) => (x.weight ?? 1) - (y.weight ?? 1) || (x.updated_at ?? 0) - (y.updated_at ?? 0))
        .slice(0, after.length - MAX_PER_SCOPE)
        .forEach((r) => void ctx.db.delete(r._id));
    }
    return { action: "inserted" };
  },
});

// ── UI surface (view + prune) ──
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("draft_lessons").collect();
    return rows
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .map((l) => ({
        _id: l._id,
        account_slug: l.account_slug ?? null,
        applies_when: l.applies_when,
        lesson: l.lesson,
        draft_mistake: l.draft_mistake ?? null,
        weight: l.weight ?? 1,
        updated_at: l.updated_at,
      }));
  },
});

export const remove = mutation({
  args: { id: v.id("draft_lessons") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
    return { ok: true };
  },
});
