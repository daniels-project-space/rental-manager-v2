import {ownerCheckBlocksRequest} from "./lib/owner_checks";
import {canonicalGenerationErrorValidator} from "./lib/canonical_generation_error";
import {ownerCheckRequestMessageId} from "./lib/owner_check_request";
/**
 * renter_bot_harness — runs renter_bot_fixtures through the REAL
 * generateDraft pipeline (same code path production uses) and scores each
 * result with renter_bot_rubric. Extends renter_bot_probe.ts's seed/cleanup
 * rather than duplicating them. Test-only. No relationship to any Hygglo
 * write path — nothing here imports hygglo-write.ts or the send actions.
 */
import { action, internalMutation, internalQuery, internalActionOf } from "./owner_functions";
import { v } from "convex/values";
import { ownerCheckValidator } from "./lib/owner_checks";
import { draftEvidenceValidator } from "./lib/renter_draft_evidence";
import { internal } from "./_generated/api";
import { scoreDraft, scoreSkippedGeneration } from "./lib/renter_bot_rubric";
import { PREFIX } from "./renter_bot_probe";

export const getFixture = internalQuery({
  args: { fixtureId: v.id("renter_bot_fixtures") },
  handler: async (ctx, { fixtureId }) => ctx.db.get(fixtureId),
});

export const getDraftByThread = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) =>
    ctx.db
      .query("renter_bot_drafts")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first(),
});

export const listActiveFixtures = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("renter_bot_fixtures").collect()).filter(
      (f) => f.active,
    ),
});

/** Snapshot before the Lab appends an assistant message or cleans up a fixture.
 * Match the actual saved draft, inbound message and Native context so historical
 * work cannot falsely complete or fail an unrelated generation. */
export const pendingOwnerChecksForDraft=internalQuery({
  args:{thread_id:v.string(),draft_text:v.string()},handler:async(ctx,a)=>{
    const conv=await ctx.db.query("conversations").withIndex("by_thread",q=>q.eq("thread_id",a.thread_id)).first();
    if(!conv?.ai_draft_for_message_id||!conv.ai_draft_context_key||conv.ai_draft_text!==a.draft_text)return null;
    const tasks=await ctx.db.query("renter_bot_owner_checks").withIndex("by_status_thread",q=>q.eq("status","pending").eq("thread_id",a.thread_id)).collect();
    return tasks.filter(task=>ownerCheckBlocksRequest(task.check)&&task.account_slug===conv.account_slug&&task.source_context_key===conv.ai_draft_context_key&&
      ownerCheckRequestMessageId(task)===conv.ai_draft_for_message_id).map(task=>task.check);
  }
});

const rubricResultValidator = v.object({
  category: v.string(),
  status: v.union(
    v.literal("pass"),
    v.literal("fail"),
    v.literal("flag"),
    v.literal("n_a"),
  ),
  detail: v.string(),
  evidence: v.optional(v.string()),
});

export const insertRun = internalMutation({
  args: {
    generation_error:v.optional(canonicalGenerationErrorValidator),
    native_quote_diagnostic:v.optional(v.string()),
    draft_evidence: v.optional(draftEvidenceValidator),
    pending_owner_checks:v.optional(v.array(ownerCheckValidator)),
    fixture_id: v.optional(v.id("renter_bot_fixtures")),
    session_thread_id: v.optional(v.string()),
    run_batch_id: v.optional(v.string()),
    account_slug: v.string(),
    draft_text: v.string(),
    draft_intent: v.optional(v.string()),
    draft_confidence: v.optional(v.number()),
    facts_claimed: v.optional(
      v.array(
        v.object({
          kind: v.string(),
          value: v.string(),
          sourceTool: v.string(),
          sourceCallId: v.string(),
          verified: v.boolean(),
        }),
      ),
    ),
    model_id: v.string(),
    filter_violations: v.array(v.string()),
    rubric_results: v.array(rubricResultValidator),
    overall_status: v.union(
      v.literal("pass"),
      v.literal("fail"),
      v.literal("flag"),
    ),
    triggered_by: v.union(
      v.literal("harness_batch"),
      v.literal("lab_ui_manual"),
    ),
    run_at: v.number(),
    duration_ms: v.optional(v.number()),
    cost_usd: v.optional(v.number()),
  },
  handler: async (ctx, args) => ctx.db.insert("renter_bot_harness_runs", args),
});

