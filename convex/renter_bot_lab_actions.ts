import type {CanonicalGenerationError} from "./lib/canonical_generation_error";
import { canonicalGenerationException, isCanonicalGenerationFailure, isFailedLabReply } from "./lib/canonical_generation_error";
import {recordSentRentalRequest} from "./lib/sent_rental_request";
import { sentBookingProposals } from "./lib/renter_sent_proposal";
import {friendReferralCodesFromMessage} from "./lib/verification_failure";
import {loadThreadReferralReference} from "./lib/thread_referral_reference";
import { listingDisplayCatalog } from "./lib/listing_display_catalog";
import { shortItemName } from "./lib/item_display_name";
import { labBooking } from "./lib/lab_lifecycle";
import { insertStockInput, patchStockInput } from "./lib/stock_input_writes";
import { insertProduct, patchProduct } from "./lib/product_context";
import { renterBotLabScenario, renterBotLabPickupPoint, renterBotLabRentalDates } from "./lib/renter_bot_lab_scenarios";
import { clearlyAcceptsTravelCompensation, mentionsPickupArea } from "./lib/travel_compensation";
import { renterBotNeedsHumanReview } from "./lib/renter_bot_review_state";
import { verifiedPickupReasonForSingleListing } from "./lib/renter_bot_listing_pickup";
import { mapPreparedComponentsToLabIds, matchesPreparedListingSnapshot, preparedListingPrice, preparedOrderPrice, preparedScenarioSourceInventoryId, type PreparedListingPrice } from "./lib/renter_bot_lab_listing_snapshot";
import { preparedLabItemPatch } from "./lib/renter_bot_lab_catalog_snapshot";
import { preparedAlternativeSnapshot } from "./lib/renter_bot_lab_alternative_snapshot";
/**
 * renter_bot_lab_actions — the ONE Convex entry point the Lab UI is allowed
 * to call, so auditing "does the Lab import any send path" is one file, not
 * a whole tree (see scripts/check-patterns.mjs invariant). Delegates to
 * renter_bot_probe / renter_bot_harness. Never imports hygglo-write.ts or
 * any of the four send-gated functions documented in
 * docs/renter-bot-policy.md.
 */
import { action, internalAction, internalActionOf, internalMutation, internalQuery, query } from "./owner_functions";
import { action as rawAction } from "./_generated/server";
import { renterBotLabAuthMarkerMatches } from "./lib/renter_bot_lab_contract";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { scoreDraft, scoreSkippedGeneration } from "./lib/renter_bot_rubric";
import { draftEvidenceValidator, type DraftEvidence } from "./lib/renter_draft_evidence";
import { PREFIX } from "./renter_bot_probe";
import type {ActionCtx, MutationCtx} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { FunctionReturnType } from "convex/server";

type CanonicalDraftResult = FunctionReturnType<typeof internal.replyInbox_actions.__service_generateDraft>;
type LabSendTestMessageResult = FunctionReturnType<typeof internal.renter_bot_lab_actions.sendTestMessage>;

type LabTurnClaimResult =
  | { status: "complete"; requestMessageId: string; runId?: Id<"renter_bot_harness_runs"> }
  | { status: "running"; requestMessageId: string }
  | { status: "claimed"; requestMessageId: string; leaseToken: string; retryReview?: boolean };

type LabTurnExecutionResult = {
  status: "ok" | "skipped" | "running" | "ready";
  requestMessageId?: string;
  turnId?: string;
  draft?: string;
  overall_status?: string;
  rubric_results?: unknown[];
  assistantContextAdded?: boolean;
  needs_review?: boolean;
  runId?: string;
  reason?: string;
  generation_error?: CanonicalGenerationError;
  model_id?: string;
  token_usage?: unknown;
  tool_stats?: unknown;
  source_receipts?: unknown;
  candidate_text?: string;
  productionGuardFlags?: unknown;
  evidence?: DraftEvidence;
};

type LabTranscriptResult = {
  session: null | {
    account_slug: string;
    item_name: string;
    display_name: string;
    items: string[];
    start_date: string;
    end_date: string;
  };
  messages: Array<{
    id: Id<"hygglo_messages">;
    message_id: string;
    sender: string;
    text: string;
    at: number;
    run_id?: string;
  }>;
  runs: Doc<"renter_bot_harness_runs">[];
  turns: Array<{
    turn_id: string;
    renter_message_id: string;
    status: "running" | "complete" | "failed";
    updated_at: number;
    run_id?: Id<"renter_bot_harness_runs">;
    failure_reason?: string;
  }>;
};

function assertLabApiAuthorization(marker: string) {
  if (!renterBotLabAuthMarkerMatches(marker, process.env)) {
    throw new Error("Isolated Lab API authorization failed");
  }
}

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

/** Deployment hook for the isolated Lab's owner-approved pickup policy data. */
export const seedLabLocationPolicy = action({
  args: {},
  handler: async (ctx): Promise<{
    rulesUpdated: number;
    memoriesUpdated: number;
    duplicateSeedMemoriesRemoved: number;
  }> =>
    ctx.runMutation(internal.renter_bot_seed.migrateLabLocationPolicy, {}),
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
  handler: async (ctx, { thread_id }): Promise<Doc<"conversations"> | null> =>
    ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first(),
});

export const getLatestMessageForThread = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }): Promise<Doc<"hygglo_messages"> | null> =>
    ctx.db
      .query("hygglo_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .order("desc")
      .first(),
});

export const getLatestRenterMessageForThread = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }): Promise<Doc<"hygglo_messages"> | null> => ctx.db.query("hygglo_messages")
    .withIndex("by_thread_sender", q => q.eq("thread_id", thread_id).eq("sender", "renter"))
    .order("desc").first(),
});

/** Saved state used by the chat page after reload, reconnect, or a failed turn. */
export const getLabTranscript = query({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }): Promise<LabTranscriptResult> => {
    if (!thread_id.startsWith(PREFIX)) throw new Error("Only Lab transcripts are available here");
    const session = await ctx.db.query("conversations").withIndex("by_thread", q => q.eq("thread_id", thread_id)).first();
    if (!session) return { session: null, messages: [], runs: [], turns: [] };
    if (!session.account_slug) throw new Error("Lab transcript has no account binding");
    const [messages, runs, turns] = await Promise.all([
      ctx.db.query("hygglo_messages").withIndex("by_thread", q => q.eq("thread_id", thread_id)).order("desc").take(100),
      ctx.db.query("renter_bot_harness_runs").withIndex("by_session_thread", q => q.eq("session_thread_id", thread_id)).order("desc").take(100),
      ctx.db.query("renter_bot_lab_turns").withIndex("by_thread", q => q.eq("thread_id", thread_id)).order("desc").take(100),
    ]);
    const order = await ctx.db.query("renter_bot_lab_orders").withIndex("by_thread", q => q.eq("thread_id", thread_id)).unique();
    if (order && order.account_slug !== session.account_slug) throw new Error("Lab transcript/order account mismatch");
    const items = order?.items.map((item) => item.name) ?? [];
    return {
      session: {
        account_slug: session.account_slug,
        item_name: items[0] ?? "",
        display_name: items[0] ?? "Saved conversation",
        items,
        start_date: order?.start_date ?? "",
        end_date: order?.end_date ?? "",
      },
      messages: messages.reverse().map(({ _id, message_id, sender, body_text, hygglo_sent_at, lab_run_id }) => ({
        id: _id, message_id, sender, text: body_text, at: hygglo_sent_at ?? 0, run_id: lab_run_id,
      })),
      runs,
      turns: turns.reverse().map(({ turn_id, renter_message_id, status, updated_at, run_id, failure_reason }) => ({
        turn_id, renter_message_id, status, updated_at, run_id, failure_reason,
      })),
    };
  },
});

