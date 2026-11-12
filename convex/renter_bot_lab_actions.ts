import type {CanonicalGenerationError} from "./lib/canonical_generation_error";
import {recordSentRentalRequest} from "./lib/sent_rental_request";
import { sentBookingProposals } from "./lib/renter_sent_proposal";
import {friendReferralCodesFromMessage} from "./lib/verification_failure";
import {loadThreadReferralReference} from "./lib/thread_referral_reference";
import { listingDisplayCatalog } from "./lib/listing_display_catalog";
import { shortItemName } from "./lib/item_display_name";
import { labBooking } from "./lib/lab_lifecycle";
import { insertStockInput, patchStockInput } from "./lib/stock_input_writes";
import { insertProduct, patchProduct } from "./lib/product_context";
import { renterBotLabScenario, renterBotLabPickupPoint, renterBotLabRentalDates } from "./lib/renter_bot_lab_scenarios";
import { preparedListingPrice, type PreparedListingPrice } from "./lib/renter_bot_lab_listing_snapshot";
import { preparedAlternativeSnapshot } from "./lib/renter_bot_lab_alternative_snapshot";
/**
 * renter_bot_lab_actions — the ONE Convex entry point the Lab UI is allowed
 * to call, so auditing "does the Lab import any send path" is one file, not
 * a whole tree (see scripts/check-patterns.mjs invariant). Delegates to
 * renter_bot_probe / renter_bot_harness. Never imports hygglo-write.ts or
 * any of the four send-gated functions documented in
 * docs/renter-bot-policy.md.
 */
import { action, internalMutation, internalQuery, query } from "./owner_functions";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { scoreDraft } from "./lib/renter_bot_rubric";
import type { DraftEvidence } from "./lib/renter_draft_evidence";
import { PREFIX } from "./renter_bot_probe";

export const listFixtures = query({
  args: {},
  handler: async (ctx) => {
    const fixtures = await ctx.db.query("renter_bot_fixtures").collect();
    // dbcinema_web excluded from the Lab entirely per Daniel, 2026-08-17 —
    // filtered here (not just client-side) so it can never leak back in
    // regardless of what seeds/imports a fixture with that account_slug.
    return fixtures
      .filter((f) => f.account_slug !== "dbcinema_web")
      .map((f) => ({
        _id: f._id,
        name: f.name,
        account_slug: f.account_slug,
        scenario_type: f.scenario_type,
        description: f.description,
        seed_context: f.seed_context,
      }));
  },
});

/** Deployment hook for the isolated Lab's owner-approved pickup policy data. */
export const seedLabLocationPolicy = action({
  args: {},
  handler: async (ctx): Promise<{
    rulesUpdated: number;
    memoriesUpdated: number;
    duplicateSeedMemoriesRemoved: number;
  }> =>
    ctx.runMutation(internal.renter_bot_seed.migrateLabLocationPolicy, {}),
});


// Real catalog lookup — image + price for one item, joined from the actual
// items/pricing_catalog tables (never invented). Read-only. Used by the Lab
// UI's context banner so Daniel can see exactly what grounding is real.
export const getItemContext = query({
  args: { itemName: v.string(), productId: v.optional(v.number()), accountSlug: v.optional(v.string()) },
  handler: async (ctx, { itemName, productId, accountSlug }) => {
    let item = await ctx.db
      .query("items")
      .withIndex("by_canonical_name", (q) => q.eq("name_canonical", itemName))
      .first();
    let listing = null;
    let displayName = item ? shortItemName(item) : itemName;
    if (productId != null) {
      if (!accountSlug) throw new Error("Listing context requires its account");
      const display = await listingDisplayCatalog(ctx, accountSlug);
      listing = await ctx.db.query("online_listings").withIndex("by_account_product", q => q.eq("account_slug", accountSlug).eq("product_id", productId)).first();
      const mapping = display.mappingMap.get(`${accountSlug}#${productId}`);
      if (mapping) {
        const candidates = mapping.components.map(c => display.itemMap.get(String(c.item_id))).filter(i => !!i);
        item = candidates.find(i => i.kind === "camera") ?? candidates.find(i => i.kind === "lens") ?? candidates[0] ?? null;
      } else {
        const product = await ctx.db.query("hygglo_products").withIndex("by_account_product", q => q.eq("accountSlug", accountSlug).eq("productId", productId)).first();
        item = product?.masterItemId ? display.itemMap.get(String(product.masterItemId)) ?? null : null;
      }
      displayName = display.name(accountSlug, productId, listing?.name ?? itemName);
    }
    const pricing = item
      ? await ctx.db
          .query("pricing_catalog")
          .withIndex("by_name", (q) => q.eq("item_name_canonical", item.name_canonical))
          .first()
      : null;
    return {
      found: !!item,
      name: item?.name_canonical ?? itemName,
      display_name: displayName,
      raw_title: listing?.name ?? itemName,
      image_url: listing?.image ?? item?.image_url,
      kind: item?.kind,
      sub_kind: item?.sub_kind,
      notes: item?.notes,
      delivery_notes: item?.delivery_notes,
      cancellation_policy: pricing?.multi_day_notes ?? item?.cancellation_policy,
      included_with_rental: item?.compatibility?.included_with_rental,
      compatible_lenses: item?.compatibility?.lenses,
      compatible_batteries: item?.compatibility?.batteries,
      compatible_cards: item?.compatibility?.cards,
      compatible_accessories: item?.compatibility?.accessories,
      qty: item?.qty,
      unit_kind: item?.unit_kind,
      daily_price_min: pricing?.daily_price_min,
      daily_price_max: pricing?.daily_price_max,
    };
  },
})

