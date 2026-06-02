/**
 * Phase 10 — Demand-Loss Classifier
 *
 * Classifies obsolete reservations into five buckets to separate genuine demand
 * loss (could have been booked, wasn't) from churn / mutual cancellations /
 * already-counted denials.
 *
 * Decision tree (Daniel-approved, design doc §A):
 *   obsolete_reason === "owner_denied"           -> "genuine_demand"
 *   obsolete_reason === "verification_failed"    -> "genuine_demand"
 *   obsolete_reason === "renter_cancelled":
 *       gross_paid_gbp > 0                       -> "genuine_demand"
 *       else                                     -> "renter_walked"
 *   obsolete_reason === "other":
 *       order_step in {BOOKED_AFTER_VERIFIED, DELIVERED, RETURNED}
 *                                                -> "genuine_demand"
 *       order_step === "CANCELED" && gross_paid_gbp === 0
 *                                                -> "renter_walked"
 *       else                                     -> "unbooked"
 *   obsolete_reason === undefined                -> "unknown"
 *
 * Dedup pass: rows classified as `genuine_demand` with reason owner_denied
 * are reclassified to `duplicate_of_denial` if a denial_records row exists
 * within ±2 days creation-time AND case-insensitive item-name match.
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { isWithinUkQuietHours } from "./lib/quiet_hours";
import { OWNER_SHARE } from "./lib/revenue_attribution";

const DAY_MS = 86_400_000;
const DEDUP_WINDOW_MS = 2 * DAY_MS;

/** Inclusive day count: Math.max(1, round(diff/day)+1). Mirrors the Hygglo
 *  convention used throughout the codebase (rental_manager critical rule). */
function inclusiveDays(startMs: number, endMs: number): number {
  return Math.max(1, Math.round((endMs - startMs) / DAY_MS) + 1);
}

function normName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

type Reservation = Doc<"reservations">;

/** Extract the primary item name for pricing/dedup. Prefers resolved_items[0]
 *  (LLM-canonicalized), falls back to items[0]. */
function primaryItemName(r: Reservation): string | null {
  const resolved = (r.resolved_items ?? [])[0];
  if (resolved?.item_name_canonical) return resolved.item_name_canonical;
  const raw = (r.items ?? [])[0];
  if (raw?.item_name) return raw.item_name;
  return null;
}

/** Start/end timestamps in ms. Prefer pickup_at/return_at; fall back to
 *  start_date/end_date ISO strings; final fallback is _creationTime. */
function dateRangeMs(r: Reservation): { start: number; end: number } {
  const start = r.pickup_at ?? (r.start_date ? Date.parse(r.start_date) : r._creationTime);
  const end = r.return_at ?? (r.end_date ? Date.parse(r.end_date) : start);
  return { start, end: Math.max(end, start) };
}

type DemandClass =
  | "genuine_demand"
  | "renter_walked"
  | "unbooked"
  | "duplicate_of_denial"
  | "unknown";

/** Pure decision tree. Exported for unit testing if needed. */
export function classifyRow(r: Reservation): DemandClass {
  const reason = r.obsolete_reason;
  const paid = r.gross_paid_gbp ?? 0;
  if (reason === "owner_denied") return "genuine_demand";
  if (reason === "verification_failed") return "genuine_demand";
  if (reason === "renter_cancelled") {
    return paid > 0 ? "genuine_demand" : "renter_walked";
  }
  if (reason === "other") {
    const step = r.order_step;
    if (step === "BOOKED_AFTER_VERIFIED" || step === "DELIVERED" || step === "RETURNED") {
      return "genuine_demand";
    }
    if (step === "CANCELED" && paid === 0) return "renter_walked";
    return "unbooked";
  }
  // reason undefined
  return "unknown";
}

/**
 * Main classifier. Batched (default 200 rows). Idempotent — skips rows where
 * demand_loss_class is already set.
 *
 * Includes the dedup-vs-denials pass inline (Phase 10.4). Cheaper than a
 * second mutation since we already have the genuine_demand+owner_denied rows
 * in hand and dedup needs to fire on every newly-classified row anyway.
 *
 * Returns:
 *   processed: rows touched this run
 *   byClass: { genuine_demand, renter_walked, unbooked, duplicate_of_denial, unknown }
 *   dedupReclassified: rows flipped from genuine_demand -> duplicate_of_denial
 *   remaining: approx. unclassified rows still queued
 */