async function appendRenterMessageInTransaction(
  ctx: MutationCtx,
  args: { thread_id: string; account_slug: string; text: string; turn_id?: string },
) {
  if (!args.thread_id.startsWith(PREFIX)) throw new Error("appendRenterMessage only accepts a Lab/probe thread_id");
  if (args.turn_id && !/^[A-Za-z0-9_-]{8,96}$/.test(args.turn_id)) throw new Error("Invalid Lab turn id");
  const messageId = args.turn_id
    ? `${args.thread_id}-turn-${args.turn_id}`
    : `${args.thread_id}-m${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  if (args.turn_id) {
    const existing = await ctx.db.query("hygglo_messages")
      .withIndex("by_thread_and_message", q => q.eq("thread_id", args.thread_id).eq("message_id", messageId)).first();
    if (existing) {
      if (existing.account_slug !== args.account_slug || existing.sender !== "renter" || existing.body_text !== args.text) {
        throw new Error("Lab turn id is already bound to a different message");
      }
      return existing.message_id;
    }
  }
  const now = Date.now();
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
  const conv = await ctx.db.query("conversations").withIndex("by_thread", q => q.eq("thread_id", args.thread_id)).first();
  if (conv) {
    const codes = friendReferralCodesFromMessage(args.text);
    const reference = codes.length ? { codes, message_id: messageId } :
      conv.referral_reference ?? await loadThreadReferralReference(ctx, args.thread_id) ?? { codes: [], message_id: messageId };
    await ctx.db.patch(conv._id, {
      referral_reference: reference,
      last_msg_at: now,
      last_sender: "renter",
      last_renter_msg_at: now,
    });
  }
  return messageId;
}

export const __service_claimTestTurn = internalMutation({
  args: {
    turn_id: v.string(), thread_id: v.string(), account_slug: v.string(), renter_text: v.string(),
    request_message_id: v.optional(v.string()), lease_token: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.thread_id.startsWith(PREFIX)) throw new Error("Only isolated Lab threads can claim generated turns");
    if (!/^[A-Za-z0-9_-]{8,96}$/.test(args.turn_id)) throw new Error("Invalid Lab turn id");
    if (!args.renter_text.trim() || args.renter_text.length > 6000) throw new Error("Invalid Lab renter text");
    const conversation = await ctx.db.query("conversations").withIndex("by_thread", q => q.eq("thread_id", args.thread_id)).first();
    if (!conversation || conversation.account_slug !== args.account_slug) throw new Error("Lab session/account mismatch");

    const existing = await ctx.db.query("renter_bot_lab_turns").withIndex("by_turn", q => q.eq("turn_id", args.turn_id)).first();
    const runningTurns = await ctx.db.query("renter_bot_lab_turns").withIndex("by_thread", q => q.eq("thread_id", args.thread_id)).collect();
    if (runningTurns.some(turn => turn.status === "running" && turn.turn_id !== args.turn_id)) {
      throw new Error("A previous Lab turn is still running; retry it before sending a new renter message");
    }

    const requestMessageId = args.request_message_id ?? await appendRenterMessageInTransaction(ctx, {
      thread_id: args.thread_id, account_slug: args.account_slug, text: args.renter_text, turn_id: args.turn_id,
    });
    const message = await ctx.db.query("hygglo_messages")
      .withIndex("by_thread_and_message", q => q.eq("thread_id", args.thread_id).eq("message_id", requestMessageId)).first();
    const latest = await ctx.db.query("hygglo_messages").withIndex("by_thread", q => q.eq("thread_id", args.thread_id)).order("desc").first();
    if (!message || message.account_slug !== args.account_slug || message.sender !== "renter" || message.body_text !== args.renter_text || latest?.message_id !== requestMessageId) {
      throw new Error("Lab turn no longer matches the latest renter message");
    }

    const now = Date.now();
    if (existing) {
      if (existing.thread_id !== args.thread_id || existing.account_slug !== args.account_slug ||
          existing.renter_message_id !== requestMessageId || existing.renter_text !== args.renter_text) {
        throw new Error("Lab turn id is already bound to different input");
      }
      if (existing.status === "running" && now - existing.lease_started_at < 210_000) return { status: "running" as const, requestMessageId };
      const savedRun = await ctx.db.query("renter_bot_harness_runs").withIndex("by_lab_turn", q => q.eq("lab_turn_id", args.turn_id)).first();
      const failedWithoutReply = isFailedLabReply(savedRun);
      if (existing.status === "complete" && !failedWithoutReply) return { status: "complete" as const, requestMessageId, runId: existing.run_id };
      // Recover failed no-reply turns, including legacy false-complete turns.
      // Only these retries bypass the shared generator's held review for this
      // same message; a new renter turn and a deliberate handoff do not.
      await ctx.db.patch(existing._id, { status: "running", lease_token: args.lease_token, lease_started_at: now, updated_at: now, failure_reason: undefined });
      return { status: "claimed" as const, requestMessageId, leaseToken: args.lease_token, ...(failedWithoutReply ? { retryReview: true } : {}) };
    }
    await ctx.db.insert("renter_bot_lab_turns", {
      turn_id: args.turn_id, thread_id: args.thread_id, account_slug: args.account_slug,
      renter_message_id: requestMessageId, renter_text: args.renter_text,
      lease_token: args.lease_token, status: "running", lease_started_at: now, updated_at: now,
    });
    return { status: "claimed" as const, requestMessageId, leaseToken: args.lease_token };
  },
});

export const __service_finishTestTurn = internalMutation({
  args: { turn_id: v.string(), thread_id: v.string(), account_slug: v.string(), lease_token: v.string(), failure_reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const turn = await ctx.db.query("renter_bot_lab_turns").withIndex("by_turn", q => q.eq("turn_id", args.turn_id)).first();
    if (!turn || turn.thread_id !== args.thread_id || turn.account_slug !== args.account_slug || turn.lease_token !== args.lease_token || turn.status !== "running") return false;
    const run = await ctx.db.query("renter_bot_harness_runs").withIndex("by_lab_turn", q => q.eq("lab_turn_id", args.turn_id)).first();
    await ctx.db.patch(turn._id, {
      status: args.failure_reason ? "failed" : "complete", updated_at: Date.now(),
      run_id: run?._id ?? turn.run_id, failure_reason: args.failure_reason,
    });
    return true;
  },
});

export const getTestTurn = internalQuery({
  args: { turn_id: v.string() },
  handler: async (ctx, { turn_id }) => ctx.db.query("renter_bot_lab_turns").withIndex("by_turn", q => q.eq("turn_id", turn_id)).first(),
});

export const appendRenterMessage = internalMutation({
  args: { thread_id: v.string(), account_slug: v.string(), text: v.string(), turn_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const runningTurns = await ctx.db.query("renter_bot_lab_turns")
      .withIndex("by_thread", q => q.eq("thread_id", args.thread_id)).collect();
    if (runningTurns.some(turn => turn.status === "running" && turn.turn_id !== args.turn_id)) {
      throw new Error("A previous Lab turn is still running; retry it before sending a new renter message");
    }
    return appendRenterMessageInTransaction(ctx, args);
  },
});

/** Test-only owner turn. This writes local simulation history, never sends. */
export const appendAssistantMessage = internalMutation({
  args: { thread_id: v.string(), account_slug: v.string(), text: v.string(), run_id: v.string(), expected_message_id: v.string(), turn_id: v.string(), lease_token: v.string(), draft_evidence: v.optional(draftEvidenceValidator) },
  handler: async (ctx, args) => {
    if (!args.thread_id.startsWith(PREFIX)) throw new Error("Only Lab/probe history can be appended");
    if (!args.text.trim()) return;
    const turn = await ctx.db.query("renter_bot_lab_turns").withIndex("by_turn", q => q.eq("turn_id", args.turn_id)).first();
    const latest = await ctx.db.query("hygglo_messages").withIndex("by_thread", q => q.eq("thread_id", args.thread_id)).order("desc").first();
    if (!turn || turn.thread_id !== args.thread_id || turn.account_slug !== args.account_slug ||
        turn.renter_message_id !== args.expected_message_id || turn.lease_token !== args.lease_token || turn.status !== "running" ||
        latest?.message_id !== args.expected_message_id || latest.sender !== "renter" || latest.account_slug !== args.account_slug) {
      throw new Error("Lab turn is stale; assistant history was not saved");
    }
    const messageId = `${args.thread_id}-assistant-${args.run_id}`;
    const existing = await ctx.db.query("hygglo_messages").withIndex("by_thread_and_message", q => q.eq("thread_id", args.thread_id).eq("message_id", messageId)).first();
    if (existing) return;
    const conversation = await ctx.db.query("conversations").withIndex("by_thread",q=>q.eq("thread_id",args.thread_id)).first();
    const proposals=conversation?.account_slug === args.account_slug ? await sentBookingProposals(ctx, conversation, args.text,
      args.draft_evidence ? {labSimulation:{draftText:args.text,evidence:args.draft_evidence,requestMessageId:args.expected_message_id}} : undefined)
      : {additions:[],dates:[],replacements:[],inquiries:[]};
    const rental_request=conversation?.account_slug===args.account_slug?await recordSentRentalRequest(ctx,conversation,args.text):undefined;
    const quoted_inquiries=proposals.inquiries,quoted_additions=proposals.additions,quoted_dates=proposals.dates,quoted_replacements=proposals.replacements;
    const now = Date.now();
    await ctx.db.insert("hygglo_messages", { account_slug: args.account_slug, thread_id: args.thread_id, message_id: messageId, lab_run_id: args.run_id, sender: "owner", sender_name: "Lab owner", body_text: args.text, ...(rental_request?{rental_request}:{}), hygglo_sent_at: now, fetched_at: now, ...(quoted_inquiries.length ? {quoted_inquiries} : {}), ...(quoted_additions.length ? {quoted_additions} : {}), ...(quoted_dates.length ? {quoted_dates} : {}), ...(quoted_replacements.length ? {quoted_replacements} : {}) });
    if(process.env.RENTER_BOT_LAB_SCENARIO_SEEDING==="enabled" && mentionsPickupArea(args.text,renterBotLabPickupPoint(args.account_slug)?.area))
      await ctx.scheduler.runAfter(24*60*60*1000,internal.renter_bot_lab_followups.createDraft,{thread_id:args.thread_id,kind:"location",anchor:now,source_message_id:messageId});
  },
});

/** The selected SKU is resolved on the server, not guessed from UI text. */
export const getSelectedListing = internalQuery({
  args: { account_slug: v.string(), product_id: v.number() },
  handler: async (ctx, a) => ctx.db.query("online_listings")
    .withIndex("by_account_product", (q) => q.eq("account_slug", a.account_slug).eq("product_id", a.product_id)).first(),
});

function assertPreparedScenarioLab() {
  if (process.env.RENTER_BOT_LAB_SCENARIO_SEEDING !== "enabled") {
    throw new Error("Prepared scenarios are available only on the isolated Renter Bot Lab backend");
  }
}

async function assertLabCatalogReady(ctx: ActionCtx, options: { preparedScenario: boolean }) {
  // A hosted Lab is deliberately backed by a seeded set of isolated
  // scenarios. Its authoritative listing snapshot is refreshed per selected
  // scenario; it must not depend on the local-only full-catalogue import.
  // Keep the local import requirement for local free-form catalogue testing.
  if (process.env.RENTER_BOT_LAB_DEPLOYMENT === "hosted") {
    assertPreparedScenarioLab();
    if (process.env.RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED !== "false") {
      throw new Error("Hosted Lab conversations require real-renter messaging to remain disabled");
    }
    if (!options.preparedScenario) {
      throw new Error("Hosted Lab sessions require a prepared, source-verified rental scenario");
    }
    return;
  }

  const catalog = await ctx.runQuery(internal.renter_bot_lab_local_setup.getCatalogStatus, {});
  const age = catalog.fetched_at == null ? Number.POSITIVE_INFINITY : Date.now() - catalog.fetched_at;
  if (catalog.status !== "ready" || !Number.isFinite(age) || age < -300_000 || age > 48 * 60 * 60 * 1000 ||
      catalog.inventory_count < 1 || catalog.listing_count < 1) {
    throw new Error("The isolated Lab catalogue is missing, stale, or still syncing. Refresh the local Lab before testing.");
  }
}

/** Owner-confirmed unavailable identities belong in the same catalogue as
 * owned gear, so stock tools can return evidence instead of guessing. These
 * are isolated Lab records and never change live listings or inventory. */
async function ensureLabUnavailableIdentities(ctx:MutationCtx){
  assertPreparedScenarioLab();
  const known=[
   {name:"Blackmagic Pyxis",slug:"lab-unavailable-blackmagic-pyxis",aliases:["Pyxis","Blackmagic Pyxis 6K"]},
   {name:"Sony A7S III",slug:"lab-unavailable-sony-a7s-iii",aliases:["A7S III","Sony A7S3"]},
   {name:"Sony A7R III",slug:"lab-unavailable-sony-a7r-iii",aliases:["A7R III","Sony A7R3"]},
  ];
  for(const item of known){
   const existing=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical",item.name)).first();
   if(!existing)await insertStockInput(ctx,"items",{name_canonical:item.name,name_input:item.name,slug:item.slug,aliases:item.aliases,
     kind:"camera",qty:0,unit_kind:"kit",status:"active",is_marketing_only:true,description_source:"owner-confirmed Lab unavailable identity",created_at:Date.now(),updated_at:Date.now()});
  }
}

/** Apply owner-confirmed account pickup points only on the isolated Lab. */
export const ensureLabPickupPoint = internalMutation({
  args: { accountSlug: v.string() },
  handler: async (ctx, { accountSlug }) => {
    assertPreparedScenarioLab();
    const point = renterBotLabPickupPoint(accountSlug);
    if (!point) throw new Error("No owner-confirmed Lab pickup point for this account");
    const account = await ctx.db.query("accounts").withIndex("by_slug", (q) => q.eq("slug", accountSlug)).first();
    if (!account) throw new Error("Unknown Lab rental account");
    const profile = await ctx.db.query("account_profiles").withIndex("by_account", (q) => q.eq("account_id", account._id)).first();
    if (!profile) throw new Error("Lab account has no pickup profile");
    await ctx.db.patch(profile._id, {
      pickup_area: point.area,
      pickup_address: point.address,
      updated_at: Date.now(),
    });
    return { accountSlug, area: point.area };
  },
});

/** Upsert only the owner-confirmed items used by the prepared Lab examples. */
export const ensurePreparedScenarioItem = internalMutation({
  args: { scenarioId: v.string(), sourceInventoryId: v.string() },
  handler: async (ctx, { scenarioId, sourceInventoryId }) => {
    assertPreparedScenarioLab();
    const scenario = renterBotLabScenario(scenarioId);
    if (!scenario) throw new Error("Unknown prepared Lab example");
    if (preparedScenarioSourceInventoryId(scenarioId, scenario.accountSlug) !== sourceInventoryId) {
      throw new Error("Prepared Lab item source identity does not match its verified listing");
    }
    await ensureLabUnavailableIdentities(ctx);
    const now = Date.now();
    const existing = await ctx.db
      .query("items")
      .withIndex("by_canonical_name", (q) => q.eq("name_canonical", scenario.item.name_canonical))
      .first();
    const sourceOwner = await ctx.db.query("items")
      .withIndex("by_lab_source_inventory_id", (q) => q.eq("lab_source_inventory_id", sourceInventoryId))
      .unique();
    if (sourceOwner && sourceOwner._id !== existing?._id) {
      throw new Error("Prepared Lab source identity is already linked to a different inventory item");
    }
    // The owner confirmed these shared physical pools. The Lab uses its own
    // stock rows and never copies or edits a real reservation.
    let suppliedStock = existing?.supplied_stock;
    if (["BMPCC 6K Full Frame", "Sony FX3"].includes(scenario.item.name_canonical)) {
      const ensurePool = async (name: string, slug: string, qty: number) => {
        const found = await ctx.db.query("items").withIndex("by_canonical_name", q => q.eq("name_canonical", name)).first();
        const quantity_basis = {basis:"owner_lower_bound" as const,source:"owner-confirmed Lab minimum",
          note:`At least ${qty} batteries confirmed; the total is not exact.`,recorded_at:now};
        if (found) {
          if (name.includes("batteries") && found.slug === slug && found.qty === qty && !found.quantity_basis)
            await patchStockInput(ctx,found._id,{quantity_basis,updated_at:now});
          return found._id;
        }
        return insertStockInput(ctx, "items", { name_canonical: name, name_input: name, slug, kind: "accessory",
          qty, unit_kind: "unit", track_independent_stock: true, status: "active", is_marketing_only: false,
          ...(name.includes("batteries") ? {quantity_basis} : {}),
          created_at: now, updated_at: now });
      };
      if (scenario.item.name_canonical === "BMPCC 6K Full Frame") {
        const battery = await ensurePool("NP-F570 batteries", "lab-np-f570-batteries", 12);
        await ensurePool("EF to L mount", "lab-ef-to-l-mount", 1);
        if (!suppliedStock?.length) suppliedStock = [{item_id:battery, qty:5, source:"Owner-confirmed Lab kit allocation"}];
      } else {
        // An existing differently named FZ100 pool must be reconciled before
        // creating a second one; otherwise stock could be counted twice.
        for (const part of suppliedStock ?? []) {
          const item = await ctx.db.get(part.item_id);
          if (!item || /\bnp[\s-]*fz100\b/i.test(item.name_canonical) && item.name_canonical !== "Sony NP-FZ100 batteries")
            throw new Error("FX3 shared battery pool requires review");
        }
        const battery = await ensurePool("Sony NP-FZ100 batteries", "lab-sony-np-fz100-batteries", 12);
        const pool = await ctx.db.get(battery);
        if (!pool || pool.status !== "active" || pool.is_marketing_only || !pool.track_independent_stock || pool.unit_kind !== "unit")
          throw new Error("FX3 shared battery pool is unavailable for this test");
        suppliedStock = [...(suppliedStock ?? []).filter(part => part.item_id !== battery),
          {item_id:battery, qty:3, source:"Owner-confirmed Lab kit allocation"}];
      }
    }
    const proposedItemFacts = {
      ...scenario.item,
      // Hosted scenarios have no full-catalogue import. Bind an isolated row
      // that has no source identity only to the exact current source ID that
      // its prepared listing snapshot verified. Existing identities remain
      // immutable in preparedLabItemPatch.
      lab_source_inventory_id: sourceInventoryId,
      ...(scenario.item.compatibility ? { compatibility: {
        ...(scenario.item.compatibility.batteries ? { batteries: [...scenario.item.compatibility.batteries] } : {}),
        ...(scenario.item.compatibility.cards ? { cards: [...scenario.item.compatibility.cards] } : {}),
        ...(scenario.item.compatibility.lenses ? { lenses: [...scenario.item.compatibility.lenses] } : {}),
        ...(scenario.item.compatibility.accessories ? { accessories: [...scenario.item.compatibility.accessories] } : {}),
        ...(scenario.item.compatibility.included_with_rental ? { included_with_rental: [...scenario.item.compatibility.included_with_rental] } : {}),
      } } : {}),
      ...(suppliedStock?.length ? {supplied_stock:suppliedStock} : {}),
      is_marketing_only: false,
      status: "active",
      description_source: "owner-confirmed prepared Lab scenario",
    };
    const itemFacts = {
      ...proposedItemFacts,
      ...(suppliedStock?.length ? { supplied_stock: suppliedStock } : {}),
      updated_at: now,
    };
    const existingItemPatch = preparedLabItemPatch(existing as unknown as Record<string, unknown> | null,
      proposedItemFacts as unknown as Record<string, unknown>, suppliedStock, now);
    let operation: "insert" | "update" = "insert";
    if (existing) {
      operation = "update";
      await patchStockInput(ctx, existing._id, existingItemPatch);
    } else {
      await insertStockInput(ctx, "items", { ...itemFacts, created_at: now });
    }
    await ctx.db.insert("audit_log", {
      table_name: "items",
      actor: "lab-scenario-seed",
      op: operation,
      count: 1,
      source_file: "convex/lib/renter_bot_lab_scenarios.ts",
      note: `${scenario.id}: ${scenario.item.name_canonical}`,
      ts: now,
    });
    return scenario.item.name_canonical;
  },
});

/** Link the one prepared listing whose physical mapping has been verified
 * against Rental Manager. Conflicting existing Lab mappings are never replaced. */
export const ensurePreparedListing = internalMutation({
  args: { scenarioId:v.string(), snapshot:v.object({account_slug:v.string(),product_id:v.number(),master_item_id:v.string(),
    inventory_name:v.string(),listing_name:v.string(),listing_description:v.string(),listing_description_synced_at:v.number(),public_url:v.string(),
    daily_price_gbp:v.number(),price_tiers:v.array(v.object({days:v.number(),pricePerDay:v.number()})),
    mapping_components:v.array(v.object({item_id:v.string(),qty:v.number()})),mapping_source:v.string(),
    source_synced_at:v.number(),checked_at:v.number(),mapping_verified:v.optional(v.boolean())}) },
  handler: async (ctx, {scenarioId, snapshot}) => {
    assertPreparedScenarioLab();
    const scenario=renterBotLabScenario(scenarioId);
    if (!scenario || scenario.item.name_canonical!==snapshot.inventory_name ||
        !matchesPreparedListingSnapshot(scenarioId,scenario.accountSlug,snapshot))
      return "source_snapshot_mismatch" as const;
    const item=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical",scenario.item.name_canonical)).unique();
    if(!item || item.status!=="active" || item.is_marketing_only) return "lab_item_unavailable" as const;
    if(item.lab_source_inventory_id!==snapshot.master_item_id) return "lab_item_source_identity_mismatch" as const;
    const mapping=await ctx.db.query("listing_resolution_override").withIndex("by_account_product",q=>q.eq("account_slug",scenario.accountSlug).eq("product_id",snapshot.product_id)).unique();
    const product=await ctx.db.query("hygglo_products").withIndex("by_account_product",q=>q.eq("accountSlug",scenario.accountSlug).eq("productId",snapshot.product_id)).unique();
    const listing=await ctx.db.query("online_listings").withIndex("by_account_product",q=>q.eq("account_slug",scenario.accountSlug).eq("product_id",snapshot.product_id)).unique();
    const labIdsBySourceId=new Map<string,Id<"items">>();
    for(const component of snapshot.mapping_components){
      const stock=await ctx.db.query("items").withIndex("by_lab_source_inventory_id",q=>q.eq("lab_source_inventory_id",component.item_id)).unique();
      if(!stock || stock.status!=="active" || stock.is_marketing_only || stock.qty<component.qty)
        return "mapped_component_unavailable" as const;
      labIdsBySourceId.set(component.item_id,stock._id);
    }
    const expectedComponents=mapPreparedComponentsToLabIds(snapshot.mapping_components,labIdsBySourceId);
    if(!expectedComponents) return "mapped_component_unavailable" as const;
    const sameComponents=(actual:Array<{item_id:string;qty:number}>)=>{
      const sorted=[...actual].sort((a,b)=>a.item_id.localeCompare(b.item_id));
      return sorted.length===expectedComponents.length && sorted.every((component,index)=>
        component.item_id===expectedComponents[index]?.item_id && component.qty===expectedComponents[index]?.qty);
    };
    if(!expectedComponents.some(component=>component.item_id===item._id && component.qty===1) || !snapshot.mapping_source.trim())
      return "prepared_mapping_missing_primary" as const;
    if(mapping && !sameComponents(mapping.components)) return "lab_mapping_differs_from_current_source" as const;
    if(product && (product.masterItemId!==item._id || product.isMarketingOnly || product.isMarketingOnlyOverride===true || product.isPublished!==true))
      return "lab_product_identity_conflict" as const;
    const now=Date.now();
    const pickupAvailability = mapping?.pickup_availability ?? {
      status: "account_area_only" as const,
      source: "owner-confirmed Lab account pickup point",
      verified_at: now,
    };
    const ownerConfirmedKitContents = scenario.ownerConfirmedKitContents
      ? {lines:[...scenario.ownerConfirmedKitContents.lines],mapping_components:expectedComponents,
          source:scenario.ownerConfirmedKitContents.source,recorded_at:now}
      : undefined;
    if(!mapping) await insertStockInput(ctx,"listing_resolution_override",{account_slug:scenario.accountSlug,product_id:snapshot.product_id,
      components:expectedComponents,
      source:snapshot.mapping_source,pickup_availability:pickupAvailability,
      ...(ownerConfirmedKitContents?{owner_confirmed_kit_contents:ownerConfirmedKitContents}:{}),updated_at:now});
    else await ctx.db.patch(mapping._id,{owner_confirmed_kit_contents:ownerConfirmedKitContents,
      ...(!mapping.pickup_availability?{pickup_availability:pickupAvailability}:{}),updated_at:now});
    const fields={name:snapshot.listing_name,description:snapshot.listing_description,descriptionSyncedAt:snapshot.listing_description_synced_at,
      publicUrl:snapshot.public_url,masterItemId:item._id,isMarketingOnly:false,isPublished:true,
      prices:snapshot.price_tiers,lastSyncedAt:snapshot.source_synced_at};
    if(product) await patchProduct(ctx,product._id,fields,product);
    else await insertProduct(ctx,{accountSlug:scenario.accountSlug,productId:snapshot.product_id,...fields});
    const listingFields={name:snapshot.listing_name,daily_price:snapshot.daily_price_gbp,is_published:true,updated_at:now};
    if(listing) await ctx.db.patch(listing._id,listingFields);
    else await ctx.db.insert("online_listings",{account_slug:scenario.accountSlug,product_id:snapshot.product_id,...listingFields});
    return true;
  },
});

/** Shared hydration boundary for both prepared-example entry points. The Lab
 * must not open a conversation that lacks its exact listing, current price,
 * and synced description: the conversational agent cannot recover missing
 * source data by reasoning from an item name. */
async function ensurePreparedScenarioListing(
  ctx: ActionCtx,
  scenarioId: string,
  snapshot: PreparedListingPrice | null,
): Promise<{ itemName: string; snapshot: PreparedListingPrice }> {
  if (!snapshot) throw new Error("Prepared example listing data is missing, stale, or ambiguous; refresh the source and retry.");
  const itemName = await ctx.runMutation(internal.renter_bot_lab_actions.ensurePreparedScenarioItem, {
    scenarioId,
    sourceInventoryId: snapshot.master_item_id,
  });
  const seeded = await ctx.runMutation(internal.renter_bot_lab_actions.ensurePreparedListing, { scenarioId, snapshot });
  if (seeded !== true) throw new Error(`Prepared example listing could not be safely linked to its isolated Lab item (${seeded}).`);
  return { itemName, snapshot };
}

/** Seed a source-verified lower-value alternative into the isolated test
 * inventory. Stock and bookings here are simulated, never live allocations. */
export const ensurePreparedAlternative = internalMutation({
  args:{scenarioId:v.string(),snapshot:v.union(v.null(),v.object({original_value_gbp:v.number(),replacement_value_gbp:v.number(),qty:v.number(),
    daily_price_gbp:v.number(),price_tiers:v.array(v.object({days:v.number(),pricePerDay:v.number()})),source_synced_at:v.number()}))},
  handler:async(ctx,{scenarioId,snapshot})=>{
    assertPreparedScenarioLab();
    const scenario=renterBotLabScenario(scenarioId);
    if(!scenario || scenario.accountSlug!=="dbcinema" || scenario.item.name_canonical!=="BMPCC 6K Full Frame")return false;
    // The owner confirmed no A7S III body is held. This is physical-stock
    // evidence for the isolated Lab, not a change to any published listing.
    // Never override an existing imported catalogue record.
    const unowned=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical","Sony A7S III")).first();
    if(!unowned)await insertStockInput(ctx,"items",{name_canonical:"Sony A7S III",name_input:"Sony A7S III",slug:"lab-sony-a7s-iii-unowned",
      kind:"camera",qty:0,unit_kind:"kit",status:"active",is_marketing_only:true,description_source:"owner-confirmed Lab non-owned camera",
      created_at:Date.now(),updated_at:Date.now()});
    const existing=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical","Sony A7 III")).unique();
    const marker="source-verified prepared Lab alternative";
    const fixture=!existing || existing.description_source===marker;
    // An imported row keeps its stock count and status. Only the specifically
    // owner-confirmed kit facts are reconciled after the source checks pass.
    if(existing && !fixture && (existing.status!=="active" || existing.is_marketing_only ||
      !/^camera(?:_body)?$/.test(existing.kind??"") || !Number.isSafeInteger(existing.qty) || existing.qty<1))return false;
    const account="dbcinema",productId=1046235;
    const mapping=await ctx.db.query("listing_resolution_override").withIndex("by_account_product",q=>q.eq("account_slug",account).eq("product_id",productId)).unique();
    const product=await ctx.db.query("hygglo_products").withIndex("by_account_product",q=>q.eq("accountSlug",account).eq("productId",productId)).unique();
    const listing=await ctx.db.query("online_listings").withIndex("by_account_product",q=>q.eq("account_slug",account).eq("product_id",productId)).unique();
    const managed=mapping?.source==="verified DB Cinema checkout listing" && !!existing && mapping.components.length===1 &&
      mapping.components[0].item_id===existing._id && mapping.components[0].qty===1;
    const withdraw=async()=>{
      if(existing && fixture && existing.status!=="inactive")await patchStockInput(ctx,existing._id,{status:"inactive",updated_at:Date.now()});
      // Withdraw only the Lab-managed offering. Imported item rows and
      // unrelated offers stay untouched when the source cannot be checked.
      if(managed && product?.masterItemId===existing?._id && product.isPublished===true)
        await patchProduct(ctx,product._id,{isPublished:false},product);
      if(managed && listing?.is_published)await ctx.db.patch(listing._id,{is_published:false,updated_at:Date.now()});
      return false;
    };
    if(!snapshot)return withdraw();
    if(!Number.isFinite(snapshot.original_value_gbp) ||
       !Number.isFinite(snapshot.replacement_value_gbp) || snapshot.replacement_value_gbp<=0 ||
       snapshot.replacement_value_gbp>=snapshot.original_value_gbp || !Number.isSafeInteger(snapshot.qty) || snapshot.qty<1) return withdraw();
    const now=Date.now();
    const target=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical","BMPCC 6K Full Frame")).unique();
    if(!target || target.status!=="active" || target.is_marketing_only || existing?.is_marketing_only)return withdraw();
    if(mapping && (!existing || mapping.components.length!==1 || mapping.components[0].item_id!==existing._id || mapping.components[0].qty!==1))return withdraw();
    if(product && (!existing || product.masterItemId!==existing._id || product.isMarketingOnly || product.isPublished!==true && !managed))return withdraw();
    const existingSupplied=existing?.supplied_stock ?? [];
    for(const part of existingSupplied) {
      const item=await ctx.db.get(part.item_id);
      if(item && /\bnp[\s-]*fz100\b/i.test(item.name_canonical) && item.name_canonical!=="Sony NP-FZ100 batteries")return withdraw();
    }
    let battery=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical","Sony NP-FZ100 batteries")).first();
    if(!battery){
      const id=await insertStockInput(ctx,"items",{name_canonical:"Sony NP-FZ100 batteries",name_input:"Sony NP-FZ100 batteries",slug:"lab-sony-np-fz100-batteries",
        kind:"accessory",qty:12,unit_kind:"unit",track_independent_stock:true,status:"active",is_marketing_only:false,
        quantity_basis:{basis:"owner_lower_bound",source:"owner-confirmed Lab minimum",note:"At least 12 batteries confirmed; the total is not exact.",recorded_at:now},created_at:now,updated_at:now});
      battery=await ctx.db.get(id);
    }
    if(battery && battery.slug==="lab-sony-np-fz100-batteries" && battery.qty===12 && !battery.quantity_basis){
      await patchStockInput(ctx,battery._id,{quantity_basis:{basis:"owner_lower_bound",source:"owner-confirmed Lab minimum",note:"At least 12 batteries confirmed; the total is not exact.",recorded_at:now},updated_at:now});
      battery=await ctx.db.get(battery._id);
    }
    if(!battery || battery.status!=="active" || battery.is_marketing_only || !battery.track_independent_stock || battery.unit_kind!=="unit")return withdraw();
    const preservedContents=(existing?.compatibility?.included_with_rental??[]).filter(content=>
      !/\bnp[\s-]*fz100\b|\b(?:sd(?:hc|xc)?|cf\s*express|cfast|memory\s+card|cards?)\b|\bchargers?\b/i.test(content));
    const facts={...(fixture?{qty:snapshot.qty,status:"active" as const,description_source:marker}:{}),
      replacement_cost_gbp:snapshot.replacement_value_gbp,battery_type:"Sony NP-FZ100",
      owner_verified_kit:{source:"Owner-confirmed Lab camera kit",contents:["3x Sony NP-FZ100 batteries","2x 128GB SD cards","1x Sony dual battery charger"]},
      compatibility:{...existing?.compatibility,batteries:["Sony NP-FZ100"],cards:["SD"],
        included_with_rental:[...preservedContents,"3× Sony NP-FZ100 batteries","2× 128GB SD cards","Sony dual battery charger"]},
      supplied_stock:[...existingSupplied.filter(part=>String(part.item_id)!==String(battery!._id)),
        {item_id:battery._id,qty:3,source:"Owner-confirmed Lab kit allocation"}],updated_at:now};
    const id=existing?existing._id:await insertStockInput(ctx,"items",{name_canonical:"Sony A7 III",name_input:"Sony A7 III",slug:"lab-sony-a7-iii",
      kind:"camera",unit_kind:"kit",is_marketing_only:false,created_at:now,...facts,
      qty:snapshot.qty,status:"active",description_source:marker});
    if(existing)await patchStockInput(ctx,id,facts);
    // Equipment identity is distinct from stock and kit contents. Only add a
    // manufacturer review when the isolated fixture has no existing review.
    const spec=await ctx.db.query("item_specs").withIndex("by_item",q=>q.eq("item_id",id)).first();
    if(!spec){
      const source_url="https://electronics.sony.com/imaging/interchangeable-lens-cameras/full-frame/p/ilce7m3-b";
      const verified_model="ILCE-7M3";
      await ctx.db.insert("item_specs",{item_id:id,item_name_canonical:"Sony A7 III",description:"Sony Alpha 7 III full-frame interchangeable-lens camera.",
        source:"manufacturer-verified",source_url,verified_model,verified_at:now,created_at:now,
        camera_capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",native_mount:"E",internal_4k:true,source_url,verified_model,verified_at:now}});
    }
    await patchStockInput(ctx,target._id,{replacement_cost_gbp:snapshot.original_value_gbp,updated_at:now});
    if(!mapping)await insertStockInput(ctx,"listing_resolution_override",{account_slug:account,product_id:productId,
      components:[{item_id:id,qty:1}],source:"verified DB Cinema checkout listing",updated_at:now});
    const fields={name:"Sony A7 III Camera Body Kit",masterItemId:id,isMarketingOnly:false,isPublished:true,
      prices:snapshot.price_tiers,lastSyncedAt:snapshot.source_synced_at};
    if(product)await patchProduct(ctx,product._id,fields,product);else await insertProduct(ctx,{accountSlug:account,productId,...fields});
    const offer={name:fields.name,daily_price:snapshot.daily_price_gbp,is_published:true,updated_at:now};
    if(listing)await ctx.db.patch(listing._id,offer);else await ctx.db.insert("online_listings",{account_slug:account,product_id:productId,...offer});
    return true;
  },
});

/** Starts a fixed, owner-grounded conversation with its item seeded first. */
export const startPreparedScenario = action({
  args: {
    scenarioId: v.union(
      v.literal("bmpcc-6k-full-frame-kit"),
      v.literal("sony-fx3-batteries"),
      v.literal("diogo-sony-fx3-kit"),
      v.literal("verification-failed"),
      v.literal("confirmed-booking"),
    ),
  },
  handler: async (ctx, { scenarioId }): Promise<{
    threadId: string;
    accountSlug: string;
    context: { scenarioTitle: string; displayName: string; items: string[]; examplePrompts: string[]; initialBotMessage?: string };
  }> => {
    assertPreparedScenarioLab();
    await assertLabCatalogReady(ctx, { preparedScenario: true });
    const scenario = renterBotLabScenario(scenarioId);
    if (!scenario) throw new Error("Unknown prepared Lab example");
    if (scenario.accountSlug === "diogo") {
      await ctx.runMutation(internal.seed.diogo_profile.seedDiogoProfile, {});
    }
    await ctx.runMutation(internal.renter_bot_lab_actions.ensureLabPickupPoint, { accountSlug: scenario.accountSlug });
    const supportsAlternative = scenario.accountSlug === "dbcinema" && scenario.item.name_canonical === "BMPCC 6K Full Frame";
    const [preparedPrice, preparedAlternative] = await Promise.all([
      preparedListingPrice(scenario.id, scenario.accountSlug),
      supportsAlternative ? preparedAlternativeSnapshot() : Promise.resolve(null),
    ]);
    const { startDate, endDate } = renterBotLabRentalDates(scenario);
    const { itemName, snapshot: readyPrice } = await ensurePreparedScenarioListing(ctx, scenarioId, preparedPrice);
    if (supportsAlternative) await ctx.runMutation(internal.renter_bot_lab_actions.ensurePreparedAlternative, {scenarioId,snapshot:preparedAlternative});
    const threadId = `${PREFIX}prepared-${scenarioId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await ctx.runMutation(internal.renter_bot_probe.seed, {
      thread_id: threadId,
      account_slug: scenario.accountSlug,
      items: [{ name: itemName, product_id: readyPrice.product_id }],
      messages: [],
      booking: scenario.startStage === "verification_failed" ? labBooking("awaiting_verification", startDate, endDate) : scenario.startStage === "confirmed" ? labBooking("confirmed",startDate,endDate) : undefined,
    });
    await ctx.runMutation(internal.renter_bot_lab_order.seed, {
      thread_id: threadId,
      account_slug: scenario.accountSlug,
      item_names: [itemName],
      prepared_price: preparedOrderPrice(readyPrice),
      start_date: startDate,
      end_date: endDate,
    });
    const failure = scenario.startStage === "verification_failed"
      ? await ctx.runMutation(internal.renter_bot_lab_order.__service_simulateVerificationFailure, { thread_id: threadId, referral_code: crypto.randomUUID() })
      : null;
    return {
      threadId,
      accountSlug: scenario.accountSlug,
      context: {
        scenarioTitle: scenario.title,
        displayName: scenario.displayName,
        items: [itemName],
        examplePrompts: [],
        ...(failure ? { initialBotMessage: failure.message } : {}),
      },
    };
  },
});

