import { confirmedClock, londonStockLabel, londonStockInstant, bufferedStockEnd, TURNAROUND_BUFFER_MINUTES } from "./confirmed_schedule";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { bestMatch } from "./item_name_match";
import { claimHoldsStock } from "./availability";
import { effStart } from "./double_booking";
import { dedupByLogicalRental } from "./reservations/predicates";
import { buildOverrideMap, buildProductIndexMap, reservationItemUnits } from "./reservations/itemUnits";
import { defaultAdapterUnits } from "./default_adapter_units";

export type StockRequest = {
  item_name: string;
  start_date: string;
  end_date: string;
  quantity?: number;
  pickup_time?: string;
  return_time?: string;
  thread_id?: string;
};

export function validIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}

export function shiftStockDate(date: string, days: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
}

export type Occupancy = {
  start: string;
  end: string;
  qty: number;
  startInstant?:number;
  endInstant?:number;
  renter_name?: string | null;
  order_id?: string;
  /** Account + renter identity + complete physical basket, never name alone. */
  extension_key?: string;
};
type DateBlock = { start_date: string; end_date: string };

/** Half-open occupancy windows; check the peak, never the sum of disjoint hires. */
export function stockWindowPeak(occupancy: Occupancy[], start: string, end: string): number {
  const instants = new Set([start, ...occupancy.map((r) => r.start).filter((t) => t >= start && t < end)]);
  let peak = 0;
  for (const at of instants) {
    const extensions = new Map<string, number>();
    let independent = 0;
    for (const row of occupancy.filter((r) => r.start <= at && r.end > at)) {
      if (!row.extension_key) independent += row.qty;
      else extensions.set(row.extension_key, Math.max(extensions.get(row.extension_key) ?? 0, row.qty));
    }
    peak = Math.max(peak, independent + [...extensions.values()].reduce((sum, qty) => sum + qty, 0));
  }
  return peak;
}

export function evaluateStockWindow(args: {
  request: StockRequest;
  owned: boolean;
  total: number;
  repair: number;
  occupancy: Occupancy[];
  blackouts: DateBlock[];
  vacations: DateBlock[];
}) {
  const { request: r, owned, total, repair, occupancy, blackouts, vacations } = args;
  const quantity = r.quantity ?? 1;
  const validTime = (time?: string) => !time || /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const days = (Date.parse(r.end_date) - Date.parse(r.start_date)) / 86400000 + 1;
  if (!validIsoDate(r.start_date) || !validIsoDate(r.end_date) || days < 1 || days > 366 ||
      !Number.isInteger(quantity) || quantity < 1 || quantity > 20 || !validTime(r.pickup_time) || !validTime(r.return_time)) {
    return { available: null, reason: "invalid_request", total_units: total, requested_units: quantity, free_units: null, per_day: [], conflicts: [] };
  }
  const start = `${r.start_date}T${r.pickup_time ?? "00:00"}`;
  const end = r.return_time ? `${r.end_date}T${r.return_time}` : `${shiftStockDate(r.end_date, 1)}T00:00`;
  if (end <= start) return { available: null, reason: "invalid_request", total_units: total, requested_units: quantity, free_units: null, per_day: [], conflicts: [] };
  const intersects = (b: DateBlock) => b.start_date <= r.end_date && b.end_date >= r.start_date;
  const vacation = vacations.some(intersects);
  const blackout = blackouts.some(intersects);
  const perDay = Array.from({ length: days }, (_, i) => {
    const date = shiftStockDate(r.start_date, i);
    const dayStart = i === 0 ? start : `${date}T00:00`;
    const dayEnd = i === days - 1 ? end : `${shiftStockDate(date, 1)}T00:00`;
    const booked = stockWindowPeak(occupancy, dayStart, dayEnd);
    const blocked = [...blackouts, ...vacations].some((b) => b.start_date <= date && b.end_date >= date);
    return { date, booked, repair, total, free: !owned || blocked ? 0 : Math.max(0, total - repair - booked) };
  });
  const free = Math.min(...perDay.map((d) => d.free));
  return {
    available: owned && free >= quantity,
    reason: !owned ? "not_rentable" : vacation ? "owner_away" : blackout ? "owner_blocked" : free < quantity ? "insufficient_units" : "available",
    total_units: total,
    requested_units: quantity,
    free_units: free,
    per_day: perDay,
    conflicts: occupancy.filter((o) => o.start < end && o.end > start).map((o) => ({ start: o.start, end: o.end, qty: o.qty })),
  };
}

