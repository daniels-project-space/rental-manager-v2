/**
 * Wave 4 — Hygglo rental decision-maker Mastra agent.
 *
 * Distinct from `dashboard-chat`:
 *   - Different system prompt (decision generator, not Q&A).
 *   - READ-ONLY tool subset — NEVER calls a tool that writes to Hygglo or Convex
 *     (we use the same `data/` layer as dashboard-chat but restrict the surface).
 *   - Model: grok-4-1-fast-non-reasoning (matches dashboard agent).
 *
 * INPUT shape (passed via system-prompt-injected context block in the workflow):
 *   {
 *     hygglo_order_id, account_slug, renter, item_breakdown,
 *     start_date, end_date, total_gbp, blacklisted, recent_messages
 *   }
 *
 * OUTPUT shape (enforced via `structuredOutput`-style suffix in the prompt;
 * the workflow then JSON.parse the assistant message text):
 *   {
 *     decision: 'accept' | 'decline' | 'ask_renter',
 *     confidence: number,      // 0..1
 *     reasoning: string,       // short — single paragraph
 *     suggestedReply: string,  // owner-→-renter draft message
 *     redFlags: string[]
 *   }
 *
 * SAFETY: this agent never has write tools attached. It generates JSON only;
 * persistence + side effects happen in the Convex mutation invoked by the
 * workflow's `writeDecisions` step. Hygglo is NEVER contacted from here.
 */
import "server-only";

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { createXai } from "@ai-sdk/xai";
import { z } from "zod";
import * as data from "@/mastra/data";

const xai = createXai({ apiKey: process.env.XAI_API_KEY ?? "" });

// ── READ-ONLY tool subset ────────────────────────────────────────
// Carefully cherry-picked: only tools that observe state. NO updates to
// rules/memories/rental status/Hygglo. The dashboard-chat agent has a
// broader surface (including update_rule, update_memory) — this one MUST NOT.

const lookupPricing = createTool({
  id: "lookup_pricing",
  description:
    "Get the canonical daily rate for an item. Use to sanity-check whether a request undershoots our published rates.",
  inputSchema: z.object({
    itemName: z.string(),
    days: z.number().optional(),
  }),
  execute: async (input: { itemName: string; days?: number }) =>
    data.catalog.lookupPricing(input),
});

const checkAvailability = createTool({
  id: "check_availability",
  description:
    "Confirm the requested item is free for the requested dates. Counts confirmed + pending reservations.",
  inputSchema: z.object({
    itemName: z.string(),
    startDate: z.string(),
    endDate: z.string(),
  }),
  execute: async (input: { itemName: string; startDate: string; endDate: string }) =>
    data.catalog.checkAvailability(input),
});

const getRenterProfile = createTool({
  id: "get_renter_profile",
  description:
    "Look up a renter's lifetime spend, rating, prior rental count, and any blacklist flag.",
  inputSchema: z.object({
    name: z.string(),
  }),
  execute: async (input: { name: string }) =>
    data.renters.getProfile(input),
});

const checkCompatibility = createTool({
  id: "check_compatibility",
  description:
    "Verify that bundled items in a request are technically compatible (e.g. mount/lens/camera).",
  inputSchema: z.object({
    items: z.array(z.string()),
  }),
  execute: async (input: { items: string[] }) =>
    data.catalog.checkCompatibility(input),
});

const aiDecisionTools = {
  lookupPricing,
  checkAvailability,
  getRenterProfile,
  checkCompatibility,
} as const;

// ── System prompt ────────────────────────────────────────────────

export const AI_DECISION_PROMPT = `You are the **Rental Decision Generator** for a Hygglo camera-rental
business operating two accounts: "dbcinema" and "leo".

You are NEVER chatting with a human. Your sole job is, for each NEW rental
order surfaced by the poller, to emit a single JSON object scoring the
request. You output STRICTLY one fenced JSON code block — no prose,
no preamble, no postamble.

--- DECISION TAXONOMY ---
- "accept"     — high confidence the request is safe; recommend owner approve.
- "decline"    — clear red flags (item unavailable, undervalued price, blacklisted
                 renter, incompatible bundle, dates conflicting).
- "ask_renter" — needs clarification before owner can decide (vague dates,
                 ambiguous item, missing context the renter could supply).

--- REQUIRED OUTPUT SHAPE ---
\`\`\`json
{
  "decision": "accept" | "decline" | "ask_renter",
  "confidence": 0.0-1.0,
  "reasoning": "1-3 sentence narrative grounded in tool results.",
  "suggestedReply": "draft message the owner can send the renter.",
  "redFlags": ["short array of concrete concerns; empty if none"]
}
\`\`\`

--- TOOLS ---
Before deciding you SHOULD call these tools as relevant:
  - lookup_pricing       (does requested total match our rates?)
  - check_availability   (is the item free for the dates?)
  - get_renter_profile   (lifetime spend, blacklist, prior rental count)
  - check_compatibility  (bundle items go together?)

All 4 are READ-ONLY. There are no write tools. Do not request other tools.

--- HARD RULES ---
1. If \`blacklisted=true\` is anywhere in the context block or renter profile,
   output decision="decline" with redFlags including "blacklisted_renter".
2. If \`check_availability\` returns \`available=false\`, prefer "decline" unless
   the conflict is < 1 day (then "ask_renter").
3. Suggested reply ALWAYS mentions the items + dates and signs off cordially.
4. Do not hallucinate prices — only cite numbers returned by lookup_pricing.
5. Confidence < 0.5 maps to "ask_renter" unless the rule above forces "decline".

--- NEVER ---
- Never call Hygglo or any external API directly. Tools only.
- Never speculate about renter intent without quoting message context.
- Never output anything outside the fenced JSON block.

You are evaluating new orders surfaced from a 5-minute poll. Be decisive but
flag uncertainty honestly. Daniel will manually approve every decision before
it acts on Hygglo (READ_ONLY_MODE is on).`;

export const aiDecisionAgent = new Agent({
  id: "ai-decision",
  name: "ai-decision",
  instructions: AI_DECISION_PROMPT,
  model: xai("grok-4-1-fast-non-reasoning"),
  tools: aiDecisionTools,
});
