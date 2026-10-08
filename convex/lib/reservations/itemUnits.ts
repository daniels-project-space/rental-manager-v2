import {londonStockInstant,londonStockLabel,bufferedStockEnd,TURNAROUND_BUFFER_MS,TURNAROUND_BUFFER_MINUTES} from "../confirmed_schedule";
import type { Id } from "../../_generated/dataModel";
import { withDefaultAdapters, type AdapterInventoryItem } from "../default_adapter_units";

type XItem = { item_id?: Id<"items"> | string | null; item_name_canonical?: string; qty?: number };
type HItem = { name?: string; product_id?: number; qty?: number };

export type ResolvableRes = {
  account_slug?: string;
  pickup_time?:string;
  return_time?:string;
  site_item_windows?: Array<{item_id: string; qty: number; start: number; end: number; pickupTime?: string | null; returnTime?: string | null; endExclusive?: boolean; stockWindowVersion?:number; turnaroundBufferMinutes?:number; pickupDate?:string; returnDate?:string}>;
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
  const listingQty = (h: HItem) => {
    const qty = h.qty ?? 1;
    if (!Number.isSafeInteger(qty) || qty < 1) throw Error("Invalid reserved listing quantity");
    return qty;
  };
  const auditedComponents = (components: Array<{item_id: string; qty: number}>) => {
    if (components.some(c => !c.item_id || !Number.isSafeInteger(c.qty) || c.qty < 1)) throw Error("Invalid audited kit quantity");
    return withDefaultAdapters(components, inventory).components;
  };
  const addUnits = (map: Map<string, number>, id: string, qty: number) => {
    const total = (map.get(id) ?? 0) + qty;
    if (!Number.isSafeInteger(qty) || qty < 1 || !Number.isSafeInteger(total)) throw Error("Invalid reserved unit quantity");
    map.set(id, total);
  };
  const slug = r.account_slug ?? "";
  if (slug === "dbcinema_web" && r.site_item_windows !== undefined) return websiteWindowUnits(r.site_item_windows, date,{pickupTime:r.pickup_time,returnTime:r.return_time});

  // 0a. Fully-overridden reservation → the override IS the answer.
  if (overrideMap && (r.hygglo_items?.length ?? 0) > 0) {
    let allOverridden = true;
    const ov = new Map<string, number>();
    for (const h of r.hygglo_items ?? []) {
      const comps = h.product_id != null ? overrideMap.get(`${slug}#${h.product_id}`) : undefined;
      if (!comps) { allOverridden = false; break; }
      const qty = listingQty(h);
      for (const c of auditedComponents(comps)) addUnits(ov, c.item_id, c.qty * qty);
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

  // 0b. Aggregate partial audits before replacing legacy attributions. Each
  // component quantity is per listing; several booked listings can share it.
  if (overrideMap) {
    const audited = new Map<string, number>();
    for (const h of r.hygglo_items ?? []) {
      const comps = h.product_id != null ? overrideMap.get(`${slug}#${h.product_id}`) : undefined;
      if (comps) {
        const qty = listingQty(h);
        for (const c of auditedComponents(comps)) addUnits(audited, c.item_id, c.qty * qty);
      }
    }
    // An unoverridden listing mapped to the same physical unit is independent
    // demand, not another alias of the audited kit. Preserve its contribution.
    for (const h of r.hygglo_items ?? []) {
      const key = h.product_id != null ? `${slug}#${h.product_id}` : undefined;
      if (!key || overrideMap.has(key)) continue;
      const id = productIndex.get(key);
      if (id && audited.has(id)) addUnits(audited, id, parseLeadingQty(h.name) * listingQty(h));
    }
    for (const [id, qty] of audited) m.set(id, qty);
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
export function websiteWindowUnits(windows: NonNullable<ResolvableRes["site_item_windows"]>, date?: string,fallback:{pickupTime?:string|null;returnTime?:string|null}={}): Map<string, number> {
  const perItem=new Map<string,Array<{start:number;end:number;qty:number}>>();
  const dayStart=date?londonStockInstant(date+"T00:00","start"):undefined;
  const tomorrow=date?new Date(Date.parse(date+"T12:00Z")+86400000).toISOString().slice(0,10):undefined;
  const dayEnd=tomorrow?londonStockInstant(tomorrow+"T00:00","end"):undefined;
  for(const w of windows){
    const days=websiteWindowDates(w);
    const exact=w.endExclusive===true&&w.stockWindowVersion===2;
    const pickupTime=w.pickupTime===undefined?fallback.pickupTime:w.pickupTime;
    const returnTime=w.returnTime===undefined?fallback.returnTime:w.returnTime;
    const start=exact?w.start:londonStockInstant(days.start+"T"+(pickupTime??"00:00"),"start");
    const nextDay=new Date(Date.parse(days.end+"T12:00Z")+86400000).toISOString().slice(0,10);
    const end=exact?w.end+(TURNAROUND_BUFFER_MINUTES-(w.turnaroundBufferMinutes??0))*60_000:londonStockInstant(returnTime?days.end+"T"+returnTime:nextDay+"T00:00","end")+TURNAROUND_BUFFER_MS;
    if(dayStart!==undefined&&dayEnd!==undefined&&(start>=dayEnd||end<=dayStart))continue;
    const rows=perItem.get(String(w.item_id))??[];rows.push({start:dayStart===undefined?start:Math.max(start,dayStart),end:dayEnd===undefined?end:Math.min(end,dayEnd),qty:w.qty});perItem.set(String(w.item_id),rows);
  }
  const result=new Map<string,number>();
  for(const [id,rows] of perItem){const points=[...new Set(rows.map(w=>w.start))];result.set(id,Math.max(...points.map(at=>rows.filter(w=>w.start<=at&&w.end>at).reduce((sum,w)=>sum+w.qty,0))));}
  return result;
}

/** Local booking-clock intervals for the calendar, including the approved turnaround occupancy. */
export function websiteDayIntervals(r: ResolvableRes & {pickup_time?:string;return_time?:string}, date: string) {
  const dayStart=Date.parse(`${date}T00:00:00Z`),dayEnd=dayStart+86400000;
  const result:Array<{id:string;a:string;b:string;qty:number}>=[];
  for(const w of r.site_item_windows ?? []) {
    const {start:pickup,end:ret}=websiteWindowDates(w);
    const pickupTime=w.pickupTime === undefined ? r.pickup_time : w.pickupTime;
    const returnTime=w.returnTime === undefined ? r.return_time : w.returnTime;
    const exact=w.endExclusive===true&&w.stockWindowVersion===2;
    const actualEnd=returnTime?`${ret}T${returnTime}`:new Date(Date.parse(ret+"T12:00Z")+86400000).toISOString().slice(0,10)+"T00:00";
    const startInstant=exact?w.start:londonStockInstant(`${pickup}T${pickupTime || "00:00"}`,"start");
    const endInstant=exact?w.end+(TURNAROUND_BUFFER_MINUTES-(w.turnaroundBufferMinutes??0))*60_000:bufferedStockEnd(actualEnd).endInstant;
    // Calendar widths use civil labels only after elapsed UTC turnaround.
    // In spring 00:30+one elapsed hour is02:30, never the missing01:30.
    let start=Date.parse(londonStockLabel(startInstant)+":00Z"),end=Date.parse(londonStockLabel(endInstant)+":00Z");
    if(end<=start&&endInstant>startInstant){start=Date.parse(londonStockLabel(startInstant).slice(0,10)+"T00:00Z");end=Date.parse(londonStockLabel(endInstant).slice(0,10)+"T00:00Z")+86400000;}
    if(start>=dayEnd || end<=dayStart)continue;
    const a=start<=dayStart?"00:00":new Date(start).toISOString().slice(11,16);
    const b=end>=dayEnd?"24:00":new Date(end).toISOString().slice(11,16);
    result.push({id:String(w.item_id),a,b,qty:w.qty});
  }
  return result;
}

/** Display saved website periods without filling gaps or borrowing another item's clock.
 * The original reservation ID is retained for every operation; periodKey is display-only.
 */
export function websiteCalendarPeriods<T extends ResolvableRes & {
  start_date?: string; end_date?: string; pickup_date?: string; return_date?: string;
  pickup_time?: string; return_time?: string;
}>(r: T, itemId?: string): Array<T & { site_period_key?: string }> {
  if (r.account_slug !== "dbcinema_web" || r.site_item_windows === undefined) return [r];
  const groups = new Map<string, NonNullable<ResolvableRes["site_item_windows"]>>();
  for (const w of r.site_item_windows) {
    if (itemId !== undefined && String(w.item_id) !== itemId) continue;
    const {start,end}=websiteWindowDates(w);
    const pickup = w.pickupTime === undefined ? r.pickup_time : w.pickupTime;
    const ret = w.returnTime === undefined ? r.return_time : w.returnTime;
    const key = JSON.stringify([start, end, pickup ?? null, ret ?? null]);
    const rows = groups.get(key) ?? []; rows.push(w); groups.set(key, rows);
  }
  return [...groups].map(([key, windows]) => {
    const w = windows[0];
    const {start,end}=websiteWindowDates(w);
    return { ...r, site_period_key: key, site_item_windows: windows,
      start_date: start, pickup_date: start, end_date: end, return_date: end,
      pickup_time: (w.pickupTime === undefined ? r.pickup_time : w.pickupTime) ?? undefined,
      return_time: (w.returnTime === undefined ? r.return_time : w.returnTime) ?? undefined };
  });
}

/** v2 endpoints are genuine UTC instants; an unknown return occupies through
 * the final local day, so midnight-exclusive belongs to the preceding day. */
function websiteWindowDates(w:NonNullable<ResolvableRes["site_item_windows"]>[number]){
 if(w.endExclusive===true&&w.stockWindowVersion===2)return {start:w.pickupDate??londonStockLabel(w.start).slice(0,10),end:w.returnDate??londonStockLabel(w.end-(w.turnaroundBufferMinutes??0)*60_000-(w.returnTime==null?1:0)).slice(0,10)};
 return {start:new Date(w.start).toISOString().slice(0,10),end:new Date(w.end).toISOString().slice(0,10)};
}
