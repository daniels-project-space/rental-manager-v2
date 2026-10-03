/**
 * Renter-bot draft workflow — Phase 1, READ-ONLY.
 *
 * Registered legacy batch entry point. No cron caller currently exists.
 * Uses the same canonical drafting action as Lab and human reply review.
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
import type { ConvexHttpClient } from "convex/browser";
import { createConvexServiceClient } from "@/lib/convex-service";
import { api } from "@/../convex/_generated/api";
import { isWithinUkQuietHours } from "@/lib/quiet-hours";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyApi = api as any;

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

function convex(): ConvexHttpClient {
  return createConvexServiceClient(CONVEX_URL);
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
    let written = 0;
    let skipped = 0;
    let escalations = 0;
    for (const cand of inputData.candidates) {
      try {
        const draft = await c.action(api.replyInbox_actions.generateDraft, { thread_id: cand.thread_id });
        if (draft.status !== "ok" || !draft.draft || draft.for_message_id !== cand.last_inbound_message_id) {
          skipped++;
          if (draft.reason?.startsWith("needs_human:")) escalations++;
          continue;
        }
        await c.mutation(anyApi.renter_bot_drafts.expireOldDrafts, {
          thread_id: cand.thread_id,
          keep_last_inbound_message_id: cand.last_inbound_message_id,
        });
        const writeRes = await c.mutation(anyApi.renter_bot_drafts.writeDraft, {
          thread_id: cand.thread_id, account_slug: cand.account_slug,
          last_inbound_message_id: cand.last_inbound_message_id, last_inbound_at: cand.last_inbound_at,
          draft_text: draft.draft, original_draft: draft.draft,
          draft_intent: draft.draft_intent ?? "general_question", draft_stage: draft.draft_stage ?? "UNKNOWN",
          draft_confidence: draft.confidence ?? 0, draft_red_flags: (draft.flags ?? []).map((f) => `${f.type}: ${f.detail}`),
          facts_claimed: draft.facts_claimed ?? [], needs_human: false,
          generated_by: "renter-bot-canonical", model_id: draft.model_id ?? "unknown",
          regeneration_count: 0, escalated: false, cost_usd: draft.cost_usd,
        });
        if (writeRes?.action === "inserted") written++; else skipped++;
      } catch (err) {
        skipped++;
        console.error(`[renter-bot] canonical generation failed thread=${cand.thread_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return {
      ...inputData,
      candidates: undefined,
      draftsWritten: written,
      draftsSkipped: skipped,
      escalations,
      filterRegenerations: 0,
    };
  },
});

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
