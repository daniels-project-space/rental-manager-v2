import { previousReferralOffer } from "./lib/referral_offer";
import {acceptsReplacement,requiresReplacementTransaction} from "./lib/renter_replacement_acceptance";
import { additionMountRequirements } from "./lib/booking_addition_mount";
import { acceptsDateChange } from "./lib/renter_date_acceptance";
import { offeringConsentIdentity } from "./lib/offering_consent_identity";
import { acceptsRemoval } from "./lib/renter_removal_acceptance";
import { acceptsAddition } from "./lib/renter_addition_acceptance";
import { renterRequestsReadOnly, renterProhibitsItemChange, type ConsentInventoryItem } from "./lib/renter_booking_consent";
import { friendBasketReply, verificationFailureReply, requestsFriendBasketRestore, friendReferralCode } from "./lib/verification_failure";
import { listingDisplayCatalog } from "./lib/listing_display_catalog";
import { shortItemName } from "./lib/item_display_name";
import { internalMutation, mutation, query, internalMutationOf, internalQueryOf } from "./owner_functions";
import { v } from "convex/values";
import { baseListingProductIds } from "./lib/base_listing_identity";
import { bestMatch, isGenericItemQuery } from "./lib/item_name_match";
import type { PriceTier } from "./lib/hygglo_pricing";
import { inclusiveDays, summarise } from "./lib/renter_order_quote";
export { inclusiveDays, summarise } from "./lib/renter_order_quote";
import { checkRentalStock, validIsoDate, loadStockSources } from "./lib/renter_stock";
import { checkOrderRentalStock, resolveOrderPhysicalItems, sameOrderPhysicalItems, orderPhysicalIdentityKey, type OrderPhysicalItem } from "./lib/renter_order_stock";
import { loadListingInventory } from "./lib/listing_inventory";
import { getBotBooking, getLabOrder } from "./lib/renter_booking";
import { draftContextKey } from "./lib/draft_review";
import type { QueryCtx } from "./_generated/server";
import { rentalStage } from "./lib/rental_stage";
import { recentThreadMessages } from "./lib/thread_messages";
import { londonToday } from "./lib/effectiveDates";
import { performJointStockCheck } from "./renter_bot_tools";
import { recommendationRequirementValidator, recommendationRequirementsKey } from "./lib/recommendation_qualification";

async function prohibitsSelectedItems(ctx: QueryCtx, accountSlug:string, text:string, action:"add_item"|"remove_item", lines:Array<{product_id?:number;item_id?:string;name?:string;qty:number}>) {
  const inventory=await ctx.db.query("items").collect();
  const native:ConsentInventoryItem[]=inventory.map(item=>({id:String(item._id),name:item.name_canonical,aliases:item.aliases??[],kind:item.kind}));
  const selectedIds:string[]=[];
  for(const line of lines){
    const previousCount=selectedIds.length;
    if(line.product_id!=null){const mapping=await loadListingInventory(ctx,accountSlug,line.product_id,line.qty,{items:inventory});selectedIds.push(...mapping.components.map(c=>String(c.item_id)));}
    else if(line.item_id)selectedIds.push(String(line.item_id));
    if(selectedIds.length===previousCount && line.name){const id=`booked:${line.name}`;native.push({id,name:line.name});selectedIds.push(id);}
  }
  return renterProhibitsItemChange(text,action,native,selectedIds);
}

async function amendmentContext(ctx: QueryCtx, threadId: string) {
  const conv = await ctx.db.query("conversations").withIndex("by_thread", q => q.eq("thread_id", threadId)).first();
  return draftContextKey(await getBotBooking(ctx, threadId), conv?.inquiry_items, await getLabOrder(ctx, threadId));
}

async function additionConsent(ctx:QueryCtx,threadId:string,account:string,text:string,
  complete:ReturnType<typeof summarise>,addition:ReturnType<typeof summarise>,additionalCost:number,referralCode?:string) {
  if(!complete.start_date || !complete.end_date || complete.total_gbp==null ||
    addition.lines.some(l=>!Number.isInteger(l.product_id) || !l.product_id || l.line_total_gbp==null))return false;
  const messages=await recentThreadMessages(ctx,threadId,2);
  // recentThreadMessages returns oldest-to-newest within the selected window.
  const previous=messages.at(-2)?.sender==="owner" ? messages.at(-2) : undefined;
  const inventory=await ctx.db.query("items").collect();
  const identities=await Promise.all(addition.lines.map(line=>offeringConsentIdentity(ctx,account,line,inventory)));
  if(identities.some(i=>!i))return false;
  const physical=await resolveOrderPhysicalItems(ctx,account,complete.lines,inventory);
  if(!physical.items.length)return false;
  return acceptsAddition(text,{context_key:await amendmentContext(ctx,threadId),start_date:complete.start_date,end_date:complete.end_date,
    physical_identity_key:orderPhysicalIdentityKey(physical.items),
    total_gbp:complete.total_gbp,additional_cost_gbp:additionalCost,
    lines:addition.lines.map((l,index)=>({...identities[index]!,product_id:l.product_id!,name:l.name,qty:l.qty,line_total_gbp:l.line_total_gbp!,daily_rate_gbp:l.effective_rate_gbp??undefined,base_daily_rate_gbp:l.daily_price_gbp}))},previous && referralCode?{...previous,quoted_additions:previous.quoted_additions?.filter(p=>p.referral_code===referralCode)}:previous);
}

async function prepareDateChange(ctx:QueryCtx,row:NonNullable<Awaited<ReturnType<typeof getLabOrder>>>,start:string,end:string) {
  const booking=await getBotBooking(ctx,row.thread_id);
  const stage=rentalStage(booking,londonToday()).stage;
  if(booking?.return_date || ["COMPLETED","CANCELLED","VERIFICATION_FAILED"].includes(stage))return {ok:false as const,error:"This rental is closed. Arrange a new booking instead."};
  if(!validIsoDate(start) || !validIsoDate(end) || end<start || inclusiveDays(start,end)>366)
    return {ok:false as const,error:"Use valid pickup and return dates in order, up to 366 rental days."};
  const collected=!!booking?.pickup_date || booking?.status==="ongoing";
  if(collected && start!==row.start_date)return {ok:false as const,error:"The rental has already been collected. Keep its original pickup date when extending the return."};
  if(!collected && start<londonToday())return {ok:false as const,error:"An upcoming rental cannot be backdated. Quote pickup from today or later."};
  const base_quote=summarise(row.items,row.start_date,row.end_date),quote=summarise(row.items,start,end);
  if(!base_quote.start_date || !base_quote.end_date || !row.items.length || base_quote.total_gbp==null || quote.total_gbp==null)
    return {ok:false as const,error_code:"unpriced_booking",error:"The complete booking needs known Native dates and prices before a date quote or edit."};
  const stock=await checkOrderRentalStock(ctx,row.account_slug,row.items,start,end,row.thread_id);
  if(stock.available!==true)return {ok:false as const,error_code:"stock_unavailable_or_unknown",error:`Cannot change this basket to ${start} – ${end}: ${stock.reason}. No dates or prices were changed. A failed range check alone does not identify which individual day is booked.`,stock_receipts:stock.receipts};
  return {ok:true as const,preview_only:true as const,source:"native_lab_date_proposal" as const,thread_id:row.thread_id,
    physical_identity_key:stock.physical_identity_key,
    before_context_key:await amendmentContext(ctx,row.thread_id),base_items:row.items.map(i=>({name:i.name,quantity:i.qty})),
    quote,base_quote,price_delta_gbp:quote.total_gbp-base_quote.total_gbp,stock_receipts:stock.receipts};
}

export const quoteDateChange=query({
  args:{thread_id:v.string(),start_date:v.string(),end_date:v.string()},
  handler:async(ctx,args)=>{assertLabThread(args.thread_id);const row=await getLabOrder(ctx,args.thread_id);
    return row ? prepareDateChange(ctx,row,args.start_date,args.end_date) : {ok:false,error:"No simulated order for this session."};},
});

/**
 * The SIMULATED Hygglo order behind a Renter Bot Lab session.
 *
 * Purpose: let the bot actually add items, drop items and move dates in chat —
 * the same things a renter can do on Hygglo — so its item resolution and its
 * arithmetic can be watched, instead of being taken on trust from prose. It
 * also removes a dead end that was producing real failures: with no way to act
 * on "yes please, add it", the bot could only ask the renter to confirm again,
 * or claim an action it had not performed and be blocked by the guard.
 *
 * SAFETY: every entry point here refuses a thread id that is not `__probe__`.
 * Nothing in this file touches hygglo_messages, reservations, calendar_holds
 * or any send path. A real booking cannot be reached from here.
 */

export const LAB_PREFIX = "__probe__";

function assertLabThread(threadId: string) {
  if (!threadId.startsWith(LAB_PREFIX)) {
    throw new Error(
      "renter_bot_lab_order only operates on Lab/probe threads — refusing a real conversation",
    );
  }
}

/**
 * Hygglo counts rental days INCLUSIVELY: a pickup and return on the same date
 * is 1 day, and 23rd→24th is 2. Getting this wrong understates every total.
 */
