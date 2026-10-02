import { internalMutation, internalQuery } from "./_generated/server";
import { defaultAdapterUnits } from "./lib/default_adapter_units";

const CAMERA_NAMES = ["BMPCC 6K Pro", "BMPCC 6K Full Frame"];
const POOL_NAME = "NP-F570 batteries";
const SOURCE = "Owner confirmation 2026-10-02: native NP-F570; total 'like over 12'. Kit allocations retain the recorded five batteries per camera.";

/** One-time, repeatable catalog repair. No rental, message, price or legacy pack edits. */
export const run = internalMutation({ args: {}, handler: async ctx => {
  const items = await ctx.db.query("items").collect();
  const cameras = CAMERA_NAMES.map(name => {
    const matches = items.filter(i => i.name_canonical === name);
    if (matches.length !== 1) throw new Error(`Review camera identity: ${name}`);
    const camera = matches[0];
    if (camera.kind !== "camera" || camera.is_marketing_only || camera.unit_kind !== "unit" ||
      !camera.compatibility?.batteries?.includes("NP-F570") ||
      !camera.compatibility.included_with_rental?.some(s => /(?:5\s*[x×].*NP-F570|NP-F570.*5\s*[x×])/i.test(s))) {
      throw new Error(`Review recorded five-battery kit: ${name}`);
    }
    return camera;
  });
  const now = Date.now();
  const matches = items.filter(i => i.name_canonical === POOL_NAME);
  if (matches.length > 1) throw new Error("Duplicate NP-F570 pool; review before repair");
  let poolId = matches[0]?._id;
  if (poolId) {
    const pool = matches[0];
    if (pool.quantity_basis?.source !== SOURCE || !pool.track_independent_stock || pool.unit_kind !== "unit")
      throw new Error("Existing NP-F570 pool requires review; refusing to overwrite");
  } else {
    poolId = await ctx.db.insert("items", {
      name_canonical: POOL_NAME, display_name: "NP-F570 batteries", name_input: POOL_NAME,
      slug: "np-f570-batteries", kind: "power", battery_type: "NP-F570", unit_kind: "unit",
      qty: 12, track_independent_stock: true,
      quantity_basis: {basis:"owner_lower_bound",source:SOURCE,
        note:"12 is the conservative allocatable lower bound. Owner reported more than 12; exact total is unconfirmed.",recorded_at:now},
      notes:"Counted physical battery pool shared by both Blackmagic kits. Five per camera comes from existing kit records. The legacy BMPCC battery pack and its £40 pack value are preserved separately; no individual battery price or value has been inferred.",
      aliases:["NP-F570 battery", "Blackmagic NP-F570 batteries"],
      is_marketing_only:false, status:"active", created_at:now, updated_at:now,
    });
  }
  for (const camera of cameras) {
    const previous = camera.supplied_stock ?? [];
    const existing = previous.filter(c => String(c.item_id) === String(poolId));
    if (existing.some(c => c.qty !== 5 || c.source !== SOURCE))
      throw new Error(`Changed kit allocation requires review: ${camera.name_canonical}`);
    const allocations = previous.filter(c => String(c.item_id) !== String(poolId));
    allocations.push({item_id:poolId,qty:5,source:SOURCE});
    await ctx.db.patch(camera._id,{supplied_stock:allocations,updated_at:now});
  }
  return {pool_id:poolId,conservative_units:matches[0]?.qty ?? 12,exact_total_confirmed:false,
    allocations:cameras.map(i=>({camera:i.name_canonical,battery_units:5})),legacy_pack_unchanged:true};
} });

export const verify = internalQuery({args:{},handler:async ctx=>{
  const items=await ctx.db.query("items").collect();
  const pool=items.find(i=>i.name_canonical===POOL_NAME);
  return {pool:pool?{item_id:pool._id,name:pool.name_canonical,qty:pool.qty,unit_kind:pool.unit_kind,
    quantity_basis:pool.quantity_basis,track_independent_stock:pool.track_independent_stock,
    replacement_cost_gbp:pool.replacement_cost_gbp??null}:null,
    cameras:items.filter(i=>CAMERA_NAMES.includes(i.name_canonical)).map(i=>({name:i.name_canonical,
      supplied:defaultAdapterUnits(i,items)})),
    legacy_pack:items.filter(i=>i.name_canonical==="BMPCC battery pack").map(i=>({id:i._id,qty:i.qty,replacement_cost_gbp:i.replacement_cost_gbp??null}))};
}});
