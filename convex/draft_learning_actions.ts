"use node";
/**
 * Draft self-improvement — the analyzer (Node runtime, LLM).
 *
 * Fires (async, best-effort) when the owner sends a reply DIFFERENT from the AI
 * draft. It finds the CORE issue and resolves it at the source rather than
 * piling on rules (Daniel, 2026-07-03):
 *   - a wrong FACT (price/kit/availability) → skip (the live-listing grounding
 *     is the fix, not a new rule);
 *   - a style/policy preference → REFINE an existing lesson where one fits, and
 *     only ADD a new one when it's genuinely distinct.
 * The lesson set stays small (hard-capped + merged in draft_learning.upsert) and
 * only the relevant few are injected per draft. Never blocks the send; drafts
 * stay operator-reviewed.
 */
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { getActionLlmModel } from "./item_resolver";
import { gatedGenerateText } from "./lib/gatedGenerate";

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first >= 0 && last > first ? text.slice(first, last + 1) : text;
}

const tokenSet = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9']+/g) ?? []);

/**
 * How the owner used the draft (drives what/whether to learn):
 *   scratch  — no draft was shown → they wrote their own
 *   rewrote  — a draft existed but they kept little of it
 *   added    — kept most of the draft but added meaningful text on top (draft was incomplete)
 *   null     — used it verbatim / trivial tweak → nothing to learn
 */
function classifyDraftUse(sent: string, draft: string): "scratch" | "rewrote" | "added" | null {
  if (sent.trim().length < 20) return null;
  if (draft.trim().length === 0) return "scratch";
  const D = tokenSet(draft);
  const S = tokenSet(sent);
  if (!D.size) return "scratch";
  let keptN = 0;
  for (const x of D) if (S.has(x)) keptN++;
  const kept = keptN / D.size;
  let added = 0;
  for (const x of S) if (!D.has(x)) added++;
  if (kept < 0.6) return "rewrote";
  if (added >= 6) return "added";
  return null;
}

export const analyzeDivergence = internalAction({
  args: {
    thread_id: v.string(),
    account_slug: v.optional(v.string()),
    sent_text: v.string(),
    draft_text: v.optional(v.string()),
  },
  handler: async (ctx, { thread_id, account_slug, sent_text, draft_text }) => {
    const draft =
      draft_text ??
      (await ctx.runQuery(internal.draft_learning.getDraftText, { thread_id })) ??
      "";

    // Classify how the owner used the draft; only learn when they didn't just
    // use it as-is. This is the whole trigger — it runs on every real send.
    const mode = classifyDraftUse(sent_text, draft);
    if (!mode) return;

    let transcript = "";
    try {
      const c = await ctx.runQuery(internal.replyInbox.getThreadContext, { thread_id });
      transcript = c.messages
        .map((m) => `${m.role === "owner" ? "Owner" : "Renter"}: ${m.content}`)
        .join("\n");
    } catch {
      /* transcript best-effort */
    }

    const existing = (await ctx.runQuery(internal.draft_learning.forScope, {
      account_slug,
    })) as Array<{ _id: string; applies_when: string; lesson: string; tags?: string[] }>;

    const system =
      "You maintain a SMALL, high-quality set of drafting lessons for an equipment-rental owner's AI reply assistant. " +
      "You learn from cases where the owner sent a reply DIFFERENT from the AI's draft. " +
      "Your job is to find the CORE reason the draft was off and fix it at the source — NOT to pile up rules. Be conservative: most divergences need NO new lesson. " +
      "Output STRICT JSON only.";
    const prompt = [
      "CONVERSATION SO FAR:",
      transcript || "(unavailable)",
      "",
      mode === "added"
        ? "AI DRAFT (the owner KEPT this and ADDED to it — so the draft was INCOMPLETE):"
        : "AI DRAFT (owner chose NOT to send this):",
      draft || "(no draft was shown)",
      "",
      "WHAT THE OWNER ACTUALLY SENT:",
      sent_text,
      mode === "added"
        ? "\nNOTE: the owner used the draft but added text on top. Work out WHAT the draft was MISSING (what the owner added) and make the lesson about including that kind of thing in this situation."
        : "",
      "",
      "CURRENT LESSON SET (keep it small; PREFER refining one of these over adding a new one):",
      existing.length
        ? existing.map((e, i) => `[${i + 1}] ${e.applies_when}: ${e.lesson}`).join("\n")
        : "(empty)",
      "",
      'Return JSON: {"root_cause": "fact"|"style"|"policy"|"missing_knowledge"|"none", "action": "skip"|"refine"|"add", "refine_index": number|null, "applies_when": string, "tags": string[], "draft_mistake": string, "lesson": string, "scope": "account"|"global"}.',
      "Decide the action:",
      "- SKIP if: the owner's reply is basically the same as the draft; OR it's a one-off/templated info dump (bank details, a specific address/link/price for THIS booking); OR it's trivial (ok/thanks); OR root_cause is 'fact' — a wrong price/spec/availability is a DATA problem handled by the live-listing grounding, NOT a drafting rule, so do not create a lesson for it.",
      "- REFINE (preferred) if an existing lesson already covers this area: set refine_index to its [number] and give an improved, still-general merged lesson.",
      "- ADD only if this is a genuinely NEW, distinct style/policy preference not covered by any existing lesson.",
      "The lesson must be GENERAL and reusable (how the owner wants replies written) — no specific prices, names, or dates. Keep applies_when short; tags = 2-6 lowercase keywords.",
    ].join("\n");

    let gen;
    try {
      gen = await gatedGenerateText({
        model: await getActionLlmModel({ strong: true }),
        system,
        prompt,
        bypass: true,
        context: { source: "draft_learning.analyzeDivergence", tag: "draft_learn" },
      });
    } catch {
      return;
    }
    if (gen.skipped) return;

    let obj: {
      root_cause?: string;
      action?: string;
      refine_index?: number | null;
      applies_when?: string;
      tags?: string[];
      draft_mistake?: string;
      lesson?: string;
      scope?: string;
    };
    try {
      obj = JSON.parse(extractJson(gen.result.text ?? ""));
    } catch {
      return;
    }
    if (!obj || obj.action === "skip" || obj.root_cause === "fact") return;
    if ((obj.action !== "add" && obj.action !== "refine") || !obj.lesson || !obj.applies_when) return;

    const refineId =
      obj.action === "refine" &&
      typeof obj.refine_index === "number" &&
      obj.refine_index >= 1 &&
      obj.refine_index <= existing.length
        ? (existing[obj.refine_index - 1]._id as never)
        : undefined;

    await ctx.runMutation(internal.draft_learning.upsert, {
      account_slug: obj.scope === "global" ? undefined : account_slug,
      applies_when: String(obj.applies_when).slice(0, 120),
      tags: (obj.tags ?? []).slice(0, 6).map((t) => String(t).toLowerCase()),
      lesson: String(obj.lesson).slice(0, 500),
      draft_mistake: obj.draft_mistake ? String(obj.draft_mistake).slice(0, 300) : undefined,
      example_sent: sent_text.slice(0, 400),
      refine_id: refineId,
    });
  },
});