export const recentRuns = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 30 }) => {
    return await ctx.db
      .query("renter_bot_harness_runs")
      .withIndex("by_run_at")
      .order("desc")
      .take(limit);
  },
});

export const getConversationForThread = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) =>
    ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first(),
});

export const appendRenterMessage = internalMutation({
  args: { thread_id: v.string(), account_slug: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    if (!args.thread_id.startsWith(PREFIX)) {
      throw new Error("appendRenterMessage only accepts a Lab/probe thread_id");
    }
    const now = Date.now();
    const messageId = `${args.thread_id}-m${now}-${Math.random().toString(36).slice(2, 10)}`;
    await ctx.db.insert("hygglo_messages", {
      account_slug: args.account_slug,
      thread_id: args.thread_id,
      message_id: messageId,
      sender: "renter",
      sender_name: "Test Renter",
      body_text: args.text,
      hygglo_sent_at: now,
      fetched_at: now,
    });
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", args.thread_id))
      .first();
    if (conv) {
      const codes=friendReferralCodesFromMessage(args.text);
      const reference=codes.length?{codes,message_id:messageId}:
        conv.referral_reference??await loadThreadReferralReference(ctx,args.thread_id)??{codes:[],message_id:messageId};
      await ctx.db.patch(conv._id, {
        referral_reference:reference,
        last_msg_at: now,
        last_sender: "renter",
        last_renter_msg_at: now,
      });
    }
  },
});

/** Test-only owner turn. This writes local simulation history, never sends. */
export const appendAssistantMessage = internalMutation({
  args: { thread_id: v.string(), account_slug: v.string(), text: v.string(), run_id: v.string() },
  handler: async (ctx, args) => {
    if (!args.thread_id.startsWith(PREFIX)) throw new Error("Only Lab/probe history can be appended");
    if (!args.text.trim()) return;
    const messageId = `${args.thread_id}-assistant-${args.run_id}`;
    const existing = await ctx.db.query("hygglo_messages").withIndex("by_thread", (q) => q.eq("thread_id", args.thread_id)).collect();
    if (existing.some((m) => m.message_id === messageId)) return;
    const conversation = await ctx.db.query("conversations").withIndex("by_thread",q=>q.eq("thread_id",args.thread_id)).first();
    const proposals=conversation?.account_slug === args.account_slug ? await sentBookingProposals(ctx, conversation, args.text) : {additions:[],dates:[],replacements:[],inquiries:[]};
    const rental_request=conversation?.account_slug===args.account_slug?await recordSentRentalRequest(ctx,conversation,args.text):undefined;
    const quoted_inquiries=proposals.inquiries,quoted_additions=proposals.additions,quoted_dates=proposals.dates,quoted_replacements=proposals.replacements;
    const now = Date.now();
    await ctx.db.insert("hygglo_messages", { account_slug: args.account_slug, thread_id: args.thread_id, message_id: messageId, sender: "owner", sender_name: "Lab owner", body_text: args.text, ...(rental_request?{rental_request}:{}), hygglo_sent_at: now, fetched_at: now, ...(quoted_inquiries.length ? {quoted_inquiries} : {}), ...(quoted_additions.length ? {quoted_additions} : {}), ...(quoted_dates.length ? {quoted_dates} : {}), ...(quoted_replacements.length ? {quoted_replacements} : {}) });
  },
});

/** The selected SKU is resolved on the server, not guessed from UI text. */
export const getSelectedListing = internalQuery({
  args: { account_slug: v.string(), product_id: v.number() },
  handler: async (ctx, a) => ctx.db.query("online_listings")
    .withIndex("by_account_product", (q) => q.eq("account_slug", a.account_slug).eq("product_id", a.product_id)).first(),
});

function assertPreparedScenarioLab() {
  if (process.env.RENTER_BOT_LAB_SCENARIO_SEEDING !== "enabled") {
    throw new Error("Prepared scenarios are available only on the isolated Renter Bot Lab backend");
  }
}

/** Apply owner-confirmed account pickup points only on the isolated Lab. */
export const ensureLabPickupPoint = internalMutation({
  args: { accountSlug: v.string() },
  handler: async (ctx, { accountSlug }) => {
    assertPreparedScenarioLab();
    const point = renterBotLabPickupPoint(accountSlug);
    if (!point) throw new Error("No owner-confirmed Lab pickup point for this account");
    const account = await ctx.db.query("accounts").withIndex("by_slug", (q) => q.eq("slug", accountSlug)).first();
    if (!account) throw new Error("Unknown Lab rental account");
    const profile = await ctx.db.query("account_profiles").withIndex("by_account", (q) => q.eq("account_id", account._id)).first();
    if (!profile) throw new Error("Lab account has no pickup profile");
    await ctx.db.patch(profile._id, {
      pickup_area: point.area,
      pickup_address: point.address,
      updated_at: Date.now(),
    });
    return { accountSlug, area: point.area };
  },
});