export const classifyObsoleteReservations = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    if (isWithinUkQuietHours()) {
      console.log("[quiet-hours] skipped", { task: "demand_loss:classifyObsoleteReservations" });
      return { skipped: true, reason: "uk_quiet_hours" };
    }
    const batch = limit ?? 200;

    // 1. Fetch obsolete rows missing a classification. The by_is_obsolete index
    //    (schema.ts) lets us skip to obsolete rows directly without a full-table
    //    scan. We then in-memory drop rows that already have a class (idempotency).
    //    Cap at ~4x batch — keeps doc-read budget well under 32k.
    const candidates: Reservation[] = [];
    const scan = await ctx.db
      .query("reservations")
      .withIndex("by_is_obsolete", (q) => q.eq("is_obsolete", true))
      .take(Math.min(batch * 4, 2000));
    for (const r of scan) {
      if (r.demand_loss_class === undefined) {
        candidates.push(r);
        if (candidates.length >= batch) break;
      }
    }

    // 2. Build a median daily-rate fallback from pricing_catalog. Used only for
    //    genuine_demand rows whose primary item isn't in the catalog.
    const catalog = await ctx.db.query("pricing_catalog").collect();
    const rateByName = new Map<string, number>();
    const allMins: number[] = [];
    for (const p of catalog) {
      if (typeof p.daily_price_min === "number") {
        rateByName.set(normName(p.item_name_canonical), p.daily_price_min);
        allMins.push(p.daily_price_min);
      }
    }
    allMins.sort((a, b) => a - b);
    const medianRate =
      allMins.length === 0
        ? 0
        : allMins.length % 2 === 1
          ? allMins[(allMins.length - 1) / 2]
          : (allMins[allMins.length / 2 - 1] + allMins[allMins.length / 2]) / 2;

    // 3. Pre-load denials for dedup (Phase 10.4). One window covering the
    // entire batch's creation-time range ±2 days. Sorted into a name→times
    // map for O(1) membership checks per candidate.
    let denialsByName = new Map<string, number[]>();
    const ownerDeniedRows = candidates.filter(
      (r) => r.obsolete_reason === "owner_denied",
    );
    if (ownerDeniedRows.length > 0) {
      const times = ownerDeniedRows.map((r) => r._creationTime);
      const minT = Math.min(...times) - DEDUP_WINDOW_MS;
      const maxT = Math.max(...times) + DEDUP_WINDOW_MS;
      const allDenials = await ctx.db
        .query("denial_records")
        .filter((q) =>
          q.and(
            q.gte(q.field("created_at"), minT),
            q.lte(q.field("created_at"), maxT),
          ),
        )
        .collect();
      for (const d of allDenials) {
        if (!d.item_name) continue;
        const k = normName(d.item_name);
        const slot = denialsByName.get(k) ?? [];
        slot.push(d.created_at);
        denialsByName.set(k, slot);
      }
    }

    // 4. Classify + estimate £ + apply.
    const byClass = {
      genuine_demand: 0,
      renter_walked: 0,
      unbooked: 0,
      duplicate_of_denial: 0,
      unknown: 0,
    };
    let dedupReclassified = 0;
    const now = Date.now();

    for (const r of candidates) {
      let cls = classifyRow(r);
      let estimated: number | undefined;

      if (cls === "genuine_demand") {
        // £ estimate
        const name = primaryItemName(r);
        const rate = name ? rateByName.get(normName(name)) : undefined;
        const usedRate = rate ?? medianRate;
        const { start, end } = dateRangeMs(r);
        const days = inclusiveDays(start, end);
        // NET attribution: pricing_catalog rates are Hygglo *gross* daily
        // prices, but every other money field on the dashboard is NET
        // take-home (after the ~36% platform fee). Apply OWNER_SHARE so
        // demand_loss_estimated_gbp is comparable to lost_revenue.ts outputs
        // and the rest of the dashboard. Sister file convex/lost_revenue.ts
        // does the same (see L320 — `* OWNER_SHARE`).
        if (usedRate > 0)
          estimated = Math.round(usedRate * days * OWNER_SHARE * 100) / 100;

        // Phase 10.4 — dedup vs denial_records for owner_denied rows.
        if (r.obsolete_reason === "owner_denied" && name) {
          const wantName = normName(name);
          const created = r._creationTime;
          const lo = created - DEDUP_WINDOW_MS;
          const hi = created + DEDUP_WINDOW_MS;
          const candidateTimes = denialsByName.get(wantName) ?? [];
          const hit = candidateTimes.some((t) => t >= lo && t <= hi);
          if (hit) {
            cls = "duplicate_of_denial";
            estimated = undefined; // £ stays on the denial side
            dedupReclassified++;
          }
        }
      }

      byClass[cls]++;
      await ctx.db.patch(r._id, {
        demand_loss_class: cls,
        demand_loss_classified_at: now,
        ...(estimated !== undefined ? { demand_loss_estimated_gbp: estimated } : {}),
      });
    }

    // 5. Cheap remaining-count probe (best-effort; not exact).
    const probe = await ctx.db
      .query("reservations")
      .withIndex("by_is_obsolete", (q) => q.eq("is_obsolete", true))
      .take(Math.min(batch * 4, 2000));
    let remaining = 0;
    for (const r of probe) {
      if (r.demand_loss_class === undefined) remaining++;
      if (remaining > batch) break;
    }
    const remainingApprox = remaining > batch ? `${batch}+` : remaining;

    return {
      processed: candidates.length,
      byClass,
      dedupReclassified,
      remaining: remainingApprox,
    };
  },
});
