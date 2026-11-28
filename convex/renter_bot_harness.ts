import {ownerCheckBlocksRequest} from "./lib/owner_checks";
import {canonicalGenerationErrorValidator} from "./lib/canonical_generation_error";
import {ownerCheckRequestMessageId} from "./lib/owner_check_request";
import {unrelatedToRenderedReplacement} from "./lib/owner_check_scope";
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
import { api, internal } from "./_generated/api";
import { PREFIX } from "./renter_bot_probe";
import { renterBotLabAuthMarkerMatches } from "./lib/renter_bot_lab_contract";
import { renterBotLabRentalDates, renterBotLabScenario, type RenterBotLabScenarioId } from "./lib/renter_bot_lab_scenarios";
import type { Doc } from "./_generated/dataModel";

function assertLabApiAuthorization(marker: string) {
  if (!renterBotLabAuthMarkerMatches(marker, process.env)) {
    throw new Error("Isolated Lab API authorization failed");
  }
}

export const getFixture = internalQuery({
  args: { fixtureId: v.id("renter_bot_fixtures") },
  handler: async (ctx, { fixtureId }): Promise<Doc<"renter_bot_fixtures"> | null> => ctx.db.get(fixtureId),
});

export const getDraftByThread = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) =>
    ctx.db
      .query("renter_bot_drafts")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first(),
});

export const getRunForLabTurn = internalQuery({
  args: { lab_turn_id: v.string() },
  handler: async (ctx, { lab_turn_id }) => ctx.db.query("renter_bot_harness_runs")
    .withIndex("by_lab_turn", q => q.eq("lab_turn_id", lab_turn_id)).first(),
});

export const listActiveFixtures = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"renter_bot_fixtures">[]> =>
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
      ownerCheckRequestMessageId(task)===conv.ai_draft_for_message_id && !unrelatedToRenderedReplacement({kind:task.check.kind,candidateNames:task.candidate_names,flags:conv.ai_draft_flags??[],prices:conv.ai_draft_evidence?.prices??[]})).map(task=>task.check);
  }
});

const rubricResultValidator = v.object({
  category: v.string(),
  status: v.union(
    v.literal("pass"),
    v.literal("fail"),
    v.literal("flag"),
    v.literal("n_a"),
    v.literal("unassessed"),
  ),
  detail: v.string(),
  evidence: v.optional(v.string()),
});

export const insertRun = internalMutation({
  args: {
    expected_message_id: v.optional(v.string()),
    lab_turn_id: v.optional(v.string()),
    lab_lease_token: v.optional(v.string()),
    generation_status: v.optional(v.union(v.literal("complete"), v.literal("failed"))),
    failure_reason: v.optional(v.string()),
    candidate_text: v.optional(v.string()),
    production_guard_flags: v.optional(v.array(v.any())),
    tool_stats: v.optional(v.any()),
    token_usage: v.optional(v.object({ prompt:v.optional(v.number()), cached:v.optional(v.number()), completion:v.optional(v.number()), cost:v.optional(v.number()) })),
    source_receipts: v.optional(v.any()),
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
      v.literal("incomplete"),
    ),
    triggered_by: v.union(
      v.literal("harness_batch"),
      v.literal("lab_ui_manual"),
    ),
    run_at: v.number(),
    duration_ms: v.optional(v.number()),
    cost_usd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { expected_message_id, lab_lease_token, ...runArgs } = args;
    if (runArgs.lab_turn_id) {
      if (!expected_message_id || !lab_lease_token || !runArgs.session_thread_id) throw new Error("Lab run must be bound to a current turn lease");
      const turn = await ctx.db.query("renter_bot_lab_turns").withIndex("by_turn", q => q.eq("turn_id", runArgs.lab_turn_id!)).first();
      if (!turn || turn.thread_id !== runArgs.session_thread_id || turn.account_slug !== runArgs.account_slug ||
          turn.renter_message_id !== expected_message_id || turn.lease_token !== lab_lease_token || turn.status !== "running") {
        throw new Error("stale_lab_turn");
      }
    }
    if (expected_message_id && runArgs.session_thread_id) {
      const latest = await ctx.db.query("hygglo_messages")
        .withIndex("by_thread", q => q.eq("thread_id", runArgs.session_thread_id!)).order("desc").first();
      if (latest?.message_id !== expected_message_id || latest.sender !== "renter" || latest.account_slug !== runArgs.account_slug) {
        throw new Error("stale_inbound");
      }
    }
    if (runArgs.lab_turn_id) {
      const existing = await ctx.db.query("renter_bot_harness_runs")
        .withIndex("by_lab_turn", q => q.eq("lab_turn_id", runArgs.lab_turn_id!)).first();
      if (existing) {
        // A retry is a new immutable result for the same renter turn. Replace
        // the whole run so omitted optional fields (especially an earlier
        // failure_reason/generation_error) cannot survive from a failed try.
        await ctx.db.replace(existing._id, runArgs);
        return existing._id;
      }
    }
    return ctx.db.insert("renter_bot_harness_runs", runArgs);
  },
});

