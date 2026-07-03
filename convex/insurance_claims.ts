import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { renterMaps, renterForReservation } from "./lib/renters";

// Canonical case pipeline — MUST match InsuranceClaimsDrawer.PIPELINE.
const STAGES = [
  "case_opened",
  "in_for_repair",
  "quote_received",
  "payout_confirmation",
  "added_to_revenue",
] as const;
type Stage = (typeof STAGES)[number] | "denied";

// Legacy rows stored progress in `status`; derive a stage for them.
function stageOf(c: { stage?: string; status?: string }): Stage {
  if (c.stage && (STAGES as readonly string[]).includes(c.stage)) return c.stage as Stage;
  if (c.stage === "denied" || c.status === "denied") return "denied";
  if (c.status === "settled" || c.status === "added_to_revenue") return "added_to_revenue";
  return "case_opened";
}
const statusForStage = (s: Stage): string =>
  s === "denied" ? "denied" : s === "added_to_revenue" ? "settled" : "open";

/** W22 Insurance/Case claims — list recent, optional account filter. */
export const list = query({
  args: { accountSlug: v.optional(v.string()) },
  handler: async (ctx, { accountSlug }) => {
    const rows = accountSlug
      ? await ctx.db.query("insurance_claims").withIndex("by_account", (q) => q.eq("account_slug", accountSlug)).order("desc").take(50)
      : await ctx.db.query("insurance_claims").withIndex("by_claim_date").order("desc").take(50);
    return rows.map((r) => ({
      id: r._id,
      accountSlug: r.account_slug,
      itemNameCanonical: r.item_name_canonical,
      renterName: r.renter_name ?? null,
      amountGbp: r.amount_gbp,
      claimDate: r.claim_date,
      description: r.description,
      status: r.status,
      stage: stageOf(r),
      payoutAmountGbp: r.payout_amount_gbp ?? null,
      creditedToMonth: r.credited_to_month ?? null,
      creditedAt: r.credited_at ?? null,
      createdAt: r.created_at,
    }));
  },
});

/** Create a claim/case directly (manual). */
export const create = mutation({
  args: {
    account_slug: v.optional(v.string()),
    item_id: v.optional(v.id("items")),
    item_name_canonical: v.optional(v.string()),
    amount_gbp: v.number(),
    claim_date: v.string(),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    stage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let accountId: Id<"accounts"> | undefined;
    if (args.account_slug) {
      const acc = await ctx.db.query("accounts").withIndex("by_slug", (q) => q.eq("slug", args.account_slug as string)).first();
      accountId = acc?._id;
    }
    const stage = (args.stage as Stage) ?? "case_opened";
    const id = await ctx.db.insert("insurance_claims", {
      account_slug: args.account_slug,
      account_id: accountId,
      item_id: args.item_id,
      item_name_canonical: args.item_name_canonical,
      amount_gbp: args.amount_gbp,
      claim_date: args.claim_date,
      description: args.description,
      status: args.status ?? statusForStage(stage),
      stage,
      created_at: Date.now(),
    });
    return { ok: true, id };
  },
});

/**
 * Open a CASE from a Return-Hub rental. Creates a stage-1 ("case_opened") claim
 * linked to the reservation, records the projected value, FLAGS (blacklists) the
 * renter, and marks the rental(s) out of the Return Hub via `case_open`.
 */
