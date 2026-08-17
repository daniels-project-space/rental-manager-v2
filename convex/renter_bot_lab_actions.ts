/**
 * renter_bot_lab_actions — the ONE Convex entry point the Lab UI is allowed
 * to call, so auditing "does the Lab import any send path" is one file, not
 * a whole tree (see scripts/check-patterns.mjs invariant). Delegates to
 * renter_bot_probe / renter_bot_harness. Never imports hygglo-write.ts or
 * any of the four send-gated functions documented in
 * docs/renter-bot-policy.md.
 */
import {
  action,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { scoreDraft } from "./lib/renter_bot_rubric";
import { PREFIX } from "./renter_bot_probe";

export const listFixtures = query({
  args: {},
  handler: async (ctx) => {
    const fixtures = await ctx.db.query("renter_bot_fixtures").collect();
    // dbcinema_web excluded from the Lab entirely per Daniel, 2026-08-17 —
    // filtered here (not just client-side) so it can never leak back in
    // regardless of what seeds/imports a fixture with that account_slug.
    return fixtures
      .filter((f) => f.account_slug !== "dbcinema_web")
      .map((f) => ({
        _id: f._id,
        name: f.name,
        account_slug: f.account_slug,
        scenario_type: f.scenario_type,
        description: f.description,
        seed_context: f.seed_context,
      }));
  },
});


// Real catalog lookup — image + price for one item, joined from the actual
// items/pricing_catalog tables (never invented). Read-only. Used by the Lab
// UI's context banner so Daniel can see exactly what grounding is real.
export const getItemContext = query({
  args: { itemName: v.string() },
  handler: async (ctx, { itemName }) => {
    const item = await ctx.db
      .query("items")
      .withIndex("by_canonical_name", (q) => q.eq("name_canonical", itemName))
      .first();
    const pricing = item
      ? await ctx.db
          .query("pricing_catalog")
          .withIndex("by_name", (q) => q.eq("item_name_canonical", item.name_canonical))
          .first()
      : null;
    return {
      found: !!item,
      name: item?.name_canonical ?? itemName,
      image_url: item?.image_url,
      kind: item?.kind,
      daily_price_min: pricing?.daily_price_min,
      daily_price_max: pricing?.daily_price_max,
    };
  },
})

export const recentRuns = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 30 }) => {
    return await ctx.db
      .query("renter_bot_harness_runs")
      .withIndex("by_run_at")
      .order("desc")
      .take(limit);
  },
});

export const getConversationForThread = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) =>
    ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first(),
});

export const appendRenterMessage = internalMutation({
  args: { thread_id: v.string(), account_slug: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    if (!args.thread_id.startsWith(PREFIX)) {
      throw new Error("appendRenterMessage only accepts a Lab/probe thread_id");
    }
    const now = Date.now();
    await ctx.db.insert("hygglo_messages", {
      account_slug: args.account_slug,
      thread_id: args.thread_id,
      message_id: `${args.thread_id}-m${now}`,
      sender: "renter",
      sender_name: "Test Renter",
      body_text: args.text,
      hygglo_sent_at: now,
      fetched_at: now,
    });
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", args.thread_id))
      .first();
    if (conv) {
      await ctx.db.patch(conv._id, {
        last_msg_at: now,
        last_sender: "renter",
        last_renter_msg_at: now,
      });
    }
  },
});

// Starts (or restarts) a live Lab test conversation — from a saved scenario
// preset, or a blank custom one seeded from location/price/items fields.
export const startLiveSession = action({
  args: {
    accountSlug: v.string(),
    fixtureId: v.optional(v.id("renter_bot_fixtures")),
    items: v.optional(v.array(v.string())),
    priceGbp: v.optional(v.number()),
    dates: v.optional(v.string()),
    location: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    threadId: string;
    context: {
      items: string[];
      priceGbp?: number;
      dates?: string;
      location?: string;
    };
  }> => {
    const threadId = `${PREFIX}lab-${Date.now()}`;
    let itemNames = args.items ?? [];
    let priceGbp = args.priceGbp;
    let dates = args.dates;
    let location = args.location;
    let messages: { role: string; text: string }[] = [];

    if (args.fixtureId) {
      const fixture = await ctx.runQuery(
        internal.renter_bot_harness.getFixture,
        { fixtureId: args.fixtureId },
      );
      if (fixture) {
        itemNames = fixture.seed_context?.items ?? [];
        priceGbp = fixture.seed_context?.price_gbp;
        dates = fixture.seed_context?.dates;
        location = fixture.seed_context?.location;
        messages = fixture.messages.map((m) => ({ role: m.role, text: m.text }));
      }
    }

    await ctx.runMutation(internal.renter_bot_probe.seed, {
      thread_id: threadId,
      account_slug: args.accountSlug,
      items: itemNames.map((name) => ({ name })),
      messages,
    });
    return {
      threadId,
      context: { items: itemNames, priceGbp, dates, location },
    };
  },
});

// Sends ONE renter-side test message into a live Lab session and returns the
// bot's REAL draft reply + rubric score. No send path anywhere in here.
export const sendTestMessage = action({
  args: { threadId: v.string(), accountSlug: v.string(), text: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ draft: string; overall_status: string; runId: string }> => {
    if (!args.threadId.startsWith(PREFIX)) {
      throw new Error("sendTestMessage only accepts a Lab/probe thread_id");
    }

    await ctx.runMutation(internal.renter_bot_lab_actions.appendRenterMessage, {
      thread_id: args.threadId,
      account_slug: args.accountSlug,
      text: args.text,
    });

    const startedAt = Date.now();
    const draftResult = await ctx.runAction(
      api.replyInbox_actions.generateDraft,
      { thread_id: args.threadId },
    );
    const draftRow = await ctx.runQuery(
      internal.renter_bot_harness.getDraftByThread,
      { thread_id: args.threadId },
    );

    const draftText = draftResult.draft ?? draftRow?.draft_text ?? "";
    const factsClaimed = (draftRow?.facts_claimed ?? []).map((f) => ({
      kind: f.kind,
      value: f.value,
      verified: f.verified,
    }));
    const rubric = scoreDraft({
      accountSlug: args.accountSlug,
      draftText,
      factsClaimed,
    });

    const runId: string = await ctx.runMutation(
      internal.renter_bot_harness.insertRun,
      {
        session_thread_id: args.threadId,
        account_slug: args.accountSlug,
        draft_text: draftText,
        draft_intent: draftRow?.draft_intent,
        draft_confidence: draftResult.confidence ?? draftRow?.draft_confidence,
        facts_claimed: draftRow?.facts_claimed,
        model_id: draftRow?.model_id ?? "unknown",
        filter_violations: rubric.filter_violation_categories,
        rubric_results: rubric.results,
        overall_status: rubric.overall_status,
        triggered_by: "lab_ui_manual" as const,
        run_at: startedAt,
        duration_ms: Date.now() - startedAt,
        cost_usd: draftRow?.cost_usd,
      },
    );

    return { draft: draftText, overall_status: rubric.overall_status, runId };
  },
});

// Sweeps this (and any other lingering) probe/Lab thread. Call when Daniel
// closes the Lab session.
export const endLiveSession = action({
  args: {},
  handler: async (ctx): Promise<{ removed: number }> =>
    ctx.runMutation(api.renter_bot_probe.cleanup, {}),
});

export const runFixtureBatch = action({
  args: { fixtureIds: v.optional(v.array(v.id("renter_bot_fixtures"))) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    runBatchId: string;
    results: Array<{ fixtureId: string; overall_status: string }>;
  }> => ctx.runAction(api.renter_bot_harness.runBatch, args),
});