type OrderLine = {
  display_name?: string;
  product_id?: number;
  item_id?: string;
  name: string;
  qty: number;
  daily_price_gbp?: number;
  pricing_basis?: "listing" | "catalog";
  price_tiers?: PriceTier[];
  origin: string;
};

/** Line totals + grand total, so the Lab and the bot quote the same numbers. */

/**
 * Daily price for one item on one account: its own listing (cheapest), else
 * the curated catalog. Identity-first, override ∪ index — the same order
 * lookup_pricing and find_owned_alternatives use, so the Lab panel, the tools
 * and the draft cannot quote three different numbers for one item.
 */
/** The listing id an item is priced from on this account (cheapest wins). */
async function listingPidForItem(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  accountSlug: string,
  itemId: string,
): Promise<number | undefined> {
  const listings = await ctx.db
    .query("online_listings")
    .withIndex("by_account", (q: { eq: (a: string, b: string) => unknown }) =>
      q.eq("account_slug", accountSlug),
    )
    .collect();
  const idx = await ctx.db.query("hygglo_product_index").collect();
  const ov = await ctx.db.query("listing_resolution_override").collect();
  const inventory = await ctx.db.query("items").collect();
  const pids = baseListingProductIds(accountSlug, itemId, idx, ov, inventory,listings);
  let best: { pid: number; price: number } | null = null;
  for (const pid of pids) {
    const l = listings.find((x: { product_id: number }) => x.product_id === pid) as
      | { daily_price?: number }
      | undefined;
    if (typeof l?.daily_price !== "number") continue;
    if (!best || l.daily_price < best.price || (l.daily_price === best.price && pid < best.pid)) best = { pid, price: l.daily_price };
  }
  return best?.pid;
}

async function resolveDailyPrice(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  accountSlug: string,
  itemId: string,
  itemName: string,
): Promise<number | undefined> {
  const listings = await ctx.db
    .query("online_listings")
    .withIndex("by_account", (q: { eq: (a: string, b: string) => unknown }) =>
      q.eq("account_slug", accountSlug),
    )
    .collect();
  const idx = await ctx.db.query("hygglo_product_index").collect();
  const ov = await ctx.db.query("listing_resolution_override").collect();
  const inventory = await ctx.db.query("items").collect();
  const pids = baseListingProductIds(accountSlug, itemId, idx, ov, inventory,listings);
  let price: number | undefined;
  for (const pid of pids) {
    const l = listings.find((x: { product_id: number }) => x.product_id === pid) as
      | { daily_price?: number }
      | undefined;
    if (typeof l?.daily_price === "number" && (price === undefined || l.daily_price < price))
      price = l.daily_price;
  }
  if (price === undefined) {
    const cat = await ctx.db.query("pricing_catalog").collect();
    const hit = cat.filter(
      (c: { item_name_canonical: string; marketing_only?: boolean; is_bundle?: boolean; daily_price_min:number }) =>
        !c.marketing_only && !c.is_bundle && c.daily_price_min > 0 &&
        c.item_name_canonical.toLowerCase().trim() === itemName.toLowerCase().trim(),
    ).sort((a: {daily_price_min:number}, b: {daily_price_min:number}) => a.daily_price_min-b.daily_price_min)[0] as { daily_price_min?: number } | undefined;
    price = hit?.daily_price_min;
  }
  return price;
}


/** Hygglo's tier table for a listing, from the daily-synced catalog cache. */
async function tiersForProduct(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  accountSlug: string,
  productId: number,
): Promise<PriceTier[] | undefined> {
  const hp = await ctx.db
    .query("hygglo_products")
    .withIndex("by_account_product", (q: { eq: (a: string, b: unknown) => unknown }) =>
      (q as unknown as { eq: (a: string, b: unknown) => { eq: (c: string, d: unknown) => unknown } })
        .eq("accountSlug", accountSlug)
        .eq("productId", productId),
    )
    .unique();
  const rows = (hp?.prices ?? []) as PriceTier[];
  return rows.length ? rows.map((r) => ({ days: r.days, pricePerDay: r.pricePerDay })) : undefined;
}

export const get = query({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const row = await ctx.db
      .query("renter_bot_lab_orders")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .unique();
    if (!row) return null;
    const display = await listingDisplayCatalog(ctx, row.account_slug);
    const booking = await getBotBooking(ctx, thread_id);
    const referral = await ctx.db.query("renter_bot_lab_referrals").withIndex("by_source", q => q.eq("source_thread_id", thread_id)).unique();
    return {
      ...summarise(
        row.items.map((i) => ({ ...i, display_name: i.product_id != null ? display.name(row.account_slug, i.product_id, i.name) : i.item_id ? shortItemName(display.itemMap.get(String(i.item_id)) ?? i.name) : shortItemName(i.name), item_id: i.item_id ? String(i.item_id) : undefined })),
        row.start_date,
        row.end_date,
      ),
      changes: row.changes,
      stage: rentalStage(booking, londonToday()).stage,
      referral_code: referral?.code,
      account_slug: row.account_slug,
    };
  },
});

/** Create/reset the simulated order when a Lab session starts. */
export const seed = internalMutation({
  args: {
    thread_id: v.string(),
    account_slug: v.string(),
    item_names: v.array(v.string()),
    start_date: v.optional(v.string()),
    end_date: v.optional(v.string()),
    /**
     * The Hygglo listing the renter is actually looking at.
     *
     * A renter books a LISTING at the listing's price, not a basket of item
     * rates. Seeding from item names priced the BMPCC 6K Pro at £35 — the
     * cheapest body-only listing — even when the scenario represented a set
     * that really costs more. Quoting an item rate for a set understates what
     * the renter pays, which is the one number they care about.
     */
    base_product_id: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    assertLabThread(a.thread_id);
    const existing = await ctx.db
      .query("renter_bot_lab_orders")
      .withIndex("by_thread", (q) => q.eq("thread_id", a.thread_id))
      .unique();
    if (await ctx.db.query("renter_bot_lab_referrals").withIndex("by_source", q => q.eq("source_thread_id", a.thread_id)).unique())
      throw new Error("A referred cancelled basket is immutable; start a new Lab session");
    if (existing) await ctx.db.delete(existing._id);

    const owned = (await ctx.db.query("items").collect()).filter(
      (i) => i.status === "active" && !i.is_marketing_only && (i.qty ?? 0) > 0,
    );
    const lines = [];
    if (a.base_product_id != null) {
      const listing = await ctx.db
        .query("online_listings")
        .withIndex("by_account_product", (q) =>
          q.eq("account_slug", a.account_slug).eq("product_id", a.base_product_id as number),
        )
        .unique();
      if (listing) {
        lines.push({
          item_id: undefined,
          product_id: a.base_product_id,
          // The listing IS the line, exactly as on Hygglo.
          name: (listing.name ?? "listing").slice(0, 70),
          qty: 1,
          daily_price_gbp: listing.daily_price,
          pricing_basis: "listing" as const,
          price_tiers: await tiersForProduct(ctx, a.account_slug, a.base_product_id as number),
          origin: "listing",
        });
      }
    }
    for (const name of lines.length ? [] : a.item_names) {
      const m = bestMatch(name, owned, (i) => i.name_canonical, (i) => (i.aliases ?? []) as string[]);
      const hit = m.match && m.confident ? m.match : null;
      const pricedPid = hit ? await listingPidForItem(ctx, a.account_slug, String(hit._id)) : undefined;
      // Price the SEEDED items too. Leaving them undefined made total_gbp null
      // for every scenario, so the bot was told "do not quote a total" on a
      // perfectly ordinary booking and the Lab panel could never show one.
      lines.push({
        item_id: hit ? hit._id : undefined,
        name: hit ? hit.name_canonical : name,
        qty: 1,
        daily_price_gbp: hit
          ? await resolveDailyPrice(ctx, a.account_slug, String(hit._id), hit.name_canonical)
          : undefined,
        pricing_basis: pricedPid != null ? "listing" as const : "catalog" as const,
        price_tiers: pricedPid != null ? await tiersForProduct(ctx, a.account_slug, pricedPid) : undefined,
        origin: "seed",
      });
    }
    await ctx.db.insert("renter_bot_lab_orders", {
      thread_id: a.thread_id,
      account_slug: a.account_slug,
      items: lines,
      start_date: a.start_date,
      end_date: a.end_date,
      changes: [],
      updated_at: Date.now(),
    });
    return { seeded: lines.length };
  },
});

/**
 * Apply one booking change. Called by the agent's `modify_booking` tool.
 *
 * Item resolution goes through the shared confident matcher, so "the 100mm
 * anamorphic" has to land on a real inventory row or the change is refused —
 * the bot cannot add something we do not own, and cannot silently add the
 * wrong thing.
 */
