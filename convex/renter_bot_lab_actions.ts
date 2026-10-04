import { sentBookingProposals } from "./lib/renter_sent_proposal";
import {friendReferralCodesFromMessage} from "./lib/verification_failure";
import {loadThreadReferralReference} from "./lib/thread_referral_reference";
import { listingDisplayCatalog } from "./lib/listing_display_catalog";
import { shortItemName } from "./lib/item_display_name";
import { labBooking } from "./lib/lab_lifecycle";
/**
 * renter_bot_lab_actions — the ONE Convex entry point the Lab UI is allowed
 * to call, so auditing "does the Lab import any send path" is one file, not
 * a whole tree (see scripts/check-patterns.mjs invariant). Delegates to
 * renter_bot_probe / renter_bot_harness. Never imports hygglo-write.ts or
 * any of the four send-gated functions documented in
 * docs/renter-bot-policy.md.
 */
import { action, internalMutation, internalQuery, query } from "./owner_functions";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { scoreDraft } from "./lib/renter_bot_rubric";
import type { DraftEvidence } from "./lib/renter_draft_evidence";
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
  args: { itemName: v.string(), productId: v.optional(v.number()), accountSlug: v.optional(v.string()) },
  handler: async (ctx, { itemName, productId, accountSlug }) => {
    let item = await ctx.db
      .query("items")
      .withIndex("by_canonical_name", (q) => q.eq("name_canonical", itemName))
      .first();
    let listing = null;
    let displayName = item ? shortItemName(item) : itemName;
    if (productId != null) {
      if (!accountSlug) throw new Error("Listing context requires its account");
      const display = await listingDisplayCatalog(ctx, accountSlug);
      listing = await ctx.db.query("online_listings").withIndex("by_account_product", q => q.eq("account_slug", accountSlug).eq("product_id", productId)).first();
      const mapping = display.mappingMap.get(`${accountSlug}#${productId}`);
      if (mapping) {
        const candidates = mapping.components.map(c => display.itemMap.get(String(c.item_id))).filter(i => !!i);
        item = candidates.find(i => i.kind === "camera") ?? candidates.find(i => i.kind === "lens") ?? candidates[0] ?? null;
      } else {
        const product = await ctx.db.query("hygglo_products").withIndex("by_account_product", q => q.eq("accountSlug", accountSlug).eq("productId", productId)).first();
        item = product?.masterItemId ? display.itemMap.get(String(product.masterItemId)) ?? null : null;
      }
      displayName = display.name(accountSlug, productId, listing?.name ?? itemName);
    }
    const pricing = item
      ? await ctx.db
          .query("pricing_catalog")
          .withIndex("by_name", (q) => q.eq("item_name_canonical", item.name_canonical))
          .first()
      : null;
    return {
      found: !!item,
      name: item?.name_canonical ?? itemName,
      display_name: displayName,
      raw_title: listing?.name ?? itemName,
      image_url: listing?.image ?? item?.image_url,
      kind: item?.kind,
      sub_kind: item?.sub_kind,
      notes: item?.notes,
      delivery_notes: item?.delivery_notes,
      cancellation_policy: pricing?.multi_day_notes ?? item?.cancellation_policy,
      included_with_rental: item?.compatibility?.included_with_rental,
      compatible_lenses: item?.compatibility?.lenses,
      compatible_batteries: item?.compatibility?.batteries,
      compatible_cards: item?.compatibility?.cards,
      compatible_accessories: item?.compatibility?.accessories,
      qty: item?.qty,
      unit_kind: item?.unit_kind,
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
    const messageId = `${args.thread_id}-m${now}-${Math.random().toString(36).slice(2, 10)}`;
    await ctx.db.insert("hygglo_messages", {
      account_slug: args.account_slug,
      thread_id: args.thread_id,
      message_id: messageId,
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
      const codes=friendReferralCodesFromMessage(args.text);
      const reference=codes.length?{codes,message_id:messageId}:
        conv.referral_reference??await loadThreadReferralReference(ctx,args.thread_id)??{codes:[],message_id:messageId};
      await ctx.db.patch(conv._id, {
        referral_reference:reference,
        last_msg_at: now,
        last_sender: "renter",
        last_renter_msg_at: now,
      });
    }
  },
});

