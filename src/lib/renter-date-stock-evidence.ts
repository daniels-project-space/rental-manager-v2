import { createHash } from "node:crypto";
import type { StockQuoteEvidence } from "../../convex/lib/renter_draft_evidence";
import type { ToolReceipt } from "./renter-tool-evidence";
import { datePriceEvidence } from "./renter-date-price-evidence";

type Quote = {
  start_date: string;
  end_date: string;
  total_gbp: number;
  travel_compensation_gbp?: number;
  lines: Array<{ product_id?: number; name: string; qty: number; line_total_gbp: number }>;
};

/**
 * Builds the physical-stock proof for an already validated date-change quote.
 * This module is Node-only: the date-price validator is also loaded by Convex,
 * whose runtime does not provide Node's crypto module.
 */
export function dateStockQuoteEvidence(receipt: ToolReceipt, threadId?: string): StockQuoteEvidence | null {
  const prices = datePriceEvidence(receipt, threadId);
  const r = receipt.result;
  const q = r.quote as Quote | undefined;
  if (prices.length < 2 || !q || !threadId) return null;

  const raw = Array.isArray(r.stock_receipts) ? r.stock_receipts : [];
  if (!raw.length || typeof r.physical_identity_key !== "string" || !r.physical_identity_key.trim()) return null;

  const items: Array<{ item_id: string; name: string; quantity: number }> = [];
  const ids = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    if (typeof item.item_id !== "string" || !item.item_id.trim() || ids.has(item.item_id) ||
      typeof item.item_name !== "string" || !item.item_name.trim() || /[\r\n]/.test(item.item_name) ||
      !Number.isInteger(item.requested_units) || Number(item.requested_units) < 1 ||
      item.available !== true || item.owned !== true || item.source !== "shared_inventory_confirmed_rentals" ||
      item.start_date !== q.start_date || item.end_date !== q.end_date ||
      typeof item.free_units !== "number" || !Number.isInteger(item.free_units) || item.free_units < Number(item.requested_units) ||
      typeof item.checked_at !== "number" || !Number.isFinite(item.checked_at)) return null;
    ids.add(item.item_id);
    items.push({ item_id: item.item_id, name: item.item_name, quantity: Number(item.requested_units) });
  }

  const identity = JSON.stringify([...items].sort((a, b) => a.item_id.localeCompare(b.item_id)).map((item) => [item.item_id, item.name, item.quantity]));
  if (identity !== r.physical_identity_key) return null;
  if (q.lines.some((line) => !Number.isInteger(line.product_id) || !line.product_id || !line.name.trim() ||
    !Number.isInteger(line.qty) || line.qty < 1 || !Number.isFinite(line.line_total_gbp) || line.line_total_gbp <= 0) ||
    new Set(q.lines.map((line) => line.product_id)).size !== q.lines.length) return null;

  const key = createHash("sha256").update(JSON.stringify([threadId, receipt.call_id, r.before_context_key, q.start_date, q.end_date, identity])).digest("hex").slice(0, 32);
  return {
    quote_key: `date_${key}`,
    start_date: q.start_date,
    end_date: q.end_date,
    proposed_basket: true,
    date_change_proposal: { before_context_key: r.before_context_key as string, physical_identity_key: r.physical_identity_key },
    listing_quote: { total_gbp: q.total_gbp, lines: q.lines.map((line) => ({ product_id: line.product_id!, name: line.name, quantity: line.qty, total_gbp: line.line_total_gbp })) },
    ...(typeof q.travel_compensation_gbp === "number" && q.travel_compensation_gbp > 0 ? { travel_compensation_gbp: q.travel_compensation_gbp } : {}),
    items,
  };
}
