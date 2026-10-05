import { mutation, query, requireOwner } from "./owner_functions";
import { v } from "convex/values";
import type {MutationCtx,QueryCtx} from "./_generated/server";
import type {Doc,Id} from "./_generated/dataModel";

async function currentOverride(ctx:QueryCtx,account:string,product:number) {
  const rows=await ctx.db.query("listing_resolution_override").withIndex("by_account_product",q=>q.eq("account_slug",account).eq("product_id",product)).collect();
  if(rows.length>1)throw new Error("Duplicate listing mappings need reconciliation before editing");
  return rows[0]??null;
}
function checkRevision(existing:Doc<"listing_resolution_override">|null,expected:string|undefined) {
  if(expected!==undefined&&expected!==JSON.stringify(existing))throw new Error("The mapping changed. Reload it before saving");
}
async function recordMappingChange(ctx:MutationCtx,before:Doc<"listing_resolution_override">|null,after:unknown,op:"insert"|"update"|"delete") {
  const identity=await ctx.auth.getUserIdentity();
  await ctx.db.insert("audit_log",{table_name:"listing_resolution_override",actor:identity?.subject??"owner-service",op,count:1,source_file:"listing_overrides",note:JSON.stringify({before,after}),ts:Date.now()});
  const settings=await ctx.db.query("settings").first();
  if(settings)await ctx.db.patch(settings._id,{draft_epoch:(settings.draft_epoch??0)+1});
}

/** All audit-authoritative listing→item overrides (for the resolver maps). */
export const getAll = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("listing_resolution_override").collect();
    return rows.map((r) => ({
      account_slug: r.account_slug,
      product_id: r.product_id,
      components: r.components.map((c) => ({ item_id: String(c.item_id), qty: c.qty })),
      note: r.note ?? null,
      revision: JSON.stringify(r),
    }));
  },
});

/** A scoped snapshot for dashboard edits; avoids fetching every mapping. */
export const getRevision=query({args:{account_slug:v.string(),product_id:v.number()},handler:async(ctx,a)=>{
  try{return {available:true as const,revision:JSON.stringify(await currentOverride(ctx,a.account_slug,a.product_id))};}
  catch(error){return {available:false as const,message:error instanceof Error?error.message:"Mapping unavailable"};}
}});

/** Pin a Hygglo listing (account#product_id) to its true item composition. */
export const setOverride = mutation({
  args: {
    account_slug: v.string(),
    product_id: v.number(),
    components: v.array(v.object({ item_id: v.id("items"), qty: v.number() })),
    note: v.optional(v.string()),
    expected_revision: v.optional(v.string()),
    dry_run: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx,true);
    if(!args.account_slug.trim()||args.account_slug!==args.account_slug.trim()||args.account_slug.length>80||!Number.isSafeInteger(args.product_id)||args.product_id<=0)throw new Error("Select an existing account and listing");
    const [existing,product,listing]=await Promise.all([
      currentOverride(ctx,args.account_slug,args.product_id),
      ctx.db.query("hygglo_products").withIndex("by_account_product",q=>q.eq("accountSlug",args.account_slug).eq("productId",args.product_id)).first(),
      ctx.db.query("online_listings").withIndex("by_account_product",q=>q.eq("account_slug",args.account_slug).eq("product_id",args.product_id)).first(),
    ]);
    // Previously observed listings can disappear from the public catalogue;
    // dashboard fee/marketing pins must still resolve those known IDs.
    const observed=!product&&!listing?await ctx.db.query("hygglo_product_index").withIndex("by_account_product",q=>q.eq("account_slug",args.account_slug).eq("product_id",args.product_id)).first():null;
    if(!product&&!listing&&!observed)throw new Error("That listing does not exist in this account");
    checkRevision(existing,args.expected_revision);
    if(args.components.length>100||args.note&&args.note.length>2000)throw new Error("Keep the mapping and review note within the supported limits");
    const totals=new Map<Id<"items">,number>();
    for(const c of args.components){
      if(!Number.isSafeInteger(c.qty)||c.qty<=0)throw new Error("Physical item quantities must be positive whole numbers");
      totals.set(c.item_id,(totals.get(c.item_id)??0)+c.qty);
    }
    const components=await Promise.all([...totals].sort(([a],[b])=>String(a).localeCompare(String(b))).map(async([item_id,qty])=>{
      const item=await ctx.db.get(item_id);
      if(!item||item.status!=="active"||item.is_marketing_only||!Number.isFinite(item.qty)||item.qty<=0)throw new Error("Select currently owned rentable inventory");
      if(!Number.isSafeInteger(qty)||qty>item.qty)throw new Error(`The kit requires more ${item.name_canonical} units than the inventory owns`);
      return {item_id,qty};
    }));
    const doc = {
      account_slug: args.account_slug,
      product_id: args.product_id,
      components,
      note: args.note?.trim()||undefined,
      source: "manual_audit",
      updated_at: Date.now(),
    };
    if(args.dry_run)return {preview:true,product_id:args.product_id,components,updated:existing?1:0,inserted:existing?0:1};
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      await recordMappingChange(ctx,existing,doc,"update");
      return { updated: 1, product_id: args.product_id };
    }
    await ctx.db.insert("listing_resolution_override", doc);
    await recordMappingChange(ctx,null,doc,"insert");
    return { inserted: 1, product_id: args.product_id };
  },
});

export const remove = mutation({
  args: { account_slug: v.string(), product_id: v.number(), expected_revision:v.optional(v.string()),dry_run:v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx,true);
    const existing=await currentOverride(ctx,args.account_slug,args.product_id);
    checkRevision(existing,args.expected_revision);
    if(args.dry_run)return {preview:true,deleted:existing?1:0};
    if (existing) {
      await ctx.db.delete(existing._id);
      await recordMappingChange(ctx,existing,null,"delete");
      return { deleted: 1 };
    }
    return { deleted: 0 };
  },
});