export const runFixture = action({
  args: {
    fixtureId: v.id("renter_bot_fixtures"),
    runBatchId: v.optional(v.string()),
    triggeredBy: v.optional(
      v.union(v.literal("harness_batch"), v.literal("lab_ui_manual")),
    ),
    // runBatch/runToCleanStreak set this so cleanup happens once at the end
    // instead of after every single fixture.
    skipCleanup: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ runId: string; overall_status: string }> => {
    const fixture = await ctx.runQuery(internal.renter_bot_harness.getFixture, {
      fixtureId: args.fixtureId,
    });
    if (!fixture) throw new Error(`Fixture ${args.fixtureId} not found`);

    const threadId = `${PREFIX}${args.fixtureId}-${Date.now()}`;
    const startedAt = Date.now();

    await ctx.runMutation(internal.renter_bot_probe.seed, {
      thread_id: threadId,
      account_slug: fixture.account_slug,
      items: (fixture.seed_context?.items ?? []).map((name) => ({ name })),
      messages: fixture.messages.map((m) => ({ role: m.role, text: m.text })),
    });

    const draftResult = await ctx.runAction(
      internal.replyInbox_actions.__service_generateDraft,
      { thread_id: threadId },
    );

    let runId: string;
    let overallStatus: string;
    if (draftResult.status === "skipped") {
      const skippedScore = scoreSkippedGeneration(draftResult.reason,
        ["complaint", "damage_report", "cancellation", "blacklisted"].includes(fixture.scenario_type));
      overallStatus = skippedScore.overall_status;
      runId = await ctx.runMutation(internal.renter_bot_harness.insertRun, {
        fixture_id: args.fixtureId,
        run_batch_id: args.runBatchId,
        account_slug: fixture.account_slug,
        draft_text: "",
        model_id: draftResult.model_id ?? draftResult.generation_error?.model_id ?? "unknown (generation failed)",
        generation_error:draftResult.generation_error,
        cost_usd:draftResult.cost_usd??draftResult.generation_error?.cost_usd,
        filter_violations: skippedScore.filter_violation_categories,
        rubric_results: skippedScore.results,
        overall_status: skippedScore.overall_status,
        triggered_by: args.triggeredBy ?? "harness_batch",
        run_at: startedAt,
        duration_ms: Date.now() - startedAt,
      });
    } else {
      // generateDraft's own return is narrow (draft/confidence/flags/status);
      // the fuller cached row (facts_claimed, intent, model_id) lives in
      // renter_bot_drafts, keyed by the same thread_id — but note the
      // fallback generation path never populates facts_claimed at all, so its
      // absence here is expected, not itself a bug (see rubric's handling).
      const draftRow = await ctx.runQuery(
        internal.renter_bot_harness.getDraftByThread,
        { thread_id: threadId },
      );

      const draftText = draftResult.draft ?? "";
      const factsClaimed = (draftResult.facts_claimed ?? []).map((f) => ({
        kind: f.kind,
        value: f.value,
        verified: f.verified,
      }));

      const pendingOwnerChecks=await ctx.runQuery(internal.renter_bot_harness.pendingOwnerChecksForDraft,{thread_id:threadId,draft_text:draftText});
      const rubric = scoreDraft({
        pendingOwnerChecks:pendingOwnerChecks??undefined,
        accountSlug: fixture.account_slug,
        draftText,
        factsClaimed,
        productionFlags: draftResult.flags,
        priceEvidence:draftResult.evidence?.prices,
        bookingRecord:draftResult.evidence?.booking_record,
        priceRequest:draftResult.evidence?.stock_request,
        lastRenterMessage:fixture.messages.filter(m=>m.role==="renter").at(-1)?.text,
      });
      overallStatus = rubric.overall_status;

      runId = await ctx.runMutation(internal.renter_bot_harness.insertRun, {
        fixture_id: args.fixtureId,
        run_batch_id: args.runBatchId,
        account_slug: fixture.account_slug,
        draft_text: draftText,
        draft_intent: draftResult.draft_intent,
        draft_confidence: draftResult.confidence ?? draftRow?.draft_confidence,
        facts_claimed: draftResult.facts_claimed,
        draft_evidence: draftResult.evidence,
        pending_owner_checks:pendingOwnerChecks??undefined,
        model_id: draftResult.model_id ?? draftResult.generation_error?.model_id ?? "unknown",
        filter_violations: rubric.filter_violation_categories,
        rubric_results: rubric.results,
        overall_status: rubric.overall_status,
        triggered_by: args.triggeredBy ?? "harness_batch",
        run_at: startedAt,
        duration_ms: Date.now() - startedAt,
        cost_usd: draftResult.cost_usd??draftResult.generation_error?.cost_usd,
        generation_error:draftResult.generation_error,
      });
    }

    if (!args.skipCleanup) {
      await ctx.runMutation(internal.renter_bot_probe.__service_cleanup, {});
    }

    return { runId, overall_status: overallStatus };
  },
});

