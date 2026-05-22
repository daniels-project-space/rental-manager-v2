/**
 * Renter-bot draft workflow — Phase 1, READ-ONLY.
 *
 * Inbound trigger: every 10 min cron in `src/trigger/renter-bot-batch.ts`
 * pulls unanswered renter messages and feeds them to this workflow.
 *
 * Per spec §A:
 *   - Decision 15: dormant in UK quiet hours (02:00–08:30). The whole
 *     batch step short-circuits before any LLM call.
 *   - Decision 6: filter strictness = block + regenerate up to 2× + flag-
 *     and-forward when still bad.
 *   - Decision 7: structured-output grounding via factsClaimed cross-check.
 *
 * READ-ONLY GUARANTEE: the only mutation this workflow performs is
 * `renter_bot_drafts.writeDraft` (and `expireOldDrafts`). No Hygglo writes.
 */
import "server-only";

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/../convex/_generated/api";
import { isWithinUkQuietHours } from "@/lib/quiet-hours";
import { getLlmModelId } from "@/lib/llm-client";
import {
  getRenterBotAgent,
  RENTER_BOT_OUTPUT_SCHEMA,
  type RenterBotOutput,
} from "../agents/renter_bot";
import {
  applyRenterBotFilters,
  buildFilterHint,
} from "@/../convex/lib/renter_bot_filters";
import { isOutOfScopeIntent } from "@/../convex/lib/renter_bot_intents";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyApi = api as any;

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

function convex(): ConvexHttpClient {
  return new ConvexHttpClient(CONVEX_URL);
}

// ── Shared schemas ────────────────────────────────────────────

const threadCandidate = z.object({
  thread_id: z.string(),
  account_slug: z.string(),
  last_inbound_message_id: z.string(),
  last_inbound_at: z.number(),
  last_inbound_body: z.string(),
});
type ThreadCandidate = z.infer<typeof threadCandidate>;

const runState = z.object({
  startedAt: z.number(),
  candidatesCount: z.number(),
  draftsWritten: z.number(),
  draftsSkipped: z.number(),
  escalations: z.number(),
  filterRegenerations: z.number(),
  quietHoursSkipped: z.boolean(),
});
type RunState = z.infer<typeof runState>;

// ── Step 1: find threads needing a draft ──────────────────────

const findCandidates = createStep({
  id: "findCandidates",
  inputSchema: z.object({
    thread_ids: z.array(z.string()).optional(),
    limit: z.number().optional(),
  }),
  outputSchema: runState.extend({ candidates: z.array(threadCandidate) }),
  execute: async ({ inputData }) => {
    const c = convex();
    const limit = inputData.limit ?? 20;

    // If the trigger gave us explicit thread_ids, resolve those.
    // Otherwise, ask Convex for threads whose latest message is from the
    // renter AND has no pending draft.
    const candidates: ThreadCandidate[] = await c.query(
      anyApi.renter_bot_batch.listUnansweredThreads,
      { limit, thread_ids: inputData.thread_ids },
    ).catch((): ThreadCandidate[] => []);

    return {
      startedAt: Date.now(),
      candidates,
      candidatesCount: candidates.length,
      draftsWritten: 0,
      draftsSkipped: 0,
      escalations: 0,
      filterRegenerations: 0,
      quietHoursSkipped: false,
    };
  },
});

// ── Step 2: agent batch ────────────────────────────────────────