/** Upsert only the owner-confirmed items used by the prepared Lab examples. */
export const ensurePreparedScenarioItem = internalMutation({
  args: { scenarioId: v.string() },
  handler: async (ctx, { scenarioId }) => {
    assertPreparedScenarioLab();
    const scenario = renterBotLabScenario(scenarioId);
    if (!scenario) throw new Error("Unknown prepared Lab example");
    const now = Date.now();
    const existing = await ctx.db
      .query("items")
      .withIndex("by_canonical_name", (q) => q.eq("name_canonical", scenario.item.name_canonical))
      .first();
    // The owner confirmed these shared physical pools. The Lab uses its own
    // stock rows and never copies or edits a real reservation.
    let suppliedStock = existing?.supplied_stock;
    if (scenario.item.name_canonical === "BMPCC 6K Full Frame") {
      const ensurePool = async (name: string, slug: string, qty: number) => {
        const found = await ctx.db.query("items").withIndex("by_canonical_name", q => q.eq("name_canonical", name)).first();
        if (found) return found._id;
        return insertStockInput(ctx, "items", { name_canonical: name, name_input: name, slug, kind: "accessory",
          qty, unit_kind: "unit", track_independent_stock: true, status: "active", is_marketing_only: false,
          created_at: now, updated_at: now });
      };
      const battery = await ensurePool("NP-F570 batteries", "lab-np-f570-batteries", 12);
      await ensurePool("EF to L mount", "lab-ef-to-l-mount", 1);
      if (!suppliedStock?.length) suppliedStock = [{item_id:battery, qty:5, source:"Owner-confirmed Lab kit allocation"}];
    }
    const itemFacts = {
      ...scenario.item,
      ...(scenario.item.compatibility ? { compatibility: {
        ...(scenario.item.compatibility.batteries ? { batteries: [...scenario.item.compatibility.batteries] } : {}),
        ...(scenario.item.compatibility.cards ? { cards: [...scenario.item.compatibility.cards] } : {}),
        ...(scenario.item.compatibility.lenses ? { lenses: [...scenario.item.compatibility.lenses] } : {}),
        ...(scenario.item.compatibility.accessories ? { accessories: [...scenario.item.compatibility.accessories] } : {}),
        ...(scenario.item.compatibility.included_with_rental ? { included_with_rental: [...scenario.item.compatibility.included_with_rental] } : {}),
      } } : {}),
      ...(suppliedStock?.length ? {supplied_stock:suppliedStock} : {}),
      is_marketing_only: false,
      status: "active",
      description_source: "owner-confirmed prepared Lab scenario",
      updated_at: now,
    };
    let operation: "insert" | "update" = "insert";
    if (existing) {
      operation = "update";
      await patchStockInput(ctx, existing._id, itemFacts);
    } else {
      await insertStockInput(ctx, "items", { ...itemFacts, created_at: now });
    }
    await ctx.db.insert("audit_log", {
      table_name: "items",
      actor: "lab-scenario-seed",
      op: operation,
      count: 1,
      source_file: "convex/lib/renter_bot_lab_scenarios.ts",
      note: `${scenario.id}: ${scenario.item.name_canonical}`,
      ts: now,
    });
    return scenario.item.name_canonical;
  },
});

/** Link the one prepared listing whose physical mapping has been verified
 * against Rental Manager. Conflicting existing Lab mappings are never replaced. */
