import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { bestMatch } from "./item_name_match";
import { claimHoldsStock } from "./availability";
import { extensionOccupancyQty, effStart, effEnd } from "./double_booking";
import { dedupByLogicalRental } from "./reservations/predicates";
import { buildOverrideMap, buildProductIndexMap, reservationItemUnits } from "./reservations/itemUnits";
import { londonToday } from "./effectiveDates";
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

type Occupancy = {
  start: string;
  end: string;
  qty: number;
  renter_name?: string | null;
  order_id?: string;
};
type DateBlock = { start_date: string; end_date: string };

/** Half-open occupancy windows; check the peak, never the sum of disjoint hires. */
export function stockWindowPeak(occupancy: Occupancy[], start: string, end: string): number {
  const instants = new Set([start, ...occupancy.map((r) => r.start).filter((t) => t >= start && t < end)]);
  let peak = 0;
  for (const at of instants) {
    peak = Math.max(peak, extensionOccupancyQty(occupancy.filter((r) => r.start <= at && r.end > at)));
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

export function stockForItem(sources: Awaited<ReturnType<typeof loadStockSources>>, item: Doc<"items">, request: StockRequest) {
  const today = londonToday();
  const occupancy: Occupancy[] = [];
  for (const r of sources.reservations) {
    // The requesting booking already occupies its units; it must not block itself.
    if (request.thread_id && r.hygglo_order_id === request.thread_id) continue;
    if (!r.start_date || !r.end_date) continue;
    const qty = reservationItemUnits(r, sources.productIndex, sources.overrides, sources.items).get(String(item._id)) ?? 0;
    if (qty <= 0) continue;
    const pickup = effStart({ start_date: r.start_date, pickup_date: r.pickup_date });
    const ret = effEnd({ end_date: r.end_date, return_date: r.return_date, status: r.status, order_step: r.order_step }, today);
    const returnTime = ret > (r.return_date ?? r.end_date) ? undefined : r.return_time;
    let end = `${shiftStockDate(ret, 1)}T00:00`;
    if (returnTime && /^([01]\d|2[0-3]):[0-5]\d$/.test(returnTime)) {
      // The buffer carries into the following date instead of wrapping to 00:xx.
      end = new Date(Date.parse(`${ret}T${returnTime}:00Z`) + 3600000).toISOString().slice(0, 16);
    }
    occupancy.push({ start: `${pickup}T${r.pickup_time ?? "00:00"}`, end, qty, renter_name: r.renter_name, order_id: r.hygglo_order_id });
  }
  const repair = sources.claims.filter(claimHoldsStock).reduce((n, c) => n + (c.repair_item_ids ?? []).filter((id) => id === item._id).length, 0);
  const result = evaluateStockWindow({ request, owned: item.status === "active" && !item.is_marketing_only && item.qty > 0, total: item.qty, repair, occupancy, blackouts: sources.blackouts.filter((b) => b.item_id === item._id), vacations: sources.vacations });
  return { ...result, ...(item.quantity_basis ? { quantity_basis: item.quantity_basis } : {}), item_name: item.name_canonical, item_id: item._id, kind: item.kind, owned: item.status === "active" && !item.is_marketing_only && item.qty > 0, is_marketing_only: item.is_marketing_only === true, buffer_minutes: 60, source: "shared_inventory_confirmed_rentals", checked_at: Date.now() };
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