const agentBatch = createStep({
  id: "agentBatch",
  inputSchema: runState.extend({ candidates: z.array(threadCandidate) }),
  outputSchema: runState,
  execute: async ({ inputData }) => {
    // Decision 15: bail out entirely during UK quiet hours.
    if (isWithinUkQuietHours()) {
      return { ...inputData, quietHoursSkipped: true, candidates: undefined };
    }
    if (inputData.candidates.length === 0) {
      return { ...inputData, candidates: undefined };
    }

    const c = convex();
    const agent = await getRenterBotAgent();
    const modelId = getLlmModelId();

    // Soft proactive nudge (wave 3 vacation-mode): load active vacations once
    // per batch and surface any starting within the next 14 days as a primer
    // line, so the bot can weave them in naturally without an extra tool call.
    let upcomingVacationPrimer = "";
    try {
      const activeVacs: Array<{
        start_date: string;
        end_date: string;
        reason?: string;
      }> = await c.query(anyApi.vacation.getActiveVacations, {});
      const today = new Date().toISOString().slice(0, 10);
      const cutoff = new Date(Date.now() + 14 * 86400_000)
        .toISOString()
        .slice(0, 10);
      const soon = (activeVacs ?? []).filter(
        (v) => v.start_date >= today && v.start_date <= cutoff,
      );
      if (soon.length > 0) {
        upcomingVacationPrimer =
          "UPCOMING OWNER VACATIONS (next 14 days):\n" +
          soon
            .map(
              (v) =>
                `- ${v.start_date} → ${v.end_date}${v.reason ? ` (${v.reason})` : ""}`,
            )
            .join("\n");
      }
    } catch (err) {
      console.warn(
        `[renter-bot] failed to load upcoming vacations: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let written = 0;
    let skipped = 0;
    let escalations = 0;
    let regens = 0;

    for (const cand of inputData.candidates) {
      // Expire any prior pending draft for this thread that wasn't keyed
      // to the current latest inbound. (Idempotency: re-running on the
      // same trigger does NOT create a duplicate, see writeDraft logic.)
      await c.mutation(anyApi.renter_bot_drafts.expireOldDrafts, {
        thread_id: cand.thread_id,
        keep_last_inbound_message_id: cand.last_inbound_message_id,
      });

      const baseMessages = [
        {
          role: "user" as const,
          content: [
            `THREAD: ${cand.thread_id}`,
            `ACCOUNT: ${cand.account_slug}`,
            ...(upcomingVacationPrimer ? [upcomingVacationPrimer] : []),
            `LATEST INBOUND MESSAGE FROM RENTER:`,
            cand.last_inbound_body,
          ].join("\n"),
        },
      ];

      let output: RenterBotOutput | null = null;
      let escalated = false;
      let regenCount = 0;
      let originalDraft = "";
      let previousHint = "";

      // Up to 3 attempts: first + 2 filter-driven regens.
      for (let attempt = 0; attempt <= 2; attempt++) {
        try {
          const messages =
            attempt === 0
              ? baseMessages
              : [
                  ...baseMessages,
                  {
                    role: "system" as const,
                    content: `FILTER VIOLATIONS on your previous draft:\n${previousHint}`,
                  },
                ];

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result: any = await (agent as any).generate(messages, {
            structuredOutput: { schema: RENTER_BOT_OUTPUT_SCHEMA },
          });
          // Mastra returns the structured object on `object` (legacy) or
          // `structuredOutput`. We probe both for forward-compat.
          const obj =
            (result?.object as RenterBotOutput | undefined) ??
            (result?.structuredOutput as RenterBotOutput | undefined) ??
            null;
          if (!obj) {
            // No structured output came back — treat as escalation.
            escalated = true;
            output = null;
            break;
          }
          if (attempt === 0) originalDraft = obj.draft;

          // Decision 12: out-of-scope intents auto-escalate.
          if (isOutOfScopeIntent(obj.intent)) {
            output = { ...obj, draft: "", needs_human: true, needs_human_reason: `out_of_scope:${obj.intent}` };
            escalated = true;
            break;
          }
          if (obj.needs_human) {
            output = { ...obj, draft: "" };
            escalated = true;
            break;
          }

          // Hard-filter pass.
          const filt = applyRenterBotFilters(obj.draft);
          if (filt.ok) {
            output = { ...obj, draft: filt.stripped };
            break;
          }
          // Build hint for next attempt.
          previousHint = buildFilterHint(filt);
          regens += 1;
          regenCount += 1;
          if (attempt === 2) {
            // Last attempt failed filters → escalate with red banner.
            output = { ...obj, draft: filt.stripped, red_flags: [
              ...obj.red_flags,
              ...filt.violations.map((v) => `FILTER:${v.category}`),
            ] };
            escalated = true;
          }
        } catch (err) {
          console.error(`[renter-bot] agent.generate failed thread=${cand.thread_id}: ${err instanceof Error ? err.message : String(err)}`);
          // Don't write a draft on hard failure — let the next cron pick it up.
          escalated = false;
          output = null;
          break;
        }
      }

      if (!output) {
        skipped += 1;
        continue;
      }

      const writeRes = await c.mutation(anyApi.renter_bot_drafts.writeDraft, {
        thread_id: cand.thread_id,
        account_slug: cand.account_slug,
        last_inbound_message_id: cand.last_inbound_message_id,
        last_inbound_at: cand.last_inbound_at,
        draft_text: output.draft,
        original_draft: originalDraft || output.draft,
        draft_intent: output.intent,
        draft_stage: output.conversation_stage,
        draft_confidence: 0.7,
        draft_red_flags: output.red_flags,
        facts_claimed: groundFacts(output),
        needs_human: !!output.needs_human,
        needs_human_reason: output.needs_human_reason,
        generated_by: "renter-bot-v1",
        model_id: modelId,
        regeneration_count: regenCount,
        escalated,
      });

      if (writeRes?.action === "inserted") written += 1;
      else skipped += 1;
      if (escalated) escalations += 1;
    }

    return {
      ...inputData,
      candidates: undefined,
      draftsWritten: written,
      draftsSkipped: skipped,
      escalations,
      filterRegenerations: regens,
    };
  },
});

/**
 * Phase 1 grounding cross-check is intentionally light: mark every
 * factsClaimed entry as `verified=false` (we don't yet store the agent's
 * raw tool-call history for sourceCallId verification). Phase 1's
 * grounding is structural — the agent MUST emit factsClaimed for every
 * load-bearing claim, and we surface unverified facts as red flags so
 * Daniel sees them when reviewing the Telegram card.
 *
 * Phase 2 will replace this with actual sourceCallId verification against
 * the Mastra tool-call trace.
 */
function groundFacts(out: RenterBotOutput): RenterBotOutput["factsClaimed"] {
  return (out.factsClaimed ?? []).map((f) => ({ ...f, verified: false }));
}

// ── Workflow assembly ──────────────────────────────────────────

export const renterBotDraftWorkflow = createWorkflow({
  id: "renter_bot_draft",
  inputSchema: z.object({
    thread_ids: z.array(z.string()).optional(),
    limit: z.number().optional(),
  }),
  outputSchema: runState,
})
  .then(findCandidates)
  .then(agentBatch)
  .commit();

// ── Manual-run helper ──────────────────────────────────────────

export async function runRenterBotDraft(input?: {
  thread_ids?: string[];
  limit?: number;
}): Promise<RunState | { ok: false; error: string }> {
  try {
    const run = renterBotDraftWorkflow.createRun();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (run as any).start({ inputData: input ?? {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = ((result as any)?.result ?? (result as any)?.output ?? null) as RunState | null;
    return state ?? { ok: false, error: "workflow_no_output" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
