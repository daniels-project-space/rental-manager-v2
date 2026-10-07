import { v } from "convex/values";

export const invoiceStatsFields = {
  count: v.number(), ready: v.number(), review: v.number(), failed: v.number(), queued: v.number(),
  revenue: v.number(), lenderFee: v.number(), renterFee: v.number(), payout: v.number(),
  revenueKnown: v.number(), lenderKnown: v.number(), renterKnown: v.number(), payoutKnown: v.number(),
};
export const invoiceStatsValidator = v.object(invoiceStatsFields);
export type InvoiceStats = Record<keyof typeof invoiceStatsFields, number>;

export function emptyInvoiceStats(): InvoiceStats {
  return {
    count: 0, ready: 0, review: 0, failed: 0, queued: 0,
    revenue: 0, lenderFee: 0, renterFee: 0, payout: 0,
    revenueKnown: 0, lenderKnown: 0, renterKnown: 0, payoutKnown: 0,
  };
}

/** Same eligibility and unknown-value rules as the original archive scan. */
export function invoiceContribution(row: {
  status: string; pdf_id?: unknown;
  amounts?: { revenue?: number; lender_fee?: number; renter_fee?: number; payout?: number; currency: string };
}): InvoiceStats {
  const result = emptyInvoiceStats();
  result.count = 1;
  if (row.status === "ready") result.ready = 1;
  else if (row.status === "review") result.review = 1;
  else if (row.status === "failed") result.failed = 1;
  else result.queued = 1;
  if (row.status !== "ready" || !row.pdf_id || row.amounts?.currency !== "GBP") return result;
  for (const [field, total, known] of [
    ["revenue", "revenue", "revenueKnown"], ["lender_fee", "lenderFee", "lenderKnown"],
    ["renter_fee", "renterFee", "renterKnown"], ["payout", "payout", "payoutKnown"],
  ] as const) {
    const value = row.amounts[field];
    if (value !== undefined) { result[total] = value; result[known] = 1; }
  }
  return result;
}
