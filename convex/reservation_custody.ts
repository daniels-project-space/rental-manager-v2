import { v } from "convex/values";
import { mutation, query, requireOwner } from "./owner_functions";
import { internal } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { dedupByLogicalRental } from "./lib/reservations/predicates";
import { buildProductIndexMap, reservationItemUnits } from "./lib/reservations/itemUnits";
import { loadCanonicalListingAllocation, reservedListingKeys } from "./lib/canonical_listing_allocation";
import { confirmedCustodyGroup, custodyBasis, custodySourceBasis, custodyRenterKey, custodyUnitsKey } from "./lib/reservation_custody";
import { validIsoDate } from "./lib/renter_stock";

async function findBooking(ctx: QueryCtx, account: string, order: string) {
  const copies = await ctx.db.query("reservations").withIndex("by_account_order",q => q.eq("account_slug",account).eq("hygglo_order_id",order)).take(6);
  if (copies.length > 5) throw Error("Reconcile duplicate booking imports before linking custody");
  const row = dedupByLogicalRental(copies)[0];
  return account === "dbcinema_web" ? null : row ?? null;
}
async function booking(ctx: QueryCtx, account: string, order: string) {
  const row=await findBooking(ctx,account,order);
  if (!row) throw Error("Provider booking not found in this account");
  return row;
}

async function allocation(ctx: QueryCtx, rows: Doc<"reservations">[]) {
  // Visible owner controls only. The shared inventory catalogue is bounded;
  // never truncate it and silently confirm an incomplete physical basket.
  const items = await ctx.db.query("items").withIndex("by_canonical_name").take(2001);
  if (items.length > 2000) throw Error("Inventory catalogue needs a paged custody resolver");
  const keys = reservedListingKeys(rows);
  if (keys.length > 200) throw Error("Too many listing components for one custody decision");
  const [index,overrides] = await Promise.all([
    Promise.all(keys.map(k => ctx.db.query("hygglo_product_index").withIndex("by_account_product",q => q.eq("account_slug",k.account).eq("product_id",k.productId)).first())),
    Promise.all(keys.map(k => ctx.db.query("listing_resolution_override").withIndex("by_account_product",q => q.eq("account_slug",k.account).eq("product_id",k.productId)).order("desc").first())),
  ]);
  const productIndex = buildProductIndexMap(index.filter((r):r is Doc<"hygglo_product_index"> => r !== null));
  const overrideMap = await loadCanonicalListingAllocation(ctx,items,overrides.filter((r):r is Doc<"listing_resolution_override"> => r !== null),rows);
  const units = new Map(rows.map(r => [String(r._id),reservationItemUnits(r,productIndex,overrideMap,items)]));
  return {items,units};
}

function sameEquipment(a: Map<string,number>, b: Map<string,number>) {
  return !!custodyUnitsKey(a) && !!custodyUnitsKey(b) && a.size === b.size && [...a.keys()].every(id => b.has(id));
}
function eligible(current: Doc<"reservations">, original: Doc<"reservations">, a: Map<string,number>, b: Map<string,number>) {
  if (current._id === original._id || current.hygglo_order_id === original.hygglo_order_id ||
      current.account_slug !== original.account_slug || !custodyRenterKey(current) ||
      custodyRenterKey(current) !== custodyRenterKey(original) || current.is_obsolete || original.is_obsolete ||
      !["confirmed","ongoing"].includes(current.status) || !["confirmed","ongoing","completed"].includes(original.status) ||
      !current.start_date || !current.end_date || !original.start_date || !original.end_date ||
      ![current.start_date,current.end_date,original.start_date,original.end_date].every(validIsoDate) ||
      current.end_date < current.start_date || original.end_date < original.start_date ||
      original.start_date > current.start_date || original.end_date > current.end_date ||
      Date.parse(current.start_date+"T00:00Z") > Date.parse(original.end_date+"T00:00Z")+86400000) return false;
  return sameEquipment(a,b);
}
const pairBasis = (a:Doc<"reservations">,b:Doc<"reservations">,units:Map<string,Map<string,number>>) =>
  JSON.stringify([custodySourceBasis(a,units.get(String(a._id))!),custodySourceBasis(b,units.get(String(b._id))!)]);

export const get = query({
  args:{account_slug:v.string(),order_id:v.string(),cursor:v.optional(v.string()),original_order_id:v.optional(v.string())},
  handler:async(ctx,args) => {
    await requireOwner(ctx,true);
    const current = await booking(ctx,args.account_slug,args.order_id);
    const searched = args.original_order_id ? await findBooking(ctx,args.account_slug,args.original_order_id) : null;
    const page = args.original_order_id
      ? {page:searched ? [searched] : [],isDone:true,continueCursor:""}
      : await ctx.db.query("reservations").withIndex("by_account_start",q => q.eq("account_slug",args.account_slug).lte("start_date",current.start_date)).order("desc").paginate({numItems:20,cursor:args.cursor ?? null});
    const candidates = dedupByLogicalRental(page.page).filter(r => r._id !== current._id);
    const {items,units} = await allocation(ctx,[current,...candidates]);
    const currentUnits = units.get(String(current._id))!;
    const currentBasis = custodyBasis(current,currentUnits);
    return {
      reservation_id:current._id,can_link:["confirmed","ongoing"].includes(current.status) && !current.is_obsolete && !!current.start_date && !!current.end_date,
      group_id:current.stock_custody_group_id ?? null,linked:!!confirmedCustodyGroup(current,currentUnits),
      note:current.stock_custody_provenance?.note ?? null,basis:currentBasis,
      equipment:[...currentUnits].map(([id,qty]) => ({item_id:id,qty,name:items.find(i => String(i._id)===id)?.name_canonical ?? "Equipment"})),
      candidates:candidates.filter(r => eligible(current,r,currentUnits,units.get(String(r._id))!)).map(r => ({
        reservation_id:r._id,order_id:r.hygglo_order_id!,start_date:r.start_date!,end_date:r.end_date!,
        equipment:[...units.get(String(r._id))!].map(([id,qty]) => ({name:items.find(i => String(i._id)===id)?.name_canonical ?? "Equipment",qty})),
        basis:pairBasis(current,r,units),
      })),
      has_more:!page.isDone,next_cursor:page.continueCursor,
    };
  },
});

