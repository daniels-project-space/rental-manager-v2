/**
 * Wave 4.6 — Data-layer entry point for browser-driven Hygglo actions.
 *
 * The Mastra tools in `dashboard-tools.ts` call into this module ONLY.
 * Direct calls into `@/lib/hygglo-ui` from outside this file are
 * disallowed (mirrors the Wave 4.5 hygglo-write chokepoint pattern).
 */
import "server-only";
import { dispatchUiAction, type DispatchEnvelope } from "@/lib/hygglo-ui";
import { checkDailyCap } from "./cost_guards";
import { getConvex } from "./client";
import { api } from "@/../convex/_generated/api";

type Slug = "dbcinema" | "leo";

export interface UiActionEnvelope {
  ok: boolean;
  action: string;
  accountSlug: Slug;
  orderId?: string;
  correlationId?: string;
  mode: "shadow" | "live" | "skipped" | "failed" | "queued";
  strategyUsed?: string;
  screenshotUrl?: string;
  confirmationText?: string | null;
  caveats: string[];
  error?: string;
  spendUsdToday?: number;
}

async function dispatchWithGuards(
  accountSlug: Slug,
  action: string,
  orderId: string | undefined,
  args: Record<string, unknown> | undefined,
): Promise<UiActionEnvelope> {
  const caveats: string[] = [];

  // 1. Cost cap.
  const cost = await checkDailyCap(accountSlug);
  if (!cost.allowed) {
    return {
      ok: false,
      action,
      accountSlug,
      orderId,
      mode: "skipped",
      caveats: ["daily_cost_cap_reached"],
      error: `Today's UI-automation spend for ${accountSlug} is $${cost.spendUsd.toFixed(2)} (cap $${cost.capUsd}). Override with HYGGLO_UI_COST_OVERRIDE=true.`,
      spendUsdToday: cost.spendUsd,
    };
  }
  if (cost.reason === "override") caveats.push("cost_override_active");

  // 2. Shadow-mode caveat for the consumer.
  const shadowDefault = (process.env.HYGGLO_UI_SHADOW_MODE ?? "true").toLowerCase() !== "false";
  const liveFlag = (process.env[`HYGGLO_UI_LIVE_${action.toUpperCase()}`] ?? "false").toLowerCase() === "true";
  if (shadowDefault && !liveFlag) caveats.push("shadow_mode");

  const envelope: DispatchEnvelope = await dispatchUiAction({
    accountSlug,
    action,
    orderId,
    args,
  });

  if (envelope.status === "skipped") {
    return { ok: false, action, accountSlug, orderId, mode: "skipped", caveats: [...caveats, "read_only_mode"], error: envelope.reason };
  }
  if (envelope.status === "queued") {
    return { ok: true, action, accountSlug, orderId, mode: "queued", caveats };
  }
  if (envelope.status === "failed") {
    return { ok: false, action, accountSlug, orderId, mode: "failed", caveats, error: envelope.error };
  }
  const r = envelope.result;
  return {
    ok: r.ok,
    action,
    accountSlug,
    orderId,
    correlationId: r.correlationId,
    mode: r.status === "live_complete" ? "live" : r.status === "shadow_complete" ? "shadow" : "failed",
    strategyUsed: r.strategyUsed,
    screenshotUrl: r.screenshotUrl,
    confirmationText: r.hyggloConfirmationText,
    caveats,
    error: r.errorMessage,
  };
}

// Per-action public helpers consumed by dashboard-tools.

export const acceptOrderUi = (i: { accountSlug: Slug; orderId: string }) =>
  dispatchWithGuards(i.accountSlug, "accept", i.orderId, {});

export const declineOrderUi = (i: { accountSlug: Slug; orderId: string; reason?: string }) =>
  dispatchWithGuards(i.accountSlug, "decline", i.orderId, { reason: i.reason });

export const addItemToOrder = (i: {
  accountSlug: Slug; orderId: string; itemName: string; quantity?: number; days?: number;
}) => dispatchWithGuards(i.accountSlug, "add_item", i.orderId, {
  itemName: i.itemName, quantity: i.quantity ?? 1, days: i.days ?? 1,
});

export const removeItemFromOrder = (i: { accountSlug: Slug; orderId: string; itemName: string }) =>
  dispatchWithGuards(i.accountSlug, "remove_item", i.orderId, { itemName: i.itemName });

export const applyOrderDiscount = (i: {
  accountSlug: Slug; orderId: string; percentOff?: number; newOwnerEarningsGbp?: number; reason?: string;
}) => {
  if (i.percentOff != null && i.newOwnerEarningsGbp != null) {
    return Promise.resolve<UiActionEnvelope>({
      ok: false, action: "apply_discount", accountSlug: i.accountSlug, orderId: i.orderId,
      mode: "failed", caveats: [], error: "pass percentOff OR newOwnerEarningsGbp, not both",
    });
  }
  return dispatchWithGuards(i.accountSlug, "apply_discount", i.orderId, {
    percentOff: i.percentOff, newOwnerEarningsGbp: i.newOwnerEarningsGbp, reason: i.reason,
  });
};

export const changeOwnerEarnings = (i: { accountSlug: Slug; orderId: string; newGbp: number; reason?: string }) =>
  dispatchWithGuards(i.accountSlug, "change_owner_earnings", i.orderId, { newGbp: i.newGbp, reason: i.reason });

export const markOrderPickedUp = (i: { accountSlug: Slug; orderId: string; notes?: string }) =>
  dispatchWithGuards(i.accountSlug, "mark_picked_up", i.orderId, { notes: i.notes });

export const markOrderReturned = (i: { accountSlug: Slug; orderId: string; conditionNotes?: string }) =>
  dispatchWithGuards(i.accountSlug, "mark_returned", i.orderId, { conditionNotes: i.conditionNotes });

export const leaveRenterReview = (i: {
  accountSlug: Slug; orderId: string; rating: 1 | 2 | 3 | 4 | 5; comment?: string;
}) => dispatchWithGuards(i.accountSlug, "leave_review", i.orderId, { rating: i.rating, comment: i.comment });

// Read-only helper — surfaces shadow rows awaiting Daniel's eyeballs.
export interface PendingShadowAction {
  correlationId: string;
  accountSlug: string;
  orderId?: string;
  action: string;
  args: unknown;
  screenshotUrl?: string;
  hyggloConfirmationText?: string | null;
  strategyUsed: string;
  startedAt: number;
  completedAt?: number;
}

export async function getPendingShadowActions(opts: {
  accountSlug?: string; limit?: number;
}): Promise<PendingShadowAction[]> {
  const cx = getConvex();
  const rows = await cx.query(api.hygglo_ui.listShadowPending, {
    accountSlug: opts.accountSlug, limit: opts.limit ?? 20,
  });
  return rows as PendingShadowAction[];
}
