import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

/** W22 Insurance Claims — list recent claims, optional account filter */
export const list = query({
  args: { accountSlug: v.optional(v.string()) },
  handler: async (ctx, { accountSlug }) => {
    let rows = accountSlug
      ? await ctx.db
          .query("insurance_claims")
          .withIndex("by_account", (q) => q.eq("account_slug", accountSlug))
          .order("desc")
          .take(50)
      : await ctx.db
          .query("insurance_claims")
          .withIndex("by_claim_date")
          .order("desc")
          .take(50);
    return rows.map((r) => ({
      id: r._id,
      accountSlug: r.account_slug,
      itemNameCanonical: r.item_name_canonical,
      amountGbp: r.amount_gbp,
      claimDate: r.claim_date,
      description: r.description,
      status: r.status,
      stage: (r as any).stage ?? null,
      stageHistory: (r as any).stage_history ?? [],
      payoutAmountGbp: (r as any).payout_amount_gbp ?? null,
      creditedToMonth: (r as any).credited_to_month ?? null,
      creditedAt: (r as any).credited_at ?? null,
      createdAt: r.created_at,
    }));
  },
});

/** Create a new insurance claim */
export const create = mutation({
  args: {
    account_slug: v.optional(v.string()),
    item_id: v.optional(v.id("items")),
    item_name_canonical: v.optional(v.string()),
    amount_gbp: v.number(),
    claim_date: v.string(),
    description: v.optional(v.string()),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    let accountId: Id<"accounts"> | undefined;
    if (args.account_slug) {
      const acc = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) => q.eq("slug", args.account_slug as string))
        .first();
      accountId = acc?._id;
    }
    const id = await ctx.db.insert("insurance_claims", {
      account_slug: args.account_slug,
      account_id: accountId,
      item_id: args.item_id,
      item_name_canonical: args.item_name_canonical,
      amount_gbp: args.amount_gbp,
      claim_date: args.claim_date,
      description: args.description,
      status: args.status,
      created_at: Date.now(),
    });
    return { ok: true, id };
  },
});

/** Update claim fields */
export const update = mutation({
  args: {
    id: v.id("insurance_claims"),
    amount_gbp: v.optional(v.number()),
    claim_date: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    item_name_canonical: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...fields }) => {
    const patch: Record<string, unknown> = {};
    if (fields.amount_gbp !== undefined) patch.amount_gbp = fields.amount_gbp;
    if (fields.claim_date !== undefined) patch.claim_date = fields.claim_date;
    if (fields.description !== undefined) patch.description = fields.description;
    if (fields.status !== undefined) patch.status = fields.status;
    if (fields.item_name_canonical !== undefined) patch.item_name_canonical = fields.item_name_canonical;
    await ctx.db.patch(id, patch);
    return { ok: true };
  },
});

/** Delete a claim */
export const remove = mutation({
  args: { id: v.id("insurance_claims") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
    return { ok: true };
  },
});


// ───────────────────────────────────────────────────────────────────
// Pipeline stages (added 2026-05-14):
//   case_opened → in_for_repair → quote_received → payout_confirmation → added_to_revenue
//   (any → denied, terminal)
// ───────────────────────────────────────────────────────────────────

const STAGES = [
  "case_opened",
  "in_for_repair",
  "quote_received",
  "payout_confirmation",
  "added_to_revenue",
] as const;

type Stage = (typeof STAGES)[number] | "denied";

function nextStage(s: Stage): Stage | null {
  const i = (STAGES as readonly string[]).indexOf(s);
  if (i < 0 || i >= STAGES.length - 1) return null;
  return STAGES[i + 1];
}

function prevStage(s: Stage): Stage | null {
  const i = (STAGES as readonly string[]).indexOf(s);
  if (i <= 0) return null;
  return STAGES[i - 1];
}