export const runBatch = action({
  args: {
    fixtureIds: v.optional(v.array(v.id("renter_bot_fixtures"))),
    runBatchId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    runBatchId: string;
    results: Array<{ fixtureId: string; overall_status: string }>;
  }> => {
    const runBatchId = args.runBatchId ?? `batch-${Date.now()}`;
    const fixtureIds =
      args.fixtureIds ??
      (
        await ctx.runQuery(internal.renter_bot_harness.listActiveFixtures, {})
      ).map((f) => f._id);

    const results: Array<{ fixtureId: string; overall_status: string }> = [];
    for (const fixtureId of fixtureIds) {
      const r = await ctx.runAction(internal.renter_bot_harness.__service_runFixture, {
        fixtureId,
        runBatchId,
        triggeredBy: "harness_batch" as const,
        skipCleanup: true, // one sweep at the end, not per-fixture
      });
      results.push({ fixtureId, overall_status: r.overall_status });
    }
    await ctx.runMutation(internal.renter_bot_probe.__service_cleanup, {});
    return { runBatchId, results };
  },
});

export const runToCleanStreak = action({
  args: {
    fixtureId: v.id("renter_bot_fixtures"),
    targetStreak: v.optional(v.number()),
    maxAttempts: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ streakAchieved: number; attempts: number; lastRunId?: string }> => {
    const target = args.targetStreak ?? 5;
    // Generous ceiling, not a target — mirrors v1's 300-run loop being a cap.
    const maxAttempts = args.maxAttempts ?? target * 6;
    const runBatchId = `streak-${args.fixtureId}-${Date.now()}`;
    let streak = 0;
    let attempts = 0;
    let lastRunId: string | undefined;
    while (streak < target && attempts < maxAttempts) {
      attempts++;
      const r = await ctx.runAction(internal.renter_bot_harness.__service_runFixture, {
        fixtureId: args.fixtureId,
        runBatchId,
        triggeredBy: "harness_batch" as const,
        skipCleanup: true,
      });
      lastRunId = r.runId;
      streak = r.overall_status === "pass" ? streak + 1 : 0;
    }
    await ctx.runMutation(internal.renter_bot_probe.__service_cleanup, {});
    return { streakAchieved: streak, attempts, lastRunId };
  },
});

