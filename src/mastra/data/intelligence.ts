/**
 * Wave 3 — "thick" intelligence functions.
 *
 * Each function returns a single rich payload sourced from one or more
 * materialized-view (MV) tables. The point: ONE chat-tool call → full picture
 * (numbers + summary + topInsight + suggested follow-ups + freshness +
 *  raw rows-of-record).
 *
 * Three Mastra consumers read from these MVs:
 *   1. Dashboard chat (this wave)
 *   2. Polling agent  (Wave 4)
 *   3. Renter-bot     (Wave 5)
 *
 * Determinism guarantees (per `/tmp/claude_scratchpad/llm_native_design.md` §1):
 *   - Platform-fee math frozen at MV-refresh time using constants mirror.
 *   - Hygglo inclusive date math is also frozen at refresh.
 *   - This module performs only display formatting + read access.
 */
import "server-only";
import { anyApi } from "convex/server";
import { getConvex } from "./client";
import { wrap, getSyncState, type ToolEnvelope } from "./envelope";
import { HYGGLO_POLLER_SOURCE } from "./constants";
import type { AccountSlug } from "./account-scope";

/**
 * Intelligence payload extends the basic ToolEnvelope `data` field with:
 *   - numbers         — typed scalar block for fast UI binding
 *   - summary         — narrative sentence
 *   - topInsight      — single highest-leverage sentence
 *   - suggestedFollowups — drill-down tool names
 *   - freshness       — relative age string ("live", "5 min ago")
 *   - ofRecord        — raw row sample (top N) for follow-up reasoning
 */
export interface IntelligencePayload<TNumbers, TRow> {
  numbers: TNumbers;
  summary: string;
  topInsight: string;
  suggestedFollowups: string[];
  freshness: string;
  ofRecord: TRow[];
}