export async function loadStockSources(ctx: QueryCtx) {
  const [items, confirmed, ongoing, index, overrides, claims, blackouts, vacations] = await Promise.all([
    ctx.db.query("items").collect(),
    ctx.db.query("reservations").withIndex("by_status", (q) => q.eq("status", "confirmed")).collect(),
    ctx.db.query("reservations").withIndex("by_status", (q) => q.eq("status", "ongoing")).collect(),
    ctx.db.query("hygglo_product_index").collect(),
    ctx.db.query("listing_resolution_override").collect(),
    ctx.db.query("insurance_claims").collect(),
    ctx.db.query("owner_unavailability").collect(),
    ctx.db.query("vacation_periods").withIndex("by_active_start", (q) => q.eq("is_active", true)).collect(),
  ]);
  return { items, reservations: dedupByLogicalRental([...confirmed, ...ongoing].filter((r) => !r.is_obsolete && !r.hygglo_order_id?.startsWith("__probe__"))), productIndex: buildProductIndexMap(index), overrides: buildOverrideMap(overrides), claims, blackouts, vacations };
}

export function resolveStockItem(name: string, items: Doc<"items">[]) {
  const exact = items.filter((i) => i.name_canonical.trim().toLowerCase() === name.trim().toLowerCase());
  if (exact.length === 1) return { match: exact[0], confident: true, ambiguousWith: [] };
  return bestMatch(name, items, (i) => i.name_canonical, (i) => i.aliases ?? []);
}

/** Forecast availability ends after the agreed return plus one-hour turnaround.
 * An overdue custody flag does not silently extend the booked period. */
function quotationEnd(r: {end_date:string;return_date?:string|null;return_time?:string;return_time_provenance?:import("../../src/lib/booking-schedule-evidence").ScheduleProof}) {
  return r.return_date && confirmedClock(r,"return",r.return_date) ? r.return_date : r.end_date;
}

/** Shared physical occupancy, including extensions, per-item windows and
 * agreed return windows. Callers project it without exposing renter identities. */
export function stockOccupancyForItem(sources: Awaited<ReturnType<typeof loadStockSources>>, item: Doc<"items">, request: StockRequest) {
  const occupancy: Occupancy[] = [];
  for (const r of sources.reservations) {
    // RETURNED is Hygglo's next-to-do step: the kit is still with its renter.
    // REVIEWED means return is complete, including while a review is pending.
    if (r.is_obsolete || r.order_step === "REVIEWED" || r.status === "completed") continue;
    // The requesting booking already occupies its units; it must not block itself.
    if (request.thread_id && r.hygglo_order_id === request.thread_id) continue;
    if (!r.start_date || !r.end_date) continue;
    if (r.account_slug === "dbcinema_web" && r.site_item_windows !== undefined) {
      const windows = r.site_item_windows.filter(w => String(w.item_id) === String(item._id));
      for (const w of windows) {
        if(w.endExclusive===true && w.stockWindowVersion===2){
          const endInstant=w.end+(TURNAROUND_BUFFER_MINUTES-(w.turnaroundBufferMinutes??0))*60_000;
          let start=londonStockLabel(w.start),end=londonStockLabel(endInstant);
          // A repeated DST clock cannot describe a positive interval in a
          // civil-label quote; keep its boundary day conservatively occupied.
          if(end<=start){start=start.slice(0,10)+"T00:00";end=shiftStockDate(end.slice(0,10),1)+"T00:00";}
          occupancy.push({start,end,startInstant:w.start,endInstant,qty:w.qty,renter_name:r.renter_name,order_id:r.hygglo_order_id});continue;
        }
        const pickup = new Date(w.start).toISOString().slice(0,10);
        const agreedReturn = new Date(w.end).toISOString().slice(0,10);
        const ret = agreedReturn;
        const pickupTime = w.pickupTime === undefined ? r.pickup_time : w.pickupTime;
        const returnTime = w.returnTime === undefined ? r.return_time : w.returnTime;
        const end = returnTime && /^([01]\d|2[0-3]):[0-5]\d$/.test(returnTime)
          ? `${ret}T${returnTime}`
          : `${shiftStockDate(ret,1)}T00:00`;
        occupancy.push({start:`${pickup}T${pickupTime ?? "00:00"}`,startInstant:londonStockInstant(`${pickup}T${pickupTime ?? "00:00"}`,"start"),...bufferedStockEnd(end),qty:w.qty,renter_name:r.renter_name,order_id:r.hygglo_order_id});
      }
      continue;
    }
    const units = reservationItemUnits(r, sources.productIndex, sources.overrides, sources.items);
    const qty = units.get(String(item._id)) ?? 0;
    if (qty <= 0) continue;
    const pickup = r.pickup_date && confirmedClock(r,"pickup",r.pickup_date) ? r.pickup_date : r.start_date;
    const ret = quotationEnd({...r,end_date:r.end_date});
    const returnTime = confirmedClock(r,"return",ret);
    let end = `${shiftStockDate(ret, 1)}T00:00`;
    if (returnTime && /^([01]\d|2[0-3]):[0-5]\d$/.test(returnTime)) {
      end = `${ret}T${returnTime}`;
    }
    let start = `${pickup}T${confirmedClock(r,"pickup",pickup) ?? "00:00"}`;
    if (end <= start) {
      // Historical logistics can put pickup after the saved return. Preserve
      // the authoritative booked days instead of emitting an impossible span
      // that prevents every storefront stock check. Custody stays unchanged.
      start = `${r.start_date}T00:00`;
      end = `${shiftStockDate(r.end_date, 1)}T00:00`;
    }
    const name = r.renter_name?.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    const renter = r.renter_id ? `id:${r.renter_id}` : name && !["unknown", "unknown renter", "?", "—"].includes(name) ? `name:${name}` : undefined;
    // Preserve same-kit extensions; sharing a battery or adapter does not make
    // two different kits one rental. Quantity is part of the complete basket.
    const extension_key = renter && r.account_slug ? JSON.stringify([r.account_slug, renter, [...units].sort(([a], [b]) => a.localeCompare(b))]) : undefined;
    occupancy.push({ start, startInstant:londonStockInstant(start,"start"), ...bufferedStockEnd(end), qty, renter_name: r.renter_name, order_id: r.hygglo_order_id, extension_key });
  }
  return occupancy;
}