// ── Multi-turn scenario runner ──────────────────────────────────
//
// runFixture seeds an entire conversation as pre-scripted history in one
// shot and scores a single final reply. That's fine for single-shot
// fixtures, but it can't check whether behavior stays correct as a
// conversation naturally progresses (each bot reply generated for real, in
// context, including on top of its own prior real replies) — which is what
// "multi-stage" testing needs: does the bot upsell only once interest is
// established, does it stay consistent turn-to-turn, does availability
// hold up once the renter starts negotiating dates, etc.
//
// One scenario = one probe thread, walked turn-by-turn through the REAL
// generateDraft pipeline. Scoped to a single scenario (not a whole suite)
// to stay well under Convex's action time limit — drive the full suite by
// calling this once per scenario from outside (see scripts/renter-bot-scenarios).
export const runMultiTurnScenario = action({
  args: {
    scenarioId: v.string(),
    accountSlug: v.string(),
    items: v.array(
      v.object({ name: v.string(), product_id: v.optional(v.number()) }),
    ),
    turns: v.array(v.string()),
    runBatchId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    scenarioId: string;
    threadId: string;
    turnResults: Array<{
      turn: number;
      renter_message: string;
      draft: string;
      overall_status: string;
      escalated: boolean;
      escalation_reason?: string;
      rubric_results: unknown[];
      productionFlags: unknown[];
      runId?: string;
    }>;
  }> => {
    const threadId = `${PREFIX}mt-${args.scenarioId}-${Date.now()}`;
    await ctx.runMutation(internal.renter_bot_probe.seed, {
      thread_id: threadId,
      account_slug: args.accountSlug,
      items: args.items,
      messages: [],
    });

    const turnResults: Array<{
      turn: number;
      renter_message: string;
      draft: string;
      overall_status: string;
      escalated: boolean;
      escalation_reason?: string;
      rubric_results: unknown[];
      productionFlags: unknown[];
      runId?: string;
    }> = [];

    for (let i = 0; i < args.turns.length; i++) {
      const text = args.turns[i];
      await ctx.runMutation(internal.renter_bot_lab_actions.appendRenterMessage, {
        thread_id: threadId,
        account_slug: args.accountSlug,
        text,
      });

      const startedAt = Date.now();
      const draftResult = await ctx.runAction(internal.replyInbox_actions.__service_generateDraft, {
        thread_id: threadId,
      });

      if (draftResult.status === "skipped") {
        turnResults.push({
          turn: i,
          renter_message: text,
          draft: "",
          overall_status: "escalated",
          escalated: true,
          escalation_reason: draftResult.reason,
          rubric_results: [],
          productionFlags: [],
        });
        continue;
      }

      const draftRow = await ctx.runQuery(internal.renter_bot_harness.getDraftByThread, {
        thread_id: threadId,
      });
      const draftText = draftResult.draft ?? "";
      const factsClaimed = (draftResult.facts_claimed ?? []).map((f) => ({
        kind: f.kind,
        value: f.value,
        verified: f.verified,
      }));

      const pendingOwnerChecks=await ctx.runQuery(internal.renter_bot_harness.pendingOwnerChecksForDraft,{thread_id:threadId,draft_text:draftText});
      const rubric = scoreDraft({
        pendingOwnerChecks:pendingOwnerChecks??undefined,
        accountSlug: args.accountSlug,
        draftText,
        factsClaimed,
        productionFlags: draftResult.flags,
        priceEvidence:draftResult.evidence?.prices,
        bookingRecord:draftResult.evidence?.booking_record,
        priceRequest:draftResult.evidence?.stock_request,
        lastRenterMessage:text,
      });

      const runId = await ctx.runMutation(internal.renter_bot_harness.insertRun, {
        session_thread_id: threadId,
        run_batch_id: args.runBatchId,
        account_slug: args.accountSlug,
        draft_text: draftText,
        draft_intent: draftResult.draft_intent,
        draft_confidence: draftResult.confidence ?? draftRow?.draft_confidence,
        facts_claimed: draftResult.facts_claimed,
        draft_evidence: draftResult.evidence,
        pending_owner_checks:pendingOwnerChecks??undefined,
        model_id: draftResult.model_id ?? draftResult.generation_error?.model_id ?? "unknown",
        filter_violations: rubric.filter_violation_categories,
        rubric_results: rubric.results,
        overall_status: rubric.overall_status,
        triggered_by: "harness_batch",
        run_at: startedAt,
        duration_ms: Date.now() - startedAt,
        cost_usd: draftResult.cost_usd??draftResult.generation_error?.cost_usd,
        generation_error:draftResult.generation_error,
      });

      if (draftText) await ctx.runMutation(internal.renter_bot_lab_actions.appendAssistantMessage, { thread_id: threadId, account_slug: args.accountSlug, text: draftText, run_id: runId });

      turnResults.push({
        turn: i,
        renter_message: text,
        draft: draftText,
        overall_status: rubric.overall_status,
        escalated: false,
        rubric_results: rubric.results,
        productionFlags: draftResult.flags ?? [],
        runId,
      });
    }

    await ctx.runMutation(internal.renter_bot_probe.__service_cleanup, {});
    return { scenarioId: args.scenarioId, threadId, turnResults };
  },
});

// Privileged caller counterpart; shares the original handler and validators.
export const __service_runFixture = internalActionOf(runFixture);

// Privileged caller counterpart; shares the original handler and validators.
export const __service_runBatch = internalActionOf(runBatch);