/** Move a claim forward through the pipeline. No-op at terminal stages. */
export const advanceStage = mutation({
  args: { id: v.id("insurance_claims") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row) throw new Error("claim not found");
    const current = (row.stage as Stage | undefined) ?? "case_opened";
    if (current === "added_to_revenue" || current === "denied") {
      return { ok: false, reason: "terminal", stage: current };
    }
    const next = nextStage(current);
    if (!next) return { ok: false, reason: "no next stage", stage: current };
    const history = [...(row.stage_history ?? []), { stage: next, at: Date.now() }];
    await ctx.db.patch(id, { stage: next, stage_history: history });
    return { ok: true, stage: next };
  },
});

/** Move a claim backward (undo a wrong advance). */
export const revertStage = mutation({
  args: { id: v.id("insurance_claims") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row) throw new Error("claim not found");
    const current = (row.stage as Stage | undefined) ?? "case_opened";
    const prev = prevStage(current);
    if (!prev) return { ok: false, reason: "already at start", stage: current };
    const history = [...(row.stage_history ?? []), { stage: prev, at: Date.now() }];
    // If reverting from added_to_revenue, clear the credit so chart updates.
    const extra: Record<string, unknown> = {};
    if (current === "added_to_revenue") {
      extra.credited_to_month = undefined;
      extra.credited_at = undefined;
    }
    await ctx.db.patch(id, { stage: prev, stage_history: history, ...extra });
    return { ok: true, stage: prev };
  },
});

/** Mark a claim denied (terminal). */
export const markDenied = mutation({
  args: { id: v.id("insurance_claims") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row) throw new Error("claim not found");
    const history = [...(row.stage_history ?? []), { stage: "denied", at: Date.now() }];
    await ctx.db.patch(id, { stage: "denied", status: "denied", stage_history: history });
    return { ok: true };
  },
});

/**
 * Set the actual payout amount (typically called once the insurer confirms).
 * Independent of stage so the owner can refine the figure mid-pipeline.
 */
export const setPayout = mutation({
  args: {
    id: v.id("insurance_claims"),
    payout_amount_gbp: v.number(),
  },
  handler: async (ctx, { id, payout_amount_gbp }) => {
    await ctx.db.patch(id, { payout_amount_gbp });
    return { ok: true };
  },
});

/**
 * Final step: credit the payout to a specific month on the lifetime chart.
 * Transitions the claim to "added_to_revenue" and marks status="settled".
 * The lifetime chart's "Claim Recovery" series sources from credited claims.
 */
export const creditToRevenue = mutation({
  args: {
    id: v.id("insurance_claims"),
    month: v.string(),                 // YYYY-MM
    payout_amount_gbp: v.optional(v.number()),
  },
  handler: async (ctx, { id, month, payout_amount_gbp }) => {
    const row = await ctx.db.get(id);
    if (!row) throw new Error("claim not found");
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new Error("month must be YYYY-MM");
    }
    const now = Date.now();
    const history = [...(row.stage_history ?? []), { stage: "added_to_revenue", at: now }];
    const patch: Record<string, unknown> = {
      stage: "added_to_revenue",
      status: "settled",
      credited_to_month: month,
      credited_at: now,
      stage_history: history,
    };
    if (payout_amount_gbp !== undefined) patch.payout_amount_gbp = payout_amount_gbp;
    await ctx.db.patch(id, patch);
    return { ok: true };
  },
});

/**
 * One-shot backfill: derive `stage` from legacy `status` for rows missing it.
 *   status="open"    → stage="case_opened"
 *   status="settled" → stage="added_to_revenue"  (assume already credited)
 *   status="denied"  → stage="denied"
 */
export const backfillStages = mutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("insurance_claims").collect();
    let patched = 0;
    for (const r of rows) {
      if (r.stage) continue;
      let stage: Stage;
      if (r.status === "denied") stage = "denied";
      else if (r.status === "settled") stage = "added_to_revenue";
      else stage = "case_opened";
      const history = [{ stage, at: r.created_at }];
      await ctx.db.patch(r._id, { stage, stage_history: history });
      patched++;
    }
    return { total: rows.length, patched };
  },
});
