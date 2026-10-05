import {ownedItemHirePriceReader} from "./lib/owned_item_hire_price";
import {listingKitContext,listingKitItem} from "./lib/listing_kit_context";
import {PRIMARY_RENTAL_REQUEST,rentalRequestValidator} from "./lib/rental_request";
import {validateRentalRequest} from "./lib/sent_rental_request";
import { referralContext } from "./lib/referral_context";
import { basketSpecificationOwnerChecks, qualifyRecommendationBasket, recommendationRequirementValidator, type RecommendationRequirement } from "./lib/recommendation_qualification";
import {cameraRequirementsValidator} from "./lib/camera_requirement_validator";
import { renterHistory } from "./lib/renter_history";
import { getBotRenter } from "./lib/renter_identity";
import { lensRequirementsValidator, listingMappingOwnerCheck } from "./lib/owner_checks";
import { ownerChecksForBot } from "./renter_bot_owner_checks";
import { draftContextKey } from "./lib/draft_review";
import { inventorySpecMap } from "./lib/inventory_spec_grounding";
import { equipmentClaimProfiles } from "./lib/equipment_claim_profiles";
import { equipmentUsageContext, equipmentFactRequests } from "./lib/item_technical_context";
import { renterCameraIdentities } from "./lib/renter_camera_identity";
import { bookingRecord } from "./lib/booking_record";
import { verifiedLensCapabilities, assessLensRequirements, hasLensRequirements, type LensCapabilities } from "./lib/lens_requirements";
import { resolveLensSet } from "./lib/lens_set_resolution";
import { availabilityBasket } from "./lib/availability_basket";
import { explicitRecommendationUse, recommendationBasket, type RecommendationLine, type RecommendationUse } from "./lib/recommendation_basket";
import { checkOrderRentalStock } from "./lib/renter_order_stock";
import { renterItemNames } from "./lib/renter_item_names";
import { summarise } from "./lib/renter_order_quote";
import { inclusiveRentalDays } from "./lib/hygglo_pricing";
import { listingDisplayName } from "./lib/item_display_name";
import { assessCameraRequirements, hasCameraRequirements, requestedCameraRole, verifiedCameraCapabilities, type CameraRequirements, type CameraCapabilities } from "./lib/camera_requirements";
import { verifiedItemSpec } from "./lib/verified_item_spec";
import { loadListingInventory, listingStock, resolveListingComponents } from "./lib/listing_inventory";
import { getBotBooking, getLabOrder, requestedListingContext } from "./lib/renter_booking";
import { additionMountRequirements } from "./lib/booking_addition_mount";
/**
 * Convex queries that back the Mastra renter-bot tools (5 of the 7 — the
 * other two are `search` (in convex/knowledge.ts) and `getTemplate`
 * (also in convex/knowledge.ts)).
 *
 * All queries here are READ-ONLY by Convex's `query()` constraint —
 * the runtime will reject any `ctx.db.insert/patch/delete` call.
 *
 * Index discipline (per CLAUDE.md hard rule #1): no `.collect()` on
 * `reservations` without a `withIndex(...)`. The bot only ever scans
 * `reservations` filtered by `by_account_slug` or `by_hygglo_order_id`.
 */
import { query, action, type QueryCtx, internalQueryOf } from "./owner_functions";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { checkRentalStock, loadStockSources, stockForRentalItem, stockForItem } from "./lib/renter_stock";
import { baseListingProductIds, chooseBaseListing } from "./lib/base_listing_identity";
import { requestRentalStage, rentalStage,isClosedRentalStage } from "./lib/rental_stage";
import { londonToday } from "./lib/effectiveDates";
import { chronologicalThreadMessages, recentThreadMessages } from "./lib/thread_messages";
import { negotiationFromMessages } from "./lib/renter_bot_negotiation";
import { rentalRequestContext, rentalRequestHistory } from "./lib/rental_request_history";
import { sameMount, bestMatch, rankByName, substitutionScore, exactTitleMatch } from "./lib/item_name_match";
import { tierRateForDays, describeTiers, rentalQuote, type PriceTier } from "./lib/hygglo_pricing";

// ── Tool 1: get_renter_context ───────────────────────────────

export const get_renter_context = query({
  args: { thread_id: v.string(),rental_request:v.optional(rentalRequestValidator) },
  handler: async (ctx, { thread_id,rental_request }) => {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();

    const reservation = await getBotBooking(ctx, thread_id);

    const profile=await getBotRenter(ctx,reservation,conversation);
    const renter=profile?{
      _id:String(profile._id),display_name:profile.display_name,hygglo_rating:profile.hygglo_rating,
      total_rentals_count:profile.platform_completed_rentals,total_spend_gbp:profile.total_spend_gbp,
      blacklisted:profile.blacklisted??profile.blacklist,blacklist_reason:profile.blacklist_reason,renter_dna:profile.renter_dna,
    }:null;

    // 12, not 3 (2026-08-21). The CONVERSATION_CRAFT anti-repetition rule says
    // "look at the conversation so far — if you have already told this renter
    // an item is unavailable, or already given the pickup windows, do NOT
    // restate it". With a 3-message window that rule was structurally
    // UNENFORCEABLE past a turn or two: by turn 4-5 the earlier statement had
    // scrolled out of view, so the model restated it and the route's
    // "already said it" check could not see it either.
    //
    // Measured on the not_owned_graceful scenario: turn 5 re-opened with "The
    // RED Komodo isn't available for those dates" when asked about PRICE.
    // 12 covers a 5-6 turn exchange (renter + owner per turn) and is cheap —
    // chat messages are short, and the static prefix is cached separately.
    const allMsgs = await chronologicalThreadMessages(ctx, thread_id);
    const recentMsgs = allMsgs.slice(-40);

    const request=await validateRentalRequest(ctx,thread_id,rental_request??conversation?.active_rental_request??PRIMARY_RENTAL_REQUEST,recentMsgs.at(-1)?.sender==="renter"?recentMsgs.at(-1)?.message_id:undefined);
    const activeStage=requestRentalStage(request,reservation,londonToday());

    const ownerChecks=await ownerChecksForBot(ctx,thread_id,draftContextKey(reservation,conversation?.inquiry_items,await getLabOrder(ctx,thread_id)));

    return {
      thread_id,
      account_slug:
        conversation?.account_id
          ? (await ctx.db.get(conversation.account_id))?.slug ?? "unknown"
          : conversation?.account_slug ?? reservation?.account_slug ?? "unknown",
      hygglo_order_id: reservation?.hygglo_order_id ?? thread_id,
      renter,
      renter_camera_identities: renterCameraIdentities(recentMsgs.filter(message=>message.sender!=="owner").map(message=>message.body_text)),
      renter_history:await renterHistory(ctx,profile,thread_id,londonToday()),
      owner_checks: ownerChecks,
      rental_request:request,
      active_request_stage:activeStage,
      rental_requests:rentalRequestHistory(allMsgs),
      conversation_stage: activeStage.stage,
      rental_stage: rentalStage(reservation, londonToday()),
      last_message_id: recentMsgs.at(-1)?.message_id ?? null,
      last_messages: recentMsgs.slice(-12)
        .map((m) => ({
          sender: m.sender === "owner" ? "owner" : "renter",
          sender_name: m.sender_name ?? m.sender,
          body: m.body_text,
          at: m.hygglo_sent_at ?? m.fetched_at,
        })),
    };
  },
});

// ── Tool 2: get_listing_context ──────────────────────────────