export const ensurePreparedListing = internalMutation({
  args: { scenarioId:v.string(), price:v.object({product_id:v.number(),daily_price_gbp:v.number(),
    price_tiers:v.array(v.object({days:v.number(),pricePerDay:v.number()})),source_synced_at:v.number(),checked_at:v.number(),mapping_verified:v.optional(v.boolean())}) },
  handler: async (ctx, {scenarioId, price}) => {
    assertPreparedScenarioLab();
    const scenario=renterBotLabScenario(scenarioId);
    if (!scenario || scenario.accountSlug!=="dbcinema" || scenario.item.name_canonical!=="BMPCC 6K Full Frame" || price.product_id!==1103089 || price.mapping_verified!==true)
      return false;
    const item=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical",scenario.item.name_canonical)).unique();
    if(!item || item.status!=="active" || item.is_marketing_only) return false;
    const mapping=await ctx.db.query("listing_resolution_override").withIndex("by_account_product",q=>q.eq("account_slug",scenario.accountSlug).eq("product_id",price.product_id)).unique();
    const product=await ctx.db.query("hygglo_products").withIndex("by_account_product",q=>q.eq("accountSlug",scenario.accountSlug).eq("productId",price.product_id)).unique();
    const listing=await ctx.db.query("online_listings").withIndex("by_account_product",q=>q.eq("account_slug",scenario.accountSlug).eq("product_id",price.product_id)).unique();
    if(mapping && (mapping.components.length!==1 || mapping.components[0].item_id!==item._id || mapping.components[0].qty!==1)) return false;
    if(product && (product.masterItemId!==item._id || product.isMarketingOnly || product.isPublished!==true)) return false;
    const now=Date.now();
    if(!mapping) await insertStockInput(ctx,"listing_resolution_override",{account_slug:scenario.accountSlug,product_id:price.product_id,
      components:[{item_id:item._id,qty:1}],source:"verified prepared Lab listing",updated_at:now});
    const fields={name:scenario.item.name_canonical,masterItemId:item._id,isMarketingOnly:false,isPublished:true,
      prices:price.price_tiers,lastSyncedAt:price.source_synced_at};
    if(product) await patchProduct(ctx,product._id,fields,product);
    else await insertProduct(ctx,{accountSlug:scenario.accountSlug,productId:price.product_id,...fields});
    const listingFields={name:scenario.item.name_canonical,daily_price:price.daily_price_gbp,is_published:true,updated_at:now};
    if(listing) await ctx.db.patch(listing._id,listingFields);
    else await ctx.db.insert("online_listings",{account_slug:scenario.accountSlug,product_id:price.product_id,...listingFields});
    return true;
  },
});

/** Seed a source-verified lower-value alternative into the isolated test
 * inventory. Stock and bookings here are simulated, never live allocations. */
