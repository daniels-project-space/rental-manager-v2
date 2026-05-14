/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Tax-year summary + accountant-ready export.
 * ──────────────────────────────────────────────────────────────────────────
 *
 *  Models a UK tax year (6 Apr YYYY → 5 Apr YYYY+1) over the reservations
 *  table. Numbers reconcile with the Revenue widget because we reuse the
 *  same canonical predicates (effectiveDate, isLive, dedupByLogicalRental).
 *
 *  Cash-basis-ish: a rental is assigned to the tax year containing its
 *  effective date (pickup_date ?? start_date). Matches what most sole-trader
 *  cash-basis filings will accept and what the rest of the dashboard reports.
 */

import { query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import {
  effectiveDate,
  dedupByLogicalRental,
  isLive,
  type ReservationRow,
} from "./lib/reservations/predicates";

// ── Tax year math ────────────────────────────────────────────────────────────

function taxYearBounds(startYear: number): { start: string; end: string; label: string } {
  const start = `${startYear}-04-06`;
  const end = `${startYear + 1}-04-05`;
  const label = `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
  return { start, end, label };
}

function taxMonthsForYear(startYear: number): Array<{ key: string; label: string }> {
  return Array.from({ length: 12 }, (_, i) => {
    const monthIdx = (3 + i) % 12; // 3 = April
    const year = startYear + (3 + i >= 12 ? 1 : 0);
    const key = `${year}-${String(monthIdx + 1).padStart(2, "0")}`;
    const label = new Date(year, monthIdx, 1).toLocaleString("en", { month: "short", year: "numeric" });
    return { key, label };
  });
}

function monthKeyOf(iso: string): string {
  return iso.slice(0, 7);
}

function defaultStartYear(): number {
  const now = new Date();
  const cutoff = new Date(now.getUTCFullYear(), 3, 6); // Apr 6
  return now >= cutoff ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

// ── Types ────────────────────────────────────────────────────────────────────

type RichReservation = ReservationRow & {
  pickup_date?: string;
  items?: Array<{ item_name: string; qty?: number }>;
  gross_paid_gbp?: number;
  net_to_owner_gbp?: number;
  platform_fee_gbp?: number;
  delivery_fee_gbp?: number;
  hygglo_order_id?: string;
};

type TaxRow = {
  date: string;
  taxYearLabel: string;
  taxMonth: string;
  customer: string;
  description: string;
  days: number;
  grossGbp: number;
  platformFeeGbp: number;
  deliveryFeeGbp: number;
  netGbp: number;
  account: string;
  platform: string;
  reservationId: string;
  hyggloOrderId: string | null;
  pickupDate: string | null;
  returnDate: string | null;
  statusNote: string;
};

function dayCount(start?: string, end?: string): number {
  if (!start || !end) return 1;
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

// ── Loaders ──────────────────────────────────────────────────────────────────

async function loadReservationsForYear(
  ctx: QueryCtx,
  startYear: number,
): Promise<{ inYear: RichReservation[]; refundCandidates: RichReservation[] }> {
  const { start, end } = taxYearBounds(startYear);
  // Bounded scan — reservations table size is in the low thousands.
  const all = (await ctx.db.query("reservations").collect()) as RichReservation[];

  // Refund candidates: cancelled/obsolete rows that still received money.
  // Surfaced as a flag so the accountant can chase them.
  const refundCandidates = all.filter(
    (r) => (r.status === "cancelled" || r.is_obsolete) && (r.gross_paid_gbp ?? 0) > 0,
  );

  // Live rentals whose effective date falls in the tax year, deduped per
  // logical rental (Hygglo poll + v1 import can produce two rows for the
  // same booking — dedup picks the one with the larger net).
  const inRange = all.filter((r) => {
    const d = effectiveDate(r);
    return d !== undefined && d >= start && d <= end;
  });
  const inYear = dedupByLogicalRental(inRange.filter(isLive)) as RichReservation[];

  return { inYear, refundCandidates };
}

async function loadRenterNames(
  ctx: QueryCtx,
  reservations: RichReservation[],
): Promise<(r: RichReservation) => string> {
  const ids = [...new Set(reservations.filter((r) => r.renter_id).map((r) => r.renter_id as string))];
  const map = new Map<string, string>();
  await Promise.all(
    ids.map(async (rid) => {
      const renter = (await ctx.db.get(rid as never)) as { display_name?: string } | null;
      if (renter) map.set(rid, renter.display_name ?? "?");
    }),
  );
  return (r: RichReservation) => {
    const denorm = (r as { renter_name?: string }).renter_name;
    if (denorm) return denorm;
    if (r.renter_id) return map.get(r.renter_id) ?? "?";
    return "?";
  };
}

// ── Public queries ───────────────────────────────────────────────────────────

export const getTaxYearSummary = query({
  args: { startYear: v.optional(v.number()) },
  handler: async (ctx, { startYear: argStart }) => {
    const startYear = argStart ?? defaultStartYear();
    const { start, end, label } = taxYearBounds(startYear);
    const { inYear, refundCandidates } = await loadReservationsForYear(ctx, startYear);

    // Pre-init monthly buckets so the chart renders zeros for inactive months.
    type Bucket = {
      grossGbp: number;
      platformFeeGbp: number;
      deliveryFeeGbp: number;
      netGbp: number;
      count: number;
    };
    const monthBuckets = new Map<string, Bucket>();
    for (const tm of taxMonthsForYear(startYear)) {
      monthBuckets.set(tm.key, { grossGbp: 0, platformFeeGbp: 0, deliveryFeeGbp: 0, netGbp: 0, count: 0 });
    }
    const accountTotals = new Map<string, Bucket>();

    let grossTotal = 0;
    let platformFeeTotal = 0;
    let deliveryFeeTotal = 0;
    let netTotal = 0;
    let missingFeeCount = 0;

    for (const r of inYear) {
      const d = effectiveDate(r);
      if (!d) continue;
      const mk = monthKeyOf(d);
      const mb = monthBuckets.get(mk)!;
      const acct = r.account_slug ?? "unknown";
      const ab =
        accountTotals.get(acct) ??
        { grossGbp: 0, platformFeeGbp: 0, deliveryFeeGbp: 0, netGbp: 0, count: 0 };

      const gross = r.gross_paid_gbp ?? 0;
      const fee = r.platform_fee_gbp ?? 0;
      const delivery = r.delivery_fee_gbp ?? 0;
      const net = r.net_to_owner_gbp ?? 0;

      mb.grossGbp += gross;
      mb.platformFeeGbp += fee;
      mb.deliveryFeeGbp += delivery;
      mb.netGbp += net;
      mb.count += 1;

      ab.grossGbp += gross;
      ab.platformFeeGbp += fee;
      ab.deliveryFeeGbp += delivery;
      ab.netGbp += net;
      ab.count += 1;
      accountTotals.set(acct, ab);

      grossTotal += gross;
      platformFeeTotal += fee;
      deliveryFeeTotal += delivery;
      netTotal += net;

      if (gross > 0 && fee === 0) missingFeeCount++;
    }

    // VAT threshold (£90k from 1 Apr 2024); warn at £85k.
    const VAT_THRESHOLD = 90_000;
    const VAT_WARNING_THRESHOLD = 85_000;
    let vatStatus: "ok" | "approaching" | "over" = "ok";
    if (grossTotal >= VAT_THRESHOLD) vatStatus = "over";
    else if (grossTotal >= VAT_WARNING_THRESHOLD) vatStatus = "approaching";

    const monthly = taxMonthsForYear(startYear).map((tm) => ({
      monthKey: tm.key,
      monthLabel: tm.label,
      ...monthBuckets.get(tm.key)!,
    }));

    const accounts = Array.from(accountTotals.entries())
      .map(([account, totals]) => ({ account, ...totals }))
      .sort((a, b) => b.grossGbp - a.grossGbp);

    const refundCandidateGbp = refundCandidates.reduce(
      (s, r) => s + (r.gross_paid_gbp ?? 0),
      0,
    );

    return {
      startYear,
      taxYearLabel: label,
      rangeStart: start,
      rangeEnd: end,
      totalTransactions: inYear.length,
      activeMonths: monthly.filter((m) => m.count > 0).length,
      summary: {
        grossGbp: grossTotal,
        platformFeeGbp: platformFeeTotal,
        deliveryFeeGbp: deliveryFeeTotal,
        netGbp: netTotal,
      },
      monthly,
      accounts,
      flags: {
        missingFeeCount,
        refundCandidateCount: refundCandidates.length,
        refundCandidateGbp,
        vatStatus,
        vatThresholdGbp: VAT_THRESHOLD,
      },
      // gross - platformFee should ≈ net (rounding drift up to a few pence).
      reconciliationDriftGbp:
        Math.round((grossTotal - platformFeeTotal - netTotal) * 100) / 100,
      generatedAt: Date.now(),
    };
  },
});

export const getTaxYearExportRows = query({
  args: { startYear: v.optional(v.number()) },
  handler: async (ctx, { startYear: argStart }) => {
    const startYear = argStart ?? defaultStartYear();
    const { label } = taxYearBounds(startYear);
    const { inYear } = await loadReservationsForYear(ctx, startYear);
    const renterNameOf = await loadRenterNames(ctx, inYear);

    const rows: TaxRow[] = [];
    for (const r of inYear) {
      const d = effectiveDate(r);
      if (!d) continue;
      const monthDate = new Date(`${d}T00:00:00Z`);
      rows.push({
        date: d,
        taxYearLabel: label,
        taxMonth: monthDate.toLocaleString("en", { month: "short", year: "numeric" }),
        customer: renterNameOf(r),
        description: (r.items ?? [])
          .map((i) => (i.qty && i.qty > 1 ? `${i.qty}x ${i.item_name}` : i.item_name))
          .join(", "),
        days: dayCount(r.start_date, r.end_date),
        grossGbp: r.gross_paid_gbp ?? 0,
        platformFeeGbp: r.platform_fee_gbp ?? 0,
        deliveryFeeGbp: r.delivery_fee_gbp ?? 0,
        netGbp: r.net_to_owner_gbp ?? 0,
        account: r.account_slug ?? "?",
        platform: "hygglo",
        reservationId: r._id,
        hyggloOrderId: r.hygglo_order_id ?? null,
        pickupDate: r.pickup_date ?? null,
        returnDate: r.end_date ?? null,
        statusNote: r.is_obsolete
          ? `obsolete:${r.status}`
          : r.status === "confirmed"
            ? ""
            : r.status,
      });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return { taxYearLabel: label, rows };
  },
});

export const listAvailableTaxYears = query({
  args: { count: v.optional(v.number()) },
  handler: async (_ctx, { count }) => {
    const n = count ?? 4;
    const current = defaultStartYear();
    return Array.from({ length: n }, (_, i) => {
      const sy = current - i;
      const { start, end, label } = taxYearBounds(sy);
      return { startYear: sy, taxYearLabel: label, rangeStart: start, rangeEnd: end };
    });
  },
});