export const get_listing_context = query({
  args: { thread_id: v.string(), equipment_names: v.optional(v.array(v.string())) },
  handler: async (ctx, { thread_id, equipment_names }) => {
    const reservation = await getBotBooking(ctx, thread_id);
    const simOrder = await getLabOrder(ctx, thread_id);
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();
    const account_slug =
      (reservation?.account_slug ?? null) ||
      ((conv as { account_slug?: string } | null)?.account_slug ?? null);

    const request = requestedListingContext(reservation,simOrder,conv?.inquiry_items);
    const lines = request.lines;
    const owner_checks: Array<NonNullable<ReturnType<typeof listingMappingOwnerCheck>>> = [];

    // Enrich each REQUESTED item with its REAL per-account Hygglo listing:
    // the daily price + the description (= what is IN the set). Keyed by
    // product_id, so no name-guessing. This is the ground truth for what the
    // renter is actually asking about.
    const items: Array<Record<string, unknown>> = [];
    const allItems = await ctx.db.query("items").collect();
    const equipment_facts = await Promise.all(equipmentFactRequests(equipment_names??[],allItems).map(async ({requested_name,item})=>{
      if(!item || !account_slug)return {requested_name,status:"unresolved" as const};
      const rows=await ctx.db.query("item_specs").withIndex("by_item",q=>q.eq("item_id",item._id)).collect();
      const spec=rows.length===1?rows[0]:undefined,verified=verifiedItemSpec(spec,item.name_canonical);
      return {requested_name,status:"owned" as const,name:item.name_canonical,kind:item.kind??null,
        spec_text:verified?.text??null,spec_verification:verified?{model:verified.model,source_url:verified.source_url}:null,
        camera_capabilities:["camera","camera_body"].includes(item.kind??"")?verifiedCameraCapabilities(spec,item.name_canonical):null,
        lens_capabilities:item.kind==="lens"?verifiedLensCapabilities(spec,item.name_canonical):null};
    }));
    for (const l of lines) {
      let daily_price_gbp: number | null = null;
      let listing_name: string | null = null;
      let public_url: string | null = null;
      // OWNERSHIP IS TRI-STATE (2026-08-21). Previously this was a bare
      // boolean defaulting to false, so "we could not determine ownership"
      // was indistinguishable from "we verified we do NOT own it".
      //
      // That default was fail-DANGEROUS. Reaching `owned: true` required all
      // of: account_slug present -> product_id is a number -> a hygglo_products
      // row exists -> it has a masterItemId -> that item is active. Any gap
      // (most commonly: an inquiry line with no product_id, which is every
      // fresh inquiry and every Lab scenario) silently produced owned:false.
      // The draft route then told the agent "we CANNOT rent this, frame it
      // ONLY as not available" — so the bot confidently told renters that
      // real, in-stock, completely free gear was unavailable, and invented a
      // substitute because kind was null too. Live-reproduced on BMPCC 6K Pro.
      //
      // null = UNKNOWN. Only an explicit false may drive the concealment path.
      let owned: boolean | null = null;
      let kind: string | null = null;
      let inventory_name: string | null = null;
      let ownership_source: string = "unresolved";
      // The body's mount, so we can offer glass that actually fits even when
      // the listing carries no "what's included" text. Knowing a body is
      // EF-mount is enough to answer "does it come with a lens?" usefully
      // ("body only, I can add the Canon EF 24-105 for £X") instead of
      // stalling with "let me check".
      let lens_mount: string | null = null;
      let price_tiers: string | null = null;
      /**
       * Detail we already hold per item and never showed the bot. Measured
       * 2026-08-23: card_type and battery_type on 67 of 81 rentable items,
       * dimensions/weight on 68, replacement cost on 76, structured kit on 32,
       * and 72 item_specs rows. A six-turn probe of exactly the questions these
       * answer scored 0/6 — three turns produced NO REPLY AT ALL and one leaked
       * "I'll inform my colleague" to the renter. The data was sitting in the
       * same table the bot already reads.
       */
      let card_type: string | null = null;
      let battery_type: string | null = null;
      let included_with_rental: string[] | null = null;
      let size_note: string | null = null;
      let replacement_cost_gbp: number | null = null;
      let spec_text: string | null = null;
      let lens_capabilities: LensCapabilities | null = null;
      let camera_capabilities: CameraCapabilities | null = null;
      let spec_verification: { model: string; source_url: string | null } | null = null;
      // When the renter's wording matches SEVERAL real products (e.g. "BMPCC
      // 6K" fully describes both the 6K Pro and the 6K Full Frame), the bot
      // must ASK which. Detected already by bestMatch's confidence gate, but
      // previously discarded — so the agent answered "yes I have the BMPCC 6K"
      // and then invented a third product line with fabricated specs to
      // explain the difference. Surface the candidates instead.
      let ambiguous_with: Array<{ name: string; lens_mount: string | null; kind: string | null }> = [];
      if (account_slug && typeof l.product_id === "number") {
        const prod = await ctx.db
          .query("hygglo_products")
          .withIndex("by_account_product", (q) =>
            q.eq("accountSlug", account_slug).eq("productId", l.product_id as number),
          )
          .first();
        price_tiers = describeTiers((prod?.prices ?? []) as PriceTier[]);
        const mid = (prod as { masterItemId?: unknown } | null)?.masterItemId;
        if (mid) {
          const it = await ctx.db.get(mid as never);
          if (it) {
            inventory_name = (it as { name_canonical?: string }).name_canonical ?? null;
            kind = (it as { kind?: string }).kind ?? null;
            owned =
              (it as { status?: string }).status === "active" &&
              !(it as { is_marketing_only?: boolean }).is_marketing_only &&
              ((it as { qty?: number }).qty ?? 0) > 0;
            ownership_source = "product_id";
          }
        }
      }

      // FALLBACK: no product_id (fresh inquiry / Lab scenario) or the listing
      // carried no masterItemId. Resolve the line by NAME against master
      // inventory instead of giving up. Ambiguous names stay UNKNOWN rather
      // than guessing a body the renter never specified.
      if (owned === null) {
        const m = bestMatch(
          l.name,
          allItems,
          (i) => i.name_canonical,
          (i) => (i.aliases ?? []) as string[],
        );
        if (m.match && m.confident) {
          const it = m.match;
          inventory_name = it.name_canonical;
          kind = kind ?? (it.kind ?? null);
          owned = it.status === "active" && !it.is_marketing_only && (it.qty ?? 0) > 0;
          ownership_source = "name_match";
          // Resolve the base listing price and identity through the deterministic
          // product index. Kit contents come from inventory records below.
          if (account_slug && (daily_price_gbp === null || listing_name === null)) {
            const idxRows = await ctx.db
              .query("hygglo_product_index")
              .withIndex("by_item_id", (q) => q.eq("item_id", it._id))
              .collect();
            // An item often has SEVERAL listings — a bare body and bundles
            // built around it. Take the CHEAPEST, i.e. its base offering,
            // exactly as lookup_pricing does.
            //
            // This previously took the FIRST index row, so the two tools
            // disagreed about the same item: lookup_pricing said the Sony FX3
            // was £40/day (bare body) while this handed the agent £60/day
            // (the body + 24-70mm bundle). Quoting the bundle as "the FX3"
            // overstates the base rate, and whichever tool the agent happened
            // to use decided the number the renter saw.
            const overrides = await ctx.db.query("listing_resolution_override").withIndex("by_account_product", (q) => q.eq("account_slug", account_slug)).collect();
            const pids = baseListingProductIds(account_slug, String(it._id), idxRows, overrides, allItems);
            let bestListing: { product_id?: number; daily_price?: number; description?: string; name?: string; public_url?: string } | null = null;
            for (const pid of pids) {
              const listing = await ctx.db
                .query("online_listings")
                .withIndex("by_account_product", (q) =>
                  q.eq("account_slug", account_slug).eq("product_id", pid),
                )
                .first();
              if (!listing || !baseListingProductIds(account_slug,String(it._id),idxRows,overrides,allItems,[listing]).includes(pid)) continue;
              const p = listing.daily_price;
              const bp = bestListing?.daily_price;
              if (!bestListing || (typeof p === "number" && (typeof bp !== "number" || p < bp || (p === bp && listing.product_id < (bestListing.product_id ?? Infinity))))) {
                bestListing = listing;
              }
            }
            if (bestListing) {
              const bl = bestListing as { product_id?: number };
              if (bl.product_id != null) {
                const hp = await ctx.db
                  .query("hygglo_products")
                  .withIndex("by_account_product", (q) =>
                    q.eq("accountSlug", account_slug).eq("productId", bl.product_id as number),
                  )
                  .unique();
                price_tiers = describeTiers((hp?.prices ?? []) as PriceTier[]);
              }
              daily_price_gbp = daily_price_gbp ?? bestListing.daily_price ?? null;
              listing_name = listing_name ?? bestListing.name ?? null;
              public_url = public_url ?? bestListing.public_url ?? null;
            }
          }
        } else if (m.match && m.ambiguousWith.length > 0) {
          ownership_source = "ambiguous_name";
          // Carry each candidate's REAL mount/kind. Telling them apart by
          // mount is a fact we hold and is exactly what the renter needs
          // ("which one takes EF glass?"); withholding it just to avoid
          // inventing specs made the bot useless and escalate instead.
          ambiguous_with = [m.match, ...m.ambiguousWith].map((i) => ({
            name: i.name_canonical,
            lens_mount: (i as { lens_mount?: string | null }).lens_mount ?? null,
            kind: i.kind ?? null,
          }));
        }
      }
      if (account_slug && typeof l.product_id === "number") {
        const listing = await ctx.db
          .query("online_listings")
          .withIndex("by_account_product", (q) =>
            q.eq("account_slug", account_slug).eq("product_id", l.product_id as number),
          )
          .first();
        if (listing) {
          daily_price_gbp = listing.daily_price ?? null;
          listing_name = listing.name ?? null;
          public_url = listing.public_url ?? null;
        }
      }
      const listingInventory = account_slug && typeof l.product_id === "number"
        ? await loadListingInventory(ctx, account_slug, l.product_id, l.qty, {items:allItems})
        : null;
      if (listingInventory) {
        owned = listingInventory.owned;
        ownership_source = listingInventory.source;
        const main = listingInventory.primary_camera ?? listingInventory.components.find((c) => ["camera", "camera_body"].includes(c.kind ?? ""))
          ?? listingInventory.components.find((c) => c.stock_required);
        if (main?.name) { inventory_name = main.name; kind = main.kind; }
      }
      // Enrich BOTH identity paths. Linked bookings need the same real specs
      // as name-resolved inquiries; a product id must not hide our item data.
      const it = inventory_name ? allItems.find((i) => i.name_canonical === inventory_name) : undefined;
      if (it) {
          lens_mount = (it as { lens_mount?: string | null }).lens_mount ?? null;
          const det = it as {
            card_type?: string | null;
            battery_type?: string | null;
            weight_kg?: number | null;
            length_cm?: number | null;
            width_cm?: number | null;
            height_cm?: number | null;
            replacement_cost_gbp?: number | null;
            compatibility?: { included_with_rental?: string[] };
          };
          // "N/A" / "N/A (lens)" are placeholders, not answers — a lens has no
          // card slot, and repeating "N/A" at a renter is worse than silence.
          const real = (v?: string | null) =>
            v && !/^n\/?a\b/i.test(v.trim()) ? v : null;
          card_type = real(det.card_type);
          battery_type = real(det.battery_type);
          included_with_rental = det.compatibility?.included_with_rental?.length
            ? det.compatibility.included_with_rental
            : null;
          replacement_cost_gbp = det.replacement_cost_gbp ?? null;
          if (det.weight_kg != null || det.length_cm != null) {
            const dims =
              det.length_cm != null
                ? `${det.length_cm}x${det.width_cm}x${det.height_cm}cm`
                : null;
            size_note = [det.weight_kg != null ? `${det.weight_kg}kg` : null, dims]
              .filter(Boolean)
              .join(", ");
          }
          const sp = await ctx.db
            .query("item_specs")
            .withIndex("by_item", (q) => q.eq("item_id", it._id))
            .collect();
          const itemSpec = sp.length === 1 ? sp[0] : undefined;
          const verified = verifiedItemSpec(itemSpec, it.name_canonical);
          spec_text = verified?.text ?? null;
          lens_capabilities = it.kind === "lens" ? verifiedLensCapabilities(itemSpec, it.name_canonical) : null;
          camera_capabilities = ["camera","camera_body"].includes(it.kind??"") ? verifiedCameraCapabilities(itemSpec,it.name_canonical) : null;
          spec_verification = verified ? { model: verified.model, source_url: verified.source_url } : null;
      }
      const inventoryComponents = listingInventory?.components ?? (it ? [{
        item_id: String(it._id), name: it.name_canonical, kind: it.kind,
        units_per_listing: 1, requested_units: l.qty, stock_required: true,
        owned: it.status === "active" && !it.is_marketing_only && it.qty > 0,
      }] : []);
      const kitContext=await listingKitContext(ctx,account_slug,it,inventoryComponents,allItems);
      const kit=kitContext.kit,storageNeedsReview=kitContext.contents_review_required;
      included_with_rental=kitContext.included_with_rental;
      if(listingInventory){
        const check=listingMappingOwnerCheck({...listingInventory,contents_review_required:storageNeedsReview},{start_date:request.start_date,end_date:request.end_date,quantity:l.qty});
        if(check)owner_checks.push(check);
      }
      items.push({
        unreconciled_kit_contents:kit.unreconciled_contents,
        storage_contents_verification_required:storageNeedsReview,
        storage_guidance:storageNeedsReview ? "Supplied storage records conflict or may describe the same physical medium. Use only kit_contents as known inclusions; do not add unreconciled notes as extra cards or infer a generic card format from camera compatibility. Ask the owner to verify linked type, capacity and count." : null,
        kit_contents: kit.contents,
        kit_completeness: kit.completeness,
        kit_source: kit.source,
        inventory_components: inventoryComponents,
        mapping_complete: listingInventory?.complete ?? !!it,
        name: l.name,
        qty: l.qty,
        product_id: l.product_id,
        // true = verified owned; false = verified NOT rentable; null = UNKNOWN.
        // Consumers MUST treat null as "not verified" and never as "not owned".
        owned,
        ownership_source,
        inventory_name,
        kind,
        lens_mount,
        price_tiers,
        card_type,
        battery_type,
        included_with_rental,
        size_note,
        replacement_cost_gbp,
        spec_text,
        lens_capabilities,
        camera_capabilities,
        spec_verification,
        ambiguous_with,
        listing_name,
        daily_price_gbp,
        whats_included: kit.included,
        public_url,
      });
    }

    return {
      thread_id,
      owner_checks,
      referral_context:account_slug?await referralContext(ctx,thread_id,account_slug,allItems):null,
      found: items.length > 0,
      is_inquiry: !reservation,
      account_slug,
      items,
      equipment_facts,
      equipment_usage: equipmentUsageContext(items),
      booking_record: account_slug?bookingRecord(thread_id,account_slug,rentalStage(reservation,londonToday()).stage,reservation,simOrder):null,
      // The request itself: dates, pickup/return time, what they pay, location.
      start_date: simOrder?.start_date ?? reservation?.start_date ?? null,
      end_date: simOrder?.end_date ?? reservation?.end_date ?? null,
      pickup_time: reservation?.pickup_time ?? null,
      return_time: reservation?.return_time ?? null,
      gross_paid_gbp: reservation?.gross_paid_gbp ?? null,
      pickup_method: (reservation as { pickup_method?: string } | null)?.pickup_method ?? null,
      location: (reservation as { location?: unknown } | null)?.location ?? null,
      order_step: reservation?.order_step ?? null,
      status: reservation?.status ?? null,
      rental_stage: rentalStage(reservation, londonToday()),
      // A booking is only CONFIRMED (safe to call "booked") in these states.
      is_confirmed: rentalStage(reservation, londonToday()).can_confirm_booking,
      awaiting_owner_action: (reservation as { awaiting_owner_action?: boolean } | null)?.awaiting_owner_action ?? null,
    };
  },
});