/** A single read-only quote for multiple exact offerings and retained gear. */
/** Preparation is shared by quoting and the single acceptance transaction. */
async function prepareEquipmentProposal(ctx: QueryCtx, a: {thread_id:string;items:Array<{product_id:number;qty:number}>;replacement?:{product_id:number;qty:number}}) {
    assertLabThread(a.thread_id);
    if(!a.items.length || a.items.length>8 || a.items.some(i=>!Number.isInteger(i.product_id)||i.product_id<1||!Number.isInteger(i.qty)||i.qty<1||i.qty>20))
      return {ok:false,error:"Use one to eight exact listing IDs with whole quantities from 1 to 20."};
    const row=await getLabOrder(ctx,a.thread_id);
    const booking=await getBotBooking(ctx,a.thread_id);
    if(!row)return {ok:false,error:"No simulated order for this session."};
    if(!row.items.length)return {ok:false,error:"There is no existing basket. Use exact standalone item pricing for a new inquiry."};
    const stage=rentalStage(booking,londonToday()).stage;
    if(booking?.return_date || ["COMPLETED","CANCELLED","VERIFICATION_FAILED"].includes(stage))
      return {ok:false,error:"This rental is closed. Arrange a new booking rather than quoting additions."};
    if(!row.start_date || !row.end_date)return {ok:false,error:"Confirm pickup and return dates before quoting additions."};
    let retained=row.items;
    let removed:typeof row.items=[];
    if(a.replacement) {
      if(booking?.pickup_date || ["IN_USE","RETURN_OVERDUE"].includes(stage))return {ok:false,error:"Collected equipment needs owner return confirmation before a replacement quote."};
      const selected=row.items.filter(l=>l.product_id===a.replacement!.product_id);
      if(selected.length!==1 || !Number.isInteger(a.replacement.product_id) || a.replacement.product_id<1 || !Number.isInteger(a.replacement.qty) || a.replacement.qty<1 || a.replacement.qty>selected[0].qty)
        return {ok:false,error:"Select an exact current listing and a valid quantity to replace."};
      removed=[{...selected[0],qty:a.replacement.qty}];
      retained=row.items.flatMap(l=>l!==selected[0]?[l]:l.qty>a.replacement!.qty?[{...l,qty:l.qty-a.replacement!.qty}]:[]);
    }
    const sources=await loadStockSources(ctx);
    const basePhysical=a.replacement?await resolveOrderPhysicalItems(ctx,row.account_slug,row.items,sources.items):null;
    if(a.replacement && !basePhysical?.items.length)return {ok:false,error:"The current basket physical identity is unverified. No booking changes were made."};
    const catalog=await listingDisplayCatalog(ctx,row.account_slug);
    const added:OrderLine[]=[];
    for(const input of a.items) {
      const listing=await ctx.db.query("online_listings").withIndex("by_account_product",q=>q.eq("account_slug",row.account_slug).eq("product_id",input.product_id)).first();
      const inventory=await loadListingInventory(ctx,row.account_slug,input.product_id,input.qty,sources);
      if(!listing || typeof listing.daily_price!=="number" || listing.daily_price<=0 || !inventory.complete || inventory.owned!==true)
        return {ok:false,error:"An exact selected offering lacks a verified owned mapping or price. No booking changes were made."};
      const line:OrderLine={name:catalog.name(row.account_slug,input.product_id,listing.name??inventory.listing_name??""),
        product_id:input.product_id,qty:input.qty,daily_price_gbp:listing.daily_price,pricing_basis:"listing",
        price_tiers:await tiersForProduct(ctx,row.account_slug,input.product_id),origin:"added"};
      const duplicate=added.find(l=>l.product_id===line.product_id);
      if(duplicate)duplicate.qty+=line.qty;
      else added.push(line);
    }
    if(added.some(l=>l.qty>20))return {ok:false,error:"The aggregate quantity per offering exceeds 20."};
    const lines:OrderLine[]=retained.map(l=>({...l,item_id:l.item_id?String(l.item_id):undefined}));
    for(const line of added) {
      const same=lines.find(l=>l.product_id===line.product_id && l.daily_price_gbp===line.daily_price_gbp && JSON.stringify(l.price_tiers??[])===JSON.stringify(line.price_tiers??[]));
      if(same)same.qty+=line.qty;
      else lines.push({...line});
    }
    const stock=await checkOrderRentalStock(ctx,row.account_slug,lines,row.start_date,row.end_date,a.thread_id,sources);
    const basket={available:stock.available,items:stock.receipts.map(r=>({name:r.item_name,quantity:r.requested_units}))};
    const stock_receipts=stock.receipts.map(r=>({...r,basket}));
    if(stock.available!==true)return {ok:false,error_code:"basket_stock_unavailable_or_unknown",error:"The complete proposed basket cannot be verified available. No items or prices changed.",stock_receipts};
    const quote=summarise(lines,row.start_date,row.end_date),base_quote=summarise(row.items,row.start_date,row.end_date),addition_quote=summarise(added,row.start_date,row.end_date);
    if(quote.total_gbp==null || base_quote.total_gbp==null || addition_quote.total_gbp==null)
      return {ok:false,error:"The proposal includes unpriced items. Ask the owner for a quote; no booking changes were made."};
    return {ok:true,action_performed:false,preview_only:true,source:"native_lab_proposal" as const,thread_id:a.thread_id,account_slug:row.account_slug,
      physical_identity_key:stock.physical_identity_key,
      base_items:row.items.map(l=>({name:l.name,quantity:l.qty})),added_items:added.map(l=>({name:l.name,quantity:l.qty})),
      ...(a.replacement?{removed_items:removed.map(l=>({name:l.name,quantity:l.qty})),change_kind:"replacement" as const,price_delta_gbp:quote.total_gbp-base_quote.total_gbp,base_physical_identity_key:orderPhysicalIdentityKey(basePhysical!.items),removed_listings:removed.map(l=>({product_id:l.product_id!,quantity:l.qty}))}:{}),
      quote,base_quote,addition_quote,additional_cost_gbp:quote.total_gbp-base_quote.total_gbp,stock_receipts,proposed_lines:lines};
}

export const quoteAdditionBasket = query({
  args:{thread_id:v.string(),items:v.array(v.object({product_id:v.number(),qty:v.number()}))},
  handler:async(ctx,a)=>{
    const result = await prepareEquipmentProposal(ctx,a);
    if ("proposed_lines" in result) { const {proposed_lines: _private, ...quote} = result; return quote; }
    return result;
  },
});

/** Exact replacement quote uses the same pricing and joint stock preparation, never a mutation. */
export const quoteReplacementBasket=query({
  args:{thread_id:v.string(),items:v.array(v.object({product_id:v.number(),qty:v.number()})),replace_product_id:v.number(),replace_quantity:v.number()},
  handler:async(ctx,a)=>{
    const result=await prepareEquipmentProposal(ctx,{thread_id:a.thread_id,items:a.items,replacement:{product_id:a.replace_product_id,qty:a.replace_quantity}});
    if("proposed_lines" in result){const {proposed_lines:_private,...quote}=result;return quote;}
    return result;
  },
});