/** Test-only owner turn. This writes local simulation history, never sends. */
export const appendAssistantMessage = internalMutation({
  args: { thread_id: v.string(), account_slug: v.string(), text: v.string(), run_id: v.string() },
  handler: async (ctx, args) => {
    if (!args.thread_id.startsWith(PREFIX)) throw new Error("Only Lab/probe history can be appended");
    if (!args.text.trim()) return;
    const messageId = `${args.thread_id}-assistant-${args.run_id}`;
    const existing = await ctx.db.query("hygglo_messages").withIndex("by_thread", (q) => q.eq("thread_id", args.thread_id)).collect();
    if (existing.some((m) => m.message_id === messageId)) return;
    const conversation = await ctx.db.query("conversations").withIndex("by_thread",q=>q.eq("thread_id",args.thread_id)).first();
    const proposals=conversation?.account_slug === args.account_slug ? await sentBookingProposals(ctx, conversation, args.text) : {additions:[],dates:[],replacements:[]};
    const quoted_additions=proposals.additions,quoted_dates=proposals.dates,quoted_replacements=proposals.replacements;
    const now = Date.now();
    await ctx.db.insert("hygglo_messages", { account_slug: args.account_slug, thread_id: args.thread_id, message_id: messageId, sender: "owner", sender_name: "Lab owner", body_text: args.text, hygglo_sent_at: now, fetched_at: now, ...(quoted_additions.length ? {quoted_additions} : {}), ...(quoted_dates.length ? {quoted_dates} : {}), ...(quoted_replacements.length ? {quoted_replacements} : {}) });
  },
});