// Starts (or restarts) a live Lab test conversation — from a saved scenario
// preset, or a blank custom one seeded from location/price/items fields.
export const startLiveSession = action({
  args: {
    accountSlug: v.string(),
    scenarioId: v.optional(v.union(
      v.literal("bmpcc-6k-full-frame-kit"),
      v.literal("sony-fx3-batteries"),
      v.literal("diogo-sony-fx3-kit"),
      v.literal("verification-failed"),
      v.literal("confirmed-booking"),
    )),
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
      initialBotMessage?: string;
    };
  }> => {
    assertPreparedScenarioLab();
    await assertLabCatalogReady(ctx, { preparedScenario: args.scenarioId !== undefined });
    const threadId = `${PREFIX}lab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let itemNames = args.items ?? [];
    let priceGbp = args.priceGbp;
    let dates = args.dates;
    let startDate = args.startDate;
    let endDate = args.endDate;
    let location = args.location;
    let messages: { role: string; text: string }[] = [];
    let preparedPrice: PreparedListingPrice | null | undefined;
    let selectedProductId = args.productId;
    let simulateVerificationFailure = false;

    // Ensure Diogo’s owner-supplied persona exists before an isolated Lab chat.
    if (args.accountSlug === "diogo") {
      assertPreparedScenarioLab();
      await ctx.runMutation(internal.seed.diogo_profile.seedDiogoProfile, {});
    }
    // Keep all three account pickup points current in the isolated Lab before
    // the draft context is loaded. This mutation refuses any non-Lab backend.
    await ctx.runMutation(internal.renter_bot_lab_actions.ensureLabPickupPoint, {
      accountSlug: args.accountSlug,
    });

    // Scenario selection must load its owner-confirmed item into the isolated
    // catalogue before the UI queries item context or permits a chat turn.
    if (args.scenarioId) {
      assertPreparedScenarioLab();
      if (args.fixtureId || args.productId != null) throw new Error("Prepared examples cannot be combined with another listing or fixture");
      const scenario = renterBotLabScenario(args.scenarioId);
      if (!scenario || scenario.accountSlug !== args.accountSlug) {
        throw new Error("Lab scenario/account mismatch");
      }
      const supportsAlternative = scenario.accountSlug === "dbcinema" && scenario.item.name_canonical === "BMPCC 6K Full Frame";
      const [scenarioPrice, preparedAlternative] = await Promise.all([
        preparedListingPrice(scenario.id, scenario.accountSlug),
        supportsAlternative ? preparedAlternativeSnapshot() : Promise.resolve(null),
      ]);
      preparedPrice = scenarioPrice;
      simulateVerificationFailure = scenario.startStage === "verification_failed";
      const preparedListing = await ensurePreparedScenarioListing(ctx, args.scenarioId, preparedPrice ?? null);
      preparedPrice = preparedListing.snapshot;
      selectedProductId = preparedListing.snapshot.product_id;
      if (supportsAlternative) await ctx.runMutation(internal.renter_bot_lab_actions.ensurePreparedAlternative, {scenarioId:args.scenarioId,snapshot:preparedAlternative});
      itemNames = [preparedListing.itemName];
    }

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
    const lifecycle = simulateVerificationFailure ? "awaiting_verification" : args.lifecycle ?? "inquiry";
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
      items: itemNames.map((name) => ({ name, ...(selectedProductId != null ? { product_id: selectedProductId } : {}) })),
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
        prepared_price: preparedPrice ? preparedOrderPrice(preparedPrice) : preparedPrice,
    });
    const failure = simulateVerificationFailure
      ? await ctx.runMutation(internal.renter_bot_lab_order.__service_simulateVerificationFailure, { thread_id: threadId, referral_code: crypto.randomUUID() })
      : null;
    return {
      threadId,
      context: { items: itemNames, productId: selectedProductId, lifecycle: failure ? "verification_failed" : lifecycle, priceGbp, dates, startDate, endDate, location, ...(failure ? { initialBotMessage: failure.message } : {}) },
    };
  },
});

// Fixture trajectories use the exact same scenario/order initializer from
// inside the already secret-authorized isolated Lab harness.
export const __service_startLiveSession = internalActionOf(startLiveSession);

// Sends ONE renter-side test message into a live Lab session and returns the
// bot's REAL draft reply + rubric score. No send path anywhere in here.
export const sendTestMessage = internalAction({
  args: {
    threadId: v.string(),
    accountSlug: v.string(),
    text: v.string(),
    turnId: v.string(),
    leaseToken: v.string(),
    requestMessageId: v.string(),
    fixtureId: v.optional(v.id("renter_bot_fixtures")),
    runBatchId: v.optional(v.string()),
    triggeredBy: v.optional(v.union(v.literal("harness_batch"), v.literal("lab_ui_manual"))),
    expectedEscalation: v.optional(v.boolean()),
    retryReview: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    draft: string;
    overall_status: "pass" | "fail" | "flag" | "incomplete";
    rubric_results: unknown[];
    assistantContextAdded: boolean;
    needs_review: boolean;
    runId: string;
    productionGuardFlags: unknown;
    generation_error?:CanonicalGenerationError;
    token_usage?: { prompt: number | null; completion: number | null; cached: number | null; cost: number | null } | null;
    tool_stats?: { steps: number; total: number; byName: Record<string, number>; duplicates: number; errors: number; queries?: string[]; calls?: Array<{ call_id?: string; name: string; args: unknown; result?: unknown; error: boolean }> } | null;
    source_receipts?: {
      context_reads: Array<{ tool: string; call_id: string; status: "ok" }>;
      listing_sources: DraftEvidence["listing_sources"];
      pickup_facts: DraftEvidence["pickup_facts"];
      prices: DraftEvidence["prices"];
      stock: DraftEvidence["stock"];
    };
    cost_usd?: number;
    native_quote_diagnostic?:string;
    status: string;
    reason?: string;
    rejectedDraft?: string;
    guard_candidate?: string;
    diagnostic_candidate?: string;
    evidence?: DraftEvidence;
    model_id?: string;
  }> => {
    if (!args.threadId.startsWith(PREFIX)) {
      throw new Error("sendTestMessage only accepts a Lab/probe thread_id");
    }
    const session = await ctx.runQuery(internal.renter_bot_lab_actions.getConversationForThread, { thread_id: args.threadId });
    if (!session || session.account_slug !== args.accountSlug) throw new Error("Lab session/account mismatch");
    const turn = await ctx.runQuery(internal.renter_bot_lab_actions.getTestTurn, { turn_id: args.turnId });
    if (!turn || turn.thread_id !== args.threadId || turn.account_slug !== args.accountSlug || turn.status !== "running" || turn.lease_token !== args.leaseToken ||
        turn.renter_message_id !== args.requestMessageId || turn.renter_text !== args.text) {
      throw new Error("Lab turn lease or message binding is stale");
    }
    const latest = await ctx.runQuery(internal.renter_bot_lab_actions.getLatestMessageForThread, { thread_id: args.threadId });
    if (latest?.message_id !== args.requestMessageId || latest.sender !== "renter" || latest.body_text !== args.text || latest.account_slug !== args.accountSlug) {
      throw new Error("Lab turn no longer matches the latest renter message");
    }

    const startedAt = Date.now();
    // Clear acceptance of a complete basket/date offer is one atomic action,
    // not separate item/date mutations that can leave a partial order behind.
    const completeBasketOutcome = await ctx.runMutation((api as any).renter_bot_lab_order.applyAcceptedCompleteBasketOffer, {
      thread_id: args.threadId,
      request_message_id: args.requestMessageId,
      lab_turn_id: args.turnId,
      lab_lease_token: args.leaseToken,
    });
    const acceptedCompleteBasketOrder = completeBasketOutcome?.ok && completeBasketOutcome.order &&
      (completeBasketOutcome.action_performed || completeBasketOutcome.already_applied) ? completeBasketOutcome : null;
    // Travel compensation remains a distinct transaction and cannot be
    // combined implicitly with an equipment/date acceptance.
    const travelCompensationOutcome = !acceptedCompleteBasketOrder && clearlyAcceptsTravelCompensation(args.text)
      ? await ctx.runMutation(api.renter_bot_lab_order.applyAcceptedTravelCompensation, {
          thread_id: args.threadId,
          request_message_id: args.requestMessageId,
          lab_turn_id: args.turnId,
          lab_lease_token: args.leaseToken,
        })
      : null;
    const acceptedTravelOrder = travelCompensationOutcome?.ok &&
      travelCompensationOutcome.order &&
      (travelCompensationOutcome.action_performed || travelCompensationOutcome.already_applied)
      ? travelCompensationOutcome
      : null;

    // The UI chat and fixture harness enter the same path. Ordinary turns use
    // the shared Gemini generator and production guards; an eligible accepted
    // adjustment uses its verified transaction receipt for a short exact reply.
    const acceptedActionOrder = acceptedCompleteBasketOrder ?? acceptedTravelOrder;
    const actionName = acceptedCompleteBasketOrder ? "apply_accepted_complete_basket_offer" : "apply_accepted_travel_compensation";
    const actionOutcome = acceptedCompleteBasketOrder ? completeBasketOutcome : travelCompensationOutcome;
    const actionCallId = `lab-action:${args.turnId}:${acceptedCompleteBasketOrder ? "complete-basket" : "travel-compensation"}`;
    const deterministicActionDraft: CanonicalDraftResult | null = acceptedActionOrder
      ? (() => {
          const order = acceptedActionOrder.order;
          if (!order) return null;
          const total = order.total_gbp;
          if (total == null || !order.start_date || !order.end_date) return null;
          const lines=order.lines as Array<{name:string;qty:number}>;
          const itemNames = lines.map(line => line.name);
          const quoteItems = lines.map(line => ({ name: line.name, quantity: line.qty }));
          const priceReceipt = {
            names: itemNames,
            kind: "basket" as const,
            total_gbp: total,
            ...(acceptedTravelOrder && order.travel_compensation_gbp > 0 && order.subtotal_gbp != null ? {
              travel_adjustment: {
                base_total_gbp: order.subtotal_gbp,
                amount_gbp: order.travel_compensation_gbp,
                total_gbp: total,
              },
            } : {}),
            days: order.days,
            start_date: order.start_date,
            end_date: order.end_date,
            items: quoteItems,
            call_id: actionCallId,
            source: "lab_order_transaction",
          };
          const toolCall = {
            call_id: actionCallId,
            name: actionName,
            source: "canonical_lab_action_dispatch",
            args: { thread_id: args.threadId, request_message_id: args.requestMessageId },
            result: actionOutcome,
            error: false,
          };
          const actionModelId = "deterministic-lab-order-action-v1";
          const actionText = acceptedCompleteBasketOrder
            ? acceptedCompleteBasketOrder.action_performed
              ? `Done — I've updated the items and rental dates as agreed. The new total is £${total.toFixed(2)}.`
              : `Those items and dates are already updated. The current total is £${total.toFixed(2)}.`
            : acceptedTravelOrder?.action_performed
              ? `Done — I've applied the one-time travel adjustment. The updated rental total is £${total.toFixed(2)}.`
              : `The one-time travel adjustment is already applied. The current rental total is £${total.toFixed(2)}.`;
          return {
            status: "ok",
            draft: actionText,
            draft_intent: "NEGOTIATION",
            confidence: 1,
            model_id: actionModelId,
            cost_usd: 0,
            token_usage: { prompt: 0, completion: 0, cached: 0, cost: 0 },
            tool_stats: {
              steps: 1,
              total: 1,
              byName: { [actionName]: 1 },
              duplicates: 0,
              errors: 0,
              calls: [toolCall],
            },
            facts_claimed: [{
              kind: "price",
              value: `The updated rental total is £${total.toFixed(2)}`,
              sourceTool: actionName,
              sourceCallId: actionCallId,
              verified: true,
            }],
            evidence: {
              model_id: actionModelId,
              stage: "LAB_ORDER_UPDATED",
              cost_usd: 0,
              prices: [priceReceipt],
              stock_request: {
                start_date: order.start_date,
                end_date: order.end_date,
                items: quoteItems,
              },
              stock: [],
            },
          } satisfies CanonicalDraftResult;
        })()
      : null;
    // Interactive chat and fixtures share this one generator/finalizer path.
    const draftResult = deterministicActionDraft ?? await ctx.runAction(
      internal.replyInbox_actions.__service_generateDraft,
      {
        thread_id: args.threadId,
        request_message_id: args.requestMessageId,
        lab_turn_id: args.turnId,
        lab_lease_token: args.leaseToken,
        retry_review: args.retryReview === true,
      },
    );
    const draftRow = await ctx.runQuery(
      internal.renter_bot_harness.getDraftByThread,
      { thread_id: args.threadId },
    );
    const threadContext = await ctx.runQuery(
      internal.replyInbox.getThreadContext,
      { thread_id: args.threadId },
    );

    const rawDraftText = draftResult.status === "ok" ? draftResult.draft ?? "" : "";
    const draftText = rawDraftText;
    const factsClaimed = (draftResult.facts_claimed ?? []).map((f: {
      kind: string;
      value: string;
      sourceTool: string;
      sourceCallId: string;
      verified: boolean;
    }) => ({
      kind: f.kind,
      value: f.value,
      sourceTool: f.sourceTool,
      sourceCallId: f.sourceCallId,
      verified: f.verified,
    }));
    const pendingOwnerChecks=await ctx.runQuery(internal.renter_bot_harness.pendingOwnerChecksForDraft,{thread_id:args.threadId,draft_text:draftText});
    const labPickupPoint = renterBotLabPickupPoint(args.accountSlug);
    const pickupArea = threadContext?.pickup_area?.trim() || labPickupPoint?.area || null;
    const pickupAddress = threadContext?.pickup_address?.trim() || labPickupPoint?.address || null;
    const rentalChargeGbp = threadContext?.gross_paid_gbp != null
      ? Math.max(0, threadContext.gross_paid_gbp - (threadContext.delivery_fee_gbp ?? 0))
      : null;
    const kitEvidence = (draftResult.evidence?.listing_sources ?? []).flatMap((source) => {
      if (source.account_slug !== args.accountSlug || !source.kit_contents?.length ||
          !source.kit_contents_source?.trim() || source.kit_contents_recorded_at == null ||
          source.kit_contents_recorded_at > source.checked_at) return [];
      return [{
        names: [source.listing_name, source.inventory_name].filter((name): name is string => !!name),
        contents: source.kit_contents,
        account_slug: source.account_slug,
        product_id: source.product_id,
        requested_item: true,
        source: source.kit_contents_source,
        recorded_at: source.kit_contents_recorded_at,
      }];
    });
    const rubric = draftResult.status === "skipped"
      ? scoreSkippedGeneration(draftResult.reason, args.expectedEscalation === true)
      : scoreDraft({
      pendingOwnerChecks:pendingOwnerChecks??undefined,
      accountSlug: args.accountSlug,
      draftText,
      factsClaimed,
      serverVerifiedAction: deterministicActionDraft !== null,
      productionFlags: draftResult.flags??draftResult.review?.flags,
      priceEvidence:draftResult.evidence?.prices,
      verifiedDeliveryFeeGbp:draftResult.verified_delivery_fee_gbp,
        bookingRecord:draftResult.evidence?.booking_record,
      replacementValueComparisons:draftResult.evidence?.replacement_value_comparisons,
      budgetPriceChecks:draftResult.evidence?.budget_price_checks,
      kitEvidence,
      priceRequest:draftResult.evidence?.stock_request,
      lastRenterMessage:args.text,
      conversationHistory: (threadContext?.messages ?? []) as { role: "owner" | "renter"; content: string }[],
      pickupArea,
      pickupReason: verifiedPickupReasonForSingleListing(
        draftResult.evidence?.listing_sources,
        draftResult.evidence?.pickup_facts,
        args.accountSlug,
      ),
      pickupAddress,
      pickupPrivacySources: threadContext?.pickup_privacy_sources ?? (pickupAddress ? [pickupAddress] : []),
      pickupConfirmed: Boolean(threadContext?.rental_stage?.booking_confirmed),
      rentalChargeGbp,
      rentalStage: threadContext?.rental_stage?.stage ?? null,
      });

    const sourceReceipts = draftResult.evidence ? {
      context_reads: [{ tool: "get_listing_context", call_id: "prefetch:listing-context", status: "ok" as const }],
      listing_sources: draftResult.evidence.listing_sources ?? [],
      pickup_facts: draftResult.evidence.pickup_facts ?? [],
      prices: draftResult.evidence.prices ?? [],
      stock: draftResult.evidence.stock ?? [],
    } : undefined;
    const recoveredAmendmentReply = draftResult.status === "ok" && Boolean(draftText.trim()) &&
      (draftResult.flags ?? []).some((flag: { type?: string; action?: string }) =>
        flag.type === "AMENDMENT_CONFIRMATION_RECOVERED" && flag.action === "rewritten");
    const generationFailed = !recoveredAmendmentReply && (
      isCanonicalGenerationFailure(draftResult) || isFailedLabReply({
        overall_status: rubric.overall_status,
        draft_text: draftText,
        rubric_results: rubric.results,
      })
    );
    const runId: string = await ctx.runMutation(
      internal.renter_bot_harness.insertRun,
      {
        expected_message_id: args.requestMessageId,
        lab_turn_id: args.turnId,
        lab_lease_token: args.leaseToken,
        generation_status: generationFailed ? "failed" : "complete",
        failure_reason: generationFailed ? draftResult.reason : undefined,
        candidate_text: typeof draftResult.guard_candidate === "string" ? draftResult.guard_candidate :
          typeof draftResult.rejectedDraft === "string" ? draftResult.rejectedDraft :
            typeof draftResult.diagnostic_candidate === "string" ? draftResult.diagnostic_candidate : undefined,
        production_guard_flags: draftResult.flags ?? draftResult.review?.flags ?? [],
        tool_stats: draftResult.tool_stats,
        token_usage: draftResult.token_usage && typeof draftResult.token_usage === "object" ? {
          ...(typeof draftResult.token_usage.prompt === "number" ? { prompt: draftResult.token_usage.prompt } : {}),
          ...(typeof draftResult.token_usage.cached === "number" ? { cached: draftResult.token_usage.cached } : {}),
          ...(typeof draftResult.token_usage.completion === "number" ? { completion: draftResult.token_usage.completion } : {}),
          ...(typeof draftResult.token_usage.cost === "number" ? { cost: draftResult.token_usage.cost } : {}),
        } : undefined,
        source_receipts: sourceReceipts,
        session_thread_id: args.threadId,
        fixture_id: args.fixtureId,
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
        triggered_by: args.triggeredBy ?? "lab_ui_manual",
        run_at: startedAt,
        duration_ms: Date.now() - startedAt,
        cost_usd: draftResult.cost_usd??draftResult.generation_error?.cost_usd,
        generation_error:draftResult.generation_error,
        native_quote_diagnostic:draftResult.native_quote_diagnostic,
      },
    );

    // A failed candidate is diagnostic output, not a simulated message the
    // renter could have received. A non-blocking flag remains visible in the
    // run record while the final guarded draft can continue the Lab dialogue.
    const assistantContextAdded = Boolean(draftText) && rubric.overall_status !== "fail";
    if (assistantContextAdded) {
      await ctx.runMutation(internal.renter_bot_lab_actions.appendAssistantMessage, {
        thread_id: args.threadId, account_slug: args.accountSlug, text: draftText, run_id: runId,
        expected_message_id: args.requestMessageId, turn_id: args.turnId, lease_token: args.leaseToken,
        ...(draftResult.evidence ? {draft_evidence:draftResult.evidence} : {}),
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
      diagnostic_candidate: draftResult.diagnostic_candidate,
      evidence: draftResult.evidence,
      model_id: draftResult.model_id,
      draft: draftText,
      overall_status: rubric.overall_status,
      rubric_results: rubric.results,
      assistantContextAdded,
      // Corrections remain in the run diagnostics, but a fully corrected
      // reply is not a pending review in the conversation itself.
      needs_review: renterBotNeedsHumanReview(rubric.results, draftResult.flags ?? draftResult.review?.flags ?? []),
      runId,
      productionGuardFlags: draftResult.flags ?? draftResult.review?.flags ?? [],
      generation_error:draftResult.generation_error,
      token_usage:draftResult.token_usage,
      tool_stats:draftResult.tool_stats,
      source_receipts:sourceReceipts,
      cost_usd:draftResult.cost_usd??draftResult.generation_error?.cost_usd,
      native_quote_diagnostic:draftResult.native_quote_diagnostic,
    };
  },
});