export const applyAdditionBasket = mutation({
  args:{thread_id:v.string(),request_message_id:v.string(),items:v.array(v.object({product_id:v.number(),qty:v.number()}))},
  handler:async(ctx,a)=>{
    assertLabThread(a.thread_id);
    if (!a.items.length || a.items.length>8 || a.items.some(i=>!Number.isInteger(i.product_id)||i.product_id<1||!Number.isInteger(i.qty)||i.qty<1||i.qty>20))
      return {ok:false,action_performed:false,error:"Use one to eight exact listing IDs with whole quantities from 1 to 20."};
    const row=await ctx.db.query("renter_bot_lab_orders").withIndex("by_thread",q=>q.eq("thread_id",a.thread_id)).unique();
    if (!row) return {ok:false,action_performed:false,error:"No simulated order for this session."};
    const [latest]=await recentThreadMessages(ctx,a.thread_id,1);
    if (!a.request_message_id || latest?.sender!=="renter" || a.request_message_id!==latest.message_id)
      return {ok:false,action_performed:false,error_code:"stale_inbound",error:"Use the current renter message. No booking changes were made."};
    if (renterRequestsReadOnly(latest.body_text,"add_item"))
      return {ok:false,action_performed:false,error_code:"renter_requested_read_only",error:"The renter requested pricing only or prohibited this edit. No booking changes were made."};
    const selections=new Map<number,number>();
    for(const item of a.items) selections.set(item.product_id,(selections.get(item.product_id)??0)+item.qty);
    const items=[...selections].sort((a,b)=>a[0]-b[0]).map(([product_id,qty])=>({product_id,qty}));
    if(items.some(i=>i.qty>20)) return {ok:false,action_performed:false,error:"The aggregate quantity exceeds 20."};
    const requestKey=JSON.stringify([a.request_message_id,"add_items",items]);
    const previous=row.changes.find(change=>change.request_key===requestKey);
    if(previous) return {ok:true,already_applied:true,action_performed:false,previous_change_summary:previous.summary,
      note:"No new edit was made. Describe the CURRENT returned order, not a historical change.",order:summarise(row.items,row.start_date,row.end_date)};
    const preceding=(await recentThreadMessages(ctx,a.thread_id,2)).at(-2);
    if(requiresReplacementTransaction(latest.body_text,preceding?.sender==="owner"?preceding:undefined))return {ok:false,action_performed:false,error_code:"atomic_replacement_required",error:"Use the complete agreed replacement transaction, never independent removal/addition calls. No booking changes were made."};
    const plan=await additionMountRequirements(ctx,{thread_id:a.thread_id,account_slug:row.account_slug,items});
    if(plan.status!=="none") return {ok:false,action_performed:false,error_code:"complete_setup_required",required_accessories:plan.items,
      error:"The selected setup is incomplete or its compatibility is unverified. Quote the complete setup and obtain agreement to its required accessories; then include every selected listing in one add_items request. No booking changes were made."};
    const prepared=await prepareEquipmentProposal(ctx,{thread_id:a.thread_id,items});
    if(!prepared.ok || !("proposed_lines" in prepared)) return {...prepared,action_performed:false};
    if(await prohibitsSelectedItems(ctx,row.account_slug,latest.body_text,"add_item",items))
      return {ok:false,action_performed:false,error_code:"renter_prohibited_item",error:"The selected items conflict with a named renter restriction, or the restriction cannot be reconciled. No booking changes were made. Clarify the restricted item instead of ignoring it."};
    if(!await additionConsent(ctx,a.thread_id,row.account_slug,latest.body_text,prepared.quote,prepared.addition_quote,prepared.additional_cost_gbp))
      return {ok:false,action_performed:false,error_code:"addition_consent_unverified",error:"The current renter message does not agree to these exact items, quantities and Native quote terms. No booking changes were made. Answer their question or quote the complete setup; do not infer permission from an unrelated message. Clear agreement to an unchanged sent quote can be used directly."};
    const {proposed_lines:_private,...verified_quote}=prepared;
    const beforeContext=await amendmentContext(ctx,a.thread_id);
    const beforeRevision=row.changes.length;
    const summaryText=`added together: ${prepared.added_items.map(i=>`${i.quantity}x ${i.name}`).join(", ")}`;
    await ctx.db.patch(row._id,{items:prepared.proposed_lines.map(line=>({...line,item_id:line.item_id as never})),
      changes:[...row.changes,{at:Date.now(),summary:summaryText,request_key:requestKey}],updated_at:Date.now()});
    return {ok:true,action_performed:true,source:"native_lab_amendment" as const,thread_id:a.thread_id,account_slug:row.account_slug,applied:summaryText,order:prepared.quote,verified_quote,additional_cost_gbp:prepared.additional_cost_gbp,stock_receipts:prepared.stock_receipts,
      context_transition:{source:"native_lab_amendment" as const,thread_id:a.thread_id,before_context_key:beforeContext,
        after_context_key:await amendmentContext(ctx,a.thread_id),before_revision:beforeRevision,after_revision:beforeRevision+1}};
  },
});

/** One consent-bound transaction: a refused replacement leaves the old basket intact. */
export const applyReplacementBasket=mutation({
 args:{thread_id:v.string(),request_message_id:v.string(),items:v.array(v.object({product_id:v.number(),qty:v.number()})),replace_product_id:v.number(),replace_quantity:v.number()},
 handler:async(ctx,a)=>{
  assertLabThread(a.thread_id);
  if(!a.items.length||a.items.length>8||a.items.some(i=>!Number.isInteger(i.product_id)||i.product_id<1||!Number.isInteger(i.qty)||i.qty<1||i.qty>20)||!Number.isInteger(a.replace_product_id)||a.replace_product_id<1||!Number.isInteger(a.replace_quantity)||a.replace_quantity<1||a.replace_quantity>20)return {ok:false,action_performed:false,error:"Use exact listing IDs and whole quantities from 1 to 20."};
  const row=await ctx.db.query("renter_bot_lab_orders").withIndex("by_thread",q=>q.eq("thread_id",a.thread_id)).unique();
  if(!row)return {ok:false,action_performed:false,error:"No simulated order."};
  const messages=await recentThreadMessages(ctx,a.thread_id,2),latest=messages.at(-1);
  if(!a.request_message_id||latest?.sender!=="renter"||latest.message_id!==a.request_message_id)return {ok:false,action_performed:false,error_code:"stale_inbound",error:"Use the current renter message. No booking changes were made."};
  if(renterRequestsReadOnly(latest.body_text,"add_item")||renterRequestsReadOnly(latest.body_text,"remove_item"))return {ok:false,action_performed:false,error_code:"renter_requested_read_only",error:"The renter requested pricing only or prohibited changes. No booking changes were made."};
  const totals=new Map<number,number>();for(const i of a.items)totals.set(i.product_id,(totals.get(i.product_id)??0)+i.qty);
  const items=[...totals].sort((a,b)=>a[0]-b[0]).map(([product_id,qty])=>({product_id,qty}));
  if(items.some(i=>i.qty>20))return {ok:false,action_performed:false,error:"The aggregate quantity exceeds 20."};
  const requestKey=JSON.stringify([a.request_message_id,"replace_items",a.replace_product_id,a.replace_quantity,items]);
  const previous=row.changes.find(c=>c.request_key===requestKey);
  if(previous)return {ok:true,already_applied:true,action_performed:false,previous_change_summary:previous.summary,order:summarise(row.items,row.start_date,row.end_date),note:"No new edit occurred. Describe the current returned basket, not a historical swap."};
  const plan=await additionMountRequirements(ctx,{thread_id:a.thread_id,account_slug:row.account_slug,items});
  if(plan.status!=="none")return {ok:false,action_performed:false,error_code:"complete_setup_required",required_accessories:plan.items,error:"Quote and agree to the complete compatible replacement setup, including required adapters. No booking changes were made."};
  const prepared=await prepareEquipmentProposal(ctx,{thread_id:a.thread_id,items,replacement:{product_id:a.replace_product_id,qty:a.replace_quantity}});
  if(!prepared.ok||!("proposed_lines" in prepared)||!prepared.removed_items||!prepared.base_physical_identity_key)return {...prepared,action_performed:false};
  if(await prohibitsSelectedItems(ctx,row.account_slug,latest.body_text,"add_item",items)||await prohibitsSelectedItems(ctx,row.account_slug,latest.body_text,"remove_item",[{product_id:a.replace_product_id,qty:a.replace_quantity}]))return {ok:false,action_performed:false,error_code:"renter_prohibited_item",error:"The replacement conflicts with a named renter restriction. No booking changes were made."};
  const inventory=await ctx.db.query("items").collect();
  const addedLines=prepared.addition_quote.lines;
  const removedLines=prepared.base_quote.lines.filter(l=>l.product_id===a.replace_product_id).map(l=>({...l,qty:a.replace_quantity}));
  const identities=await Promise.all([...addedLines,...removedLines].map(l=>offeringConsentIdentity(ctx,row.account_slug,l,inventory)));
  if(identities.some(i=>!i))return {ok:false,action_performed:false,error:"The replacement identities need owner review. No booking changes were made."};
  const consentLine=(l:typeof addedLines[number],index:number)=>({...identities[index]!,product_id:l.product_id!,name:l.name,qty:l.qty,line_total_gbp:l.line_total_gbp!,daily_rate_gbp:l.effective_rate_gbp??undefined,base_daily_rate_gbp:l.daily_price_gbp});
  const settings=await ctx.db.query("settings").first(),beforeContext=await amendmentContext(ctx,a.thread_id);
  if(!acceptsReplacement(latest.body_text,{context_key:beforeContext,epoch:settings?.draft_epoch??0,physical_identity_key:prepared.physical_identity_key,base_physical_identity_key:prepared.base_physical_identity_key,start_date:prepared.quote.start_date!,end_date:prepared.quote.end_date!,total_gbp:prepared.quote.total_gbp!,base_total_gbp:prepared.base_quote.total_gbp!,added:addedLines.map(consentLine),removed:removedLines.map((l,index)=>consentLine(l,addedLines.length+index))},messages.at(-2)?.sender==="owner"?messages.at(-2):undefined))return {ok:false,action_performed:false,error_code:"replacement_consent_unverified",error:"The current renter message does not agree to these exact removed and replacement units, dates and complete Native price. Quote the full swap or reconcile their request. No booking changes were made."};
  const {proposed_lines:_private,...verified_quote}=prepared;
  const beforeRevision=row.changes.length;
  const summary=`replaced ${prepared.removed_items.map(i=>`${i.quantity}x ${i.name}`).join(", ")} with ${prepared.added_items.map(i=>`${i.quantity}x ${i.name}`).join(", ")}`;
  await ctx.db.patch(row._id,{items:prepared.proposed_lines.map(l=>({...l,item_id:l.item_id as never})),changes:[...row.changes,{at:Date.now(),summary,request_key:requestKey}],updated_at:Date.now()});
  return {ok:true,action_performed:true,source:"native_lab_amendment" as const,thread_id:a.thread_id,account_slug:row.account_slug,applied:summary,order:prepared.quote,verified_quote,stock_receipts:prepared.stock_receipts,context_transition:{source:"native_lab_amendment" as const,thread_id:a.thread_id,before_context_key:beforeContext,after_context_key:await amendmentContext(ctx,a.thread_id),before_revision:beforeRevision,after_revision:beforeRevision+1}};
 },
});

