/**
 * ──────────────────────────────────────────────────────────────────────────
 *  AI attribution — tiered credit assignment for reservation revenue.
 *  Backend single source of truth (mirror to FE if needed).
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Wave AI-BE rework (2026-05-22). Replaces the previous flat-rate
 * `ai_boost_rate` skim (0.24 of revenue) with REAL per-reservation
 * attribution driven by the `ai_decision` and `ai_decision_audit` tables.
 *
 * TIERS (per Daniel's decision):
 *   - hard_ai     : decision.status === "approved" + audit.hygglo.attempted
 *                   + reservation confirmed/completed + not obsolete
 *                   → 100% revenue credit
 *   - soft_ai     : decision.status === "approved_modified" + same other
 *                   conditions → 50% credit (the AI drafted, human edited)
 *   - assisted    : ai_decision row exists but action was not attempted
 *                   (e.g. READ_ONLY_MODE) OR the human overrode and
 *                   reservation still confirmed → 0% credit, counted only
 *   - baseline    : no ai_decision row → 0% credit, counted only
 *
 * Pure functions: callers fetch decisions/audits ONCE and pass arrays in
 * to avoid per-reservation N+1 lookups inside Convex query handlers.
 */

import type { Id } from "../_generated/dataModel";

export type AiTier = "hard_ai" | "soft_ai" | "assisted" | "baseline";

export type AiAttribution = {
  tier: AiTier;
  decisionId: Id<"ai_decision"> | null;
  decisionStatus: string | null;
  attempted: boolean | null;
  creditFraction: number; // 1.0 | 0.5 | 0
};

// Minimal structural types so this module stays decoupled from generated
// Doc<> types (lets us unit-test it in plain TS).
export type AiDecisionLite = {
  _id: Id<"ai_decision">;
  reservation_id: Id<"reservations">;
  status: string;
  generatedAt: number;
};

export type AiDecisionAuditLite = {
  _id: Id<"ai_decision_audit">;
  decisionId: Id<"ai_decision">;
  hygglo?: { attempted?: boolean } | null;
  actedAt?: number;
};

export type ReservationLite = {
  _id: Id<"reservations">;
  status: string;
  is_obsolete?: boolean;
  net_to_owner_gbp?: number;
  gross_paid_gbp?: number;
};

const ATTRIBUTING_DECISION_STATUSES = new Set([
  "approved",
  "approved_modified",
]);

const COUNTING_RES_STATUSES = new Set(["confirmed", "completed"]);

/**
 * Classify a single reservation into one of the four AI tiers.
 *
 * Caller MUST pre-filter the decisions list to the relevant set (e.g. all
 * decisions for the reservations under consideration). This function is
 * pure and does NO database access.
 *
 * The "first attributing decision" rule: among the reservation's decisions
 * with status ∈ {approved, approved_modified}, pick the EARLIEST by
 * generatedAt — that one represents the AI's initial verdict that was
 * acted on. Tied generatedAt → first by _id order.
 */
export function classifyReservation(
  reservation: ReservationLite,
  decisions: ReadonlyArray<AiDecisionLite>,
  audits: ReadonlyArray<AiDecisionAuditLite>,
): AiAttribution {
  // ── 0. Reservation must be eligible for any credit ─────────────
  // Even if AI made a decision, an obsolete or cancelled reservation
  // yields no real revenue → never credit it. We still surface the
  // tier as `assisted` so call-counts stay honest if a decision exists.
  const resEligible =
    !(reservation.is_obsolete ?? false) &&
    COUNTING_RES_STATUSES.has(reservation.status);

  // ── 1. Find all AI decisions tied to this reservation ──────────
  const resDecisions = decisions.filter(
    (d) => d.reservation_id === reservation._id,
  );

  if (resDecisions.length === 0) {
    return {
      tier: "baseline",
      decisionId: null,
      decisionStatus: null,
      attempted: null,
      creditFraction: 0,
    };
  }

  // ── 2. Pick the earliest attributing decision (approved or modified) ─
  const attributing = resDecisions
    .filter((d) => ATTRIBUTING_DECISION_STATUSES.has(d.status))
    .sort((a, b) => {
      const t = (a.generatedAt ?? 0) - (b.generatedAt ?? 0);
      if (t !== 0) return t;
      return String(a._id).localeCompare(String(b._id));
    })[0];

  // No approved/approved_modified — only declined/rejected/pending/expired.
  // The AI WAS consulted (so not "baseline"), but did not produce a credited
  // action → tier "assisted", 0 credit. Use the latest non-attributing
  // decision so the surfaced decisionId/status is the most recent state.
  if (!attributing) {
    const latest = [...resDecisions].sort(
      (a, b) => (b.generatedAt ?? 0) - (a.generatedAt ?? 0),
    )[0];
    return {
      tier: "assisted",
      decisionId: latest?._id ?? null,
      decisionStatus: latest?.status ?? null,
      attempted: null,
      creditFraction: 0,
    };
  }

  // ── 3. Did we actually send the action to Hygglo? ──────────────
  // ai_decision_audit logs every approve/decline action; hygglo.attempted
  // is false when READ_ONLY_MODE was on. We look for the LATEST audit
  // for the chosen decision to reflect the final state.
  const decisionAudits = audits
    .filter((a) => a.decisionId === attributing._id)
    .sort((a, b) => (b.actedAt ?? 0) - (a.actedAt ?? 0));

  const latestAudit = decisionAudits[0] ?? null;
  const attempted = latestAudit?.hygglo?.attempted ?? null;

  // No audit row OR not attempted → assisted (intent recorded but no
  // side effect sent). 0 credit, decision still surfaced.
  if (latestAudit === null || attempted !== true) {
    return {
      tier: "assisted",
      decisionId: attributing._id,
      decisionStatus: attributing.status,
      attempted: attempted ?? false,
      creditFraction: 0,
    };
  }

  // ── 4. Reservation must be confirmed/completed to award credit ─
  if (!resEligible) {
    return {
      tier: "assisted",
      decisionId: attributing._id,
      decisionStatus: attributing.status,
      attempted: true,
      creditFraction: 0,
    };
  }

  // ── 5. Award credit based on decision status ───────────────────
  if (attributing.status === "approved") {
    return {
      tier: "hard_ai",
      decisionId: attributing._id,
      decisionStatus: "approved",
      attempted: true,
      creditFraction: 1.0,
    };
  }

  // approved_modified → soft credit (Daniel edited the draft before send)
  return {
    tier: "soft_ai",
    decisionId: attributing._id,
    decisionStatus: "approved_modified",
    attempted: true,
    creditFraction: 0.5,
  };
}