function relativeAge(generatedAtMs: number | undefined | null): string {
  if (!generatedAtMs) return "unknown";
  const diff = Date.now() - generatedAtMs;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "live";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

// ─── Purchase intelligence ──────────────────────────────────────────────

export interface PurchaseSignalRow {
  itemRequested: string;
  requestCount30d: number;
  projectedAnnualGbp: number;
  aliasOfOwned: string | null;
  confidence: "high" | "med" | "low";
}

export interface PurchaseNumbers {
  totalSignalsCount: number;
  topSignalGbp: number;
  totalProjectedAnnualGbp: number;
  highConfidenceCount: number;
}

/**
 * ONE call → full purchase-recommendation picture.
 *
 * Sources:
 *   - mv.purchase_signals.get     — signals + topInsight
 *   - mv.top_earners_30d.get      — context for what we already have
 */
export async function getPurchaseIntelligence(args: {
  account?: AccountSlug;
}): Promise<ToolEnvelope<IntelligencePayload<PurchaseNumbers, PurchaseSignalRow>>> {
  const convex = getConvex();
  const account = args.account ?? "all";

  const [signalsDoc, topEarnersDoc, syncState] = await Promise.all([
    convex.query(anyApi.mv.purchase_signals.get, { account }),
    convex.query(anyApi.mv.top_earners.get, { account }),
    getSyncState(),
  ]);

  const signals: PurchaseSignalRow[] = signalsDoc?.signals ?? [];
  const topInsight = signalsDoc?.topInsight ?? "No purchase signals available — MV not yet refreshed.";

  const numbers: PurchaseNumbers = {
    totalSignalsCount: signals.length,
    topSignalGbp: signals[0]?.projectedAnnualGbp ?? 0,
    totalProjectedAnnualGbp: signals.reduce((s, r) => s + r.projectedAnnualGbp, 0),
    highConfidenceCount: signals.filter((s) => s.confidence === "high").length,
  };

  const summary =
    signals.length > 0
      ? `${signals.length} unmet-demand signal${signals.length === 1 ? "" : "s"} surfaced in last 30 days. ` +
        `Projected annual upside if all addressed: £${Math.round(numbers.totalProjectedAnnualGbp)}. ` +
        `${numbers.highConfidenceCount} high-confidence.`
      : "No high-frequency unmet demand right now.";

  const topEarnerNames = (topEarnersDoc?.rows ?? []).slice(0, 3).map((r: { itemName: string }) => r.itemName);
  const followups: string[] = [];
  if (signals[0]) followups.push(`get_item_cycle for "${signals[0].itemRequested}" ROI check`);
  if (topEarnerNames.length > 0) followups.push(`check_availability ${topEarnerNames.join(", ")} (current top earners)`);
  followups.push("get_unmatched_demand for full 6-month detail");

  return wrap({
    data: {
      numbers,
      summary,
      topInsight,
      suggestedFollowups: followups,
      freshness: relativeAge(signalsDoc?.generatedAt),
      ofRecord: signals.slice(0, 10),
    },
    source: "mv.purchase_signals",
    syncState,
  });
}

// ─── Churn intelligence ─────────────────────────────────────────────────

export interface ChurnRow {
  renterName: string;
  lastRentalDaysAgo: number;
  lifetimeGbp: number;
  lifetimeRentals: number;
  risk: "high" | "med" | "low";
  reason: string;
}

export interface ChurnNumbers {
  totalAtRiskCount: number;
  highRiskCount: number;
  totalLifetimeAtRiskGbp: number;
}

/**
 * ONE call → churn-risk picture.
 *
 * Sources:
 *   - mv.churn_risk_renters.get
 */
export async function getChurnRisk(args: {
  account?: AccountSlug;
}): Promise<ToolEnvelope<IntelligencePayload<ChurnNumbers, ChurnRow>>> {
  const convex = getConvex();
  const account = args.account ?? "all";

  const [doc, syncState] = await Promise.all([
    convex.query(anyApi.mv.churn_risk.get, { account }),
    getSyncState(),
  ]);

  const rows: ChurnRow[] = doc?.rows ?? [];
  const highRisk = rows.filter((r) => r.risk === "high");

  const numbers: ChurnNumbers = {
    totalAtRiskCount: rows.filter((r) => r.risk !== "low").length,
    highRiskCount: highRisk.length,
    totalLifetimeAtRiskGbp: highRisk.reduce((s, r) => s + r.lifetimeGbp, 0),
  };

  const summary =
    rows.length === 0
      ? "No renters with ≥2 lifetime rentals — churn analysis not actionable."
      : `${numbers.highRiskCount} high-risk renter${numbers.highRiskCount === 1 ? "" : "s"} ` +
        `(£${Math.round(numbers.totalLifetimeAtRiskGbp)} lifetime value), ` +
        `${numbers.totalAtRiskCount} total in re-engagement window.`;

  const topInsight =
    highRisk.length > 0
      ? `${highRisk[0].renterName} (£${Math.round(highRisk[0].lifetimeGbp)} lifetime, ${highRisk[0].lifetimeRentals} rentals) — ${highRisk[0].reason}`
      : "No high-risk renters detected.";

  const followups = [
    "get_renter_profile for top at-risk renter (deeper rental history)",
    "check_blacklist before any re-engagement outreach",
  ];

  return wrap({
    data: {
      numbers,
      summary,
      topInsight,
      suggestedFollowups: followups,
      freshness: relativeAge(doc?.generatedAt),
      ofRecord: rows.slice(0, 10),
    },
    source: "mv.churn_risk_renters",
    syncState,
  });
}

// ─── Utilization intelligence ───────────────────────────────────────────

export interface UtilRow {
  itemName: string;
  capacity: number;
  rentedNow: number;
  idleDays7d: number;
  utilization7dPct: number;
}

export interface UtilNumbers {
  fleetUtilizationPct: number;
  itemsActive: number;
  hotItemsCount: number;          // util7d >= 70%
  idleItemsCount: number;         // util7d <= 10%
}

/**
 * ONE call → fleet-utilization picture.
 *
 * Sources:
 *   - mv.utilization_today.get
 *   - mv.upcoming_returns.get (used for "X items returning in 7d" follow-up hint)
 */
export async function getUtilizationSnapshot(args: {
  account?: AccountSlug;
}): Promise<ToolEnvelope<IntelligencePayload<UtilNumbers, UtilRow>>> {
  const convex = getConvex();
  const account = args.account ?? "all";

  const [utilDoc, returnsDoc, syncState] = await Promise.all([
    convex.query(anyApi.mv.utilization.get, { account }),
    convex.query(anyApi.mv.upcoming_returns.get, { account }),
    getSyncState(),
  ]);

  const rows: UtilRow[] = utilDoc?.rows ?? [];
  const hot = rows.filter((r) => r.utilization7dPct >= 70);
  const idle = rows.filter((r) => r.utilization7dPct <= 10);

  const numbers: UtilNumbers = {
    fleetUtilizationPct: utilDoc?.fleetUtilizationPct ?? 0,
    itemsActive: rows.length,
    hotItemsCount: hot.length,
    idleItemsCount: idle.length,
  };

  const upcomingCount = (returnsDoc?.rows ?? []).length;

  const summary =
    rows.length === 0
      ? "No active inventory yet — utilization unavailable."
      : `Fleet utilization (7d): ${numbers.fleetUtilizationPct}%. ` +
        `${numbers.hotItemsCount} hot item${numbers.hotItemsCount === 1 ? "" : "s"} (≥70%), ` +
        `${numbers.idleItemsCount} idle (≤10%). ${upcomingCount} item${upcomingCount === 1 ? "" : "s"} returning in next 7d.`;

  const topInsight =
    hot[0]
      ? `${hot[0].itemName} is hottest at ${hot[0].utilization7dPct}% — bottleneck? consider buying a second unit.`
      : idle[0]
        ? `${idle[0].itemName} has ${idle[0].idleDays7d} idle days in 7d (${idle[0].utilization7dPct}%) — sell or price down?`
        : "Fleet evenly utilized.";

  const followups = [
    "get_top_earning_items for revenue context on hot units",
    "get_sell_recommendations for idle inventory",
    "get_item_cycle for any item to see day-by-day pattern",
  ];

  return wrap({
    data: {
      numbers,
      summary,
      topInsight,
      suggestedFollowups: followups,
      freshness: relativeAge(utilDoc?.generatedAt),
      ofRecord: rows.slice(0, 15),
    },
    source: "mv.utilization_today",
    syncState,
  });
}

// Suppress unused-import lint for HYGGLO_POLLER_SOURCE (used implicitly via getSyncState)
void HYGGLO_POLLER_SOURCE;