type RunLabTurnArgs = {
  auth_marker: string;
  threadId: string;
  accountSlug: string;
  text: string;
  turnId: string;
  requestMessageId?: string;
  fixtureId?: Id<"renter_bot_fixtures">;
  runBatchId?: string;
  triggeredBy?: "harness_batch" | "lab_ui_manual";
  expectedEscalation?: boolean;
  readinessProbe?: boolean;
};

const runLabTurnValidators = {
  auth_marker: v.string(),
  threadId: v.string(),
  accountSlug: v.string(),
  text: v.string(),
  turnId: v.string(),
  requestMessageId: v.optional(v.string()),
  fixtureId: v.optional(v.id("renter_bot_fixtures")),
  runBatchId: v.optional(v.string()),
  triggeredBy: v.optional(v.union(v.literal("harness_batch"), v.literal("lab_ui_manual"))),
  expectedEscalation: v.optional(v.boolean()),
  readinessProbe: v.optional(v.boolean()),
};

async function executeLabTurn(ctx: ActionCtx, args: RunLabTurnArgs): Promise<LabTurnExecutionResult> {
  assertLabApiAuthorization(args.auth_marker);
  if (args.readinessProbe === true) return { status: "ready" };
  await assertLabCatalogReady(ctx, { preparedScenario: args.threadId.startsWith(PREFIX) });
  if (!args.threadId.startsWith(PREFIX)) throw new Error("Only isolated Lab threads accept generated turns");
  if (!/^[A-Za-z0-9_-]{8,96}$/.test(args.turnId)) throw new Error("Invalid Lab turn id");
  if (!args.text.trim() || args.text.length > 6000) throw new Error("Test message must contain 1–6000 characters");

  const session: Doc<"conversations"> | null = await ctx.runQuery(internal.renter_bot_lab_actions.getConversationForThread, { thread_id: args.threadId });
  if (!session || session.account_slug !== args.accountSlug) throw new Error("Lab session/account mismatch");
  const leaseToken = crypto.randomUUID();
  const claim: LabTurnClaimResult = await ctx.runMutation(internal.renter_bot_lab_actions.__service_claimTestTurn, {
    turn_id: args.turnId,
    thread_id: args.threadId,
    account_slug: args.accountSlug,
    renter_text: args.text,
    request_message_id: args.requestMessageId,
    lease_token: leaseToken,
  });
  const requestMessageId = claim.requestMessageId;
  if (claim.status === "running") return { status: "running", requestMessageId, turnId: args.turnId };
  if (claim.status === "complete") {
    const saved: Doc<"renter_bot_harness_runs"> | null = await ctx.runQuery(internal.renter_bot_harness.getRunForLabTurn, { lab_turn_id: args.turnId });
    if (!saved || saved.session_thread_id !== args.threadId || saved.account_slug !== args.accountSlug) {
      throw new Error("Completed Lab turn result is missing or mismatched");
    }
    return {
      status: saved.generation_status === "failed" ? "skipped" : saved.draft_text ? "ok" : "skipped",
      requestMessageId,
      turnId: args.turnId,
      draft: saved.draft_text,
      overall_status: saved.overall_status,
      rubric_results: saved.rubric_results,
      assistantContextAdded: Boolean(saved.draft_text),
      needs_review: renterBotNeedsHumanReview(saved.rubric_results, saved.production_guard_flags),
      runId: saved._id,
      reason: saved.failure_reason,
      generation_error: saved.generation_error,
      model_id: saved.model_id,
      token_usage: saved.token_usage,
      tool_stats: saved.tool_stats,
      source_receipts: saved.source_receipts,
      candidate_text: saved.candidate_text,
      productionGuardFlags: saved.production_guard_flags ?? [],
      evidence: saved.draft_evidence,
    } satisfies LabTurnExecutionResult;
  }

  // This boundary wraps the complete sendTestMessage/finalization action.
  // Endpoint failures are already reported by generateDraft; an exception
  // escaping this action is response processing until telemetry is saved.
  let failureStage: "response_processing" | "generation_telemetry" = "response_processing";
  try {
    const result: LabSendTestMessageResult = await ctx.runAction(internal.renter_bot_lab_actions.sendTestMessage, {
      threadId: args.threadId,
      accountSlug: args.accountSlug,
      text: args.text,
      turnId: args.turnId,
      leaseToken: claim.leaseToken,
      retryReview: claim.retryReview === true,
      requestMessageId,
      fixtureId: args.fixtureId,
      runBatchId: args.runBatchId,
      triggeredBy: args.triggeredBy ?? "lab_ui_manual",
      expectedEscalation: args.expectedEscalation,
    });
    if (result.status !== "ok" && result.status !== "skipped") {
      failureStage = "response_processing";
      throw new Error("Lab finalizer returned an unsupported turn status");
    }
    const failedWithoutReply = isFailedLabReply({
      generation_status: isCanonicalGenerationFailure(result) ? "failed" : undefined,
      overall_status: result.overall_status,
      draft_text: result.draft,
      rubric_results: result.rubric_results,
    });
    const failureReason = failedWithoutReply
      ? result.reason ?? result.generation_error?.error_code ?? "no_reply_generated"
      : undefined;
    failureStage = "generation_telemetry";
    await ctx.runMutation(internal.renter_bot_lab_actions.__service_finishTestTurn, {
      turn_id: args.turnId,
      thread_id: args.threadId,
      account_slug: args.accountSlug,
      lease_token: claim.leaseToken,
      ...(failureReason ? { failure_reason: failureReason } : {}),
    });
    return { ...result, status: result.status, requestMessageId, turnId: args.turnId } satisfies LabTurnExecutionResult;
  } catch (error) {
    const generation_error = canonicalGenerationException(
      error,
      "context",
      500,
      failureStage,
    );
    const failureReason = `canonical_generation_${generation_error.error_code}`;
    let runId: Id<"renter_bot_harness_runs"> | undefined;
    try {
      runId = await ctx.runMutation(internal.renter_bot_harness.insertRun, {
        expected_message_id: requestMessageId,
        lab_turn_id: args.turnId,
        lab_lease_token: claim.leaseToken,
        generation_status: "failed",
        failure_reason: failureReason,
        generation_error,
        session_thread_id: args.threadId,
        fixture_id: args.fixtureId,
        run_batch_id: args.runBatchId,
        account_slug: args.accountSlug,
        draft_text: "",
        model_id: "unknown",
        filter_violations: [],
        rubric_results: [{ category: "generation", status: "flag", detail: "The Lab turn failed before a complete result was saved." }],
        overall_status: "flag",
        triggered_by: args.triggeredBy ?? "lab_ui_manual",
        run_at: Date.now(),
      });
    } catch { /* a stale lease must not create a failure record for newer work */ }
    try {
      await ctx.runMutation(internal.renter_bot_lab_actions.__service_finishTestTurn, {
        turn_id: args.turnId,
        thread_id: args.threadId,
        account_slug: args.accountSlug,
        lease_token: claim.leaseToken,
        failure_reason: failureReason,
      });
    } catch { /* the transcript still contains the renter message for retry */ }
    return {
      status: "skipped",
      requestMessageId,
      turnId: args.turnId,
      reason: failureReason,
      generation_error,
      draft: "",
      overall_status: "flag",
      rubric_results: [{ category: "generation", status: "flag", detail: "The Lab turn failed before a complete result was saved." }],
      assistantContextAdded: false,
      needs_review: false,
      runId,
    } satisfies LabTurnExecutionResult;
  }
}

/** The sole public Lab generation/finalization entry. The capability is never sent to the browser. */
export const runTestTurn = rawAction({ args: runLabTurnValidators, handler: executeLabTurn });
export const __service_runTestTurn = internalAction({ args: runLabTurnValidators, handler: executeLabTurn });

// Closing a Lab session must not remove other operators' simulations.
export const endLiveSession = action({
  args: { threadId: v.string() },
  handler: async (ctx, args): Promise<{ removed: number }> =>
    ctx.runMutation(internal.renter_bot_probe.__service_cleanup, { thread_id: args.threadId }),
});

export const runFixtureBatch = action({
  args: { auth_marker: v.string(), fixtureIds: v.optional(v.array(v.id("renter_bot_fixtures"))) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    runBatchId: string;
    results: Array<{ fixtureId: string; overall_status: string }>;
  }> => {
    assertLabApiAuthorization(args.auth_marker);
    return ctx.runAction(internal.renter_bot_harness.__service_runBatch, args);
  },
});