export const confirm = mutation({
  args:{account_slug:v.string(),order_id:v.string(),original_order_id:v.string(),basis:v.string(),note:v.string(),retained_equipment:v.literal(true)},
  handler:async(ctx,args) => {
    await requireOwner(ctx,true);
    const note = args.note.trim();
    if (note.length < 10 || note.length > 1000) throw Error("Describe the agreed continuous custody (10–1000 characters)");
    const current = await booking(ctx,args.account_slug,args.order_id),original = await booking(ctx,args.account_slug,args.original_order_id);
    const {units} = await allocation(ctx,[current,original]);
    if (pairBasis(current,original,units) !== args.basis) throw Error("Booking or equipment changed; reload before confirming custody");
    if (!eligible(current,original,units.get(String(current._id))!,units.get(String(original._id))!)) throw Error("Bookings must be in the same account, for the same renter and physical equipment, with continuous periods");
    const group = original.stock_custody_group_id ?? original._id;
    const root = await ctx.db.get(group);
    if (!root || root.account_slug !== args.account_slug || custodyRenterKey(root) !== custodyRenterKey(current)) throw Error("Invalid custody group");
    if (current.stock_custody_group_id && current.stock_custody_group_id !== group) throw Error("Undo the current custody link before choosing another original booking");
    const members = await ctx.db.query("reservations").withIndex("by_stock_custody_group",q => q.eq("stock_custody_group_id",group)).take(51);
    if (members.length > 49 && !members.some(r => r._id === current._id)) throw Error("Custody chain requires a new owner review");
    if ([current,original].every(r => r.stock_custody_group_id === group && confirmedCustodyGroup(r,units.get(String(r._id))!) && r.stock_custody_provenance?.note === note)) return {changed:false,group_id:group};
    const now = Date.now(),actor = (await ctx.auth.getUserIdentity())?.subject ?? "owner";
    for (const row of [original,current]) await ctx.db.patch(row._id,{stock_custody_group_id:group,stock_custody_provenance:{source:"owner_confirmation",order_id:row.hygglo_order_id!,account_slug:args.account_slug,renter_key:custodyRenterKey(row)!,units_key:custodyUnitsKey(units.get(String(row._id))!)!,start_date:row.start_date!,end_date:row.end_date!,confirmed_at:now,confirmed_by:actor,note}});
    await ctx.db.insert("audit_log",{table_name:"reservations",actor,op:"update",count:2,note:JSON.stringify({action:"confirm_continuous_custody",group_id:group,original_id:original._id,extension_id:current._id,note,previous:[original.stock_custody_provenance ?? null,current.stock_custody_provenance ?? null]}),ts:now});
    await ctx.scheduler.runAfter(0,internal.mv.calendar.refresh,{force:true});
    await ctx.scheduler.runAfter(0,internal.mv.stats_drawer.refresh,{force:true});
    return {changed:true,group_id:group};
  },
});

export const undo = mutation({
  args:{account_slug:v.string(),order_id:v.string(),basis:v.string(),note:v.string()},
  handler:async(ctx,args) => {
    await requireOwner(ctx,true);
    const current = await booking(ctx,args.account_slug,args.order_id),note=args.note.trim();
    if (note.length < 10 || note.length > 1000) throw Error("Record why this custody relationship is being removed (10–1000 characters)");
    const {units} = await allocation(ctx,[current]);
    if (custodyBasis(current,units.get(String(current._id))!) !== args.basis) throw Error("Booking or equipment changed; reload before removing custody");
    if (!current.stock_custody_group_id) return {changed:false,count:0};
    const members = current.stock_custody_group_id === current._id
      ? await ctx.db.query("reservations").withIndex("by_stock_custody_group",q => q.eq("stock_custody_group_id",current._id)).take(51) : [current];
    if (members.length > 50 || members.some(r => r.account_slug !== args.account_slug)) throw Error("Custody chain requires owner reconciliation");
    const actor=(await ctx.auth.getUserIdentity())?.subject ?? "owner",now=Date.now();
    for (const row of members) await ctx.db.patch(row._id,{stock_custody_group_id:undefined,stock_custody_provenance:undefined});
    await ctx.db.insert("audit_log",{table_name:"reservations",actor,op:"update",count:members.length,note:JSON.stringify({action:"undo_continuous_custody",group_id:current.stock_custody_group_id,removed:members.map(r => ({id:r._id,proof:r.stock_custody_provenance ?? null})),note}),ts:now});
    await ctx.scheduler.runAfter(0,internal.mv.calendar.refresh,{force:true});
    await ctx.scheduler.runAfter(0,internal.mv.stats_drawer.refresh,{force:true});
    return {changed:true,count:members.length};
  },
});