export const applyChange = mutation({
  args: {
    thread_id: v.string(),
    action: v.union(
      v.literal("add_item"),
      v.literal("remove_item"),
      v.literal("set_dates"),
    ),
    preview_only: v.optional(v.boolean()),
    /** Bound by the canonical server tool scope, never chosen by the model. */
    request_message_id: v.optional(v.string()),
    item_name: v.optional(v.string()),
    product_id: v.optional(v.number()),
    qty: v.optional(v.number()),
    start_date: v.optional(v.string()),
    end_date: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    assertLabThread(a.thread_id);
    if (a.preview_only && !["add_item","set_dates"].includes(a.action)) return {ok:false,error:"Use a read-only addition or date proposal."};
    const row = await ctx.db
      .query("renter_bot_lab_orders")
      .withIndex("by_thread", (q) => q.eq("thread_id", a.thread_id))
      .unique();
    if (!row) return { ok: false, error: "no simulated order for this session" };

    const [latestMessage] = await recentThreadMessages(ctx, a.thread_id, 1);
    if ((!a.preview_only && (!a.request_message_id || latestMessage?.sender !== "renter")) ||
      (a.request_message_id !== undefined && a.request_message_id !== latestMessage?.message_id))
      return { ok:false, action_performed:false, error_code:"stale_inbound", error:"Booking edits require the current renter message ID. No booking changes were made; regenerate using the current conversation." };
    if (!a.preview_only && latestMessage?.sender === "renter" &&
      renterRequestsReadOnly(latestMessage.body_text, a.action))
      return {ok:false,action_performed:false,error_code:"renter_requested_read_only",
        error:"The current renter message requests pricing only or prohibits this edit. No booking changes were made. Use a read-only quote or answer their question; ask for confirmation before making the restricted change."};
    const messageId = a.request_message_id ?? latestMessage?.message_id;
    const nativeItems = a.action === "set_dates" ? [] : await ctx.db.query("items").collect();
    const identity = a.item_name ? bestMatch(a.item_name, nativeItems, i=>i.name_canonical, i=>i.aliases ?? []) : null;
    if (a.product_id != null && (!Number.isInteger(a.product_id) || a.product_id < 1)) return {ok:false,error:"Use an exact listing product ID."};
    let itemKey = a.product_id != null ? `product:${a.product_id}` : identity?.confident && identity.match ? String(identity.match._id) : a.item_name?.trim().toLowerCase();
    if (a.product_id == null && a.action === "add_item" && identity?.confident && identity.match) {
      const pid = await listingPidForItem(ctx,row.account_slug,String(identity.match._id));
      if (pid != null) itemKey = `product:${pid}`;
    }
    if (a.product_id == null && a.action === "remove_item" && a.item_name) {
      const candidates = row.items.map(line=>({line,native:nativeItems.find(i=>String(i._id)===String(line.item_id))}));
      const selected = bestMatch(a.item_name,candidates,c=>c.native?.name_canonical ?? c.line.name,c=>c.native?.aliases ?? []);
      if (selected.confident && selected.match?.line.product_id != null) itemKey = `product:${selected.match.line.product_id}`;
      else if(messageId){
        const history=row.changes.flatMap(change=>{
          if(!change.removed_item || change.removed_item.qty!==(a.qty??1) || !change.request_key)return [];
          try{const key=JSON.parse(change.request_key);return key[0]===messageId && key[1]==="remove_item" ? [change.removed_item] : [];}catch{return [];}
        });
        const prior=bestMatch(a.item_name,history,r=>r.identity_name,r=>r.aliases);
        if(prior.confident && prior.match)itemKey=`product:${prior.match.product_id}`;
      }
    }
    const requestKey = messageId && !a.preview_only ? JSON.stringify([messageId,a.action,
      ...(a.action === "set_dates" ? [a.start_date,a.end_date ?? a.start_date] : [itemKey,a.qty ?? 1])]) : undefined;
    // Existing Lab ledgers used physical identity before exact offering keys.
    // Upgrading must not replay an already-applied inbound request.
    const legacyKey = messageId && !a.preview_only && a.action !== "set_dates" && identity?.confident && identity.match
      ? JSON.stringify([messageId,a.action,String(identity.match._id),a.qty ?? 1]) : undefined;
    const previous = requestKey ? row.changes.find(change => change.request_key === requestKey || legacyKey !== undefined && change.request_key === legacyKey) : undefined;
    if (previous) return {ok:true,already_applied:true,action_performed:false,previous_change_summary:previous.summary,
      note:"This request was applied previously. NO new edit was made. Describe the CURRENT order below, using already set to or already contains where appropriate; never say I moved, added or removed it this time. A later edit may have changed the order since that earlier action.",
      order:summarise(row.items,row.start_date,row.end_date)};

    if(!a.preview_only && ["add_item","remove_item"].includes(a.action)) {
      const preceding=(await recentThreadMessages(ctx,a.thread_id,2)).at(-2);
      if(requiresReplacementTransaction(latestMessage?.body_text??"",preceding?.sender==="owner"?preceding:undefined))return {ok:false,action_performed:false,error_code:"atomic_replacement_required",error:"An agreed swap must be applied together through replace_items. No booking changes were made."};
    }
    const beforeContext = await amendmentContext(ctx, a.thread_id);
    const beforeRevision = row.changes.length;
    const transition = async () => ({ source: "native_lab_amendment" as const,
      thread_id: a.thread_id, before_context_key: beforeContext,
      after_context_key: await amendmentContext(ctx, a.thread_id),
      before_revision: beforeRevision, after_revision: beforeRevision + 1 });

    const lines: OrderLine[] = row.items.map((i) => ({
      ...i,
      item_id: i.item_id ? String(i.item_id) : undefined,
    }));
    let summaryText = "";
    const booking = await getBotBooking(ctx, a.thread_id);
    const stage = rentalStage(booking, londonToday()).stage;
    if (booking?.return_date || ["COMPLETED", "CANCELLED", "VERIFICATION_FAILED"].includes(stage))
      return { ok: false, error: "This rental is already closed. Arrange a new booking instead of changing its dates or items." };

    if (a.action === "set_dates") {
      if (!a.start_date) return { ok: false, error: "start_date required" };
      const end = a.end_date ?? a.start_date;
      if (!validIsoDate(a.start_date) || !validIsoDate(end) || end < a.start_date || inclusiveDays(a.start_date, end) > 366)
        return { ok: false, error: "Use valid pickup and return dates in order, up to 366 rental days" };
      if ((booking?.pickup_date || booking?.status === "ongoing") && a.start_date !== row.start_date)
        return { ok: false, error: "The rental has already been collected. Keep its original pickup date when extending the return." };
      if (a.start_date === row.start_date && end === row.end_date)
        return {ok:true,already_applied:true,action_performed:false,unchanged:true,
          note:"The booking already has these dates. No new edit occurred. Say the dates are already set, not that you moved or changed them.",
          order:summarise(lines,row.start_date,row.end_date)};
      const prepared=await prepareDateChange(ctx,row,a.start_date,end);
      if(!prepared.ok)return prepared;
      if(a.preview_only)return prepared;
      const messages=await recentThreadMessages(ctx,a.thread_id,2);
      const owner=messages.at(-2)?.sender==="owner" ? messages.at(-2) : undefined;
      if(!acceptsDateChange(latestMessage!.body_text,{context_key:beforeContext,
        physical_identity_key:prepared.physical_identity_key??undefined,
        from_start_date:prepared.base_quote.start_date!,from_end_date:prepared.base_quote.end_date!,
        start_date:a.start_date,end_date:end,total_gbp:prepared.quote.total_gbp!,base_total_gbp:prepared.base_quote.total_gbp!,today:londonToday()},owner))
        return {ok:false,action_performed:false,error_code:"date_consent_unverified",error:"The current renter message does not agree to these exact dates and Native price. No dates or prices changed. Use quote_booking_dates, offer its complete period and total, then use clear acceptance without asking again for already agreed terms."};
      await ctx.db.patch(row._id, {
        start_date: a.start_date,
        end_date: end,
        changes: [
          ...row.changes,
          { at: Date.now(), summary: `dates -> ${a.start_date} to ${end}`, ...(requestKey ? {request_key:requestKey} : {}) },
        ],
        updated_at: Date.now(),
      });
      if (booking) await ctx.db.patch(booking._id, {
        start_date: a.start_date,
        end_date: end,
      });
      return {
        ok: true,
        action_performed: true,
        applied: `dates set to ${a.start_date} – ${end}`,
        order: prepared.quote,
        verified_date_quote:prepared,
        stock_receipts: prepared.stock_receipts,
        context_transition: await transition(),
      };
    }

    if (!a.item_name) return { ok: false, error: "item_name required" };

    if (a.action === "remove_item") {
      const qty = a.qty ?? 1;
      if (!Number.isInteger(qty) || qty < 1 || qty > 20)
        return { ok: false, error: "quantity must be a whole number between 1 and 20" };
      if (isGenericItemQuery(a.item_name))
        return { ok: false, error: `"${a.item_name}" names a category. Ask which exact booked model to remove; no items or prices changed.` };
      const inventory = nativeItems;
      const candidates = lines.map(line => ({ line, native: inventory.find(i => String(i._id) === line.item_id) }));
      // Physical identity and reviewed aliases outrank advertising-title prose.
      // A7 II is not A7 III; an FX3 title mentioning A7S III is still an FX3.
      const exact = a.product_id != null ? candidates.filter(c => c.line.product_id === a.product_id) : [];
      const match = a.product_id != null ? {match:exact.length === 1 ? exact[0] : null,confident:exact.length === 1} : bestMatch(a.item_name, candidates,
        c => c.native?.name_canonical ?? c.line.name, c => c.native?.aliases ?? []);
      if (!match.match || !match.confident)
        return {
          ok: false,
          error: `"${a.item_name}" does not identify one specific booked line. Ask which exact model they mean. No items or prices changed. Do not claim it is included in a kit without checking the native kit contents.`,
        };
      const selected = match.match.line;
      if (!Number.isInteger(selected.qty) || selected.qty < qty)
        return { ok: false, error: `Only ${selected.qty}x ${selected.name} are on this booking. Do not remove more than the booked quantity; no items or prices changed.` };
      if(latestMessage?.sender==="renter" && await prohibitsSelectedItems(ctx,row.account_slug,latestMessage.body_text,"remove_item",[{...selected,qty}]))
        return {ok:false,action_performed:false,error_code:"renter_prohibited_item",error:"The selected removal conflicts with a named renter restriction. No items or prices changed."};
      const bookedQuote=summarise(lines,row.start_date,row.end_date);
      const identities=await Promise.all(bookedQuote.lines.map(line=>offeringConsentIdentity(ctx,row.account_slug,line,inventory)));
      const consentLines=bookedQuote.lines.map((line,index)=>({...identities[index],product_id:line.product_id ?? 0,name:line.name,qty:line.qty,
        line_total_gbp:line.line_total_gbp ?? NaN}));
      if(selected.product_id==null || identities.some(i=>!i) || !acceptsRemoval(latestMessage?.body_text ?? "",consentLines,{product_id:selected.product_id,qty},{start_date:row.start_date ?? "",end_date:row.end_date ?? ""}))
        return {ok:false,action_performed:false,error_code:"removal_consent_unverified",
          error:"The current renter message does not request removal of this exact booked offering and quantity. No items or prices were changed. Answer their question or clarify the intended booked item; do not infer permission from an unrelated message or remove a kit component as a whole listing."};
      const removedIdentity=identities[lines.indexOf(selected)]!;
      selected.qty -= qty;
      const kept = lines.filter(l => l !== selected || selected.qty > 0);
      summaryText = `removed ${qty}x ${match.match.native?.name_canonical ?? selected.name}`;
      await ctx.db.patch(row._id, {
        items: kept.map((l) => ({ ...l, item_id: l.item_id as never })),
        changes: [...row.changes, { at: Date.now(), summary: summaryText, ...(requestKey ? {request_key:requestKey} : {}),
          removed_item:{product_id:selected.product_id!,qty,identity_name:removedIdentity.identity_name,
            aliases:[...removedIdentity.aliases,...removedIdentity.primary_removal_aliases]} }],
        updated_at: Date.now(),
      });
      return {
        ok: true,
        action_performed: true,
        applied: summaryText,
        order: summarise(kept, row.start_date, row.end_date),
        context_transition: await transition(),
      };
    }

    // add_item
    const owned = nativeItems.filter(
      (i) => i.status === "active" && !i.is_marketing_only && (i.qty ?? 0) > 0,
    );
    // A category is not a product. "a lens" resolved to a DZOFilm Vespid
    // 3-Lens Set purely because its one token was covered — a £20/day set
    // added to a booking nobody asked for. Ask which, don't pick.
    if (isGenericItemQuery(a.item_name)) {
      return {
        ok: false,
        error: `"${a.item_name}" names a category, not a specific item — ask the renter WHICH model they want before adding anything`,
      };
    }
    const m = bestMatch(a.item_name, owned, (i) => i.name_canonical, (i) => (i.aliases ?? []) as string[]);
    if (a.product_id == null && (!m.match || !m.confident)) {
      // Refusing beats guessing: adding the wrong lens to a booking is exactly
      // the silent error this whole system is built to avoid.
      return {
        ok: false,
        error: `could not identify "${a.item_name}" as one specific item we own — ask the renter which exact model they mean`,
      };
    }
    const qty = a.qty ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) return { ok: false, error: "quantity must be a whole number between 1 and 20" };
    // The complete basket check below counts existing kit components. This
    // preliminary check concerns only the requested extra physical units.
    const requested = qty;
    if (!row.start_date || !row.end_date) return { ok: false, error: "Ask for pickup and return dates before adding equipment" };
    let additionLine: OrderLine;
    let stock: Record<string, unknown>;
    if (a.product_id != null) {
      const listing = await ctx.db.query("online_listings").withIndex("by_account_product",q=>q.eq("account_slug",row.account_slug).eq("product_id",a.product_id!)).first();
      const inventory = await loadListingInventory(ctx,row.account_slug,a.product_id,qty);
      if (!listing || typeof listing.daily_price !== "number" || listing.daily_price <= 0 || !inventory.complete || inventory.owned !== true)
        return {ok:false,error:"The exact listing lacks a complete verified owned mapping or price. No items or prices changed."};
      const catalog = await listingDisplayCatalog(ctx,row.account_slug);
      const name = catalog.name(row.account_slug,a.product_id,listing.name ?? inventory.listing_name ?? a.item_name);
      additionLine = {name,qty,product_id:a.product_id,daily_price_gbp:listing.daily_price,
        pricing_basis:"listing",price_tiers:await tiersForProduct(ctx,row.account_slug,a.product_id),origin:"added"};
      const standalone = await checkOrderRentalStock(ctx,row.account_slug,[additionLine],row.start_date,row.end_date,a.thread_id);
      if (standalone.available !== true) return {ok:false,error:"The selected listing is unavailable or has unknown component stock for these dates. No items or prices changed.",stock_receipts:standalone.receipts};
      stock = standalone.receipts[0];
    } else {
      const item = m.match!;
      const checked = await checkRentalStock(ctx, { item_name: item.name_canonical, quantity: requested, start_date: row.start_date, end_date: row.end_date, thread_id: a.thread_id });
      if (checked.available !== true) return { ok: false, error: `Cannot add ${requested}x ${item.name_canonical} for these dates (${checked.reason}); ${checked.free_units ?? "unknown"} units free. Do not claim the change happened.` };
      stock = checked;
      const price = await resolveDailyPrice(
        ctx, row.account_slug, String(item._id), item.name_canonical,
      );
      // Capture the same listing's multi-day terms with its standalone price.
      const pricedPid = await listingPidForItem(ctx, row.account_slug, String(item._id));
      const tiers = pricedPid != null ? await tiersForProduct(ctx, row.account_slug, pricedPid) : undefined;
      additionLine = {
        item_id: String(item._id), name: item.name_canonical, qty,
        ...(pricedPid != null ? {product_id:pricedPid} : {}),
        daily_price_gbp:price, pricing_basis:pricedPid != null ? "listing" : "catalog",
        price_tiers:tiers, origin:"added",
      };
    }
    if (additionLine.product_id != null) {
      const plan=await additionMountRequirements(ctx,{thread_id:a.thread_id,account_slug:row.account_slug,items:[{product_id:additionLine.product_id,qty}]});
      if(plan.status!=="none") return {ok:false,action_performed:false,error_code:"complete_setup_required",required_accessories:plan.items,
        error:"This single addition needs a complete verified setup. Quote and accept all required owner-supplied adapters together with add_items; no items or prices changed."};
    }

    if(!a.preview_only && latestMessage?.sender==="renter" && await prohibitsSelectedItems(ctx,row.account_slug,latestMessage.body_text,"add_item",[additionLine]))
      return {ok:false,action_performed:false,error_code:"renter_prohibited_item",error:"The selected addition conflicts with a named renter restriction. No items or prices changed."};

    // A body and its kits share physical IDs; merge only identical offerings
    // with the same captured commercial terms.
    const already = lines.find(l => (additionLine.product_id != null ? l.product_id === additionLine.product_id :
      l.item_id === additionLine.item_id && l.product_id == null && l.pricing_basis === "catalog") &&
      l.daily_price_gbp === additionLine.daily_price_gbp && JSON.stringify(l.price_tiers ?? []) === JSON.stringify(additionLine.price_tiers ?? []));
    if (already) { additionLine.name = already.name; additionLine.item_id = already.item_id; }
    if (already) {
      already.qty += qty;
      summaryText = `${already.name} qty -> ${already.qty}`;
    } else {
      lines.push(additionLine);
      summaryText = `added ${qty}x ${additionLine.name}${additionLine.daily_price_gbp != null ? ` at £${additionLine.daily_price_gbp}/day` : ""}`;
    }

    const basketStock = await checkOrderRentalStock(ctx, row.account_slug, lines, row.start_date, row.end_date, a.thread_id);
    if (basketStock.available !== true) {
      const constraints = basketStock.receipts.filter(r => r.available !== true)
        .map(r => `${r.item_name}: the complete basket needs ${r.requested_units}, ${r.free_units ?? "unknown"} free`).join("; ");
      return { ok: false, error_code: "basket_stock_unavailable_or_unknown",
        error: `Cannot add this item to the complete basket for ${row.start_date} – ${row.end_date}: ${constraints || basketStock.reason}. Kit contents already consume stock. No items or prices were changed. Explain the basket capacity; do not call the extra item itself booked or unavailable based only on a larger combined-quantity check.`,
        stock_receipts: basketStock.receipts };
    }

    if (a.preview_only) {
      const quote = summarise(lines, row.start_date, row.end_date);
      const baseQuote = summarise(row.items, row.start_date, row.end_date);
      const additionQuote = summarise([additionLine], row.start_date, row.end_date);
      if (quote.total_gbp == null || baseQuote.total_gbp == null || additionQuote.total_gbp == null) return {ok:false,error:"The complete proposed basket has unpriced items. Ask the owner for a quote; no items or prices changed."};
      return {ok:true, action_performed:false, preview_only:true, source:"native_lab_proposal" as const,
        physical_identity_key:basketStock.physical_identity_key,
        thread_id:a.thread_id, account_slug:row.account_slug,
        base_items:row.items.map(l=>({name:l.name,quantity:l.qty})),
        added_items:[{name:additionLine.name,quantity:qty}], quote,
        base_quote:baseQuote, addition_quote:additionQuote,
        additional_cost_gbp:quote.total_gbp-baseQuote.total_gbp,
        stock_receipt:{...stock,start_date:row.start_date,end_date:row.end_date},
        stock_receipts:basketStock.receipts};
    }

    const completeQuote=summarise(lines,row.start_date,row.end_date);
    const additionQuote=summarise([additionLine],row.start_date,row.end_date);
    const baseQuote=summarise(row.items,row.start_date,row.end_date);
    if(completeQuote.total_gbp==null || baseQuote.total_gbp==null ||
      !await additionConsent(ctx,a.thread_id,row.account_slug,latestMessage!.body_text,completeQuote,additionQuote,completeQuote.total_gbp-baseQuote.total_gbp))
      return {ok:false,action_performed:false,error_code:"addition_consent_unverified",error:"This exact addition and its price are not agreed by the current renter message or an unchanged sent Native quote. No booking changes were made. Use a read-only quote when agreement is missing."};

    await ctx.db.patch(row._id, {
      items: lines.map((l) => ({ ...l, item_id: l.item_id as never })),
      changes: [...row.changes, { at: Date.now(), summary: summaryText, ...(requestKey ? {request_key:requestKey} : {}) }],
      updated_at: Date.now(),
    });
    return {
      ok: true,
      action_performed: true,
      applied: summaryText,
      order: summarise(lines, row.start_date, row.end_date),
      stock_receipt: { ...stock, start_date: row.start_date, end_date: row.end_date },
      stock_receipts: basketStock.receipts,
      context_transition: await transition(),
    };
  },
});

