/**
 * Keyword scorer across `rules` + `memories` (Phase 1 implementation).
 *
 * Pure scorer — exposed as a Convex query in `convex/knowledge.ts`. Phase 2+
 * will swap to embeddings while keeping this signature.
 *
 * Ranking:
 *   1. relevance desc (token-hit count)
 *   2. priority desc  (rule priority 10 > 9 > ... ; memory priority 10 > 9 > ...)
 *
 * Token rule: lowercase the haystack + needle, split on whitespace, ignore
 * tokens shorter than 3 characters. Substring containment, not prefix —
 * "delivery" matches "deliver" too.
 *
 * 2026-08-17: was priority-desc-first. With ~100 operational rules seeded
 * at priority 10 and FAQs/templates at 6-7, that meant a rule with a couple
 * of incidental word overlaps (common tokens like "the"/"sent"/"accept" are
 * unfiltered substrings, not word-boundary matches) permanently outranked
 * an FAQ that was a near-total keyword match for the question. Confirmed
 * live: "FAQ: Reservation Hold" (relevance 6 — the single highest score
 * across all 83 matches for "is my slot held in the meantime") ranked 74th
 * of 83 because its priority (6) sat behind 73 priority-10 rules with
 * relevance as low as 2. The bot's real search_knowledge tool call (limit
 * 3-5) never saw it and escalated a fully FAQ-answerable question. Priority
 * now only breaks ties among equally-relevant hits, which is what it reads
 * as doing anyway.
 */

export type KnowledgeHit = {
  source: "rule" | "memory";
  title: string;
  content: string;
  category?: string | null;   // for rules: policy | pricing | ... ; for memories: tag list joined
  scope?: string | null;       // for memories
  priority: number;
  relevance: number;
  id: string;
};

export interface ScorerInputRule {
  _id: string;
  rule_kind: string;
  rule_body: string;
  category?: string | null;
  priority?: number | null;
  enabled: boolean;
}

export interface ScorerInputMemory {
  _id: string;
  scope: string;
  title?: string | null;
  content: string;
  tags?: string[] | null;
  priority?: number | null;
}

function tokens(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 3);
}

function scoreHay(hay: string, qs: string[]): number {
  if (qs.length === 0) return 0;
  let score = 0;
  for (const t of qs) if (hay.includes(t)) score += 1;
  return score;
}

export function rankKnowledge(
  query: string,
  rules: ScorerInputRule[],
  memories: ScorerInputMemory[],
  opts: { scope?: string; limit?: number } = {},
): KnowledgeHit[] {
  const qs = tokens(query);
  if (qs.length === 0) return [];
  const limit = opts.limit ?? 5;
  const scoped = opts.scope?.toLowerCase();

  const hits: KnowledgeHit[] = [];

  for (const r of rules) {
    if (!r.enabled) continue;
    if (scoped === "rule" || scoped === "rules") {
      // intentionally no filter — proceed
    } else if (scoped && scoped !== "all" && scoped !== "rule" && scoped !== "rules") {
      // skip rules when scope is e.g. "template" / "faq"
      continue;
    }
    const hay = `${r.rule_kind} ${r.rule_body} ${r.category ?? ""}`.toLowerCase();
    const rel = scoreHay(hay, qs);
    if (rel === 0) continue;
    hits.push({
      source: "rule",
      title: r.rule_kind,
      content: r.rule_body,
      category: r.category ?? null,
      scope: null,
      priority: r.priority ?? 5,
      relevance: rel,
      id: r._id,
    });
  }

  for (const m of memories) {
    if (scoped && scoped !== "all" && scoped !== "memory" && scoped !== "memories") {
      if (m.scope !== scoped) continue;
    }
    const tagStr = (m.tags ?? []).join(" ");
    const hay = `${m.title ?? ""} ${m.content} ${tagStr}`.toLowerCase();
    const rel = scoreHay(hay, qs);
    if (rel === 0) continue;
    hits.push({
      source: "memory",
      title: m.title ?? m.content.slice(0, 80),
      content: m.content,
      category: tagStr || null,
      scope: m.scope,
      priority: m.priority ?? (m.scope === "operational" ? 10 : 5),
      relevance: rel,
      id: m._id,
    });
  }

  hits.sort((a, b) => b.relevance - a.relevance || b.priority - a.priority);
  return hits.slice(0, limit);
}