export type AiCreditTotals = {
  hard_ai_gbp: number;
  soft_ai_gbp: number;         // raw, pre-credit-weighted
  soft_ai_credit_gbp: number;  // soft_ai_gbp * 0.5
  assisted_gbp: number;        // 0-credit gross of assisted rows
  baseline_gbp: number;        // 0-credit gross of baseline rows
  hard_count: number;
  soft_count: number;
  assisted_count: number;
  baseline_count: number;
  total_attributed_gbp: number;       // hard_ai_gbp + soft_ai_credit_gbp
  drilldown_reservation_ids: string[]; // hard + soft ids (in order)
};

/**
 * Pick the revenue figure for a reservation. We mirror the existing
 * revenue.ts behaviour: `net_to_owner_gbp` is the field summed into
 * `totalRaw` that the legacy aiBoost skimmed from. Fall back to
 * `gross_paid_gbp` only if net is missing (defensive — backfill rows).
 */
function revenueGbp(r: ReservationLite): number {
  if (typeof r.net_to_owner_gbp === "number") return r.net_to_owner_gbp;
  if (typeof r.gross_paid_gbp === "number") return r.gross_paid_gbp;
  return 0;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Aggregate tiered credit totals over a list of reservations.
 *
 * Pre-fetched arguments:
 *   - reservations: the reservations to classify (already filtered to
 *     the month/account scope).
 *   - decisions: ALL ai_decision rows that could match these reservations.
 *     Pass the global table or a pre-filtered subset; the classifier
 *     filters per-reservation internally.
 *   - audits: ALL ai_decision_audit rows for the same scope.
 */
export function tieredCreditTotals(
  reservations: ReadonlyArray<ReservationLite>,
  decisions: ReadonlyArray<AiDecisionLite>,
  audits: ReadonlyArray<AiDecisionAuditLite>,
): AiCreditTotals {
  let hard_ai_gbp = 0;
  let soft_ai_gbp = 0;
  let assisted_gbp = 0;
  let baseline_gbp = 0;
  let hard_count = 0;
  let soft_count = 0;
  let assisted_count = 0;
  let baseline_count = 0;
  const drilldown_reservation_ids: string[] = [];

  for (const r of reservations) {
    const cls = classifyReservation(r, decisions, audits);
    const amt = revenueGbp(r);
    switch (cls.tier) {
      case "hard_ai":
        hard_ai_gbp += amt;
        hard_count += 1;
        drilldown_reservation_ids.push(String(r._id));
        break;
      case "soft_ai":
        soft_ai_gbp += amt;
        soft_count += 1;
        drilldown_reservation_ids.push(String(r._id));
        break;
      case "assisted":
        assisted_gbp += amt;
        assisted_count += 1;
        break;
      case "baseline":
        baseline_gbp += amt;
        baseline_count += 1;
        break;
    }
  }

  const soft_ai_credit_gbp = soft_ai_gbp * 0.5;
  const total_attributed_gbp = hard_ai_gbp + soft_ai_credit_gbp;

  return {
    hard_ai_gbp: r2(hard_ai_gbp),
    soft_ai_gbp: r2(soft_ai_gbp),
    soft_ai_credit_gbp: r2(soft_ai_credit_gbp),
    assisted_gbp: r2(assisted_gbp),
    baseline_gbp: r2(baseline_gbp),
    hard_count,
    soft_count,
    assisted_count,
    baseline_count,
    total_attributed_gbp: r2(total_attributed_gbp),
    drilldown_reservation_ids,
  };
}

/** Median utility (works on any numeric array; 0 for empty). */
export function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return r2((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return r2(sorted[mid]);
}