export const ensurePreparedAlternative = internalMutation({
  args:{scenarioId:v.string(),snapshot:v.union(v.null(),v.object({original_value_gbp:v.number(),replacement_value_gbp:v.number(),qty:v.number(),
    daily_price_gbp:v.number(),price_tiers:v.array(v.object({days:v.number(),pricePerDay:v.number()})),source_synced_at:v.number()}))},
  handler:async(ctx,{scenarioId,snapshot})=>{
    assertPreparedScenarioLab();
    const scenario=renterBotLabScenario(scenarioId);
    if(!scenario || scenario.accountSlug!=="dbcinema" || scenario.item.name_canonical!=="BMPCC 6K Full Frame")return false;
    // The owner confirmed no A7S III body is held. This is physical-stock
    // evidence for the isolated Lab, not a change to any published listing.
    // Never override an existing imported catalogue record.
    const unowned=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical","Sony A7S III")).first();
    if(!unowned)await insertStockInput(ctx,"items",{name_canonical:"Sony A7S III",name_input:"Sony A7S III",slug:"lab-sony-a7s-iii-unowned",
      kind:"camera",qty:0,unit_kind:"kit",status:"active",is_marketing_only:true,description_source:"owner-confirmed Lab non-owned camera",
      created_at:Date.now(),updated_at:Date.now()});
    const existing=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical","Sony A7 III")).unique();
    const marker="source-verified prepared Lab alternative";
    const fixture=!existing || existing.description_source===marker;
    // An imported row keeps its stock count and status. Only the specifically
    // owner-confirmed kit facts are reconciled after the source checks pass.
    if(existing && !fixture && (existing.status!=="active" || existing.is_marketing_only ||
      !/^camera(?:_body)?$/.test(existing.kind??"") || !Number.isSafeInteger(existing.qty) || existing.qty<1))return false;
    const account="dbcinema",productId=1046235;
    const mapping=await ctx.db.query("listing_resolution_override").withIndex("by_account_product",q=>q.eq("account_slug",account).eq("product_id",productId)).unique();
    const product=await ctx.db.query("hygglo_products").withIndex("by_account_product",q=>q.eq("accountSlug",account).eq("productId",productId)).unique();
    const listing=await ctx.db.query("online_listings").withIndex("by_account_product",q=>q.eq("account_slug",account).eq("product_id",productId)).unique();
    const managed=mapping?.source==="verified DB Cinema checkout listing" && !!existing && mapping.components.length===1 &&
      mapping.components[0].item_id===existing._id && mapping.components[0].qty===1;
    const withdraw=async()=>{
      if(existing && fixture && existing.status!=="inactive")await patchStockInput(ctx,existing._id,{status:"inactive",updated_at:Date.now()});
      // Withdraw only the Lab-managed offering. Imported item rows and
      // unrelated offers stay untouched when the source cannot be checked.
      if(managed && product?.masterItemId===existing?._id && product.isPublished===true)
        await patchProduct(ctx,product._id,{isPublished:false},product);
      if(managed && listing?.is_published)await ctx.db.patch(listing._id,{is_published:false,updated_at:Date.now()});
      return false;
    };
    if(!snapshot)return withdraw();
    if(!Number.isFinite(snapshot.original_value_gbp) ||
       !Number.isFinite(snapshot.replacement_value_gbp) || snapshot.replacement_value_gbp<=0 ||
       snapshot.replacement_value_gbp>=snapshot.original_value_gbp || !Number.isSafeInteger(snapshot.qty) || snapshot.qty<1) return withdraw();
    const now=Date.now();
    const target=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical","BMPCC 6K Full Frame")).unique();
    if(!target || target.status!=="active" || target.is_marketing_only || existing?.is_marketing_only)return withdraw();
    if(mapping && (!existing || mapping.components.length!==1 || mapping.components[0].item_id!==existing._id || mapping.components[0].qty!==1))return withdraw();
    if(product && (!existing || product.masterItemId!==existing._id || product.isMarketingOnly || product.isPublished!==true && !managed))return withdraw();
    const existingSupplied=existing?.supplied_stock ?? [];
    for(const part of existingSupplied) {
      const item=await ctx.db.get(part.item_id);
      if(item && /\bnp[\s-]*fz100\b/i.test(item.name_canonical) && item.name_canonical!=="Sony NP-FZ100 batteries")return withdraw();
    }
    let battery=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical","Sony NP-FZ100 batteries")).first();
    if(!battery){
      const id=await insertStockInput(ctx,"items",{name_canonical:"Sony NP-FZ100 batteries",name_input:"Sony NP-FZ100 batteries",slug:"lab-sony-np-fz100-batteries",
        kind:"accessory",qty:12,unit_kind:"unit",track_independent_stock:true,status:"active",is_marketing_only:false,created_at:now,updated_at:now});
      battery=await ctx.db.get(id);
    }
    if(!battery || battery.status!=="active" || battery.is_marketing_only || !battery.track_independent_stock || battery.unit_kind!=="unit")return withdraw();
    const preservedContents=(existing?.compatibility?.included_with_rental??[]).filter(content=>
      !/\bnp[\s-]*fz100\b|\b(?:sd(?:hc|xc)?|cf\s*express|cfast|memory\s+card|cards?)\b|\bchargers?\b/i.test(content));
    const facts={...(fixture?{qty:snapshot.qty,status:"active" as const,description_source:marker}:{}),
      replacement_cost_gbp:snapshot.replacement_value_gbp,battery_type:"Sony NP-FZ100",
      compatibility:{...existing?.compatibility,batteries:["Sony NP-FZ100"],cards:["SD"],
        included_with_rental:[...preservedContents,"3× Sony NP-FZ100 batteries","2× 128GB SD cards","Sony dual battery charger"]},
      supplied_stock:[...existingSupplied.filter(part=>String(part.item_id)!==String(battery!._id)),
        {item_id:battery._id,qty:3,source:"Owner-confirmed Lab kit allocation"}],updated_at:now};
    const id=existing?existing._id:await insertStockInput(ctx,"items",{name_canonical:"Sony A7 III",name_input:"Sony A7 III",slug:"lab-sony-a7-iii",
      kind:"camera",unit_kind:"kit",is_marketing_only:false,created_at:now,...facts,
      qty:snapshot.qty,status:"active",description_source:marker});
    if(existing)await patchStockInput(ctx,id,facts);
    // Equipment identity is distinct from stock and kit contents. Only add a
    // manufacturer review when the isolated fixture has no existing review.
    const spec=await ctx.db.query("item_specs").withIndex("by_item",q=>q.eq("item_id",id)).first();
    if(!spec){
      const source_url="https://electronics.sony.com/imaging/interchangeable-lens-cameras/full-frame/p/ilce7m3-b";
      const verified_model="ILCE-7M3";
      await ctx.db.insert("item_specs",{item_id:id,item_name_canonical:"Sony A7 III",description:"Sony Alpha 7 III full-frame interchangeable-lens camera.",
        source:"manufacturer-verified",source_url,verified_model,verified_at:now,created_at:now,
        camera_capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",native_mount:"E",internal_4k:true,source_url,verified_model,verified_at:now}});
    }
    await patchStockInput(ctx,target._id,{replacement_cost_gbp:snapshot.original_value_gbp,updated_at:now});
    if(!mapping)await insertStockInput(ctx,"listing_resolution_override",{account_slug:account,product_id:productId,
      components:[{item_id:id,qty:1}],source:"verified DB Cinema checkout listing",updated_at:now});
    const fields={name:"Sony A7 III Camera Body Kit",masterItemId:id,isMarketingOnly:false,isPublished:true,
      prices:snapshot.price_tiers,lastSyncedAt:snapshot.source_synced_at};
    if(product)await patchProduct(ctx,product._id,fields,product);else await insertProduct(ctx,{accountSlug:account,productId,...fields});
    const offer={name:fields.name,daily_price:snapshot.daily_price_gbp,is_published:true,updated_at:now};
    if(listing)await ctx.db.patch(listing._id,offer);else await ctx.db.insert("online_listings",{account_slug:account,product_id:productId,...offer});
    return true;
  },
});

/** Starts a fixed, owner-grounded conversation with its item seeded first. */
export const startPreparedScenario = action({
  args: {
    scenarioId: v.union(
      v.literal("bmpcc-6k-full-frame-kit"),
      v.literal("sony-fx3-batteries"),
      v.literal("verification-failed"),
    ),
  },
  handler: async (ctx, { scenarioId }): Promise<{
    threadId: string;
    accountSlug: string;
    context: { scenarioTitle: string; displayName: string; items: string[]; examplePrompts: string[]; initialBotMessage?: string };
  }> => {
    assertPreparedScenarioLab();
    const scenario = renterBotLabScenario(scenarioId);
    if (!scenario) throw new Error("Unknown prepared Lab example");
    const supportsAlternative = scenario.accountSlug === "dbcinema" && scenario.item.name_canonical === "BMPCC 6K Full Frame";
    const [preparedPrice, preparedAlternative] = await Promise.all([
      preparedListingPrice(scenario.id, scenario.accountSlug),
      supportsAlternative ? preparedAlternativeSnapshot() : Promise.resolve(null),
    ]);
    const { startDate, endDate } = renterBotLabRentalDates(scenario);
    const itemName = await ctx.runMutation(internal.renter_bot_lab_actions.ensurePreparedScenarioItem, { scenarioId });
    if (preparedPrice) await ctx.runMutation(internal.renter_bot_lab_actions.ensurePreparedListing, {scenarioId,price:preparedPrice});
    if (supportsAlternative) await ctx.runMutation(internal.renter_bot_lab_actions.ensurePreparedAlternative, {scenarioId,snapshot:preparedAlternative});
    const threadId = `${PREFIX}prepared-${scenarioId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await ctx.runMutation(internal.renter_bot_probe.seed, {
      thread_id: threadId,
      account_slug: scenario.accountSlug,
      items: [{ name: itemName }],
      messages: [],
      booking: scenario.startStage === "verification_failed" ? labBooking("awaiting_verification", startDate, endDate) : undefined,
    });
    await ctx.runMutation(internal.renter_bot_lab_order.seed, {
      thread_id: threadId,
      account_slug: scenario.accountSlug,
      item_names: [itemName],
      prepared_price: preparedPrice,
      start_date: startDate,
      end_date: endDate,
    });
    const failure = scenario.startStage === "verification_failed"
      ? await ctx.runMutation(internal.renter_bot_lab_order.__service_simulateVerificationFailure, { thread_id: threadId, referral_code: crypto.randomUUID() })
      : null;
    return {
      threadId,
      accountSlug: scenario.accountSlug,
      context: {
        scenarioTitle: scenario.title,
        displayName: scenario.displayName,
        items: [itemName],
        examplePrompts: [],
        ...(failure ? { initialBotMessage: failure.message } : {}),
      },
    };
  },
});

// Starts (or restarts) a live Lab test conversation — from a saved scenario
// preset, or a blank custom one seeded from location/price/items fields.
export const startLiveSession = action({
  args: {
    accountSlug: v.string(),
    scenarioId: v.optional(v.union(
      v.literal("bmpcc-6k-full-frame-kit"),
      v.literal("sony-fx3-batteries"),
      v.literal("verification-failed"),
    )),
    fixtureId: v.optional(v.id("renter_bot_fixtures")),
    items: v.optional(v.array(v.string())),
    priceGbp: v.optional(v.number()),
    dates: v.optional(v.string()),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    location: v.optional(v.string()),
    /** Real Hygglo listing to base the scenario on (its price is what the renter pays). */
    productId: v.optional(v.number()),
    lifecycle: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    threadId: string;
    context: {
      items: string[];
      productId?: number;
      lifecycle?: string;
      priceGbp?: number;
      dates?: string;
      startDate?: string;
      endDate?: string;
      location?: string;
      initialBotMessage?: string;
    };
  }> => {
    const threadId = `${PREFIX}lab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let itemNames = args.items ?? [];
    let priceGbp = args.priceGbp;
    let dates = args.dates;
    let startDate = args.startDate;
    let endDate = args.endDate;
    let location = args.location;
    let messages: { role: string; text: string }[] = [];
    let preparedPrice: PreparedListingPrice | null | undefined;
    let simulateVerificationFailure = false;

    // Keep all three account pickup points current in the isolated Lab before
    // the draft context is loaded. This mutation refuses any non-Lab backend.
    await ctx.runMutation(internal.renter_bot_lab_actions.ensureLabPickupPoint, {
      accountSlug: args.accountSlug,
    });

    // Scenario selection must load its owner-confirmed item into the isolated
    // catalogue before the UI queries item context or permits a chat turn.
    if (args.scenarioId) {
      assertPreparedScenarioLab();
      if (args.fixtureId || args.productId != null) throw new Error("Prepared examples cannot be combined with another listing or fixture");
      const scenario = renterBotLabScenario(args.scenarioId);
      if (!scenario || scenario.accountSlug !== args.accountSlug) {
        throw new Error("Lab scenario/account mismatch");
      }
      const supportsAlternative = scenario.accountSlug === "dbcinema" && scenario.item.name_canonical === "BMPCC 6K Full Frame";
      const [scenarioPrice, preparedAlternative] = await Promise.all([
        preparedListingPrice(scenario.id, scenario.accountSlug),
        supportsAlternative ? preparedAlternativeSnapshot() : Promise.resolve(null),
      ]);
      preparedPrice = scenarioPrice;
      simulateVerificationFailure = scenario.startStage === "verification_failed";
      const seededItemName = await ctx.runMutation(
        internal.renter_bot_lab_actions.ensurePreparedScenarioItem,
        { scenarioId: args.scenarioId },
      );
      if (preparedPrice) await ctx.runMutation(internal.renter_bot_lab_actions.ensurePreparedListing, {scenarioId:args.scenarioId,price:preparedPrice});
      if (supportsAlternative) await ctx.runMutation(internal.renter_bot_lab_actions.ensurePreparedAlternative, {scenarioId:args.scenarioId,snapshot:preparedAlternative});
      itemNames = [seededItemName];
    }

    if (args.fixtureId) {
      const fixture = await ctx.runQuery(
        internal.renter_bot_harness.getFixture,
        { fixtureId: args.fixtureId },
      );
      if (fixture) {
        itemNames = fixture.seed_context?.items ?? [];
        priceGbp = fixture.seed_context?.price_gbp;
        dates = fixture.seed_context?.dates;
        startDate = fixture.seed_context?.start_date;
        endDate = fixture.seed_context?.end_date;
        location = fixture.seed_context?.location;
        messages = fixture.messages.map((m) => ({ role: m.role, text: m.text }));
      }
    }

    startDate = args.startDate ?? startDate;
    endDate = args.endDate ?? endDate;
    const lifecycle = simulateVerificationFailure ? "awaiting_verification" : args.lifecycle ?? "inquiry";
    const booking = labBooking(lifecycle, startDate, endDate);

    if (args.productId != null) {
      const listing = await ctx.runQuery(internal.renter_bot_lab_actions.getSelectedListing, {
        account_slug: args.accountSlug, product_id: args.productId,
      });
      if (!listing) throw new Error("Selected listing is not present on this account");
      itemNames = [listing.name];
    }

    await ctx.runMutation(internal.renter_bot_probe.seed, {
      thread_id: threadId,
      account_slug: args.accountSlug,
      items: itemNames.map((name) => ({ name, ...(args.productId != null ? { product_id: args.productId } : {}) })),
      messages,
      booking,
    });
    // Simulated Hygglo order for this session, so the bot can genuinely add
    // and remove gear and move dates instead of only talking about it.
    await ctx.runMutation(internal.renter_bot_lab_order.seed, {
      thread_id: threadId,
      account_slug: args.accountSlug,
      item_names: itemNames,
      start_date: startDate,
      end_date: endDate,
      base_product_id: args.productId,
      prepared_price: preparedPrice,
    });
    const failure = simulateVerificationFailure
      ? await ctx.runMutation(internal.renter_bot_lab_order.__service_simulateVerificationFailure, { thread_id: threadId, referral_code: crypto.randomUUID() })
      : null;
    return {
      threadId,
      context: { items: itemNames, productId: args.productId, lifecycle: failure ? "verification_failed" : lifecycle, priceGbp, dates, startDate, endDate, location, ...(failure ? { initialBotMessage: failure.message } : {}) },
    };
  },
});

// Sends ONE renter-side test message into a live Lab session and returns the
// bot's REAL draft reply + rubric score. No send path anywhere in here.
export const sendTestMessage = action({
  args: { threadId: v.string(), accountSlug: v.string(), text: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    draft: string;
    overall_status: "pass" | "fail" | "flag";
    assistantContextAdded: boolean;
    runId: string;
    productionGuardFlags: unknown;
    generation_error?:CanonicalGenerationError;
    native_quote_diagnostic?:string;
    status: string;
    reason?: string;
    rejectedDraft?: string;
    guard_candidate?: string;
    evidence?: DraftEvidence;
    model_id?: string;
  }> => {
    if (!args.threadId.startsWith(PREFIX)) {
      throw new Error("sendTestMessage only accepts a Lab/probe thread_id");
    }
    const session = await ctx.runQuery(internal.renter_bot_lab_actions.getConversationForThread, { thread_id: args.threadId });
    if (!session || session.account_slug !== args.accountSlug) throw new Error("Lab session/account mismatch");

    await ctx.runMutation(internal.renter_bot_lab_actions.appendRenterMessage, {
      thread_id: args.threadId,
      account_slug: args.accountSlug,
      text: args.text,
    });

    // Referrals enter the SAME request-planning/quote pipeline as other chats.
    // Native listing context supplies the shared gear; a code is not an edit.
    const startedAt = Date.now();
    const draftResult = await ctx.runAction(
      internal.replyInbox_actions.__service_generateDraft,
      { thread_id: args.threadId },
    );
    const draftRow = await ctx.runQuery(
      internal.renter_bot_harness.getDraftByThread,
      { thread_id: args.threadId },
    );
    const threadContext = await ctx.runQuery(
      internal.replyInbox.getThreadContext,
      { thread_id: args.threadId },
    );

    const draftText = draftResult.status === "ok" ? draftResult.draft ?? "" : "";
    const factsClaimed = (draftResult.facts_claimed ?? []).map((f) => ({
      kind: f.kind,
      value: f.value,
      verified: f.verified,
    }));
    const pendingOwnerChecks=await ctx.runQuery(internal.renter_bot_harness.pendingOwnerChecksForDraft,{thread_id:args.threadId,draft_text:draftText});
    const labPickupPoint = renterBotLabPickupPoint(args.accountSlug);
    const pickupArea = threadContext?.pickup_area?.trim() || labPickupPoint?.area || null;
    const pickupAddress = threadContext?.pickup_address?.trim() || labPickupPoint?.address || null;
    const rentalChargeGbp = threadContext?.gross_paid_gbp != null
      ? Math.max(0, threadContext.gross_paid_gbp - (threadContext.delivery_fee_gbp ?? 0))
      : null;
    const rubric = scoreDraft({
      pendingOwnerChecks:pendingOwnerChecks??undefined,
      accountSlug: args.accountSlug,
      draftText,
      factsClaimed,
      productionFlags: draftResult.flags??draftResult.review?.flags,
      priceEvidence:draftResult.evidence?.prices,
      verifiedDeliveryFeeGbp:draftResult.verified_delivery_fee_gbp,
        bookingRecord:draftResult.evidence?.booking_record,
      replacementValueComparisons:draftResult.evidence?.replacement_value_comparisons,
      budgetPriceChecks:draftResult.evidence?.budget_price_checks,
      priceRequest:draftResult.evidence?.stock_request,
      lastRenterMessage:args.text,
      conversationHistory: (threadContext?.messages ?? []) as { role: "owner" | "renter"; content: string }[],
      pickupArea,
      pickupAddress,
      pickupPrivacySources: threadContext?.pickup_privacy_sources ?? (pickupAddress ? [pickupAddress] : []),
      pickupConfirmed: Boolean(threadContext?.rental_stage?.booking_confirmed),
      rentalChargeGbp,
      rentalStage: threadContext?.rental_stage?.stage ?? null,
    });

    const runId: string = await ctx.runMutation(
      internal.renter_bot_harness.insertRun,
      {
        session_thread_id: args.threadId,
        account_slug: args.accountSlug,
        draft_text: draftText,
        draft_intent: draftResult.draft_intent,
        draft_confidence: draftResult.confidence ?? draftRow?.draft_confidence,
        facts_claimed: draftResult.facts_claimed,
        draft_evidence: draftResult.evidence,
        pending_owner_checks:pendingOwnerChecks??undefined,
        model_id: draftResult.model_id ?? draftResult.generation_error?.model_id ?? "unknown",
        filter_violations: rubric.filter_violation_categories,
        rubric_results: rubric.results,
        overall_status: rubric.overall_status,
        triggered_by: "lab_ui_manual" as const,
        run_at: startedAt,
        duration_ms: Date.now() - startedAt,
        cost_usd: draftResult.cost_usd??draftResult.generation_error?.cost_usd,
        generation_error:draftResult.generation_error,
        native_quote_diagnostic:draftResult.native_quote_diagnostic,
      },
    );

    // A failed candidate is diagnostic output, not a simulated message the
    // renter could have received. A non-blocking flag remains visible in the
    // run record while the final guarded draft can continue the Lab dialogue.
    const assistantContextAdded = Boolean(draftText) && rubric.overall_status !== "fail";
    if (assistantContextAdded) {
      await ctx.runMutation(internal.renter_bot_lab_actions.appendAssistantMessage, {
        thread_id: args.threadId, account_slug: args.accountSlug, text: draftText, run_id: runId,
      });
    }

    // Surfaces the REAL production guardDraft() flags (draft_guard.ts) --
    // e.g. UNGROUNDED_UNAVAILABILITY -- not persisted, diagnostic only, so
    // Daniel/I can see directly whether the actual production safety net
    // caught something, not just this harness's own rubric.
    return {
      status: draftResult.status,
      reason: draftResult.reason,
      rejectedDraft: draftResult.rejectedDraft,
      guard_candidate: draftResult.guard_candidate,
      evidence: draftResult.evidence,
      model_id: draftResult.model_id,
      draft: draftText,
      overall_status: rubric.overall_status,
      assistantContextAdded,
      runId,
      productionGuardFlags: draftResult.flags ?? draftResult.review?.flags ?? [],
      generation_error:draftResult.generation_error,
      native_quote_diagnostic:draftResult.native_quote_diagnostic,
    };
  },
});

// Closing a Lab session must not remove other operators' simulations.
export const endLiveSession = action({
  args: { threadId: v.string() },
  handler: async (ctx, args): Promise<{ removed: number }> =>
    ctx.runMutation(internal.renter_bot_probe.__service_cleanup, { thread_id: args.threadId }),
});

export const runFixtureBatch = action({
  args: { fixtureIds: v.optional(v.array(v.id("renter_bot_fixtures"))) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    runBatchId: string;
    results: Array<{ fixtureId: string; overall_status: string }>;
  }> => ctx.runAction(internal.renter_bot_harness.__service_runBatch, args),
});