// ── Tool 3: lookup_pricing ───────────────────────────────────

// Pricing supplies base amounts. A model-selected flag is not location evidence
// or approval for a different amount; keep unknown separate from ineligible.
const UNVERIFIED_DISTANCE_DISCOUNT = {
  distance_discount_applies: null,
  distance_discount_verification: "unverified" as const,
  distance_discount_guidance: "The quoted total is the base price; no distance discount has been applied. A discounted offer requires verified eligibility and a verified reduced quote or recorded owner approval.",
};

export const lookup_pricing = query({
  args: {
    item_name: v.string(),
    product_id: v.optional(v.number()),
    account_slug: v.optional(v.string()),
    days: v.optional(v.number()),
    quantity: v.optional(v.number()),
    // Legacy caller compatibility only; never used as eligibility evidence.
    listing_location_non_central: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { item_name, product_id, account_slug, days = 1, quantity = 1 },
  ) => {
    if (product_id != null && !account_slug) return {found:false as const,item_name,message:"An exact listing quote requires its account"};
    if (!Number.isInteger(days) || days < 1 || days > 366 || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return { found: false as const, item_name, note: "Use a whole rental duration from 1 to 366 days" };
    /**
     * Nearest listing TITLES when nothing matched, for the miss return.
     *
     * A miss used to say only "No pricing row ... treat price as 'check with
     * Daniel'", which gave the agent nothing to correct, so it guessed another
     * spelling and called again. Handing back the real titles turns three or
     * four blind retries into at most one informed call.
     */
    let nearMisses: string[] = [];

    // GROUND TRUTH first: the account's REAL Hygglo listing (its actual
    // daily price + description/kit), matched by name against OWNED-backed
    // listings. Falls back to the curated pricing_catalog below. (Daniel)
    if (account_slug) {
      // "Owned" = the index, CORRECTED by the audit-authoritative override.
      // The index alone let the bot quote gear the audit had already ruled
      // marketing-only (DANIEL RULE 18: not on the master list = not in stock),
      // and hid gear whose only correct mapping lives in an override.
      const [idxRows, ovrRows] = await Promise.all([
        ctx.db.query("hygglo_product_index").collect(),
        ctx.db
          .query("listing_resolution_override")
          .withIndex("by_account_product", (q) => q.eq("account_slug", account_slug))
          .collect(),
      ]);
      const ownedPids = new Set<number>();
      for (const r of idxRows) if (r.account_slug === account_slug) ownedPids.add(r.product_id);
      for (const o of ovrRows) {
        // Empty components = deliberately backed by nothing → never quotable.
        if (o.components.length === 0) ownedPids.delete(o.product_id);
        else ownedPids.add(o.product_id);
      }
      const listings = (await ctx.db.query("online_listings")
        .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
        .collect()).filter((l) => ownedPids.has(l.product_id));
      // DETERMINISTIC FIRST (2026-08-21): resolve the item by name against
      // master inventory, then find ITS listing via the audit-authoritative
      // product_id index. Identity, not string similarity.
      //
      // The old path scored raw COVERAGE (hits / query-token-count) over long
      // marketing listing names, which is how "BMPCC 6K Pro" scored a PERFECT
      // 1.0 against "Blackmagic cinema camera full frame 6k Bmpcc + Rode video
      // mic PRO plus microphone + tripod smallrig interview set": the "pro"
      // came from the MICROPHONE. It returned the wrong body, the wrong kit,
      // and £70/day for a £35/day camera. Coverage cannot distinguish "this
      // listing IS the item" from "this listing merely mentions the item".
      let best: (typeof listings)[number] | null = null;
      let bestScore = 0;
      let matchedCanonical: string | undefined;
      let resolvedCanonical: string | undefined;
      let ambiguousNames: string[] = [];
      if (product_id != null) {
        best = listings.find(l => l.product_id === product_id) ?? null;
        if (!best) return { found: false as const, item_name, message: "No verified owned listing for this exact product" };
        bestScore = 1;
      }
      if (!best) {
        const allItems = await ctx.db.query("items").collect();
        const im = bestMatch(
          item_name,
          allItems,
          (i) => i.name_canonical,
          (i) => (i.aliases ?? []) as string[],
        );
        if (im.match && im.confident) {
          resolvedCanonical = im.match.name_canonical;
          const idxRows = await ctx.db
            .query("hygglo_product_index")
            .withIndex("by_item_id", (q2) => q2.eq("item_id", im.match!._id))
            .collect();
          const pids = new Set(baseListingProductIds(account_slug, String(im.match._id), idxRows, ovrRows, allItems,listings));
          // Among this item's own listings prefer the CHEAPEST — that's the
          // base offering rather than an add-on bundle built around it.
          best = chooseBaseListing(listings, [...pids]);
          if (best) { bestScore = 1; matchedCanonical = im.match.name_canonical; }
        } else if (im.match && im.ambiguousWith.length) {
          ambiguousNames = [im.match, ...im.ambiguousWith].map(i => i.name_canonical);
        }
      }
      // EXACT TITLE FAST PATH — identity, not similarity.
      //
      // The agent usually passes the listing's own title, copied out of the
      // fact pack. That should be a trivial hit, but it fell through to the
      // Jaccard fallback below, which demands coverage === 1 over TOKENS — and
      // a title like "2× Sony A7 III … 24-70mm f/2.8 GM" tokenises differently
      // depending on the multiplication sign, slashes and hyphens, so an item's
      // own name could fail to match itself. The agent then retried with
      // shorter variants: "Blazar Remus full frame 33mm t1.8 1.5x anamorphic" →
      // "Blazar Remus 33mm" → "Anamorphic Blazar Remus 33mm". Each retry is
      // another step, and a step re-sends the whole ~8.5K base prompt.
      //
      // Comparing normalised FULL strings is an identity test, so it cannot
      // quote one listing's price for another — the failure the Jaccard path
      // exists to prevent.
      if (!best && !resolvedCanonical) {
        const exact = exactTitleMatch(
          item_name,
          listings.filter((l) => typeof l.daily_price === "number"),
          (l) => l.name,
        );
        if (exact) {
          best = exact;
          bestScore = 1;
        }
      }
      // Fallback: Jaccard over listing names (penalises the extra tokens a fat
      // bundle carries, unlike the old coverage score) with FULL query
      // coverage required, so every word the renter said must be present.
      if (!best && !resolvedCanonical && !ambiguousNames.length) {
        const ranked = rankByName(item_name, listings, (l) => l.name ?? "");
        const top = ranked.find(
          (r) => r.coverage === 1 && typeof r.item.daily_price === "number",
        );
        if (top) {
          best = top.item;
          bestScore = top.score;
        }
        // Nearest NAMES for the miss path, so the agent can ask once more with
        // a real title instead of inventing variants. Names only — handing back
        // a near-miss PRICE is exactly how "BMPCC 6K Pro" once got quoted at
        // £70/day off a bundle that merely mentioned it.
        else
          nearMisses = ranked
            .filter((r) => typeof r.item.daily_price === "number")
            .slice(0, 5)
            .map((r) => r.item.name ?? "")
            .filter(Boolean);
      }
      if (!best && ambiguousNames.length) return {found:false as const,item_name,
        ambiguous_with:ambiguousNames,message:"Specify the exact model or adapter destination mount before quoting a price."};
      if (best && bestScore >= 0.3 && typeof best.daily_price === "number") {
        // Exact copied titles can bypass name resolution. Recover a canonical
        // identity only if this is an authoritative base offering for one item;
        // a bundle title must never become a body-only addition quote.
        if (!matchedCanonical) {
          const inventory = await ctx.db.query("items").collect();
          const identities = inventory.filter(i => i.status === "active" && !i.is_marketing_only &&
            baseListingProductIds(account_slug, String(i._id), idxRows, ovrRows, inventory,listings).includes(best!.product_id));
          if (identities.length === 1) matchedCanonical = identities[0].name_canonical;
        }
        // REAL Hygglo tiers, not a guessed curve.
        //
        // This used a hardcoded multiplier (0.7 at 3 days, 0.5 at 7) that has
        // nothing to do with what Hygglo charges. leo#1172440's real 3-day
        // rate is 0.83x, not 0.7 — so a 3-day quote came out £168 against a
        // real £200, i.e. we undercut our own listing by £32 and would have
        // had to either honour it or correct it in front of the renter. Every
        // listing carries its own tier table, synced daily by catalog-sync.
        const hp = await ctx.db
          .query("hygglo_products")
          .withIndex("by_account_product", (q) =>
            q.eq("accountSlug", account_slug).eq("productId", best!.product_id),
          )
          .unique();
        const tiers = (hp?.prices ?? []) as PriceTier[];
        const oneDay = tierRateForDays(tiers, 1) ?? best.daily_price;
        const quote = rentalQuote(tiers, best.daily_price, days, quantity);
        if (!quote) return { found: false as const, item_name, message: "No valid quote for this duration and quantity" };
        // A kit price cannot become a component price when another component
        // is unavailable. Expose exact base titles for a separate Native quote.
        const selectedContents = await loadListingInventory(ctx, account_slug, best.product_id);
        // A stale nonempty mapping is not ownership proof. Explicitly inactive,
        // marketing-only or zero-inventory components make the offering
        // unrentable even when the imported listing still carries a price.
        if (selectedContents.owned === false) return {
          found: false as const, item_name, product_id: best.product_id,
          reason: "not_rentable" as const,
          message: "This listing contains an item that is not owned rentable inventory. Do not quote or recommend this offering; use a separately verified owned alternative.",
        };
        if (!selectedContents.complete || selectedContents.owned !== true || (!selectedContents.coverage && /body-only-fallback/i.test(ovrRows.find(o=>o.product_id===best!.product_id)?.note ?? ""))) return {
          found:false as const,item_name,product_id:best.product_id,reason:"listing_mapping_unverified" as const,
          message:"This listing's full equipment mapping is unverified. Its price cannot establish a rentable kit or a body-only rate. Ask for owner review or use a separately verified base offering. This is not a dated out-of-stock verdict.",
        };
        const componentBaseOfferings: Array<{name:string;listing_name:string;product_id:number}> = [];
        if (!matchedCanonical && selectedContents.complete && selectedContents.owned === true) {
          const inventory = await ctx.db.query("items").collect();
          for (const component of selectedContents.components) {
            if (!component.stock_required || component.owned !== true) continue;
            const item = inventory.find(i => String(i._id) === component.item_id);
            if (!item || !["camera", "camera_body", "lens", "drone", "gimbal", "monitor", "audio", "lighting", "grip"].includes(item.kind ?? "")) continue;
            const candidate = chooseBaseListing(listings, baseListingProductIds(account_slug, component.item_id, idxRows, ovrRows, inventory,listings));
            if (!candidate || candidate.product_id === best.product_id || !candidate.name) continue;
            const contents = await loadListingInventory(ctx, account_slug, candidate.product_id);
            if (!contents.complete || contents.owned !== true) continue;
            componentBaseOfferings.push({name:item.name_canonical,listing_name:candidate.name,product_id:candidate.product_id});
            if (componentBaseOfferings.length >= 4) break;
          }
        }
        const mediaInventory = await ctx.db.query("items").collect();
        const kitItem=listingKitItem(selectedContents,mediaInventory);
        const kitReviews=await Promise.all([...new Set([kitItem?._id,...selectedContents.components
          .filter(c=>["camera","camera_body"].includes(c.kind??"")).map(c=>c.item_id)].filter(Boolean))]
          .map(id=>listingKitContext(ctx,account_slug,mediaInventory.find(i=>String(i._id)===String(id)),selectedContents.components,mediaInventory,
            {indexes:idxRows,overrides:ovrRows,peers:listings})));
        const storageNeedsReview=kitReviews.some(r=>r.contents_review_required);
        return {
          found: true as const,
          ...quote,
          storage_contents_verification_required:storageNeedsReview,
          storage_guidance:storageNeedsReview ? "Supplied storage records conflict or may describe the same physical medium. Do not promise unverified supplied SSD/card type, capacity or count until the owner confirms it. The camera's supported recording media are separate from what the kit supplies." : null,
          component_base_offerings: componentBaseOfferings,
          item_name,
          matched_listing: best.name,
          matched_canonical: matchedCanonical,
          display_name: matchedCanonical,
          listing_title_is_not_kit_contents: true,
          display_guidance: "Use display_name for a base offering in renter replies. matched_listing is the exact internal lookup identifier; its advertising, storage capacities and comparison models are not verified supplied contents. Confirm contents through listing context and physical inventory; never add a title's SSD/card/lens promise to a body quote.",
          product_id: best.product_id,
          account_slug,
          // The rate that applies to THIS length — what the renter pays per day.
          one_day_rate_gbp: Math.round(oneDay * 100) / 100,
          days,
          price_tiers: describeTiers(tiers),
          ...UNVERIFIED_DISTANCE_DISCOUNT,
        };
      }
    }
    // A catalog row cannot invent identity, ownership or a multi-day tier.
    const inventory = await ctx.db.query("items").collect();
    const resolved = bestMatch(item_name, inventory, (i) => i.name_canonical, (i) => i.aliases ?? []);
    if (!resolved.match || !resolved.confident || resolved.match.status !== "active" || resolved.match.is_marketing_only || resolved.match.qty < 1)
      return { found: false as const, item_name, did_you_mean: nearMisses, message: "No verified rentable identity for this price request" };
    const catalog = await ctx.db.query("pricing_catalog").collect();
    const rows = catalog.filter((r) => !r.marketing_only && !r.is_bundle && r.item_name_canonical.toLowerCase().trim() === resolved.match!.name_canonical.toLowerCase().trim());
    if (rows.length === 0) {
      return {
        found: false as const,
        item_name,
        message: `No pricing row for "${item_name}". Treat price as 'check with Daniel'.`,
        // The names that DO exist on this account, so the next call can be an
        // informed one instead of another guess at the spelling.
        did_you_mean: nearMisses,
        guidance: nearMisses.length
          ? "That exact name matched nothing. If one of did_you_mean is the same item, call lookup_pricing ONCE more with that exact title. If none of them is, the price or identity needs confirmation. A price miss does not prove that the gear is unavailable; check exact owned inventory and dates before refusing it. Do NOT retry with reworded versions of the original name, and do NOT quote a price for a did_you_mean entry without looking it up."
          : "That exact name matched nothing and there is no close listing on this account. Do not retry with a reworded name; say you'll confirm the price, or check a verified owned alternative. This price miss is not an out-of-stock verdict.",
      };
    }

    // Use the lowest-min row (most conservative). Renter-bot should never
    // surface the inflated max from marketing-only listings.
    rows.sort((a, b) => a.daily_price_min - b.daily_price_min);
    const top = rows[0];

    const dailyRate = top.daily_price_min;
    return {
      found: true as const,
      item_name,
      matched_canonical: top.item_name_canonical,
      daily_rate_gbp: dailyRate,
      daily_rate_max_gbp: top.daily_price_max,
      days,
      source: "curated_catalog" as const,
      multi_day_basis: "unknown_no_listing" as const,
      quantity,
      listed_total_gbp: days === 1 ? Math.round(dailyRate * quantity * 100) / 100 : null,
      guidance: days > 1 ? "Only a curated daily price is known. No verified duration tier exists; confirm the exact total with the owner. Never invent a discount." : "Curated daily price; no listing tier data available.",
      ...UNVERIFIED_DISTANCE_DISCOUNT,
      // Internal — kept off-limits to renter per disclosure rules.
      is_bundle: !!top.is_bundle,
      marketing_only: !!top.marketing_only,
    };
  },
});

// ── Tool 4: check_availability ───────────────────────────────

type JointStockArgs={account_slug:string;thread_id?:string;start_date:string;end_date:string;
  items:Array<{item_name:string;quantity:number;product_id?:number}>;
  booking_use?:RecommendationUse;replace_product_id?:number;replace_quantity?:number;
  pickup_time?:string;return_time?:string;recommendation_requirements?:RecommendationRequirement[]};
export async function performJointStockCheck(ctx:QueryCtx,a:JointStockArgs,preloadedSources?:Awaited<ReturnType<typeof loadStockSources>>,recheck?:{standalone_offer:true;new_inquiry?:true}) {
    if (!a.items.length || a.items.length>8) return {available:null,reason:"use_one_to_eight_exact_items",components:[]};
    const [booking,labOrder]=a.thread_id ? await Promise.all([getBotBooking(ctx,a.thread_id),getLabOrder(ctx,a.thread_id)]) : [null,null];
    if ((booking?.account_slug && booking.account_slug!==a.account_slug) || (labOrder?.account_slug && labOrder.account_slug!==a.account_slug)) throw new Error("The current booking belongs to a different account");
    const stage=rentalStage(booking,londonToday()).stage;
    const separate=a.booking_use==="separate"||recheck?.new_inquiry===true;
    if(recheck && stage!=="INQUIRY" && !separate)return {available:null,reason:"inquiry_offer_stage_changed",components:[]};
    // A separate hire keeps the original reservation in the stock ledger.
    const stockThread=separate?"":a.thread_id??"";
    const closed=isClosedRentalStage(stage);
    const requiresContext=["CONFIRMED_UPCOMING","COLLECTION_DUE","IN_USE","RETURN_OVERDUE"].includes(stage);
    const existing:RecommendationLine[]=labOrder ? labOrder.items.map(l=>({name:l.name,qty:l.qty,product_id:l.product_id,item_id:l.item_id ? String(l.item_id) : undefined}))
      : booking?.hygglo_items?.length ? booking.hygglo_items.map(l=>({name:l.name,qty:l.qty ?? 1,product_id:l.product_id})) : booking?.items?.map(l=>({name:l.item_name,qty:l.qty ?? 1})) ?? [];
    const recent=!separate && !recheck && a.thread_id && !closed && existing.length ? await recentThreadMessages(ctx,a.thread_id,12) : [];
    const expected=explicitRecommendationUse(recent.filter(m=>m.sender!=="owner").at(-1)?.body_text ?? "");
    const sources=preloadedSources ?? await loadStockSources(ctx);
    const candidates:RecommendationLine[]=[];
    for (const line of a.items) {
      const set=line.product_id==null ? resolveLensSet(line.item_name,sources.items) : null;
      if (set && !set.ok) return {available:null,reason:set.reason,components:[]};
      if (set?.ok) candidates.push(...set.items.map(i=>({name:i.name_canonical,qty:line.quantity,item_id:String(i._id)})));
      else {
        const match=line.product_id==null ? bestMatch(line.item_name,sources.items,i=>i.name_canonical,i=>i.aliases ?? []) : null;
        candidates.push({name:match?.confident ? match.match!.name_canonical : line.item_name,qty:line.quantity,product_id:line.product_id,
          ...(match?.confident ? {item_id:String(match.match!._id)} : {})});
      }
    }
    if (candidates.length>8) return {available:null,reason:"use_one_to_eight_exact_items",components:[]};
    if (candidates.some(c=>!Number.isInteger(c.qty)||c.qty<1||c.qty>20)) return {available:null,reason:"invalid_quantity",components:[]};
    // A verified non-rentable member makes this exact set impossible in any
    // booking scenario. Report that catalogue constraint even when addition
    // versus replacement is undecided; never certify a positive proposal here.
    const physical=candidates.map(c=>c.product_id==null ? sources.items.find(i=>String(i._id)===c.item_id) : undefined);
    if (physical.every(Boolean) && physical.some(i=>i!.is_marketing_only || i!.status!=="active" || i!.qty<=0)) {
      const receipts=physical.map((i,index)=>({...stockForItem(sources,i!,{item_name:i!.name_canonical,start_date:a.start_date,end_date:a.end_date,
        quantity:candidates[index].qty,thread_id:stockThread,pickup_time:a.pickup_time,return_time:a.return_time}),start_date:a.start_date,end_date:a.end_date}));
      const basket={available:false,items:receipts.map(r=>({name:r.item_name,quantity:r.requested_units}))};
      return {available:false,reason:"not_rentable",source:"native_catalogue_eligibility",stock_scope:"proposed_basket",...(separate?{new_inquiry:true as const}:{}),
        start_date:a.start_date,end_date:a.end_date,basket,components:receipts.map(r=>({...r,basket,...(separate?{new_inquiry:true as const}:{})})),
        guidance:"At least one exact requested member is not rentable in the Native catalogue. This is not a calendar conflict and does not imply every member is missing. No booking or price changes were made."};
    }
    const plan=recommendationBasket(existing,candidates[0],{requires_booking_context:requiresContext,open_basket:!closed && existing.length>0,
      can_replace:!["IN_USE","RETURN_OVERDUE"].includes(stage),booking_use:separate?"separate":a.booking_use,expected_use:separate?undefined:expected,replace_product_id:a.replace_product_id,replace_quantity:a.replace_quantity});
    if (!plan.ok) return {available:null,reason:plan.reason,components:[]};
    const check=await checkOrderRentalStock(ctx,a.account_slug,[...plan.lines,...candidates.slice(1)],a.start_date,a.end_date,stockThread,sources,{pickup_time:a.pickup_time,return_time:a.return_time});
    const basket={available:check.available,items:check.receipts.map(r=>({name:r.item_name,quantity:r.requested_units}))};
    // An inquiry has no accepted base price to preserve. Quote the complete
    // proposed set after an explicit addition/replacement plan too, including
    // retained request items. Reuse the same loaded listings; confirmed
    // amendments retain their dedicated consent/quote path.
    const itemMap=new Map(sources.items.map(i=>[String(i._id),i]));
    const quotedLines=check.offerings?.map(l=>({...l,name:listingDisplayName(l.name,
      {components:sources.overrides.get(`${a.account_slug}#${l.product_id}`) ?? []},
      itemMap),verified_price_names:[l.name]}));
    const preview=check.available===true && (plan.use==="standalone" || plan.use==="separate" || stage==="INQUIRY") && inclusiveRentalDays(a.start_date,a.end_date)!=null &&
      quotedLines?.length===[...plan.lines,...candidates.slice(1)].length ? summarise(quotedLines,a.start_date,a.end_date) : null;
    const paired=check.receipts.some(r=>["camera","camera_body"].includes(r.kind??""))&&check.receipts.some(r=>r.kind==="lens");
    const technicalItems=await Promise.all((a.recommendation_requirements?.length||paired?check.receipts:[]).map(async r=>{
      const item=itemMap.get(r.item_id),specs=item&&["camera","camera_body","lens"].includes(r.kind??"")?await ctx.db.query("item_specs").withIndex("by_item",q=>q.eq("item_id",item._id)).collect():[];
      return {item_id:r.item_id,name:r.item_name,kind:r.kind??"",quantity:r.requested_units,native_mount:item?.lens_mount,spec:specs.length===1?specs[0]:null};
    }));
    const technical_qualification=qualifyRecommendationBasket(a.recommendation_requirements??[],technicalItems);
    const owner_checks=basketSpecificationOwnerChecks(a.recommendation_requirements??[],technicalItems,{start_date:a.start_date,end_date:a.end_date});
    const quote=preview?.total_gbp!=null && preview.total_gbp>0 ? {...preview,source:"native_inquiry_basket" as const} : null;
    return {available:check.available,reason:check.reason,booking_use:separate?"separate":plan.use,...(separate?{new_inquiry:true as const}:{}),stock_scope:"proposed_basket",source:"shared_inventory_confirmed_rentals",
      account_slug:a.account_slug,thread_id:a.thread_id ?? null,rental_stage:stage,preview_only:true,physical_identity_key:check.physical_identity_key,
      start_date:a.start_date,end_date:a.end_date,basket,components:check.receipts.map(r=>({...r,basket,...(separate?{new_inquiry:true as const}:{})})),replacement_removed_listings:plan.removed,quote,technical_qualification,
      owner_checks,offered_listings:check.offerings?.map(l=>({product_id:l.product_id,quantity:l.qty})),
      guidance:"Read-only joint stock check. available:true proves dated capacity only. technical_qualification separately verifies the submitted requirements and camera/lens setup; a false or unknown setup verdict does not prove the items work together. Select a compatible verified set, or explain the missing proof. For a new inquiry, quote.total_gbp and its exact lines supply the combined price; use these instead of another pricing call or mental arithmetic. quote:null means the combined price is unverified; confirmed amendments use quote_booking_addition/replacement. Explain shared component failures; a failed proposal does not mean every item is independently unavailable. No booking or price changes were made."};
}

export const check_availability = query({
  args: {
    item_name: v.string(),
    product_id: v.optional(v.number()),
    start_date: v.string(),   // ISO YYYY-MM-DD
    end_date: v.string(),      // ISO YYYY-MM-DD
    account_slug: v.optional(v.string()),
    quantity: v.optional(v.number()),
    pickup_time: v.optional(v.string()),
    return_time: v.optional(v.string()),
    thread_id: v.optional(v.string()),
    booking_use: v.optional(v.union(v.literal("current"),v.literal("standalone"),v.literal("additional"),v.literal("replacement"),v.literal("separate"))),
    prefetch_current: v.optional(v.boolean()),
    replace_product_id: v.optional(v.number()),
    replace_quantity: v.optional(v.number()),
  },
  handler: async (ctx, { item_name, start_date, end_date, account_slug, quantity, pickup_time, return_time, thread_id, product_id, booking_use, prefetch_current, replace_product_id, replace_quantity }) => {
    // Expand verified prime-set identities into the shared Native joint check.
    // One snapshot proves the result; no second model call is needed.
    if (product_id == null && /\bsets?\s*$/i.test(item_name)) {
      const sources = await loadStockSources(ctx);
      const set = resolveLensSet(item_name, sources.items);
      if (set && !set.ok) return {available:null,owned:null,item_name,start_date,end_date,reason:set.reason,resolved_items:[],
        guidance:"The exact lens-set identities are unverified or ambiguous. Ask for the exact lenses or owner clarification; do not call this set unavailable."};
      if (set?.ok) {
        if (!account_slug || booking_use==="current") return {available:null,reason:!account_slug ? "missing_account" : "select_exact_current_listing",components:[]};
        const resolved_items=set.items.map(item=>({item_name:item.name_canonical,quantity:quantity ?? 1}));
        const result=await performJointStockCheck(ctx,{account_slug,thread_id,start_date,end_date,items:resolved_items,booking_use,
          replace_product_id,replace_quantity,pickup_time,return_time},sources);
        return {...result,resolved_items,free_units:null};
      }
    }
    if (thread_id) {
      const [booking,labOrder]=await Promise.all([getBotBooking(ctx,thread_id),getLabOrder(ctx,thread_id)]);
      if ((booking?.account_slug && booking.account_slug!==account_slug) || (labOrder?.account_slug && labOrder.account_slug!==account_slug))
        throw new Error("The current booking belongs to a different account");
      const stage=rentalStage(booking,londonToday()).stage;
      const closed=["COMPLETED","CANCELLED","VERIFICATION_FAILED"].includes(stage);
      const requiresContext=["CONFIRMED_UPCOMING","COLLECTION_DUE","IN_USE","RETURN_OVERDUE"].includes(stage);
      const existing:RecommendationLine[]=labOrder ? labOrder.items.map(l=>({name:l.name,qty:l.qty,product_id:l.product_id,item_id:l.item_id ? String(l.item_id) : undefined}))
        : booking?.hygglo_items?.length ? booking.hygglo_items.map(l=>({name:l.name,qty:l.qty ?? 1,product_id:l.product_id}))
        : booking?.items?.map(l=>({name:l.item_name,qty:l.qty ?? 1})) ?? [];
      const recent=booking_use!=="separate" && existing.length && !closed ? await recentThreadMessages(ctx,thread_id,12) : [];
      const expected=explicitRecommendationUse(recent.filter(m=>m.sender!=="owner").at(-1)?.body_text ?? "");
      if (requiresContext || booking_use || expected) {
        const sources=await loadStockSources(ctx);
        const match=product_id==null ? bestMatch(item_name,sources.items,i=>i.name_canonical,i=>i.aliases ?? []) : null;
        const selected=product_id==null || !account_slug ? null : await ctx.db.query("hygglo_products")
          .withIndex("by_account_product",q=>q.eq("accountSlug",account_slug).eq("productId",product_id)).first();
        if (product_id!=null && !selected?.name?.trim()) return {available:null,owned:null,product_id,
          item_name:"Unverified listing identity",start_date,end_date,reason:"listing_identity_unverified",components:[],
          guidance:"The exact product has no verified Native name in this account. Do not reuse the requested name as proof of stock or ownership."};
        const candidate={name:selected?.name ?? (match?.confident ? match.match!.name_canonical : item_name),qty:quantity ?? 1,product_id,
          ...(match?.confident ? {item_id:String(match.match!._id)} : {})};
        const basket=availabilityBasket(existing,candidate,{requires_booking_context:requiresContext,open_basket:!closed && existing.length>0,
          can_replace:!["IN_USE","RETURN_OVERDUE"].includes(stage),booking_use,expected_use:expected,replace_product_id,replace_quantity,
          current_context:prefetch_current===true});
        const check=basket.ok && account_slug ? await checkOrderRentalStock(ctx,account_slug,basket.lines,start_date,end_date,basket.use==="separate"?"":thread_id,sources,{pickup_time,return_time}) : null;
        return {available:check?.available ?? null,owned:check?.available===true ? true : null,item_name:candidate.name,
          product_id,requested_units:candidate.qty,free_units:null,start_date,end_date,checked_at:Date.now(),
          booking_use:basket.use,...(basket.use==="separate"?{new_inquiry:true as const}:{}),rental_stage:stage,reason:basket.ok ? check?.reason ?? "missing_account" : basket.reason,
          stock_scope:basket.use==="current" ? "current_booking" : "proposed_basket",
          basket:check ? {available:check.available,items:check.receipts.map(r=>({name:r.item_name,quantity:r.requested_units}))} : undefined,
          components:(check?.receipts ?? []).map(r=>({...r,...(basket.use==="separate"?{new_inquiry:true as const}:{}),basket:{available:check!.available,items:check!.receipts.map(c=>({name:c.item_name,quantity:c.requested_units}))}})),replacement_removed_listings:basket.removed,
          conflict_count:check?.receipts.filter(r=>r.available===false).length ?? 0,buffer_violation:false,
          guidance:"This verdict checks the complete basket. Current-booking checks do not prove an extra item. A rejected proposal can be caused by shared components; explain their counts rather than claiming the added item is independently out of stock. Replacement is a read-only scenario, never a booking edit."};
      }
    }
    if (product_id !== undefined) {
      if (!account_slug) throw new Error("A listing stock check needs its account");
      const sources = await loadStockSources(ctx);
      const listing = await loadListingInventory(ctx, account_slug, product_id, quantity ?? 1, sources);
      const result = listingStock(sources, listing, { item_name, start_date, end_date, quantity, pickup_time, return_time, thread_id });
      return { ...result, conflict_count: result.components.filter((c) => c.available === false).length, buffer_violation: false };
    }
    const result = await checkRentalStock(ctx, { item_name, start_date, end_date, quantity, pickup_time, return_time, thread_id });
    return { ...result, start_date, end_date, conflict_count: result.conflicts.length, buffer_violation: false };

  },
});

/** One Native snapshot for a joint equipment proposal, never an order edit. */
export const check_basket_availability = query({
  args:{account_slug:v.string(),thread_id:v.optional(v.string()),start_date:v.string(),end_date:v.string(),
    items:v.array(v.object({item_name:v.string(),quantity:v.number(),product_id:v.optional(v.number())})),
    booking_use:v.optional(v.union(v.literal("standalone"),v.literal("additional"),v.literal("replacement"),v.literal("separate"))),
    replace_product_id:v.optional(v.number()),replace_quantity:v.optional(v.number()),
    pickup_time:v.optional(v.string()),return_time:v.optional(v.string()),recommendation_requirements:v.optional(v.array(recommendationRequirementValidator))},
  handler:async(ctx,a)=>performJointStockCheck(ctx,a),
});

// ── Tool 6: get_negotiation_stance ───────────────────────────

export const get_negotiation_stance = query({
  args: {
    thread_id: v.string(),
    // Compatibility with older clients; Native history is the authority.
    latest_message: v.optional(v.string()),
    rental_request:v.optional(rentalRequestValidator),
  },
  handler: async (ctx, { thread_id,rental_request }) => {
    const all = await chronologicalThreadMessages(ctx, thread_id);
    const conversation=await ctx.db.query("conversations").withIndex("by_thread",q=>q.eq("thread_id",thread_id)).first();
    const request=await validateRentalRequest(ctx,thread_id,rental_request??conversation?.active_rental_request??PRIMARY_RENTAL_REQUEST,all.at(-1)?.sender==="renter"?all.at(-1)?.message_id:undefined);
    return negotiationFromMessages(all,request);
  },
});


/** Read-only request planning. A new hire is anchored by Native, never by
 * client-supplied dates, amounts, quote keys or a fabricated message id. */
export const select_rental_request=query({
 args:{thread_id:v.string(),intent:v.union(v.literal("continue"),v.literal("new"),v.literal("primary"),v.literal("resume")),origin_message_id:v.optional(v.string()),rental_request:v.optional(rentalRequestValidator)},
 handler:async(ctx,{thread_id,intent,origin_message_id,rental_request})=>{
  const conversation=await ctx.db.query("conversations").withIndex("by_thread",q=>q.eq("thread_id",thread_id)).first();
  if(!conversation)throw new Error("Rental conversation not found");
  const messages=await chronologicalThreadMessages(ctx,thread_id),latest=messages.at(-1);
  if(latest?.sender!=="renter")throw new Error("Request planning requires a current renter message");
  const selected=intent==="primary"?PRIMARY_RENTAL_REQUEST:intent==="new"?{kind:"inquiry" as const,origin_message_id:latest.message_id}:intent==="resume"?{kind:"inquiry" as const,origin_message_id:origin_message_id??""}:rental_request??conversation.active_rental_request??PRIMARY_RENTAL_REQUEST;
  const request=await validateRentalRequest(ctx,thread_id,selected,intent==="resume"?undefined:latest.message_id);
  return {rental_request:request,active_request_stage:requestRentalStage(request,await getBotBooking(ctx,thread_id),londonToday()),request_context:rentalRequestContext(messages,request),negotiation:negotiationFromMessages(messages,request),request_message_id:latest.message_id,context_only:true};
 }
});

// ── Tool: check_location (delivery distance, db-cinema-v2 method) ──────────────
// Geocode the renter's postcode + this account's hub via postcodes.io, haversine
// the distance, and check it against the account's delivery range (hub_max_km).
export const check_location = action({
  args: { renter_postcode: v.string(), account_slug: v.string() },
  handler: async (
    ctx,
    { renter_postcode, account_slug },
  ): Promise<Record<string, unknown>> => {
    const geocode = async (pc: string) => {
      const clean = pc.replace(/\s+/g, "").toUpperCase();
      if (clean.length < 5) return null;
      try {
        const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`);
        if (!r.ok) return null;
        const res = ((await r.json()) as { result?: { latitude?: number; longitude?: number; admin_ward?: string; admin_district?: string } })?.result;
        if (!res?.latitude || typeof res.longitude !== "number") return null;
        return {
          lat: res.latitude,
          lng: res.longitude,
          label: [res.admin_ward, res.admin_district].filter(Boolean).join(", "),
        };
      } catch {
        return null;
      }
    };
    const haversineKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
      const R = 6371;
      const dLat = ((b.lat - a.lat) * Math.PI) / 180;
      const dLng = ((b.lng - a.lng) * Math.PI) / 180;
      const x =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    };

    const hubs = (await ctx.runQuery(internal.settings.__service_listAccountHubs, {})) as Array<{
      slug: string; hub_postcode: string | null; hub_label: string | null;
    }>;
    const hub = hubs.find((h) => h.slug === account_slug);
    if (!hub?.hub_postcode) return { ok: false, reason: "No delivery hub set for this account — pickup only." };
    const hubGeo = await geocode(hub.hub_postcode);
    if (!hubGeo) return { ok: false, reason: "Couldn't resolve the hub location." };
    const renterGeo = await geocode(renter_postcode);
    if (!renterGeo) return { ok: false, reason: "That doesn't look like a full UK postcode — please re-send it." };

    const km = Math.round(haversineKm(hubGeo, renterGeo) * 10) / 10;
    const settings = (await ctx.runQuery(internal.settings.__service_get, {})) as { hub_max_km?: number; hub_heavy_max_km?: number } | null;
    const maxKm = settings?.hub_max_km ?? 30;
    const heavyMaxKm = settings?.hub_heavy_max_km ?? maxKm;
    const deliverable = km <= maxKm;
    return {
      ok: true,
      distance_km: km,
      hub_label: hub.hub_label ?? hub.hub_postcode,
      renter_area: renterGeo.label,
      max_km: maxKm,
      heavy_max_km: heavyMaxKm,
      within_delivery_range: deliverable,
      within_heavy_range: km <= heavyMaxKm,
      non_central: km > 5, // triggers the 10% distance discount rule
      note: deliverable
        ? `~${km}km from our ${hub.hub_label ?? "hub"} — within delivery range (offer delivery or pickup).`
        : `~${km}km — beyond our ${maxKm}km delivery range; offer pickup only.`,
    };
  },
});


// ── Tool: find_owned_alternatives ─────────────────────────────────────────────
// The account's OWNED, in-stock items (active, not marketing-only) — optionally
// filtered to one kind (lens, camera, drone...). Used to offer a REAL substitute
// when the renter asks for something we don't stock. Works for every account.
/** Technical evidence only: never an availability or rental-kit verdict. */
export const get_verified_camera_profiles = query({ args: {}, handler: async ctx => {
  return (await readEquipmentClaimProfiles(ctx)).cameras;
} });
async function readEquipmentClaimProfiles(ctx:QueryCtx) {
 const [items,specs]=await Promise.all([ctx.db.query("items").collect(),ctx.db.query("item_specs").collect()]);
 return equipmentClaimProfiles(items,specs);
}
export const get_verified_equipment_profiles=query({args:{},handler:readEquipmentClaimProfiles});

export const find_owned_alternatives = query({
  args: {
    account_slug: v.string(),
    kind: v.optional(v.string()),
    lens_mount: v.optional(v.string()),
    camera_requirements: v.optional(cameraRequirementsValidator),
    lens_requirements: v.optional(lensRequirementsValidator),
    item_name: v.optional(v.string()),
    exclude_name: v.optional(v.string()),
    lower_value_only: v.optional(v.boolean()),
    max_rental_total_gbp: v.optional(v.number()),
    start_date: v.optional(v.string()),
    end_date: v.optional(v.string()),
    quantity: v.optional(v.number()),
    thread_id: v.optional(v.string()),
    booking_use: v.optional(v.union(v.literal("standalone"),v.literal("additional"),v.literal("replacement"),v.literal("separate"))),
    replace_product_id: v.optional(v.number()),
    replace_quantity: v.optional(v.number()),
  },
  handler: async (ctx, { account_slug, kind, lens_mount, item_name, exclude_name, start_date, end_date, quantity, thread_id, camera_requirements, lens_requirements, lower_value_only, max_rental_total_gbp, booking_use, replace_product_id, replace_quantity }) => {
    const quoteDays=inclusiveRentalDays(start_date,end_date);
    if(max_rental_total_gbp!==undefined&&(!Number.isFinite(max_rental_total_gbp)||max_rental_total_gbp<=0||
      quoteDays===null||quoteDays>366||!Number.isInteger(quantity??1)||(quantity??1)<1||(quantity??1)>20))
      return {count:0,alternatives:[],budget_outcome:"invalid_budget_scope",error:"A rental-total limit needs a positive amount, valid exact dates and quantity. A daily rate cannot establish a total-budget match."};
    // Owned = active + not marketing-only + qty>0 on the SHARED items table
    // (accounts front the same gear). If kind is given AND real, narrow by it;
    // otherwise scan all and rank by NAME similarity to the requested item —
    // robust when a marketing listing has kind=null.
    // The `kind` taxonomy is NOT consistent across the catalog: the RED Komodo
    // is "camera_body" while every rentable camera is "camera". A kind-scoped
    // query therefore returned only marketing rows, filtered to ZERO owned
    // alternatives, and the caller silently got nothing to offer — which left
    // the draft with no grounding at all and escalated 100% of not-owned
    // inquiries. Normalise for comparison, and never let a kind filter be the
    // reason we have nothing to suggest.
    const normKind = (k?: string | null): string =>
      (k ?? "").toLowerCase().replace(/_?(body|bodies)$/, "").replace(/_+$/, "");
    const isOwned = (it: { status?: string; is_marketing_only?: boolean; qty?: number }) =>
      it.status === "active" && !it.is_marketing_only && (it.qty ?? 0) > 0;

    let base = kind
      ? await ctx.db.query("items").withIndex("by_kind", (q) => q.eq("kind", kind)).collect()
      : await ctx.db.query("items").collect();
    let owned = base.filter(isOwned);
    let kindFellBack = false;
    if (owned.length === 0) {
      // Either the kind was wrong/unknown, or everything of that kind is
      // marketing-only. Scan the whole catalog and let substitution ranking
      // (same normalised category, mount, family) pick — that is strictly
      // better than returning an empty list.
      base = await ctx.db.query("items").collect();
      owned = base.filter(isOwned);
      kindFellBack = true;
    }

    // NOTE (2026-08-21): the old local tokenizer here listed "pro", "full",
    // "frame", "camera" and "lens" as STOP words. That made "BMPCC 6K Pro" and
    // "BMPCC 6K Full Frame" both reduce to {bmpcc, 6k} — identical — so the
    // ranker could not tell two different camera bodies apart and happily
    // offered the wrong one. Ranking now uses the shared, variant-preserving
    // matcher in lib/item_name_match.ts instead.

    // Prices and wording are account-specific. Reading every account's fat
    // listing docs both mixed brands and dominated this tool's DB bandwidth.
    const listings = await ctx.db
      .query("online_listings")
      .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
      .collect();
    // Resolve price by IDENTITY (item -> product_id index -> listing), the
    // same path lookup_pricing uses.
    //
    // The old implementation here matched listing NAME tokens at >=0.6
    // coverage and took the CHEAPEST hit. Live consequence: this tool quoted
    // the Sony FX3 at £18/day while lookup_pricing quoted the real £40/day
    // from its actual listing — so a single conversation said "£18/day" in one
    // turn and "£112 for 4 days" (£40/day) in another, and every substitution
    // we offered was under-priced. Identity, not similarity.
    const idxAll = await ctx.db.query("hygglo_product_index").collect();
    // OVERRIDE ∪ INDEX. listing_resolution_override is audit-authoritative and
    // wins over the index everywhere; reading the index alone made this tool
    // miss the mapping and fall back to the curated catalog. Live: it quoted
    // the Blazar Remus 100mm at £26 (stale catalog) while lookup_pricing --
    // which does consult overrides -- quoted the real listing's £25, so one
    // conversation stated two different prices for the same lens two turns
    // apart. Only SINGLE-item overrides count: a bundle's price is the
    // bundle's, not the component's.
    const ovAll = await ctx.db.query("listing_resolution_override").collect();
    const allInventory = await ctx.db.query("items").collect();
    const specs = await ctx.db.query("item_specs").collect();
    const specsByItem = inventorySpecMap(specs);
    const {listing:candidateListing,price:candidatePrice}=ownedItemHirePriceReader(ctx,account_slug,listings,idxAll,ovAll,allInventory,quoteDays,quantity??1);
    // Alternative listing quotes require identity-backed account pricing.

    // Rank by SUBSTITUTABILITY, not bare name overlap. A renter asking for a
    // Blackmagic cinema body should be offered the other Blackmagic body (same
    // family, and ideally a mount their glass already fits) — not whichever
    // Sony happens to share the token "camera". Same-kind + same-mount +
    // shared family tokens all contribute; see lib/item_name_match.ts.
    let ranked = owned as typeof owned;
    let matchedBy = kind ? "kind" : "all";
    // The item being replaced — needed for mount/family affinity scoring.
    const targetName = item_name ?? exclude_name ?? null;
    let targetId: string | null = null;
    let targetValue: number | null = null;
    let targetRentable=false;
    let target: { name: string; kind?: string | null; lens_mount?: string | null } | null = null;
    if (targetName) {
      // Resolve against the FULL catalog, not just owned: the item being
      // replaced is very often the one we do NOT stock, so looking it up in
      // `owned` would never find it and we would lose its kind and mount —
      // exactly the signals that make a substitute sensible.
      const allForTarget = await ctx.db.query("items").collect();
      const tm = bestMatch(targetName, allForTarget, (i) => i.name_canonical, (i) => (i.aliases ?? []) as string[]);
      if (tm.match && tm.confident) {
        targetValue = typeof tm.match.replacement_cost_gbp === "number" && tm.match.replacement_cost_gbp > 0 ? tm.match.replacement_cost_gbp : null;
        targetId = String(tm.match._id);
        targetRentable=tm.match.status==="active"&&!tm.match.is_marketing_only&&tm.match.qty>0;
        target = {
          name: tm.match.name_canonical,
          kind: tm.match.kind ?? null,
          lens_mount: tm.match.lens_mount ?? null,
        };
      } else {
        target = { name: targetName, kind: kind ?? null, lens_mount: lens_mount ?? null };
      }
    }
    if (target) {
      const t = target;
      const tn = { ...t, kind: normKind(t.kind) };
      ranked = owned
        .slice()
        .sort((a, b) =>
          substitutionScore(tn, { name: b.name_canonical, kind: normKind(b.kind), lens_mount: b.lens_mount }) -
          substitutionScore(tn, { name: a.name_canonical, kind: normKind(a.kind), lens_mount: a.lens_mount }),
        );
      matchedBy = "substitution";
    } else if (item_name) {
      const scored = rankByName(item_name, owned, (i) => i.name_canonical, (i) => (i.aliases ?? []) as string[]);
      if (scored.length) {
        ranked = scored.map((x) => x.item);
        matchedBy = "name";
      }
    }

    const exclude = (exclude_name ?? "").toLowerCase().trim();
    const targetLower = (item_name ?? "").toLowerCase().trim();
    const exclusion = exclude_name ? bestMatch(exclude_name, allInventory, i => i.name_canonical, i => i.aliases ?? []) : null;
    const excludedMatch = exclusion?.confident ? exclusion.match : null;
    const cameraQuery = camera_requirements !== undefined || normKind(kind) === "camera" || normKind(target?.kind) === "camera";
    const requirements: CameraRequirements = { ...camera_requirements };
    if (cameraQuery && !requirements.role) {
      const exactTarget = allInventory.find(i => i.name_canonical === target?.name);
      const targetCapabilities = exactTarget ? verifiedCameraCapabilities(specsByItem.get(String(exactTarget._id)), exactTarget.name_canonical) : null;
      const role = targetCapabilities?.role ?? requestedCameraRole(target?.name ?? targetName, kind ?? target?.kind);
      if (role) requirements.role = role;
    }
    const booking = thread_id ? await getBotBooking(ctx,thread_id) : null;
    const labOrder = thread_id ? await getLabOrder(ctx,thread_id) : null;
    if ((booking?.account_slug && booking.account_slug !== account_slug) || (labOrder?.account_slug && labOrder.account_slug !== account_slug))
      return {count:0,alternatives:[],error:"The current booking belongs to a different account"};
    const stage = rentalStage(booking,londonToday()).stage;
    const closed = ["COMPLETED","CANCELLED","VERIFICATION_FAILED"].includes(stage);
    const requiresBookingContext = ["CONFIRMED_UPCOMING","COLLECTION_DUE","IN_USE","RETURN_OVERDUE"].includes(stage);
    if(max_rental_total_gbp!==undefined&&booking_use!=="separate"&&(requiresBookingContext||booking_use&&booking_use!=="standalone"))
      return {count:0,alternatives:[],budget_outcome:"joint_quote_required",error:"This total-budget filter applies to an independent candidate hire. A current-booking addition or replacement needs a Native quote for the complete proposed basket; its candidate price is not the basket total."};
    const existingLines: RecommendationLine[] = labOrder ? labOrder.items.map(l=>({name:l.name,qty:l.qty,product_id:l.product_id,item_id:l.item_id ? String(l.item_id) : undefined}))
      : booking?.hygglo_items?.length ? booking.hygglo_items.map(l=>({name:l.name,qty:l.qty ?? 1,product_id:l.product_id}))
      : booking?.items?.map(l=>({name:l.item_name,qty:l.qty ?? 1})) ?? [];
    const recent = booking_use!=="separate" && thread_id ? await recentThreadMessages(ctx,thread_id,12) : [];
    const latestRenter = recent.filter(m=>m.sender!=="owner").at(-1)?.body_text ?? "";
    const expectedUse = requiresBookingContext ? explicitRecommendationUse(latestRenter) : undefined;
    const lensQuery = lens_requirements !== undefined || normKind(kind) === "lens" || normKind(target?.kind) === "lens";
    const desiredLensRequirements = lens_requirements ?? {};
    const lensRequirementsSpecified = lens_requirements !== undefined;
    const basketContext = {requires_booking_context:requiresBookingContext,open_basket:!closed && existingLines.length>0,
      can_replace:!["IN_USE","RETURN_OVERDUE"].includes(stage),booking_use,expected_use:expectedUse,replace_product_id,replace_quantity};
    const alternatives: Array<Record<string, unknown>> = [];
    const rejected = { requirements: 0, stock: 0, budget_over_limit:0, budget_price_unknown:0 };
    const rejectedBudgetOptions:Array<{item_id:string;name:string;total_gbp:number;product_id:number|null}>=[];
    const budgetPriceReviewNeeded:Array<{item_id:string;name:string;product_id:number|null}>=[];
    const budgetPriceFacts:Array<{item_id:string;name:string;product_id:number;total_gbp:number}>=[];
    const recordBudgetPrice=(item:typeof owned[number],priced:Awaited<ReturnType<typeof candidatePrice>>)=>{
      if(priced.quote&&priced.altPid!=null)budgetPriceFacts.push({item_id:String(item._id),name:item.name_canonical,product_id:priced.altPid,total_gbp:priced.quote.listed_total_gbp});
    };
    if(max_rental_total_gbp!==undefined&&targetRentable&&targetId){
      const original=allInventory.find(item=>String(item._id)===targetId);
      if(original)recordBudgetPrice(original,await candidatePrice(original));
    }
    const lensReviewNeeded: Array<{item_id:string;name:string;unverified_requirements:string[]}> = [];
    const cameraReviewNeeded: Array<{item_id:string;name:string;unverified_requirements:string[]}> = [];
    const rejectedStockOptions: Array<Record<string,unknown>> = [];
    const stockSources = start_date && end_date ? await loadStockSources(ctx) : null;
    for (const it of ranked) {
      // Replacement value, never the daily hire rate, determines this filter.
      if (lower_value_only && (targetValue == null || typeof it.replacement_cost_gbp !== "number" || it.replacement_cost_gbp <= 0 || it.replacement_cost_gbp >= targetValue)) continue;
      if (cameraQuery && normKind(it.kind) !== "camera") continue;
      const nameLower = it.name_canonical.toLowerCase();
      // Never offer the very item being replaced back as its own alternative.
      if (String(it._id) === targetId || (excludedMatch && it._id === excludedMatch._id)) continue;
      if (exclude && nameLower === exclude) continue;
      if (targetLower && nameLower === targetLower) continue;
      const requiredKind = normKind(target?.kind ?? kind);
      if (requiredKind && normKind(it.kind) !== requiredKind) continue;
      // Normalised compare: inventory spells the same mount several ways
      // ("Canon EF mount" vs "EF"), and an exact compare silently filtered out
      // every genuinely-compatible lens.
      const spec = specsByItem.get(String(it._id));
      const capabilities = verifiedCameraCapabilities(spec, it.name_canonical);
      const lensCapabilities = lensQuery && it.kind === "lens" ? verifiedLensCapabilities(spec,it.name_canonical) : null;
      if (!cameraQuery && lens_mount && !sameMount(it.lens_mount ?? "", lens_mount)) continue;
      if(lensQuery&&(it.kind!=="lens"||!lensRequirementsSpecified)){rejected.requirements++;continue;}
      const lensAssessment=lensQuery?assessLensRequirements(lensCapabilities,desiredLensRequirements):null;
      const cameraAssessment=cameraQuery?assessCameraRequirements(capabilities,requirements,lens_mount):null;
      // Known incompatibility is decided from the already loaded reviews.
      // It needs no pricing query and is not a potential budget solution.
      if(lensAssessment?.status==="mismatch"||cameraAssessment?.status==="mismatch"){rejected.requirements++;continue;}
      const budgetPrice=max_rental_total_gbp!==undefined?await candidatePrice(it):null;
      if(budgetPrice){
        recordBudgetPrice(it,budgetPrice);
        if(budgetPrice.quote&&Math.round(budgetPrice.quote.listed_total_gbp*100)>Math.round(max_rental_total_gbp!*100)){
          rejected.budget_over_limit++;
          rejectedBudgetOptions.push({item_id:String(it._id),name:it.name_canonical,total_gbp:budgetPrice.quote.listed_total_gbp,product_id:budgetPrice.altPid??null});
          continue;
        }
      }
      const recordBudgetPriceReview=()=>{
        if(budgetPrice&&!budgetPrice.quote){
          rejected.budget_price_unknown++;
          budgetPriceReviewNeeded.push({item_id:String(it._id),name:it.name_canonical,product_id:budgetPrice.altPid??null});
        }
      };
      if(lensAssessment?.status==="unknown"){
        lensReviewNeeded.push({item_id:String(it._id),name:it.name_canonical,unverified_requirements:lensAssessment.unknown});recordBudgetPriceReview();
        rejected.requirements++;continue;
      }
      if(cameraAssessment?.status==="unknown"){
        cameraReviewNeeded.push({item_id:String(it._id),name:it.name_canonical,unverified_requirements:cameraAssessment.unknown});recordBudgetPriceReview();
        rejected.requirements++;continue;
      }
      if(budgetPrice&&!budgetPrice.quote){recordBudgetPriceReview();continue;}

      // Tier table for the listing this alternative is priced from, so an
      // upsell quoted during a 5-day booking uses the 5-day rate rather than
      // the 1-day one.
      const {candidateContents,altListing,altPid}=candidateListing(it);
      const basket = recommendationBasket(existingLines,{name:it.name_canonical,qty:quantity ?? 1,item_id:String(it._id),product_id:altPid},basketContext);
      const check = stockSources && start_date && end_date && basket.ok
        ? await checkOrderRentalStock(ctx,account_slug,basket.lines,start_date,end_date,basket.use==="separate"?"":thread_id ?? "",stockSources) : null;
      if (check && check.available !== true) {
        rejected.stock++;
        if (rejectedStockOptions.length<8) rejectedStockOptions.push({name:it.name_canonical,kind:it.kind,booking_use:basket.use,
          reason:check.reason,stock_receipts:check.receipts.map(r=>({...r,...(basket.use==="separate"?{new_inquiry:true as const}:{})}))});
        continue;
      }
      const stock = stockSources && start_date && end_date ? {available:check?.available ?? null,
        start_date,end_date,quantity:quantity ?? 1,free_units:["standalone","separate"].includes(basket.use??"") ? check?.receipts.find(r=>r.item_id===String(it._id))?.free_units ?? null : null,
        checked_at:Date.now(),basis:basket.use ?? "unresolved_booking_context",reason:basket.ok ? check?.reason ?? "dates_required" : basket.reason} : null;
      const {altTiers,altOneDay,quote}=budgetPrice??await candidatePrice(it);
      const physical=altPid!=null?candidateContents.get(altPid):undefined;
      const kitContext=await listingKitContext(ctx,account_slug,it,physical?.components??[],allInventory,
        {indexes:idxAll,overrides:ovAll,peers:listings});
      const kit=kitContext.kit,storageNeedsReview=kitContext.contents_review_required;
      const mappingComplete=physical?.complete??false;
      const includesLens=["camera","camera_body"].includes(it.kind??"")&&mappingComplete
        ?physical!.components.some(c=>c.kind==="lens"):null;
      const verified = verifiedItemSpec(spec, it.name_canonical);
      alternatives.push({
        item_id:String(it._id),
        product_id:altPid??null,
        quote: quote ? { ...quote, start_date, end_date, product_id: altPid, matched_listing: altListing?.name } : null,
        price_tiers: altTiers,
        availability: stock,
        stock_receipts: (check?.receipts ?? []).map(r=>({...r,...(basket.use==="separate"?{new_inquiry:true as const}:{})})),
        booking_use: basket.use ?? null,
        stock_context_reason: basket.ok ? null : basket.reason,
        replacement_removed_listings: basket.removed,
        replacement_changes_kit_contents: basket.removed.length>0,
        storage_contents_verification_required:storageNeedsReview,
        storage_guidance:storageNeedsReview ? "Supplied media records conflict or overlap. kit_contents contains the known part; unreconciled_kit_contents does not establish another card or a generic card format. Ask the owner to verify linked type, capacity and count. Camera compatibility does not prove supplied media." : null,
        unreconciled_kit_contents:kit.unreconciled_contents,
        name: it.name_canonical,
        kind: it.kind,
        replacement_cost_gbp: it.replacement_cost_gbp ?? null,
        lens_mount: capabilities?.native_mount ?? it.lens_mount ?? null,
        lens_capabilities: lensCapabilities,
        camera_capabilities: capabilities,
        daily_price_gbp: altOneDay ?? altListing?.daily_price ?? null,
        price_requires_owner_confirmation: !altListing,
        included: kit.included,
        kit_contents: kit.contents,
        kit_source: kit.source,
        mapping_complete: mappingComplete,
        listing_name: altListing?.name ?? null,
        includes_lens: includesLens,
        spec_text: verified?.text ?? null,
        spec_verification: verified ? { model: verified.model, source_url: verified.source_url } : null,
      });
      // 6, not 8. The route only ever shows the top 5 and the craft rules say
      // to offer ONE (at most two) — the tail was never used, but was re-sent
      // on every subsequent agent step.
      if (alternatives.length >= 6) break;
    }
    const kitReviewProducts=alternatives.filter(a=>a.storage_contents_verification_required&&a.mapping_complete&&typeof a.product_id==="number").map(a=>a.product_id as number);
    const ownerCheck=kitReviewProducts.length ? {kind:"kit_recommendation" as const,candidate_product_ids:[...new Set(kitReviewProducts)],
      start_date:start_date??null,end_date:end_date??null,quantity:quantity??1} : !alternatives.length ? lensQuery && lensRequirementsSpecified && lensReviewNeeded.length ? {
      kind:"lens_recommendation" as const,requirements:desiredLensRequirements,candidate_item_ids:lensReviewNeeded.map(i=>i.item_id),lens_mount:lens_mount??null,
      start_date:start_date??null,end_date:end_date??null,quantity:quantity??1,
    } : cameraQuery && hasCameraRequirements(requirements,lens_mount) && cameraReviewNeeded.length ? {
      kind:"camera_recommendation" as const,requirements,candidate_item_ids:cameraReviewNeeded.map(i=>i.item_id),lens_mount:lens_mount??null,
      start_date:start_date??null,end_date:end_date??null,quantity:quantity??1,
    } : null : null;
    return {
      account_slug,thread_id:thread_id??null,
      rental_stage:stage,
      booking_context_required:requiresBookingContext&&booking_use!=="separate",
      current_booking_listings:existingLines,
      booking_use:booking_use ?? expectedUse ?? (requiresBookingContext ? null : "standalone"),
      message_booking_use:expectedUse ?? null,
      rejected_stock_options:rejectedStockOptions,
      stock_guidance:"Availability applies only to the returned booking_use. For a separate hire choose separate, which checks the new gear while keeping the existing reservation occupied. After selecting an option, use check_basket_availability with separate and its exact listing ID for a Native combined quote. For a confirmed-booking amendment, choose additional or replacement with the exact current replace_product_id. Replacement removes that entire listing's specified units, including its kit contents; explain what changes. In-use replacements require return confirmation. Unknown context or missing dates cannot prove availability. Prices are for each suggested offering, not a combined booking total. No booking was changed.",
      kind: kind ?? null,
      matched_by: matchedBy,
      kind_fell_back: kindFellBack,
      target: target?.name ?? null,
      target_rentable:targetRentable,
      target_identity_resolved: targetId != null,
      target_item_id:targetId!=null?String(targetId):null,
      lower_value_only: lower_value_only === true,
      target_replacement_cost_gbp: targetValue,
      lower_value_reason: lower_value_only && targetValue == null ? "Original item identity or replacement value is unverified; ask the owner before suggesting a lower-value option" : null,
      verification_approval_guaranteed: false,
      camera_requirements: cameraQuery ? requirements : null,
      required_native_mount:lens_mount??null,requested_quantity:quantity??1,
      lens_requirements: lensQuery ? desiredLensRequirements : null,
      lens_requirements_specified: lensQuery && lensRequirementsSpecified,
      lens_requirement_checked: lensQuery && lensRequirementsSpecified && hasLensRequirements(desiredLensRequirements),
      lens_review_needed: lensQuery ? lensReviewNeeded : [],
      owner_check:ownerCheck,
      camera_review_needed:cameraQuery?cameraReviewNeeded:[],
      camera_search_outcome:!cameraQuery?null:alternatives.length?"verified_matches":cameraReviewNeeded.length?"needs_spec_review":"no_verified_match",
      camera_inventory_absence_established:false,
      camera_guidance:"Missing mode proof is not camera absence or dated unavailability. camera_review_needed identifies owned candidates requiring exact-model specification review, not verified alternatives. Explain the missing proof and proceed with the owner review. Reviewed modes are positive evidence, not an exhaustive list of unsupported modes. A handled task is not specification, stock or price proof.",
      lens_search_outcome: !lensQuery ? null : !lensRequirementsSpecified ? "requirements_not_specified" : alternatives.length ? "verified_matches" : lensReviewNeeded.length ? "needs_spec_review" : "no_verified_match",
      lens_inventory_absence_established: false,
      owner_review_workflow: ownerCheck ? {
        status:"owner_review_required",persistence:"with_saved_draft_or_review",customer_input_required:false,specification_result_verified:false,
      } : null,
      lens_guidance: "Pass a structured lens_requirements object for the desired option, including {} when no technical constraints apply. Current-item descriptions and questions are not alternative requirements. Lens suitability requires reviewed exact-model properties. Unknown does not satisfy a hard requirement. lens_review_needed names are owned items requiring specification review, not verified alternatives. Zero verified matches never proves that we do not own an item or that it is booked; explain missing verification and ask the owner to check. Wide-angle labels do not guarantee angle of view on a cropped sensor; confirm the camera and recording mode. F-stops and T-stops are distinct. Stock and native mount checks remain separate.",
      max_rental_total_gbp:max_rental_total_gbp??null,
      budget_price_scope:max_rental_total_gbp!==undefined?"independent_candidate_hire":null,
      budget_outcome:max_rental_total_gbp===undefined?null:alternatives.length?"verified_matches":
        cameraReviewNeeded.length||lensReviewNeeded.length||budgetPriceReviewNeeded.length?"needs_review":"no_verified_match",
      rejected_budget_options:rejectedBudgetOptions.slice(0,8),
      budget_price_review_needed:budgetPriceReviewNeeded.slice(0,8),
      budget_check_facts:max_rental_total_gbp!==undefined?{start_date:start_date!,end_date:end_date!,quantity:quantity??1,max_total_gbp:max_rental_total_gbp,prices:budgetPriceFacts.slice(0,8)}:null,
      budget_matches_exhaustive:false,
      budget_guidance:max_rental_total_gbp===undefined?null:"Returned alternatives have a verified dated candidate hire total within the supplied maximum. The limit is a hard constraint, not an ideal target. Rejected-budget rows are price diagnostics, not stock or capability proof. Unknown price or mode proof does not establish an affordable match or that no suitable owned option exists. Continue specification/price owner review where needed; do not claim the cheapest option from partial verification. This search grants no discount or booking authority. Current-booking changes require a quote for the complete proposed basket.",
      recording_requirement_checked: !!requirements.recording,
      // Only the recorded mode properties are checked, never arbitrary codecs.
      requirements_match_is_not_codec_verification: true,
      rejected,
      count: alternatives.length,
      alternatives,
    };
  },
});

/**
 * Mount adapters we own and rent.
 *
 * Why this exists: the bot correctly told a renter the Blazar Remus lenses are
 * native PL and "would require a PL-to-EF adapter, which isn't included" — and
 * then stopped there. We own five mount adapters. A blocker we can actually
 * sell the fix for should never be delivered as a dead end.
 *
 * Selection is by CANONICAL NAME PATTERN over our own inventory ("X to Y
 * mount"), which is exact and auditable — it deliberately excludes "V-mount
 * 150Wh"/"V-mount 95Wh", which are batteries, not adapters. This is not a
 * similarity match against listing titles.
 */
export const get_addition_mount_requirements = query({
  args: { thread_id: v.string(), account_slug: v.string(), product_id: v.optional(v.number()), quantity: v.optional(v.number()), items: v.optional(v.array(v.object({ product_id: v.number(), qty: v.number() }))) },
  handler: additionMountRequirements,
});

export const get_mount_adapters = query({
  args: { account_slug: v.string() },
  handler: async (ctx, { account_slug }) => {
    const ADAPTER_RE = /^\s*([a-z0-9 ]+?)\s+to\s+([a-z0-9 ]+?)\s*mount\s*$/i;
    const inventory = await ctx.db.query("items").collect();
    const items = inventory.filter(
      (i) =>
        i.status === "active" &&
        !i.is_marketing_only &&
        (i.qty ?? 0) > 0 &&
        ADAPTER_RE.test(i.name_canonical),
    );
    if (items.length === 0) return { adapters: [] };

    const listings = await ctx.db
      .query("online_listings")
      .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
      .collect();
    const idxAll = await ctx.db.query("hygglo_product_index").collect();
    const listingByPid = new Map(listings.map((l) => [l.product_id, l]));
    const catalog = await ctx.db.query("pricing_catalog").collect();
    const catalogPrice = new Map<string, number>();
    for (const row of catalog) {
      const k = row.item_name_canonical.toLowerCase().trim();
      const cur = catalogPrice.get(k);
      if (cur === undefined || row.daily_price_min < cur) catalogPrice.set(k, row.daily_price_min);
    }
    // Identity-first, cheapest own listing, then the curated catalog — the same
    // order lookup_pricing and find_owned_alternatives use, so the three tools
    // cannot quote different numbers for one item.
    // Override ∪ index, for the same reason as find_owned_alternatives above:
    // the index alone misses adapters that are only mapped by an override, and
    // the price silently degrades to null or a stale catalog row.
    const ovAll = await ctx.db.query("listing_resolution_override").collect();
    const pidsFor = (itemId: string): number[] => baseListingProductIds(account_slug, itemId, idxAll, ovAll, inventory,listings);
    const priceFor = (itemId: string, name: string): number | null => {
      let best: number | null = null;
      for (const pid of pidsFor(itemId)) {
        const l = listingByPid.get(pid) as { daily_price?: number } | undefined;
        if (typeof l?.daily_price !== "number") continue;
        if (best === null || l.daily_price < best) best = l.daily_price;
      }
      return best ?? catalogPrice.get(name.toLowerCase().trim()) ?? null;
    };

    return {
      adapters: await Promise.all(items.map(async (i) => {
        const m = i.name_canonical.match(ADAPTER_RE);
        const pid = chooseBaseListing(listings, pidsFor(String(i._id)))?.product_id;
        const hp = pid == null ? null : await ctx.db
          .query("hygglo_products")
          .withIndex("by_account_product", (q) =>
            q.eq("accountSlug", account_slug).eq("productId", pid),
          )
          .unique();
        return {
          price_tiers: describeTiers((hp?.prices ?? []) as PriceTier[]),
          name: i.name_canonical,
          from_mount: (m?.[1] ?? "").trim(),
          to_mount: (m?.[2] ?? "").trim(),
          qty: i.qty ?? 0,
          daily_price_gbp: priceFor(String(i._id), i.name_canonical),
        };
      })),
    };
  },
});

/**
 * The account's HARD TRUTHS — the owner's own standing instructions.
 *
 * Daniel writes these per account in Settings ("SD cards, batteries, chargers,
 * cables and straps are INCLUDED free ... never quote them as separate paid
 * items", "only ever offer gear that's actually in my inventory", "listing
 * titles sometimes say 'like a [model]' — those are marketing comparisons, NOT
 * gear I stock"). They are assembled in replyInbox.ts and editable in the
 * Settings drawer, and the renter-bot draft route never received them, so the
 * model had never seen one.
 *
 * Today's replies happen to comply because the kit data says the same thing —
 * but that is accidental. Any item without kit data leaves the rule with
 * nothing behind it, and the other clauses are not covered by data at all.
 */
export const get_hard_truths = query({
  args: { account_slug: v.string() },
  handler: async (ctx, { account_slug }) => {
    const account = (await ctx.db.query("accounts").collect()).find(
      (a) => a.slug === account_slug,
    );
    if (!account) return { hard_truths: null };
    const profile = await ctx.db
      .query("account_profiles")
      .withIndex("by_account", (q) => q.eq("account_id", account._id))
      .unique();
    return { hard_truths: profile?.hard_truths ?? null };
  },
});

// Privileged caller counterpart; shares the original handler and validators.
export const __service_lookup_pricing = internalQueryOf(lookup_pricing);

// Privileged caller counterpart; shares the original handler and validators.
export const __service_find_owned_alternatives = internalQueryOf(find_owned_alternatives);

// Privileged caller counterpart; shares the original handler and validators.
export const __service_get_verified_camera_profiles = internalQueryOf(get_verified_camera_profiles);
export const __service_get_verified_equipment_profiles = internalQueryOf(get_verified_equipment_profiles);