export function stockForItem(sources: Awaited<ReturnType<typeof loadStockSources>>, item: Doc<"items">, request: StockRequest) {
  const occupancy = stockOccupancyForItem(sources,item,request);
  const repair = sources.claims.filter(claimHoldsStock).reduce((n, c) => n + (c.repair_item_ids ?? []).filter((id) => id === item._id).length, 0);
  const result = evaluateStockWindow({ request, owned: item.status === "active" && !item.is_marketing_only && item.qty > 0, total: item.qty, repair, occupancy, blackouts: sources.blackouts.filter((b) => b.item_id === item._id), vacations: sources.vacations });
  return { ...result, ...(item.quantity_basis ? { quantity_basis: item.quantity_basis } : {}), item_name: item.name_canonical, item_id: item._id, kind: item.kind, owned: item.status === "active" && !item.is_marketing_only && item.qty > 0, is_marketing_only: item.is_marketing_only === true, buffer_minutes: TURNAROUND_BUFFER_MINUTES, source: "shared_inventory_confirmed_rentals", checked_at: Date.now() };
}

export async function checkRentalStock(ctx: QueryCtx, request: StockRequest) {
  const sources = await loadStockSources(ctx);
  const resolved = resolveStockItem(request.item_name, sources.items);
  if (!resolved.confident || !resolved.match) {
    return { available: null, found: false, owned: null, reason: resolved.ambiguousWith.length ? "ambiguous_item" : "unknown_item", item_name: request.item_name, free_units: null, total_units: null, requested_units: request.quantity ?? 1, per_day: [], conflicts: [], alternatives: resolved.ambiguousWith.map((i) => i.name_canonical), checked_at: Date.now() };
  }
  return { found: true, ...stockForRentalItem(sources, resolved.match, request), alternatives: [] };
}

/** Rentable camera offering includes its recorded supplied adapters. Keep
 * stockForItem physical-only for component receipts and basket aggregation. */
export function stockForRentalItem(sources:Awaited<ReturnType<typeof loadStockSources>>,item:Doc<"items">,request:StockRequest) {
  const primary=stockForItem(sources,item,request);
  if (primary.reason === "invalid_request") return primary;
  const defaults=defaultAdapterUnits(item,sources.items);
  if (!defaults.components.length && !defaults.unresolved.length) return primary;
  const components=[{...primary,units_per_item:1},...defaults.components.map(c=>{
    const adapter=sources.items.find(i=>String(i._id)===c.item_id)!;
    return {...stockForItem(sources,adapter,{...request,item_name:adapter.name_canonical,quantity:c.qty*(request.quantity??1)}),units_per_item:c.qty};
  })];
  const negative=components.some(c=>c.available===false);
  const available=negative?false:defaults.unresolved.length?null:components.every(c=>c.available===true)?true:null;
  const free=defaults.unresolved.length?null:Math.min(...components.map(c=>c.free_units==null?0:Math.floor(c.free_units/c.units_per_item)));
  const total=Math.min(...components.map(c=>Math.floor(c.total_units/c.units_per_item)));
  const per_day=primary.per_day.map(day=>({...day,free:Math.min(...components.map(c=>{
    const date=c.per_day.find(d=>d.date===day.date);
    return date?Math.floor(date.free/c.units_per_item):0;
  }))}));
  return {...primary,available,free_units:free,total_units:total,per_day,reason:negative?"supplied_component_unavailable":available===true?"available":"unresolved_default_adapter",
    source:"item_with_supplied_adapters",components,unresolved_default_adapters:defaults.unresolved};
}
