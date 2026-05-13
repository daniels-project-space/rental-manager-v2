/**
 * Wave 4.6 — UI automation cost guard.
 *
 * Pre-flight check before dispatching any browser-use UI action. Hard
 * ceiling of $5/account/day across LLM calls. Operator override:
 * env `HYGGLO_UI_COST_OVERRIDE=true`.
 */
import "server-only";
import { getConvex } from "./client";
import { api } from "@/../convex/_generated/api";

export const DAILY_CAP_USD = 5;

export interface CostCheckResult {
  allowed: boolean;
  spendUsd: number;
  capUsd: number;
  reason?: string;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function checkDailyCap(accountSlug: string): Promise<CostCheckResult> {
  if ((process.env.HYGGLO_UI_COST_OVERRIDE ?? "").toLowerCase() === "true") {
    return { allowed: true, spendUsd: 0, capUsd: DAILY_CAP_USD, reason: "override" };
  }
  const cx = getConvex();
  const row = await cx.query(api.hygglo_ui.getTodaysSpend, {
    accountSlug,
    isoDate: todayIsoDate(),
  });
  const spend = row?.spendUsd ?? 0;
  if (spend >= DAILY_CAP_USD) {
    return {
      allowed: false,
      spendUsd: spend,
      capUsd: DAILY_CAP_USD,
      reason: "daily_cost_cap_reached",
    };
  }
  return { allowed: true, spendUsd: spend, capUsd: DAILY_CAP_USD };
}
