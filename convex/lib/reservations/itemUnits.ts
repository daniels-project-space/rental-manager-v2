import type { Id } from "../../_generated/dataModel";

type XItem = { item_id?: Id<"items"> | string | null; item_name_canonical?: string; qty?: number };
type HItem = { name?: string; product_id?: number };

export type ResolvableRes = {
  account_slug?: string;
  expanded_items?: XItem[] | null;
  resolved_items?: XItem[] | null;
  hygglo_items?: HItem[] | null;
};

/** "2x Sony FX3 …" / "2 x …" → 2 ; otherwise 1 (clamped 1..20). */
export function parseLeadingQty(name?: string): number {
  if (!name) return 1;
  const m = name.match(/^\s*(\d{1,2})\s*[x×]\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 20) return n;
  }
  return 1;
}

/** `account_slug#product_id` → item_id (string). */
export function buildProductIndexMap(
  rows: Array<{ account_slug: string; product_id: number; item_id: Id<"items"> }>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) m.set(`${r.account_slug}#${r.product_id}`, String(r.item_id));
  return m;
}

/**
 * Authoritative held-units for a reservation: item_id(string) → qty. Combines,
 * in priority order, so a rental whose LLM bundle-resolution missed a listing
 * is never under-counted — the bug where a "DJI RS3 Pro Gimbal Set" listing was
 * left out of expanded_items, making the gimbal uncountable for availability
 * and unselectable when opening a case:
 *   1. expanded_items  (kit-decomposed, carries qty)
 *   2. resolved_items  (item_ids not already covered)
 *   3. hygglo_items.product_id → hygglo_product_index (the reliable per-listing
 *      mapping) for any listing whose inventory item still isn't represented;
 *      qty parsed from a leading "Nx" in the listing title.
 */
export function reservationItemUnits(
  r: ResolvableRes,
  productIndex: Map<string, string>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of r.expanded_items ?? []) if (x.item_id) m.set(String(x.item_id), x.qty ?? 1);
  for (const x of r.resolved_items ?? []) {
    if (x.item_id && !m.has(String(x.item_id))) m.set(String(x.item_id), x.qty ?? 1);
  }
  const slug = r.account_slug ?? "";
  for (const h of r.hygglo_items ?? []) {
    if (h.product_id == null) continue;
    const id = productIndex.get(`${slug}#${h.product_id}`);
    if (!id || m.has(id)) continue;
    m.set(id, parseLeadingQty(h.name));
  }
  return m;
}
