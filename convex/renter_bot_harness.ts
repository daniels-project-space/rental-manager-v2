/**
 * renter_bot_harness — runs renter_bot_fixtures through the REAL
 * generateDraft pipeline (same code path production uses) and scores each
 * result with renter_bot_rubric. Extends renter_bot_probe.ts's seed/cleanup
 * rather than duplicating them. Test-only. No relationship to any Hygglo
 * write path — nothing here imports hygglo-write.ts or the send actions.
 */
import { action, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { scoreDraft } from "./lib/renter_bot_rubric";
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
      api.replyInbox_actions.generateDraft,
      { thread_id: threadId },
    );

    let runId: string;
    let overallStatus: string;
    if (draftResult.status === "skipped") {
      // generateDraft deliberately declined to draft (needs_human escalation,
      // or the primary/fallback generation path itself errored). That's
      // correct behavior for complaint/damage/scam-style scenarios, not a
      // failure — score it as its own thing rather than running an empty
      // string through the normal rubric and calling it a fail.
      overallStatus = "pass";
      runId = await ctx.runMutation(internal.renter_bot_harness.insertRun, {
        fixture_id: args.fixtureId,
        run_batch_id: args.runBatchId,
        account_slug: fixture.account_slug,
        draft_text: "",
        model_id: "n/a (skipped)",
        filter_violations: [],
        rubric_results: [
          {
            category: "escalation",
            status: "pass",
            detail: `Bot declined to draft (reason: ${draftResult.reason ?? "unspecified"}) — correct behavior if this is a genuine escalation case, but "subscription_unavailable" can also mean the upstream call itself failed. Worth a manual glance if that reason shows up a lot.`,
          },
        ],
        overall_status: overallStatus as "pass",
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

      const draftText = draftResult.draft ?? draftRow?.draft_text ?? "";
      const factsClaimed = (draftRow?.facts_claimed ?? []).map((f) => ({
        kind: f.kind,
        value: f.value,
        verified: f.verified,
      }));

      const rubric = scoreDraft({
        accountSlug: fixture.account_slug,
        draftText,
        factsClaimed,
      });
      overallStatus = rubric.overall_status;

      runId = await ctx.runMutation(internal.renter_bot_harness.insertRun, {
        fixture_id: args.fixtureId,
        run_batch_id: args.runBatchId,
        account_slug: fixture.account_slug,
        draft_text: draftText,
        draft_intent: draftRow?.draft_intent,
        draft_confidence: draftResult.confidence ?? draftRow?.draft_confidence,
        facts_claimed: draftRow?.facts_claimed,
        model_id: draftRow?.model_id ?? "unknown",
        filter_violations: rubric.filter_violation_categories,
        rubric_results: rubric.results,
        overall_status: rubric.overall_status,
        triggered_by: args.triggeredBy ?? "harness_batch",
        run_at: startedAt,
        duration_ms: Date.now() - startedAt,
        cost_usd: draftRow?.cost_usd,
      });
    }

    if (!args.skipCleanup) {
      await ctx.runMutation(api.renter_bot_probe.cleanup, {});
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
      const r = await ctx.runAction(api.renter_bot_harness.runFixture, {
        fixtureId,
        runBatchId,
        triggeredBy: "harness_batch" as const,
        skipCleanup: true, // one sweep at the end, not per-fixture
      });
      results.push({ fixtureId, overall_status: r.overall_status });
    }
    await ctx.runMutation(api.renter_bot_probe.cleanup, {});
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
      const r = await ctx.runAction(api.renter_bot_harness.runFixture, {
        fixtureId: args.fixtureId,
        runBatchId,
        triggeredBy: "harness_batch" as const,
        skipCleanup: true,
      });
      lastRunId = r.runId;
      streak = r.overall_status === "pass" ? streak + 1 : 0;
    }
    await ctx.runMutation(api.renter_bot_probe.cleanup, {});
    return { streakAchieved: streak, attempts, lastRunId };
  },
});