/** A final platform event, never a renter's claim or a pending document check. */
export const simulateVerificationFailure = mutation({
  args: { thread_id: v.string(), referral_code: v.string() },
  handler: async (ctx, a) => {
    assertLabThread(a.thread_id);
    if (!/^[a-f0-9-]{36}$/i.test(a.referral_code)) throw new Error("Use a generated referral code");
    const booking = await getBotBooking(ctx, a.thread_id);
    const order = await getLabOrder(ctx, a.thread_id);
    if (!booking || !order) throw new Error("A simulated booking and basket are required");
    const old = await ctx.db.query("renter_bot_lab_referrals").withIndex("by_source", q => q.eq("source_thread_id", a.thread_id)).unique();
    if (old) {
      if (rentalStage(booking, londonToday()).stage !== "VERIFICATION_FAILED") throw new Error("Failure event no longer matches the booking");
      return { ok: true, already_applied: true, referral_code: old.code, message: verificationFailureReply(old.code) };
    }
    if (rentalStage(booking, londonToday()).stage !== "AWAITING_VERIFICATION")
      throw new Error("Only a booking awaiting verification can receive this final failure event");
    if (await ctx.db.query("renter_bot_lab_referrals").withIndex("by_code", q => q.eq("code", a.referral_code)).unique())
      throw new Error("Referral code already exists");
    const now = Date.now();
    await ctx.db.patch(booking._id, { status: "cancelled", order_step: "VERIFICATION_FAILED" });
    await ctx.db.patch(order._id, { changes: [...order.changes, { at: now, summary: "Final verification failure: simulated booking automatically cancelled" }], updated_at: now });
    let physicalItems:OrderPhysicalItem[]|undefined;
    try {const resolved=await resolveOrderPhysicalItems(ctx,order.account_slug,order.items);if(resolved.items.length)physicalItems=[...resolved.items];}
    catch { /* Final cancellation must still succeed when catalogue identity needs review. */ }
    await ctx.db.insert("renter_bot_lab_referrals", { code: a.referral_code, source_thread_id: a.thread_id, account_slug: order.account_slug, created_at: now, expires_at: now + 7 * 86400000, ...(physicalItems?{physical_items:physicalItems}:{}) });
    const message = verificationFailureReply(a.referral_code);
    await ctx.db.insert("hygglo_messages", { account_slug: order.account_slug, thread_id: a.thread_id, message_id: `${a.thread_id}-verification-failed`, sender: "owner", sender_name: "Lab owner", body_text: message, hygglo_sent_at: now, fetched_at: now });
    return { ok: true, already_applied: false, referral_code: a.referral_code, message };
  },
});