export const openCaseFromReservation = mutation({
  args: {
    reservationId: v.id("reservations"),
    memberIds: v.optional(v.array(v.id("reservations"))),
    projected_value_gbp: v.number(),
    description: v.optional(v.string()),
    // Accept raw strings: auto-detected return-hub item ids are resolved from
    // reservations and don't always exist in the `items` table. We resolve/skip
    // non-inventory ids below instead of letting a v.id("items") validator
    // silently reject the whole mutation.
    repair_item_ids: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { reservationId, memberIds, projected_value_gbp, description, repair_item_ids }) => {
    const res = await ctx.db.get(reservationId);
    if (!res) throw new Error("Reservation not found");
    // Keep only ids that actually resolve to an `items` doc; drop the rest so a
    // stray reservation-derived id can't poison the claim write.
    let repairItemIds: Id<"items">[] | undefined;
    if (repair_item_ids && repair_item_ids.length) {
      const normalizedId = ctx.db.normalizeId.bind(ctx.db);
      const resolved: Id<"items">[] = [];
      for (const raw of repair_item_ids) {
        // normalizeId returns null for strings that aren't a valid id for the
        // `items` table (wrong format or wrong table) — no throw.
        const id = normalizedId("items", raw);
        if (!id) continue;
        const doc = await ctx.db.get(id);
        if (doc) resolved.push(id);
      }
      repairItemIds = resolved.length ? resolved : undefined;
    }
    const itemName = (res.items ?? [])[0]?.item_name ?? null;
    const itemId = ((res.resolved_items ?? [])[0]?.item_id ?? (res.expanded_items ?? [])[0]?.item_id) as
      | Id<"items">
      | undefined;
    let accountId: Id<"accounts"> | undefined;
    if (res.account_slug) {
      const acc = await ctx.db.query("accounts").withIndex("by_slug", (q) => q.eq("slug", res.account_slug as string)).first();
      accountId = acc?._id;
    }
    const today = new Date().toISOString().slice(0, 10);
    const claimId = await ctx.db.insert("insurance_claims", {
      account_slug: res.account_slug,
      account_id: accountId,
      item_id: itemId,
      item_name_canonical: itemName ?? undefined,
      renter_name: res.renter_name ?? undefined,
      reservation_id: reservationId,
      amount_gbp: projected_value_gbp,
      claim_date: today,
      description,
      status: "open",
      stage: "case_opened",
      opened_from: "return_hub",
      repair_item_ids: repairItemIds,
      created_at: Date.now(),
    });

    // Auto-flag (blacklist) the renter — a damage/loss case is the strongest
    // flagging consequence, and surfaces on their next request via the alert.
    const maps = await renterMaps(ctx);
    const renterDoc = await renterForReservation(ctx, res, maps);
    if (renterDoc) {
      const reason = `Case opened: ${itemName ?? "item"} (£${Math.round(projected_value_gbp)} projected)`;
      const log = [
        ...(renterDoc.note_log ?? []),
        { text: reason, at: Date.now(), source: "open-case" },
      ];
      await ctx.db.patch(renterDoc._id, {
        blacklisted: true,
        blacklist: true,
        blacklist_reason: reason,
        blacklisted_at: Date.now(),
        note_log: log,
      });
      await ctx.db.patch(claimId, { renter_id: renterDoc._id });
    }

    // Pull the rental(s) out of the Return Hub.
    const ids = Array.from(new Set([reservationId, ...(memberIds ?? [])]));
    for (const id of ids) {
      await ctx.db.patch(id, { case_open: true, case_id: claimId });
    }

    // The Return Hub reads the mv_due_returns cache (refreshed hourly by the
    // cron). Without an immediate refresh the cased rental keeps showing in the
    // hub for up to an hour, so opening a case LOOKS like it did nothing. Refresh
    // now so the rental leaves the hub the moment the case is opened.
    await ctx.scheduler.runAfter(0, internal.mv.due_returns.refresh, {});

    return { ok: true, claimId, flaggedRenter: renterDoc?.display_name ?? null };
  },
});

/** Update claim fields. */
export const update = mutation({
  args: {
    id: v.id("insurance_claims"),
    amount_gbp: v.optional(v.number()),
    claim_date: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    item_name_canonical: v.optional(v.string()),
    /** Replace which units the case holds out of stock (empty array = none). */
    repair_item_ids: v.optional(v.array(v.id("items"))),
  },
  handler: async (ctx, { id, ...fields }) => {
    const patch: Record<string, unknown> = {};
    for (const k of ["amount_gbp", "claim_date", "description", "status", "item_name_canonical", "repair_item_ids"] as const) {
      if (fields[k] !== undefined) patch[k] = fields[k];
    }
    await ctx.db.patch(id, patch);
    return { ok: true };
  },
});

export const advanceStage = mutation({
  args: { id: v.id("insurance_claims") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row) return;
    const cur = stageOf(row);
    if (cur === "denied" || cur === "added_to_revenue") return;
    const idx = STAGES.indexOf(cur as (typeof STAGES)[number]);
    const next = STAGES[Math.min(STAGES.length - 1, idx + 1)];
    await ctx.db.patch(id, { stage: next, status: statusForStage(next) });
  },
});

export const revertStage = mutation({
  args: { id: v.id("insurance_claims") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row) return;
    const cur = stageOf(row);
    if (cur === "denied") {
      await ctx.db.patch(id, { stage: "case_opened", status: "open" });
      return;
    }
    const idx = Math.max(0, STAGES.indexOf(cur as (typeof STAGES)[number]));
    const prev = STAGES[Math.max(0, idx - 1)];
    await ctx.db.patch(id, { stage: prev, status: statusForStage(prev) });
  },
});

export const markDenied = mutation({
  args: { id: v.id("insurance_claims") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { stage: "denied", status: "denied" });
  },
});

export const creditToRevenue = mutation({
  args: { id: v.id("insurance_claims"), credited_to_month: v.string(), payout_amount_gbp: v.number() },
  handler: async (ctx, { id, credited_to_month, payout_amount_gbp }) => {
    await ctx.db.patch(id, {
      stage: "added_to_revenue",
      status: "settled",
      credited_to_month,
      payout_amount_gbp,
      credited_at: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("insurance_claims") },
  handler: async (ctx, { id }) => {
    // Release any rentals this case pulled out of the Return Hub.
    const linked = (await ctx.db.query("reservations").collect()).filter(
      (r) => (r as { case_id?: string }).case_id === (id as string),
    );
    for (const r of linked) await ctx.db.patch(r._id, { case_open: undefined, case_id: undefined });
    await ctx.db.delete(id);
    // Same reason as openCaseFromReservation: refresh the Return Hub cache now so
    // the released rental reappears immediately instead of after the hourly cron.
    await ctx.scheduler.runAfter(0, internal.mv.due_returns.refresh, {});
    return { ok: true };
  },
});