export const runFixture = action({
  args: {
    auth_marker: v.string(),
    fixtureId: v.id("renter_bot_fixtures"),
    runBatchId: v.optional(v.string()),
    triggeredBy: v.optional(
      v.union(v.literal("harness_batch"), v.literal("lab_ui_manual")),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ threadId: string; runId: string; overall_status: string }> => {
    assertLabApiAuthorization(args.auth_marker);
    const fixture = await ctx.runQuery(internal.renter_bot_harness.getFixture, {
      fixtureId: args.fixtureId,
    });
    if (!fixture) throw new Error(`Fixture ${args.fixtureId} not found`);

    const session = await ctx.runAction(api.renter_bot_lab_actions.startLiveSession, {
      accountSlug: fixture.account_slug,
      fixtureId: args.fixtureId,
    });
    const threadId = session.threadId;
    const renterMessage = await ctx.runQuery(internal.renter_bot_lab_actions.getLatestRenterMessageForThread, { thread_id: threadId });
    if (!renterMessage || renterMessage.account_slug !== fixture.account_slug) throw new Error("Fixture needs a final renter message");
    const result = await ctx.runAction(api.renter_bot_lab_actions.runTestTurn, {
      auth_marker: args.auth_marker,
      threadId,
      accountSlug: fixture.account_slug,
      text: renterMessage.body_text,
      turnId: crypto.randomUUID(),
      requestMessageId: renterMessage.message_id,
      fixtureId: args.fixtureId, runBatchId: args.runBatchId,
      triggeredBy: args.triggeredBy ?? "harness_batch",
      expectedEscalation: ["complaint", "damage_report", "cancellation", "blacklisted"].includes(fixture.scenario_type),
    });
    if (result.status === "running") {
      throw new Error(`Fixture Lab turn is still running in ${threadId}; preserve it for recovery`);
    }
    if (typeof result.runId !== "string") throw new Error("Fixture turn did not persist a run record");
    return { threadId, runId: result.runId, overall_status: String(result.overall_status ?? "flag") };
  },
});

export const runBatch = action({
  args: {
    auth_marker: v.string(),
    fixtureIds: v.optional(v.array(v.id("renter_bot_fixtures"))),
    runBatchId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    runBatchId: string;
    results: Array<{ fixtureId: string; threadId: string; runId: string; overall_status: string }>;
  }> => {
    assertLabApiAuthorization(args.auth_marker);
    const runBatchId = args.runBatchId ?? `batch-${Date.now()}`;
    const fixtureIds =
      args.fixtureIds ??
      (
        await ctx.runQuery(internal.renter_bot_harness.listActiveFixtures, {})
      ).map((f) => f._id);

    const results: Array<{ fixtureId: string; threadId: string; runId: string; overall_status: string }> = [];
    for (const fixtureId of fixtureIds) {
      const r = await ctx.runAction(internal.renter_bot_harness.__service_runFixture, {
        auth_marker: args.auth_marker,
        fixtureId,
        runBatchId,
        triggeredBy: "harness_batch" as const,
      });
      results.push({ fixtureId, threadId: r.threadId, runId: r.runId, overall_status: r.overall_status });
    }
    return { runBatchId, results };
  },
});

export const runToCleanStreak = action({
  args: {
    auth_marker: v.string(),
    fixtureId: v.id("renter_bot_fixtures"),
    targetStreak: v.optional(v.number()),
    maxAttempts: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ streakAchieved: number; attempts: number; lastRunId?: string }> => {
    assertLabApiAuthorization(args.auth_marker);
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
        auth_marker: args.auth_marker,
        fixtureId: args.fixtureId,
        runBatchId,
        triggeredBy: "harness_batch" as const,
      });
      lastRunId = r.runId;
      streak = r.overall_status === "pass" ? streak + 1 : 0;
    }
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
    auth_marker: v.string(),
    scenarioId: v.string(),
    turns: v.array(v.string()),
    runBatchId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    scenarioId: string;
    threadId: string;
    order_before: unknown;
    order_after: unknown;
    turnResults: Array<{
      turn: number;
      renter_message: string;
      draft: string;
      overall_status: string;
      escalated: boolean;
      escalation_reason?: string;
      turn_status: "ok" | "skipped" | "running";
      failure_reason?: string;
      candidate_text?: string;
      generation_error?: unknown;
      rubric_results: unknown[];
      productionFlags: unknown[];
      runId?: string;
      order_after: unknown;
    }>;
  }> => {
    assertLabApiAuthorization(args.auth_marker);
    const scenario = renterBotLabScenario(args.scenarioId);
    if (!scenario) throw new Error("Unknown prepared Lab scenario");
    const { startDate, endDate } = renterBotLabRentalDates(scenario);
    const session = await ctx.runAction(internal.renter_bot_lab_actions.__service_startLiveSession, {
      accountSlug: scenario.accountSlug,
      scenarioId: scenario.id as RenterBotLabScenarioId,
      items: [scenario.item.name_canonical],
      lifecycle: scenario.startStage === "confirmed" ? "confirmed" : "awaiting_owner_approval",
      startDate,
      endDate,
      dates: `${startDate} to ${endDate}`,
    });
    const threadId = session.threadId;

    const turnResults: Array<{
      turn: number;
      renter_message: string;
      draft: string;
      overall_status: string;
      escalated: boolean;
      escalation_reason?: string;
      turn_status: "ok" | "skipped" | "running";
      failure_reason?: string;
      candidate_text?: string;
      generation_error?: unknown;
      rubric_results: unknown[];
      productionFlags: unknown[];
      runId?: string;
      order_after: unknown;
    }> = [];
    const orderBefore = await ctx.runQuery(internal.renter_bot_lab_order.__service_get, { thread_id: threadId });
    if (!orderBefore) throw new Error("Prepared Lab session did not create its simulated order");

      for (let i = 0; i < args.turns.length; i++) {
        const text = args.turns[i];
        const turnId = crypto.randomUUID();
        const result = await ctx.runAction(api.renter_bot_lab_actions.runTestTurn, {
          auth_marker: args.auth_marker,
          threadId,
          accountSlug: scenario.accountSlug,
          text,
          turnId,
          runBatchId: args.runBatchId,
          triggeredBy: "harness_batch",
          expectedEscalation: false,
        });
        const orderAfter = await ctx.runQuery(internal.renter_bot_lab_order.__service_get, { thread_id: threadId });

        if (result.status === "running") {
          turnResults.push({
            turn: i,
            renter_message: text,
            draft: "",
            overall_status: "running",
            escalated: false,
            turn_status: "running",
            rubric_results: [],
            productionFlags: [],
            order_after: orderAfter,
          });
          break;
        }

        const hasReply = result.status === "ok" && Boolean(result.draft);
        turnResults.push({
          turn: i,
          renter_message: text,
          draft: result.draft ?? "",
          overall_status: result.overall_status ?? "flag",
          escalated: false,
          turn_status: result.status === "ok" ? "ok" : "skipped",
          ...(!hasReply ? { failure_reason: result.reason ?? "no_approved_reply" } : {}),
          ...(result.candidate_text ? { candidate_text: result.candidate_text } : {}),
          ...(result.generation_error ? { generation_error: result.generation_error } : {}),
          rubric_results: result.rubric_results ?? [],
          productionFlags: Array.isArray(result.productionGuardFlags) ? result.productionGuardFlags : [],
          runId: result.runId,
          order_after: orderAfter,
        });

        // Do not make later renter turns appear to follow a bot reply that was
        // never approved. Keep the incomplete thread intact for inspection.
        if (!hasReply) break;
      }

    const orderAfter = await ctx.runQuery(internal.renter_bot_lab_order.__service_get, { thread_id: threadId });
    return { scenarioId: scenario.id, threadId, order_before: orderBefore, order_after: orderAfter, turnResults };
  },
});

// Privileged caller counterpart; shares the original handler and validators.
export const __service_runFixture = internalActionOf(runFixture);

// Privileged caller counterpart; shares the original handler and validators.
export const __service_runBatch = internalActionOf(runBatch);