/** Explicit basket handoff. No inherited verification, payment or approval. */
export const redeemReferral = mutation({
  args: { thread_id: v.string(), code: v.string(), preview_only:v.optional(v.boolean()), request_message_id:v.optional(v.string()),
    start_date:v.optional(v.string()),end_date:v.optional(v.string()),items:v.optional(v.array(v.object({product_id:v.number(),qty:v.number()}))),recommendation_requirements:v.optional(v.array(recommendationRequirementValidator)) },
  handler: async (ctx, a) => {
    assertLabThread(a.thread_id);
    const referral = await ctx.db.query("renter_bot_lab_referrals").withIndex("by_code", q => q.eq("code", a.code)).unique();
    if (!referral || referral.expires_at <= Date.now()) return { ok: false, error: "Referral is invalid or expired" };
    if (referral.source_thread_id === a.thread_id) return { ok: false, error: "A friend needs their own new booking" };
    if (referral.redeemed_by) return referral.redeemed_by === a.thread_id
      ? { ok: true, already_applied: true, action_performed:false, message: "This referral is already linked to your request. No duplicate items were added and your current basket has not been changed. Use your current basket and rental stage for the next step." } : { ok: false, error: "Referral has already been used" };
    const messages=await recentThreadMessages(ctx,a.thread_id,12),latest=messages.at(-1);
    if(a.request_message_id!=null && (!a.request_message_id || latest?.sender!=="renter" || latest.message_id!==a.request_message_id))
      return {ok:false,action_performed:false,error:"Use the current renter message. No basket was changed",reason:"stale_inbound"};
    if(!a.preview_only && (!latest || latest.sender!=="renter" || renterRequestsReadOnly(latest.body_text,"add_item") ))
      return {ok:false,action_performed:false,error:"Restoring this basket needs a current renter request that allows basket changes. Use a read-only referral preview otherwise",reason:"referral_restore_not_authorized"};
    if((friendReferralCode(messages).code??(!friendReferralCode(messages).ambiguous?previousReferralOffer(messages)?.referral_code:undefined))!==a.code)
      return {ok:false,action_performed:false,error:"Use the exact basket reference supplied by this renter. No basket was changed",reason:"referral_not_in_current_context"};
    const target = await getLabOrder(ctx, a.thread_id);
    const source = await getLabOrder(ctx, referral.source_thread_id);
    const booking = await getBotBooking(ctx, referral.source_thread_id);
    if (!source || !target || target.account_slug !== referral.account_slug || rentalStage(booking, londonToday()).stage !== "VERIFICATION_FAILED")
      return { ok: false, error: "Referral does not match this account or a cancelled verification failure" };
    if (await getBotBooking(ctx, a.thread_id) || target.items.length || target.changes.length)
      return { ok: false, error: "Start an empty inquiry for the friend's own booking" };
    // The referral identifies gear, not the friend's trip dates. An existing
    // destination date request takes precedence as a whole; never blend a
    // partial request with the source or silently overwrite it.
    const suppliedDates=a.start_date!=null || a.end_date!=null;
    const ownDates=suppliedDates || target.start_date!=null || target.end_date!=null;
    const start=suppliedDates?a.start_date:ownDates?target.start_date:source.start_date;
    const end=suppliedDates?a.end_date:ownDates?target.end_date:source.end_date;
    if (!start || !end || !validIsoDate(start) || !validIsoDate(end) || start>end || start<londonToday() || inclusiveDays(start,end)>366)
      return { ok: false, error: ownDates ? "Confirm valid pickup and return dates for your own request before restoring the basket" : "Original dates have passed or need confirmation. Choose new dates for your own request" };
    const sources=await loadStockSources(ctx);
    const identity=await resolveOrderPhysicalItems(ctx,target.account_slug,source.items,sources.items);
    if(!sameOrderPhysicalItems(referral.physical_items,[...identity.items]))
      return {ok:false,error:"The original equipment identity needs review before restoring this basket",reason:"referral_basket_identity_changed_or_unverified"};
    const selected=a.items;
    if(selected && (!selected.length || selected.length>8 || new Set(selected.map(l=>l.product_id)).size!==selected.length || selected.some(l=>!Number.isInteger(l.product_id)||!Number.isInteger(l.qty)||l.qty<1||l.qty>20||!source.items.some(s=>s.product_id===l.product_id))))
      return {ok:false,action_performed:false,error:"Select exact original listing references and valid quantities. Other gear needs its own normal inquiry",reason:"invalid_referral_selection"};
    const requested=selected?selected.map(l=>({...source.items.find(s=>s.product_id===l.product_id)!,qty:l.qty})):source.items;
    const allListingIds=requested.every(l=>l.product_id!=null);
    if(!a.preview_only && await prohibitsSelectedItems(ctx,target.account_slug,latest!.body_text,"add_item",requested))
      return {ok:false,action_performed:false,error:"The current renter request excludes selected equipment. No basket was changed",reason:"referral_restore_not_authorized"};
    const lines = [];
    for (const old of requested) {
      if (old.product_id != null) {
        // The shared inquiry engine below reads this exact listing's current
        // prices together with its physical mapping; do not price it twice.
        if(allListingIds)lines.push({...old});
        else {
          const listing=await ctx.db.query("online_listings").withIndex("by_account_product",q=>q.eq("account_slug",target.account_slug).eq("product_id",old.product_id!)).unique();
          if(!listing||typeof listing.daily_price!=="number")return {ok:false,error:"A basket listing is no longer priced. Ask the owner to check it"};
          lines.push({...old,name:listing.name??old.name,daily_price_gbp:listing.daily_price,price_tiers:await tiersForProduct(ctx,target.account_slug,old.product_id),pricing_basis:"listing" as const});
        }
      } else if (old.item_id) {
        const item = await ctx.db.get(old.item_id);
        if (!item || item.status !== "active" || item.is_marketing_only || (item.qty ?? 0) < old.qty) return { ok: false, error: "An item is no longer owned and available" };
        const daily = await resolveDailyPrice(ctx, target.account_slug, String(item._id), item.name_canonical);
        const pid = await listingPidForItem(ctx, target.account_slug, String(item._id));
        if (daily == null || pid == null) return { ok: false, error: "An item needs a current listing price" };
        lines.push({ ...old, name: item.name_canonical, daily_price_gbp: daily, price_tiers: await tiersForProduct(ctx, target.account_slug, pid), pricing_basis: "listing" as const });
      } else return { ok: false, error: "Unresolved item identity: ask the owner to check the basket" };
    }
    // Exact listing restores use the SAME stock/price/qualification engine as
    // an ordinary inquiry. Its atomic receipt can render the reply directly.
    const pendingOffer=previousReferralOffer(messages);
    const inheritedRequirements=!requestsFriendBasketRestore(latest?.body_text??"") && pendingOffer?.referral_code===a.code?
      pendingOffer.recommendation_requirements??[]:[];
    const combinedRequirements=[...inheritedRequirements,...a.recommendation_requirements??[]];
    const currentRequirements=combinedRequirements.filter((r,i)=>combinedRequirements.findIndex(other=>recommendationRequirementsKey([r])===recommendationRequirementsKey([other]))===i);
    const verified_inquiry_quote=allListingIds?await performJointStockCheck(ctx,{account_slug:target.account_slug,thread_id:a.thread_id,start_date:start,end_date:end,booking_use:"standalone",
      items:lines.map(l=>({product_id:l.product_id!,item_name:l.name,quantity:l.qty})),recommendation_requirements:currentRequirements},sources):null;
    const qualification=verified_inquiry_quote && "technical_qualification" in verified_inquiry_quote?verified_inquiry_quote.technical_qualification:undefined;
    if((currentRequirements.length || qualification?.setup.applied) && qualification?.verified!==true)
      return {ok:false,action_performed:false,error:"The current gear no longer has verified qualification for this offer. Review the requirements before restoring it",reason:"technical_requirements_unverified"};
    const stock=verified_inquiry_quote?{available:verified_inquiry_quote.available,receipts:verified_inquiry_quote.components}:await checkOrderRentalStock(ctx, target.account_slug, lines, start, end, a.thread_id,sources);
    if (stock.available !== true) return { ok: false, error: "Original basket is no longer available for these dates", stock_receipts: stock.receipts };
    const quote = verified_inquiry_quote&&"quote" in verified_inquiry_quote?verified_inquiry_quote.quote:summarise(lines.map(l => ({ ...l, item_id: l.item_id ? String(l.item_id) : undefined })), start, end);
    if(!quote)return {ok:false,error:"Basket needs a verified current Native quote before restoring it"};
    if (quote.total_gbp == null || quote.unpriced.length) return { ok: false, error: "Basket needs current pricing; ask the owner before restoring it" };
    if(verified_inquiry_quote && lines.some(l=>!quote.lines.some(q=>q.product_id===l.product_id && q.qty===l.qty)))
      return {ok:false,error:"Current quote does not identify every selected listing. No basket was changed"};
    if(!a.preview_only && !requestsFriendBasketRestore(latest!.body_text) &&
      !await additionConsent(ctx,a.thread_id,target.account_slug,latest!.body_text,quote,quote,quote.total_gbp,a.code))
      return {ok:false,action_performed:false,error:"Accept the exact basket offer or explicitly request restoration. No basket was changed",reason:"referral_restore_not_authorized"};
    const pricedLines=verified_inquiry_quote?lines.map(l=>{const current=quote.lines.find(q=>q.product_id===l.product_id && q.qty===l.qty)!;return {...l,name:current.name,daily_price_gbp:current.daily_price_gbp,price_tiers:current.price_tiers,pricing_basis:"listing" as const};}):lines;
    const display = await listingDisplayCatalog(ctx, target.account_slug);
    const message = friendBasketReply({ ...quote, lines: lines.map(l => ({ qty: l.qty, name: l.product_id != null ? display.name(target.account_slug, l.product_id, l.name) : shortItemName(l.name) })) },a.preview_only);
    if(a.preview_only)return {ok:true,preview_only:true,action_performed:false,order:quote,message,stock_receipts:stock.receipts};
    const beforeContext=await amendmentContext(ctx,a.thread_id),beforeRevision=target.changes.length;
    const now = Date.now();
    await ctx.db.patch(target._id, { items: pricedLines, start_date: start, end_date: end, changes: [{ at: now, summary: "Friend referral: basket restored with fresh prices and stock; new booking checks still required" }], updated_at: now });
    const conv = await ctx.db.query("conversations").withIndex("by_thread", q => q.eq("thread_id", a.thread_id)).first();
    if (conv) await ctx.db.patch(conv._id, { inquiry_items: pricedLines.map(l => ({ name: l.name, qty: l.qty, ...(l.product_id != null ? { product_id: l.product_id } : {}) })) });
    await ctx.db.patch(referral._id, { redeemed_by: a.thread_id });
    // Agent calls publish one reviewed reply through the canonical draft path.
    // Legacy owner-driven Lab redemption still records its event reply here.
    if(a.request_message_id==null)await ctx.db.insert("hygglo_messages", { account_slug: target.account_slug, thread_id: a.thread_id, message_id: `${a.thread_id}-friend-referral`, sender: "owner", sender_name: "Lab owner", body_text: message, hygglo_sent_at: now, fetched_at: now });
    return { ok: true, already_applied: false, action_performed:true, source:"native_lab_amendment" as const,thread_id:a.thread_id,account_slug:target.account_slug,order: quote, message, stock_receipts: stock.receipts,
      verified_inquiry_quote:verified_inquiry_quote?{...verified_inquiry_quote,recommendation_requirements:currentRequirements,guidance:"Native stock, price and qualification receipt for the basket applied by this transaction. This receipt proves the quote; the parent action_performed and context_transition prove restoration. No booking was created or confirmed."}:null,
      context_transition:{source:"native_lab_amendment" as const,thread_id:a.thread_id,before_context_key:beforeContext,after_context_key:await amendmentContext(ctx,a.thread_id),before_revision:beforeRevision,after_revision:beforeRevision+1} };
  },
});

// Privileged caller counterpart; shares the original handler and validators.
export const __service_redeemReferral = internalMutationOf(redeemReferral);

export const __service_get = internalQueryOf(get);