/** The selected SKU is resolved on the server, not guessed from UI text. */
export const getSelectedListing = internalQuery({
  args: { account_slug: v.string(), product_id: v.number() },
  handler: async (ctx, a) => ctx.db.query("online_listings")
    .withIndex("by_account_product", (q) => q.eq("account_slug", a.account_slug).eq("product_id", a.product_id)).first(),
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
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    location: v.optional(v.string()),
    /** Real Hygglo listing to base the scenario on (its price is what the renter pays). */
    productId: v.optional(v.number()),
    lifecycle: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    threadId: string;
    context: {
      items: string[];
      productId?: number;
      lifecycle?: string;
      priceGbp?: number;
      dates?: string;
      startDate?: string;
      endDate?: string;
      location?: string;
    };
  }> => {
    const threadId = `${PREFIX}lab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let itemNames = args.items ?? [];
    let priceGbp = args.priceGbp;
    let dates = args.dates;
    let startDate = args.startDate;
    let endDate = args.endDate;
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
        startDate = fixture.seed_context?.start_date;
        endDate = fixture.seed_context?.end_date;
        location = fixture.seed_context?.location;
        messages = fixture.messages.map((m) => ({ role: m.role, text: m.text }));
      }
    }

    startDate = args.startDate ?? startDate;
    endDate = args.endDate ?? endDate;
    const lifecycle = args.lifecycle ?? "inquiry";
    const booking = labBooking(lifecycle, startDate, endDate);

    if (args.productId != null) {
      const listing = await ctx.runQuery(internal.renter_bot_lab_actions.getSelectedListing, {
        account_slug: args.accountSlug, product_id: args.productId,
      });
      if (!listing) throw new Error("Selected listing is not present on this account");
      itemNames = [listing.name];
    }

    await ctx.runMutation(internal.renter_bot_probe.seed, {
      thread_id: threadId,
      account_slug: args.accountSlug,
      items: itemNames.map((name) => ({ name, ...(args.productId != null ? { product_id: args.productId } : {}) })),
      messages,
      booking,
    });
    // Simulated Hygglo order for this session, so the bot can genuinely add
    // and remove gear and move dates instead of only talking about it.
    await ctx.runMutation(internal.renter_bot_lab_order.seed, {
      thread_id: threadId,
      account_slug: args.accountSlug,
      item_names: itemNames,
      start_date: startDate,
      end_date: endDate,
      base_product_id: args.productId,
    });
    return {
      threadId,
      context: { items: itemNames, productId: args.productId, lifecycle, priceGbp, dates, startDate, endDate, location },
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
  ): Promise<{
    draft: string;
    overall_status: string;
    runId: string;
    productionGuardFlags: unknown;
    status: string;
    reason?: string;
    rejectedDraft?: string;
    guard_candidate?: string;
    evidence?: DraftEvidence;
    model_id?: string;
  }> => {
    if (!args.threadId.startsWith(PREFIX)) {
      throw new Error("sendTestMessage only accepts a Lab/probe thread_id");
    }
    const session = await ctx.runQuery(internal.renter_bot_lab_actions.getConversationForThread, { thread_id: args.threadId });
    if (!session || session.account_slug !== args.accountSlug) throw new Error("Lab session/account mismatch");

    await ctx.runMutation(internal.renter_bot_lab_actions.appendRenterMessage, {
      thread_id: args.threadId,
      account_slug: args.accountSlug,
      text: args.text,
    });

    // Referrals enter the SAME request-planning/quote pipeline as other chats.
    // Native listing context supplies the shared gear; a code is not an edit.
    const startedAt = Date.now();
    const draftResult = await ctx.runAction(
      internal.replyInbox_actions.__service_generateDraft,
      { thread_id: args.threadId },
    );
    const draftRow = await ctx.runQuery(
      internal.renter_bot_harness.getDraftByThread,
      { thread_id: args.threadId },
    );

    const draftText = draftResult.status === "ok" ? draftResult.draft ?? "" : "";
    const factsClaimed = (draftResult.facts_claimed ?? []).map((f) => ({
      kind: f.kind,
      value: f.value,
      verified: f.verified,
    }));
    const rubric = scoreDraft({
      accountSlug: args.accountSlug,
      draftText,
      factsClaimed,
      productionFlags: draftResult.flags,
    });

    const runId: string = await ctx.runMutation(
      internal.renter_bot_harness.insertRun,
      {
        session_thread_id: args.threadId,
        account_slug: args.accountSlug,
        draft_text: draftText,
        draft_intent: draftResult.draft_intent,
        draft_confidence: draftResult.confidence ?? draftRow?.draft_confidence,
        facts_claimed: draftResult.facts_claimed,
        draft_evidence: draftResult.evidence,
        model_id: draftResult.model_id ?? "unknown",
        filter_violations: rubric.filter_violation_categories,
        rubric_results: rubric.results,
        overall_status: rubric.overall_status,
        triggered_by: "lab_ui_manual" as const,
        run_at: startedAt,
        duration_ms: Date.now() - startedAt,
        cost_usd: draftResult.cost_usd,
      },
    );

    if (draftText) {
      await ctx.runMutation(internal.renter_bot_lab_actions.appendAssistantMessage, {
        thread_id: args.threadId, account_slug: args.accountSlug, text: draftText, run_id: runId,
      });
    }

    // Surfaces the REAL production guardDraft() flags (draft_guard.ts) --
    // e.g. UNGROUNDED_UNAVAILABILITY -- not persisted, diagnostic only, so
    // Daniel/I can see directly whether the actual production safety net
    // caught something, not just this harness's own rubric.
    return {
      status: draftResult.status,
      reason: draftResult.reason,
      rejectedDraft: draftResult.rejectedDraft,
      guard_candidate: draftResult.guard_candidate,
      evidence: draftResult.evidence,
      model_id: draftResult.model_id,
      draft: draftText,
      overall_status: rubric.overall_status,
      runId,
      productionGuardFlags: draftResult.flags ?? [],
    };
  },
});

// Closing a Lab session must not remove other operators' simulations.
export const endLiveSession = action({
  args: { threadId: v.string() },
  handler: async (ctx, args): Promise<{ removed: number }> =>
    ctx.runMutation(internal.renter_bot_probe.__service_cleanup, { thread_id: args.threadId }),
});

export const runFixtureBatch = action({
  args: { fixtureIds: v.optional(v.array(v.id("renter_bot_fixtures"))) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    runBatchId: string;
    results: Array<{ fixtureId: string; overall_status: string }>;
  }> => ctx.runAction(internal.renter_bot_harness.__service_runBatch, args),
});
