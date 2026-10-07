import type { Id } from "../../_generated/dataModel";
import { withDefaultAdapters, type AdapterInventoryItem } from "../default_adapter_units";

type XItem = { item_id?: Id<"items"> | string | null; item_name_canonical?: string; qty?: number };
type HItem = { name?: string; product_id?: number; qty?: number };

export type ResolvableRes = {
  account_slug?: string;
  site_item_windows?: Array<{item_id: string; qty: number; start: number; end: number}>;
  expanded_items?: XItem[] | null;
  resolved_items?: XItem[] | null;
  hygglo_items?: HItem[] | null;
};

export type OverrideMap = Map<string, Array<{ item_id: string; qty: number }>>;

/** "2x Sony FX3 …" / "2 x …" → 2 ; otherwise 1 (clamped 1..20). */
export function parseLeadingQty(name?: string): number {
  if (!name) return 1;
  const m = name.match(/^\s*(\d{1,2})\s*(?:x\b|×)/i);
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

/** `account_slug#product_id` → audit-authoritative components. */
export function buildOverrideMap(
  rows: Array<{ account_slug: string; product_id: number; components: Array<{ item_id: Id<"items"> | string; qty: number }> }>,
): OverrideMap {
  const m: OverrideMap = new Map();
  for (const r of rows) {
    m.set(`${r.account_slug}#${r.product_id}`, r.components.map((c) => ({ item_id: String(c.item_id), qty: c.qty })));
  }
  return m;
}

/**
 * Authoritative held-units for a reservation: item_id(string) → qty. Priority:
 *   0. listing_resolution_override (manual audit) — when EVERY listing on the
 *      reservation is overridden, it fully defines the items (LLM resolution
 *      ignored); partial overrides win for the items they name.
 *   1. expanded_items (kit-decomposed, qty)
 *   2. resolved_items (item_ids not already covered)
 *   3. hygglo_items.product_id → hygglo_product_index (reliable per-listing
 *      mapping) for listings still unrepresented; qty from a leading "Nx".
 *
 * Fixes both the dropped-item bug (a "DJI RS3 Pro Gimbal" listing left out of
 * expanded_items) and, via the override, mis-resolved listings (e.g. a Canon R5
 * listing the LLM mapped to a Sony FX3).
 */
export function reservationItemUnits(
  r: ResolvableRes,
  productIndex: Map<string, string>,
  overrideMap?: OverrideMap,
  inventory: AdapterInventoryItem[] = [],
  date?: string,
): Map<string, number> {
  const slug = r.account_slug ?? "";
  if (slug === "dbcinema_web" && r.site_item_windows !== undefined) return websiteWindowUnits(r.site_item_windows, date);

  // 0a. Fully-overridden reservation → the override IS the answer.
  if (overrideMap && (r.hygglo_items?.length ?? 0) > 0) {
    let allOverridden = true;
    const ov = new Map<string, number>();
    for (const h of r.hygglo_items ?? []) {
      const comps = h.product_id != null ? overrideMap.get(`${slug}#${h.product_id}`) : undefined;
      if (!comps) { allOverridden = false; break; }
      for (const c of withDefaultAdapters(comps,inventory).components) ov.set(c.item_id, (ov.get(c.item_id) ?? 0) + c.qty * (h.qty ?? 1));
    }
    // allOverridden with an EMPTY ov = every listing is a marketing/own-nothing
    // override → the reservation has no owned items (drops mis-attributions).
    if (allOverridden) return ov;
  }

  // 1–3. Legacy union.
  const m = new Map<string, number>();
  for (const x of r.expanded_items ?? []) if (x.item_id) m.set(String(x.item_id), x.qty ?? 1);
  for (const x of r.resolved_items ?? []) {
    if (x.item_id && !m.has(String(x.item_id))) m.set(String(x.item_id), x.qty ?? 1);
  }
  for (const h of r.hygglo_items ?? []) {
    if (h.product_id == null) continue;
    const id = productIndex.get(`${slug}#${h.product_id}`);
    if (!id || m.has(id)) continue;
    m.set(id, parseLeadingQty(h.name));
  }

  // 0b. Overlay any partial overrides — authoritative for the items they name.
  if (overrideMap) {
    for (const h of r.hygglo_items ?? []) {
      const comps = h.product_id != null ? overrideMap.get(`${slug}#${h.product_id}`) : undefined;
      if (comps) for (const c of comps) m.set(c.item_id, c.qty);
    }
  }
  return new Map(withDefaultAdapters([...m].map(([item_id,qty]) => ({item_id,qty})),inventory).components.map(c=>[c.item_id,c.qty]));
}


/**
 * "Standard bundled accessory" — SD/CF cards + camera/gimbal batteries that ship
 * WITH the camera as standard kit. We have as many as we have cameras, so they
 * are not an independent availability constraint and shouldn't clutter item
 * lists or trigger overbooking. (Power STATIONS like Anker/EcoFlow are real gear
 * — only kind "power" items whose name mentions a battery are excluded.)
 */
export function isStandardAccessory(kind: string | undefined, name: string | undefined): boolean {
  const k = kind ?? "";
  if (k === "storage_card" || k === "media") return true;
  if (k === "power" && /batter/i.test(name ?? "")) return true;
  return false;
}

/** The saved website allocation is authoritative; extensions do not multiply bodies. */
export function websiteWindowUnits(windows: NonNullable<ResolvableRes["site_item_windows"]>, date?: string): Map<string, number> {
  const perItem = new Map<string, Array<{start: string; end: string; qty: number}>>();
  for (const w of windows) {
    const start = new Date(w.start).toISOString().slice(0, 10), end = new Date(w.end).toISOString().slice(0, 10);
    if (date && (date < start || date > end)) continue;
    const rows = perItem.get(String(w.item_id)) ?? []; rows.push({start, end, qty:w.qty}); perItem.set(String(w.item_id),rows);
  }
  const result = new Map<string,number>();
  for (const [id,rows] of perItem) {
    if (date) { result.set(id,rows.reduce((n,w)=>n+w.qty,0)); continue; }
    const starts = [...new Set(rows.map(w=>w.start))];
    result.set(id, Math.max(...starts.map(day=>rows.filter(w=>w.start<=day && w.end>=day).reduce((n,w)=>n+w.qty,0))));
  }
  return result;
}

/** Local booking-clock intervals for the calendar, including the standard return buffer. */
export function websiteDayIntervals(r: ResolvableRes & {pickup_time?:string;return_time?:string}, date: string) {
  const dayStart=Date.parse(`${date}T00:00:00Z`),dayEnd=dayStart+86400000;
  const result:Array<{id:string;a:string;b:string;qty:number}>=[];
  for(const w of r.site_item_windows ?? []) {
    const pickup=new Date(w.start).toISOString().slice(0,10),ret=new Date(w.end).toISOString().slice(0,10);
    const start=Date.parse(`${pickup}T${r.pickup_time || "00:00"}:00Z`);
    const end=r.return_time ? Date.parse(`${ret}T${r.return_time}:00Z`)+3600000 : Date.parse(`${ret}T00:00:00Z`)+86400000;
    if(start>=dayEnd || end<=dayStart)continue;
    const a=start<=dayStart?"00:00":new Date(start).toISOString().slice(11,16);
    const b=end>=dayEnd?"24:00":new Date(end).toISOString().slice(11,16);
    result.push({id:String(w.item_id),a,b,qty:w.qty});
  }
  return result;
}
