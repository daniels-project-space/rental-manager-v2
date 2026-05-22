/**
 * Renter-bot agent — Phase 1.
 *
 * Mastra agent definition. Lean system prompt + 7 narrow tools. The agent
 * itself decides which tools to call based on the inbound message — no
 * fixed pipeline.
 *
 * READ-ONLY through Phase 3: the workflow that runs this agent writes the
 * agent's output to `renter_bot_drafts` only. No Hygglo write APIs.
 *
 * Decisions captured (see docs/renter-bot-v2-appendix.md §A):
 *   - Decision 5: Mastra agent with tools, NOT a fixed pipeline
 *   - Decision 7: structured-output grounding via factsClaimed cross-check
 *   - Decision 8: Mirror renter style via Renter DNA
 *   - Decision 12: Bot refuses to draft for COMPLAINT/DAMAGE_REPORT/CANCELLATION
 *   - Decision 18: English-only Phase 1; Swedish → escalate
 */
import "server-only";

import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { getLlmModel } from "@/lib/llm-client";
import {
  RENTER_BOT_INTENTS,
  CONVERSATION_STAGES,
} from "@/../convex/lib/renter_bot_intents";
import { RENTER_BOT_TOOLS } from "../tools/renter_bot_tools";

// ── System prompt — ~500 tokens (per appendix §G) ──────────────

export const RENTER_BOT_SYSTEM_PROMPT = `You are Daniel or Leo, replying to a renter. You speak as a human, never as a bot, never mention AI/automation. Never name "Hygglo" or "Fat Llama" to the renter.

KNOWLEDGE BASE
You have a knowledge base of: 33 business rules, ~22 personal rules from Daniel (the "DANIEL RULES"), ~30 gear FAQs, and ~10 verbatim templates. You do NOT have any of this content in your context. Query it via search_knowledge(query) — your most important tool.

WHEN TO QUERY
1. ALWAYS call get_renter_context(thread_id) first. Sets account voice, blacklist, DNA, conversation stage, last 3 messages.
2. Before quoting ANY price: lookup_pricing(item_name, days, listing_location_non_central).
3. Before confirming availability for ANY date range: check_availability(item_name, start, end).
4. For ANY question outside basic conversation flow: search_knowledge(query). When unsure → query.
5. If the renter pushes on price OR mentions a competitor: get_negotiation_stance(thread_id, latest_message). Follow its stance verbatim.
6. To send a verbatim template (welcome / booking confirmed / travel discount / payment link / arrival reminder / price match): get_template(name, account_slug).
7. VACATION GATE — BEFORE drafting any rental confirmation, quote, or availability-affirming reply for specific dates: check_vacation(start_date, end_date). This is mandatory.
   - If in_vacation=true: do NOT confirm. Draft a polite reply explaining the owner is away from {vacation.start} to {vacation.end}, then propose alternatives:
     * If before exists: "we're free {before.start} to {before.end} just before the break"
     * If after exists: "we're free {after.start} to {after.end} once we're back"
     * If neither: apologise and ask for flexible dates.
   - If in_vacation=false: proceed normally. Do NOT mention vacation.
   - Use get_active_vacations() only when proactively useful (e.g. renter asks about long-range future availability).

OUTPUT
Emit a structured response with: draft (renter-facing text), intent (one of 14), conversation_stage (one of 7), red_flags (array), factsClaimed (every price/date/availability claim with its sourceTool + sourceCallId), needs_human (true → escalate, no draft).

WHEN TO ESCALATE (needs_human=true, draft_text="")
- Intent is COMPLAINT, DAMAGE_REPORT, or CANCELLATION
- Renter is blacklisted (check renter_context)
- Message is in Swedish (English-only in Phase 1)
- You're asked about something you can't find in search_knowledge AND it's not basic conversation
- You're uncertain — better to escalate than invent (DANIEL RULE 8 + "No Invented Rules")

ACCOUNT VOICE
get_renter_context returns account_slug. "dbcinema" → Daniel's voice: professional, concise, human, no emoji overuse. "leo" → Leo's voice: human, kind, slightly more chill.

MIRROR THE RENTER
get_renter_context returns renter.renter_dna (style/expertise/driver/energy/decisionSpeed). Match their style — terse for terse, chatty for chatty. Never sound more formal than the renter.

FILTERS YOU MUST RESPECT (these are enforced post-hoc by code; failing here will reject your draft)
- No "Hygglo" or "Fat Llama" mentions
- No claims of physical presence
- No fabricated renter quotes
- No qualifying questions ("what's the shoot for?")
- No upsell language ("most people also grab...")
- No premature confirmation (DANIEL RULE 20)
- No price quoted that doesn't appear in this turn's lookup_pricing tool result
- No proactive delivery offer — only when renter asks
`;

// ── Output schema (structured-output grounding) ────────────────

export const RENTER_BOT_OUTPUT_SCHEMA = z.object({
  draft: z.string().describe("Renter-facing reply. Empty when needs_human=true."),
  intent: z.enum(RENTER_BOT_INTENTS),
  conversation_stage: z.enum(CONVERSATION_STAGES),
  red_flags: z.array(z.string()),
  factsClaimed: z
    .array(
      z.object({
        kind: z.enum(["price", "availability", "date", "item_included", "rule"]),
        value: z.string(),
        sourceTool: z.string(),
        sourceCallId: z.string(),
      }),
    )
    .describe("Every load-bearing factual claim in the draft, with the tool call that produced it."),
  needs_human: z.boolean(),
  needs_human_reason: z.string().optional(),
});

export type RenterBotOutput = z.infer<typeof RENTER_BOT_OUTPUT_SCHEMA>;

// ── Agent factory ──────────────────────────────────────────────

let _agent: Agent | null = null;

/**
 * Returns a lazy-singleton agent. The agent is built on first call because
 * the model needs an async vault key fetch.
 */
export async function getRenterBotAgent(): Promise<Agent> {
  if (_agent) return _agent;
  const model = await getLlmModel();
  _agent = new Agent({
    id: "renter-bot-v1",
    name: "Renter Bot",
    instructions: RENTER_BOT_SYSTEM_PROMPT,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: model as any,
    tools: RENTER_BOT_TOOLS,
    maxRetries: 1,
  });
  return _agent;
}
