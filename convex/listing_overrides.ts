import { deleteStockInput, insertStockInput, patchStockInput } from "./lib/stock_input_writes";
import { mutation, query, requireOwner } from "./owner_functions";
import { v } from "convex/values";
import type {MutationCtx,QueryCtx} from "./_generated/server";
import type {Doc,Id} from "./_generated/dataModel";
import { componentReplacementInventoryFingerprint, missingComponentMatchesSellerCopy } from "./lib/componentReplacementEvidence";

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
      const sameComponents = JSON.stringify(existing.components) === JSON.stringify(components);
      const patch = { ...doc, ...(sameComponents ? {} : { component_replacements: undefined }) };
      await patchStockInput(ctx, existing._id, patch);
      await recordMappingChange(ctx,existing,{ ...existing, ...patch },"update");
      return { updated: 1, product_id: args.product_id };
    }
    await insertStockInput(ctx, "listing_resolution_override", doc);
    await recordMappingChange(ctx,null,doc,"insert");
    return { inserted: 1, product_id: args.product_id };
  },
});

export const getComponentReplacements = query({
  args: { account_slug: v.string(), product_id: v.number() },
  handler: async (ctx, args) => {
    await requireOwner(ctx, true);
    const existing = await currentOverride(ctx, args.account_slug, args.product_id);
    const replacements = existing?.component_replacements ?? [];
    const ids = [...new Set(replacements.flatMap(rule => [rule.original_item_id, rule.replacement_item_id]).filter((id): id is typeof replacements[number]["replacement_item_id"] => !!id))];
    const items = await Promise.all(ids.map(id => ctx.db.get(id)));
    const componentNames = Object.fromEntries(items.filter(item => !!item).map(item => [String(item!._id), item!.display_name ?? item!.name_canonical]));
    return { revision: JSON.stringify(existing), replacements, componentNames, checkoutAvailable: false as const };
  },
});

export const setComponentReplacements = mutation({
  args: {
    account_slug: v.string(), product_id: v.number(), expected_revision: v.string(),
    replacements: v.array(v.object({ original_item_id: v.optional(v.id("items")), missing_original: v.optional(v.object({descriptor_id:v.string(),label:v.string(),quantity:v.number(),source_url:v.string(),source_excerpt:v.string()})), replacement_item_id: v.id("items"), qty: v.number(), price_adjustment_pence: v.number(), extension_adjustment_pence: v.optional(v.array(v.number())), replacement_size_score: v.number(), weights: v.array(v.object({item_id:v.id("items"),weight_grams:v.number()})), review_note: v.string() })),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, true);
    const existing = await currentOverride(ctx, args.account_slug, args.product_id);
    checkRevision(existing, args.expected_revision);
    if (!existing || args.account_slug !== "dbcinema" || !existing.components.length || args.replacements.length > 25)
      throw Error("Select a mapped DB Cinema listing.");
    const listing = await ctx.db.query("online_listings").withIndex("by_account_product", q => q.eq("account_slug", args.account_slug).eq("product_id", args.product_id)).first();
    const pairs = new Set<string>();
    const replacements = await Promise.all(args.replacements.map(async replacement => {
      const original = existing.components.find(component => component.item_id === replacement.original_item_id);
      const missing = replacement.missing_original;
      const missingValid = !!missing && /^declared:[a-z0-9][a-z0-9_-]{0,100}$/.test(missing.descriptor_id) && missing.label.trim().length > 1 && missing.label.length <= 200 &&
        Number.isSafeInteger(missing.quantity) && missing.quantity > 0 && missing.source_excerpt.trim().length >= 10 && missing.source_excerpt.length <= 1000 &&
        /^https:\/\/[^\s]+$/i.test(missing.source_url) && missing.source_url.length <= 1000;
      const pair = JSON.stringify([replacement.original_item_id ?? missing?.descriptor_id, replacement.replacement_item_id]);
      const note = replacement.review_note.trim();
      if ((!!replacement.original_item_id === !!missing) || (!original && !missingValid) || (missing && !missingComponentMatchesSellerCopy(missing, listing)) || replacement.original_item_id === replacement.replacement_item_id || pairs.has(pair) ||
          !Number.isSafeInteger(replacement.qty) || replacement.qty < 1 || replacement.qty > (original?.qty ?? missing?.quantity ?? 0) || (missing && replacement.qty !== missing.quantity) ||
          !Number.isSafeInteger(replacement.price_adjustment_pence) || (replacement.extension_adjustment_pence !== undefined && (replacement.extension_adjustment_pence.length !== 30 || replacement.extension_adjustment_pence.some(amount => !Number.isSafeInteger(amount) || Math.abs(amount) > 100000000))) || !Number.isSafeInteger(replacement.replacement_size_score) || replacement.replacement_size_score < 1 || replacement.replacement_size_score > 5 || note.length < 10 || note.length > 500)
        throw Error("Check the substitution, quantity, price and review note.");
      pairs.add(pair);
      const required = new Set([...existing.components.map(component => String(component.item_id)), String(replacement.replacement_item_id)]);
      if (replacement.weights.length !== required.size || new Set(replacement.weights.map(weight => String(weight.item_id))).size !== required.size ||
          replacement.weights.some(weight => !required.has(String(weight.item_id)) || !Number.isSafeInteger(weight.weight_grams) || weight.weight_grams < 1))
        throw Error("Enter a positive weight for every physical component.");
      const item = await ctx.db.get(replacement.replacement_item_id);
      if (!item || item.status !== "active" || item.is_marketing_only || !Number.isSafeInteger(item.qty) || item.qty < replacement.qty ||
          !Number.isFinite(item.replacement_cost_gbp) || (item.replacement_cost_gbp ?? 0) <= 0)
        throw Error("The replacement needs active owned stock and a verified value.");
      const inventory = await Promise.all([...required].map(id => ctx.db.get(id as Id<"items">)));
      if (inventory.some(unit => !unit || unit.status !== "active" || unit.is_marketing_only || !Number.isSafeInteger(unit.qty) || unit.qty < 1 ||
          !Number.isFinite(unit.replacement_cost_gbp) || (unit.replacement_cost_gbp ?? 0) <= 0))
        throw Error("Every component needs active owned stock and a verified value.");
      return { ...replacement, review_note: note, reviewed_at: Date.now(), inventory_fingerprint: componentReplacementInventoryFingerprint(inventory) };
    }));
    const patch = { component_replacements: replacements, updated_at: Date.now() };
    await ctx.db.patch(existing._id, patch);
    await recordMappingChange(ctx, existing, { ...existing, ...patch }, "update");
    return { reviewed: replacements.length, checkoutAvailable: false as const };
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
      await deleteStockInput(ctx, existing._id);
      await recordMappingChange(ctx,existing,null,"delete");
      return { deleted: 1 };
    }
    return { deleted: 0 };
  },
});
