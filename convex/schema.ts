import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Phase 1.A schema. Tables with `Empty in this phase` are scaffolding for later phases
// (renters, reservations, conversations, rules, denial_records).
// MASTER SAFETY RAIL: settings.ALLOW_HYGGLO_SEND must remain false.
export default defineSchema({
  // ── To-Do lists (owner personal checklists) ──────────────────
  todo_lists: defineTable({
    name: v.string(),
    items: v.array(v.object({ id: v.string(), text: v.string(), done: v.boolean() })),
    created_at: v.number(),
  }),
  // ── Accounts ─────────────────────────────────────────────────
  accounts: defineTable({
    slug: v.string(),                  // "leo" | "dbcinema"
    display_name: v.string(),
    hygglo_seller_id: v.optional(v.string()),
    hygglo_username: v.optional(v.string()),
    /** Hygglo profile photo. Seeded from /v4/my/orders/:id detail.users.me.profileImage. */
    profile_image_url: v.optional(v.string()),
    notes: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_slug", ["slug"]),

  // Per-account persona/templates/rules (Phase 1.B v1 mining seed)
  account_profiles: defineTable({
    account_id: v.id("accounts"),
    // legacy fields (kept for compat)
    persona: v.optional(v.string()),
    templates: v.optional(v.any()),
    // expanded Phase 1.B fields
    persona_prompt: v.optional(v.string()),
    language: v.optional(v.string()),
    greeting_template: v.optional(v.string()),
    signoff_template: v.optional(v.string()),
    business_hours: v.optional(v.any()),
    delivery: v.optional(v.any()),
    pricing_rules: v.optional(v.any()),
    discount_codes: v.optional(v.array(v.any())),
    response_style: v.optional(v.any()),    // widened from string to JSON object
    rules: v.optional(v.any()),
    // Owner-editable ground-truth injected verbatim at the END of the draft
    // prompt (recency bias) — e.g. included-free accessories, battery families,
    // "suggest only gear we own". Account-specific. See generateDraft.
    hard_truths: v.optional(v.string()),
    // Per-account main rental hub (where THIS account's gear lives). Confirmed
    // via postcodes.io. Tile distance + the too-heavy tag measure from here.
    // (The heavy/max-km ranges stay global in `settings`.)
    hub_postcode: v.optional(v.string()),
    hub_label: v.optional(v.string()),
    hub_lat: v.optional(v.number()),
    hub_lng: v.optional(v.number()),
    // Per-account PICKUP address (full street + postcode). Shared with the
    // renter only AFTER a booking is confirmed. Editable in Settings.
    pickup_address: v.optional(v.string()),
    // Per-account pickup/return WINDOWS (London). Empty -> global default
    // (10:00-12:00 & 19:00-21:00). Editable in Settings.
    pickup_hours: v.optional(v.array(v.object({ start: v.string(), end: v.string() }))),
    // Post-return discount code texted to good renters (Settings drawer).
    // Interpolated into the account's return message template at return time;
    // unset -> DEFAULT_RETURN_DISCOUNTS (convex/lib/return_messages.ts).
    return_discount_code: v.optional(v.string()),
    return_discount_percent: v.optional(v.number()),
    message_templates: v.optional(v.any()),
    unknown_categories: v.optional(v.array(v.string())),
    last_synced_v1: v.optional(v.number()),
    source_files: v.optional(v.array(v.string())),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_account", ["account_id"]),

  // ── Inventory ────────────────────────────────────────────────
  items: defineTable({
    name_canonical: v.string(),
    name_input: v.string(),
    slug: v.string(),
    kind: v.string(),                // camera, lens, audio, lighting, grip, gimbal, drone, monitor, transmission, accessory, smoke_fx, dj_audio, power, storage_card, support, motion, stabilizer, video, effects, bundle
    sub_kind: v.optional(v.string()),
    qty: v.number(),
    unit_kind: v.string(),           // "unit" | "kit" | "set"
    weight_kg: v.optional(v.number()),
    length_cm: v.optional(v.number()),
    width_cm: v.optional(v.number()),
    height_cm: v.optional(v.number()),
    size_score: v.optional(v.number()),
    category_v1: v.optional(v.string()),
    notes: v.optional(v.string()),
    lens_mount: v.optional(v.string()),
    battery_type: v.optional(v.string()),
    card_type: v.optional(v.string()),
    compatibility: v.optional(v.object({
      batteries: v.optional(v.array(v.string())),
      cards: v.optional(v.array(v.string())),
      lenses: v.optional(v.array(v.string())),
      accessories: v.optional(v.array(v.string())),
      included_with_rental: v.optional(v.array(v.string())),
    })),
    delivery_notes: v.optional(v.string()),
    replacement_cost_gbp: v.optional(v.number()),
    acquisition_cost_gbp: v.optional(v.number()),
    // Unix ms when Leo bought this unit. Used by getItemPayback to project
    // break-even. Falls back to items._creationTime when unknown.
    acquired_at: v.optional(v.number()),
    is_marketing_only: v.boolean(),
    status: v.string(),               // "active" | "inactive" | "marketing_only" | "archived"
    description_source: v.optional(v.string()),
    // Phase 1.B.3: per-item Hygglo cancellation policy text (scraped from listing bottom every 60d).
    // null/undefined for now until Phase 3 Stagehand scrape populates.
    cancellation_policy: v.optional(v.string()),
    aliases: v.optional(v.array(v.string())),        // alternate names imported from v1
    image_url: v.optional(v.string()),              // populated from first matching reservation's photos_urls
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_canonical_name", ["name_canonical"])
    .index("by_slug", ["slug"])
    .index("by_kind", ["kind"]),

  item_specs: defineTable({
    item_id: v.id("items"),
    item_name_canonical: v.string(),
    description: v.string(),
    specs_long: v.optional(v.string()),
    source: v.string(),                // "v1-handwritten" | "grok-generated-2026-05-08"
    created_at: v.number(),
  }).index("by_item", ["item_id"]).index("by_name", ["item_name_canonical"]),

  // ── Bundles (named kits) ─────────────────────────────────────
  bundles: defineTable({
    slug: v.string(),
    bundle_name: v.string(),
    daily_price_min: v.optional(v.number()),
    daily_price_max: v.optional(v.number()),
    use_cases: v.optional(v.array(v.string())),
    trigger_keywords: v.optional(v.array(v.string())),
    savings_note: v.optional(v.string()),
    delivery_note: v.optional(v.string()),
    account_scope: v.optional(v.string()),  // "both" | "leo" | "dbcinema"
    created_at: v.number(),
  }).index("by_slug", ["slug"]).index("by_account_scope", ["account_scope"]),

  bundle_items: defineTable({
    bundle_id: v.id("bundles"),
    item_id: v.optional(v.id("items")),       // null if not yet linked (item name unmatched)
    item_name_canonical: v.string(),
    qty: v.number(),
  }).index("by_bundle", ["bundle_id"]).index("by_item", ["item_id"]),

  // ── Marketing redirects ──────────────────────────────────────
  marketing_redirects: defineTable({
    marketing_name: v.string(),
    real_item_id: v.optional(v.id("items")),
    real_item_name_canonical: v.string(),
    selling_point: v.optional(v.string()),
    category: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_marketing_name", ["marketing_name"]),

  // ── Pricing catalog ──────────────────────────────────────────
  pricing_catalog: defineTable({
    item_id: v.optional(v.id("items")),
    item_name_canonical: v.string(),
    account_id: v.optional(v.id("accounts")),
    category: v.optional(v.string()),
    daily_price_min: v.number(),
    daily_price_max: v.number(),       // 1-day reference
    is_bundle: v.boolean(),
    bundle_items: v.optional(v.array(v.string())),
    multi_day_notes: v.optional(v.string()),
    marketing_only: v.optional(v.boolean()),
    created_at: v.number(),
  }).index("by_item", ["item_id"]).index("by_item_account", ["item_id", "account_id"]).index("by_name", ["item_name_canonical"]),

  // ── Listing photos (port from v1) ────────────────────────────
  listing_photos: defineTable({
    listing_id: v.string(),
    account_id: v.optional(v.id("accounts")),
    account_slug: v.string(),
    items: v.array(v.object({
      item_name: v.string(),
      qty: v.number(),
    })),
    included: v.optional(v.array(v.string())),
    notes: v.optional(v.string()),
    photo_file: v.optional(v.string()),  // legacy /tmp path
    photo_url: v.optional(v.string()),    // future R2 URL (filled in Phase 3)
    created_at: v.number(),
  }).index("by_listing", ["listing_id"]).index("by_account", ["account_id"]),

  // ── Photo R2 mirror index (empty in this phase) ──────────────
  media_index: defineTable({
    kind: v.string(),                // "listing_photo" | "item_canonical"
    r2_key: v.string(),
    source_url: v.optional(v.string()),
    listing_id: v.optional(v.string()),
    item_id: v.optional(v.id("items")),
    created_at: v.number(),
  }).index("by_kind", ["kind"]).index("by_listing", ["listing_id"]).index("by_item", ["item_id"]),

  // ── Renters / reservations / calendar (Phase 2.A v1 import) ──
  renters: defineTable({
    // Phase 2.A v1 import fields (all optional to remain backward-compatible)
    v1_renter_profile_id: v.optional(v.string()),
    hygglo_user_id: v.optional(v.string()),    // widened to optional for v2 import (some v1 rows lack hygglo_user_id)
    display_name: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    hygglo_rating: v.optional(v.number()),
    hygglo_review_count: v.optional(v.number()),
    total_rentals_count: v.optional(v.number()),
    // When renter_trust last read this renter's Hygglo order detail. Lets the
    // backfill cron progress past already-checked (incl. 0-review) renters.
    trust_checked_at: v.optional(v.number()),
    total_spend_gbp: v.optional(v.number()),
    first_rental_at: v.optional(v.number()),
    last_rental_at: v.optional(v.number()),
    blacklisted: v.optional(v.boolean()),
    blacklist_reason: v.optional(v.string()),
    imported_at: v.optional(v.number()),
    notes: v.optional(v.string()),
    blacklist: v.optional(v.boolean()),       // legacy boolean (kept for compat)
    // Renter-bot Phase 1+ — 5-axis DNA profile, evolved per message.
    // Bot reads + updates only when signal is strong (delta > 0.5).
    renter_dna: v.optional(v.object({
      style: v.optional(v.string()),         // formal | casual | terse | chatty
      expertise: v.optional(v.string()),     // pro | intermediate | beginner
      driver: v.optional(v.string()),        // price | quality | speed | trust
      energy: v.optional(v.string()),        // calm | excited | anxious | impatient
      decisionSpeed: v.optional(v.string()), // quick | deliberate | slow | flipflop
      signals_observed: v.optional(v.number()),
      updated_at: v.optional(v.number()),
    })),
    // ── Trust / CRM (CLI-managed via convex/renters_admin.ts) ──
    whitelisted: v.optional(v.boolean()),
    whitelist_reason: v.optional(v.string()),
    blacklisted_at: v.optional(v.number()),
    whitelisted_at: v.optional(v.number()),
    flag_on_request: v.optional(v.boolean()),
    flag_on_request_reason: v.optional(v.string()),
    flag_on_request_at: v.optional(v.number()),
    note_log: v.optional(
      v.array(
        v.object({ text: v.string(), at: v.number(), source: v.optional(v.string()) }),
      ),
    ),
    created_at: v.number(),
  })
    .index("by_hygglo_user_id", ["hygglo_user_id"])
    .index("by_v1_renter_profile_id", ["v1_renter_profile_id"])
    .index("by_blacklisted", ["blacklisted"])
    .index("by_total_spend", ["total_spend_gbp"])
    .index("by_display_name", ["display_name"]),

  reservations: defineTable({
    // Legacy/scaffold fields (kept)
    account_id: v.optional(v.id("accounts")),
    renter_id: v.optional(v.id("renters")),
    listing_id: v.optional(v.string()),
    status: v.string(),               // "confirmed" | "completed" | "pending_review" | "cancelled" | "declined"
    start_at: v.optional(v.number()),
    end_at: v.optional(v.number()),
    notes: v.optional(v.string()),
    // Phase 2.A v1 import fields
    account_slug: v.optional(v.string()),
    v1_rental_id: v.optional(v.string()),
    hygglo_listing_id: v.optional(v.string()),
    start_date: v.optional(v.string()),       // ISO date YYYY-MM-DD
    end_date: v.optional(v.string()),         // ISO date YYYY-MM-DD
    pickup_date: v.optional(v.string()),      // actual gear pickup date (BF-06)
    duration_days: v.optional(v.number()),
    gross_paid_gbp: v.optional(v.number()),
    net_to_owner_gbp: v.optional(v.number()),
    platform_fee_gbp: v.optional(v.number()),
    platform_fee_pct: v.optional(v.number()),
    delivery_fee_gbp: v.optional(v.number()),
    currency: v.optional(v.string()),
    items: v.optional(v.array(v.object({
      item_name: v.string(),
      qty: v.optional(v.number()),
      source: v.optional(v.string()),
      confidence_score: v.optional(v.number()),
      v1_extracteditem_id: v.optional(v.string()),
      // 2026-05-20: widened to accept raw Hygglo items[] (poller commit aa2ad13 starts writing these)
      type: v.optional(v.string()),
      // 2026-05-20: widened to accept raw Hygglo items[] (poller commit aa2ad13 starts writing these)
      image: v.optional(v.any()),
      // 2026-05-20: widened to accept raw Hygglo items[] (poller commit aa2ad13 starts writing these; upstream sends number)
      product_id: v.optional(v.any()),
      // 2026-05-20: widened to accept raw Hygglo items[] (poller commit aa2ad13 starts writing these)
      slug: v.optional(v.string()),
    }))),
    bundle_id: v.optional(v.id("bundles")),
    v1_created_at: v.optional(v.number()),
    v1_updated_at: v.optional(v.number()),
    imported_at: v.optional(v.number()),
    hygglo_order_id: v.optional(v.string()),   // Hygglo order ID for poll-synced reservations
    // ── Phase 1 live-polling fields ──────────────────────────────
    order_step: v.optional(v.union(
      v.literal("REQUEST"),
      v.literal("APPROVED"),
      v.literal("FUNDS_RESERVED"),
      v.literal("VERIFIED"),
      v.literal("BOOKED_AFTER_VERIFIED"),
      v.literal("DELIVERED"),
      v.literal("RETURNED"),
      v.literal("REVIEWED"),
      v.literal("CANCELED"),
      v.literal("VERIFICATION_FAILED"),
    )),
    pickup_time: v.optional(v.string()),           // "HH:MM" — LLM-extracted from owner-renter chat
    return_time: v.optional(v.string()),           // "HH:MM"
    return_date: v.optional(v.string()),           // ISO date — may differ from end_date (e.g. morning after)
    pickup_method: v.optional(v.string()),         // "delivery" | "collection" | "unknown"
    return_method: v.optional(v.string()),
    // ── Listing location cache (2026-06-27) ──
    // The pickup/listing location shown on Hygglo, resolved from the public
    // listing endpoint and cached here. Distance-from-hub + the heavy tag are
    // computed LIVE at read time (from these coords + the current Settings hub),
    // so changing the hub re-rates every tile without a rewrite.
    loc_label: v.optional(v.string()),             // "St James's, Westminster"
    loc_area: v.optional(v.string()),              // "St James's"
    loc_municipality: v.optional(v.string()),      // "London"
    loc_street: v.optional(v.string()),            // "Whitehall 3"
    loc_zip: v.optional(v.string()),               // "SW1A 2DD"
    loc_lat: v.optional(v.number()),
    loc_lng: v.optional(v.number()),
    loc_public_url: v.optional(v.string()),
    loc_resolved_at: v.optional(v.number()),
    // Cached order weight summary (items don't change, so safe to cache).
    loc_total_weight_kg: v.optional(v.number()),
    loc_heaviest_kg: v.optional(v.number()),
    loc_big_items: v.optional(v.number()),
    loc_vehicle: v.optional(v.string()),           // "motorcycle" | "car" | "van"
    /** Hash of the last N messages used for time extraction. If unchanged, skip the LLM call. */
    times_transcript_hash: v.optional(v.string()),
    /** When the extractor last ran successfully for this reservation. */
    times_extracted_at: v.optional(v.number()),
    photos_urls: v.optional(v.array(v.string())),  // raw Hygglo CDN URLs
    /** Wave-5 image-accuracy fix.
     *  Per-item Hygglo image hints captured at poll time (positionally aligned
     *  with `items[]`). Authoritative source for widget thumbnails — never
     *  derived from the global items.image_url, which is shared across rentals
     *  and corrupts neighbouring items. */
    image_hints: v.optional(v.array(v.object({
      item_name: v.string(),                 // Hygglo's items[i].name verbatim
      item_name_normalised: v.string(),      // lowercased + collapsed whitespace
      image_url: v.string(),                 // best per-item URL (large > original > url > medium > thumbnail)
      source: v.union(
        v.literal("hygglo_per_item"),        // items[i].image.* (preferred)
        v.literal("hygglo_order"),           // fallback to order-level photos_urls (legacy poll path)
        v.literal("manual_override"),        // future: owner-set in admin UI
      ),
      captured_at: v.number(),               // ms
    }))),
    /** PASS-9: raw Hygglo per-rental items array — AUTHORITATIVE for dashboard
     *  tile imagery. Bypasses any cross-rental matching against the global
     *  items table (which mis-bound Michelle's Atomos Ninja V to a GM bundle
     *  image). Populated by poller and backfill from detail.items[]. */
    hygglo_items: v.optional(v.array(v.object({
      name: v.string(),
      image_url: v.union(v.string(), v.null()),
      type: v.string(),
      qty: v.optional(v.number()),
      product_id: v.optional(v.number()),
      slug: v.optional(v.string()),
    }))),
    pickup_arrival_confirmed: v.optional(v.boolean()),
    is_obsolete: v.optional(v.boolean()),           // mirrors Hygglo filter=obsolete
    obsolete_reason: v.optional(v.union(
      v.literal("owner_denied"),                    // REQUEST step never advanced
      v.literal("renter_cancelled"),                // CANCELED step active
      v.literal("verification_failed"),             // VERIFIED/FUNDS_RESERVED but obsolete
      v.literal("other"),
    )),
    // Phase 3 calendar integration fields
    pickup_at: v.optional(v.number()),              // ms epoch — actual handover start
    return_at: v.optional(v.number()),              // ms epoch — actual handover end
    renter_name: v.optional(v.string()),            // denormalized from Hygglo otherPartName
    /** 2026-05-19 — Hygglo renter user id (detail.users.otherPart.id). Used by
     *  the poller + backfill to resolve `renter_id` via the renters table's
     *  `by_hygglo_user_id` index. Kept on the reservation row as a denormalized
     *  hint so future runs can re-link without refetching the order. */
    hygglo_user_id: v.optional(v.string()),
    booking_status: v.optional(v.string()),         // raw Hygglo booking status (e.g. "pending_review", "confirmed")
    /** Reply Inbox (2026-06-22): true when Hygglo's order `actions` map currently
     *  offers accept/deny — i.e. the request is awaiting MY approval (the trigger
     *  shown atop the messages board). Authoritative source for the Approve/Decline
     *  buttons; the queue falls back to order_step==="REQUEST" when unset. */
    awaiting_owner_action: v.optional(v.boolean()),
    /** Granular owner actions still available on the order (2026-06-26). Lets the
     *  Quick Reply widget distinguish a NEW request (both true → Approve+Decline)
     *  from one I've already APPROVED (accept gone, only deny → show Approve done
     *  + Decline only). Set optimistically when I approve/decline in the widget;
     *  undefined → derive from awaiting_owner_action (a fresh request = both). */
    can_accept: v.optional(v.boolean()),
    can_deny: v.optional(v.boolean()),

    /** LLM-resolved master-inventory items for this reservation.
     *  Cleared on poll if items[] changes; re-populated by item_resolver action. */
    resolved_items: v.optional(v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      confidence: v.number(),
      qty: v.optional(v.number()),
      // Per-item revenue attribution from the original source. Set by the
      // v1-Postgres migration (carries v1's authoritative per-row revenue
      // share so v2 chat answers match v1's answers). When absent, the
      // chat query falls back to proportional split via pricing_catalog.
      revenue_gbp: v.optional(v.number()),
    }))),
    /** After bundle decomposition: every physical item this reservation
     *  occupies. A reservation that resolves to {FX3 Cinematic Kit, qty:1}
     *  expands to {FX3, 24-70 GM, RS3 Pro, Atomos, ND filter} each qty:1.
     *  Conflict + out-of-stock + sell-reco read this, not resolved_items. */
    expanded_items: v.optional(v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      qty: v.number(),
      via_bundle: v.optional(v.id("bundles")),   // set when expanded from a kit
    }))),
    /** Unix ms when the resolver last ran. */
    resolution_at: v.optional(v.number()),
    /** "llm" | "exact_match" | "manual" — provenance of the resolution. */
    resolution_method: v.optional(v.string()),
    /** Hash of items[].map(i=>i.item_name) when resolution_at was set. Used to invalidate. */
    resolution_input_hash: v.optional(v.string()),
    /** ms epoch — bumped by the poller ONLY when a poll cycle actually changed
     *  the row (see poll_hash). Idle rows keep their old stamp, so an indexed
     *  max(last_polled_at) is a true "anything changed?" signal AND idle rows are
     *  no longer re-versioned every cycle (was the dominant reactive DB-IO drain). */
    last_polled_at: v.optional(v.number()),
    /** Hash of the poller write-set (all upserted fields except the last_polled_at
     *  timestamp). The upsert skips both patches when this is unchanged, so an
     *  idle reservation is not re-written every 5-min cycle. 2026-07-10. */
    poll_hash: v.optional(v.string()),
    /** Last Hygglo filter the row was seen in: "pending" | "current" | "future" | "obsolete". */
    source_filter: v.optional(v.string()),
    /** Open damage/loss case — pulls the rental OUT of the Return Hub (tracked
     *  as a case, not a pending return). Set by insurance_claims:openCaseFromReservation. */
    case_open: v.optional(v.boolean()),
    case_id: v.optional(v.id("insurance_claims")),
    return_outcome: v.optional(v.string()),          // smooth | issues | fantastic
    return_good_tags: v.optional(v.array(v.string())), // operator-tapped "what was good" chips
    return_bad_tags: v.optional(v.array(v.string())),  // operator-tapped "what was bad" chips
    review_message: v.optional(v.string()),          // composed thank-you/review (prepared)
    platform_close_pending: v.optional(v.boolean()),
    platform_closed_at: v.optional(v.number()),
    // ── Auto-close (returns_autoclose.ts) per-step idempotency stamps ──
    // Each set once the corresponding Hygglo write returns `sent`, so a
    // partial-failure re-run of the drain never re-closes / re-rates / re-spams.
    // platform_closed_at (above) remains the FINAL stamp that drops the row from
    // pendingPlatformClose.
    platform_returned_at: v.optional(v.number()), // close (action:"return") confirmed sent
    review_done_at: v.optional(v.number()),        // 5★ review (action:"review") confirmed sent (or skipped-as-done)
    msg_done_at: v.optional(v.number()),           // discount chat (action:"chat") confirmed sent (or skipped-as-done)
    auto_close_attempts: v.optional(v.number()),   // incremented on each failed drain pass
    auto_close_last_error: v.optional(v.string()), // last failure detail for the operator log
    /** Phase 18.2 — monotonic activity timestamp from Hygglo's order-list
     *  response (sort=latest-activity). Used by poll-hygglo to skip the
     *  per-order detail fetch when the list value matches the stored value
     *  (no changes since last poll). Stored as ms epoch when parseable,
     *  string otherwise. Optional: rows pre-Phase-18.2 have it undefined and
     *  will fall through to the regular detail fetch path. */
    latest_activity: v.optional(v.union(v.number(), v.string())),
    // Phase 10.1 — Demand-Loss Classifier. Populated by classifyObsoleteReservations
    // for rows where is_obsolete === true. Optional/backward compatible.
    demand_loss_class: v.optional(
      v.union(
        v.literal("genuine_demand"),
        v.literal("renter_walked"),
        v.literal("unbooked"),
        v.literal("duplicate_of_denial"),
        v.literal("unknown"),
      ),
    ),
    demand_loss_classified_at: v.optional(v.number()),
    demand_loss_estimated_gbp: v.optional(v.number()),
    // ── Phase 3 — Denial actor reclassification (audit_reclassification.md §3) ──
    /** Final denial actor (4-outcome canonical model). Set once at first classify. */
    denial_actor: v.optional(v.union(
      v.literal("owner_denied"),
      v.literal("renter_ghosted"),
      v.literal("renter_cancelled_explicit"),
      v.literal("system_or_other"),
    )),
    /** Re-classifier output (kept separate from denial_actor so we can compare
     *  before/after backfill). Mirror enum. */
    reclassified_outcome: v.optional(v.union(
      v.literal("owner_denied"),
      v.literal("renter_ghosted"),
      v.literal("renter_cancelled_explicit"),
      v.literal("system_or_other"),
    )),
    reclassified_at: v.optional(v.number()),
    /** Human-readable rule label, e.g. "obsolete_reason=owner_denied+no_chat_conflict". */
    reclassified_signal: v.optional(v.string()),
    reclassified_confidence: v.optional(v.union(
      v.literal("high"),
      v.literal("medium"),
      v.literal("low"),
    )),
    /** Cached "last hygglo_messages sender" at the time of obsolescence. */
    last_message_sender_at_obsolete: v.optional(v.union(
      v.literal("me"),
      v.literal("renter"),
      v.literal("none"),
    )),
    last_message_at_obsolete: v.optional(v.number()),
    chat_owner_cancel_hit: v.optional(v.boolean()),
    chat_renter_cancel_hit: v.optional(v.boolean()),
    chat_owner_approval_hit: v.optional(v.boolean()),
    /** Best-effort timestamp when this reservation first became obsolete. */
    obsolete_at: v.optional(v.number()),
    // ── Phase 3d — Hygglo system-event signal (ground truth) ─────
    /** Derived from `activity.event.content` in Hygglo's /v4/my/orders/:id.
     *  "blue text" — owner deny / renter cancel / system auto-cancel / verification
     *  failure / approved. Overrides chat-regex in the classifier (rule #0). */
    hygglo_system_signal: v.optional(v.union(
      v.literal("owner_denied"),
      v.literal("renter_cancelled"),
      v.literal("auto_cancelled"),
      v.literal("verification_failed"),
      v.literal("approved"),
      v.literal("none"),
    )),
    /** Raw event.content text that produced `hygglo_system_signal`. Observability only. */
    hygglo_system_signal_text: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_account", ["account_id"])
    .index("by_status", ["status"])
    .index("by_renter", ["renter_id"])
    .index("by_account_slug", ["account_slug"])
    .index("by_start_date", ["start_date"])
    .index("by_v1_rental_id", ["v1_rental_id"])
    .index("by_hygglo_order_id", ["hygglo_order_id"])
    // Reply Inbox (2026-06-22): cheap lookup of pending REQUESTs awaiting the
    // owner's approve/decline, so the queue can always surface them.
    .index("by_order_step", ["order_step"])
    .index("by_awaiting_owner_action", ["awaiting_owner_action"])
    // Pass 13e (2026-05-26): obsolete rows are a small fraction of the table
    // (~50 of ~1700) and the dashboard / refresher / audit paths frequently
    // filter to them. Unindexed `.filter(is_obsolete=true)` was scanning the
    // full table on every call. Indexed lookup reduces row reads ~30x.
    .index("by_is_obsolete", ["is_obsolete"])
    .index("by_demand_loss_class", ["demand_loss_class"])
    // Phase 7a (2026-05-24) — composite for audit_qty_drift + dashboard
    // status-scoped queries. Cuts unindexed full-table scans down to the
    // confirmed-only slice (~300 rows vs ~1700).
    .index("by_account_status", ["account_slug", "status"])
    // Pass 8b (2026-05-31): the stats_drawer MV dirty-probe needs to detect ANY
    // reservation mutation cheaply. The poller bumps last_polled_at on every
    // touched row, so an indexed max(last_polled_at) lets the probe catch status
    // changes on PAST/ongoing rentals that the old top-50-by-future-start_date
    // scan missed (which left the MV — and the dashboard tile — stale for hours).
    .index("by_last_polled_at", ["last_polled_at"])
    // Consistency fix (2026-06-02): the stats_drawer MV dirty-probe must also
    // detect a Trigger-driven booking-time extraction (setTimes patches
    // pickup_date/return_date/pickup_time/return_time + bumps times_extracted_at)
    // WITHOUT touching last_polled_at. Without this, a negotiated date/time
    // change updated the live calendar instantly but left the Active tab
    // (MV-cached) stale until the next poller bump. Indexed max(times_extracted_at)
    // lets the probe catch it in one read.
    .index("by_times_extracted_at", ["times_extracted_at"])
    // 2026-07-12 cost audit: listForReconcile (poller, every cycle × account)
    // read the ENTIRE account history via by_account_slug (~700 fat rows to
    // derive forward-looking holds). Composite index lets it scope to
    // account + recent start_date in one indexed range.
    .index("by_account_start", ["account_slug", "start_date"]),

  // ── Layer B (2026-05-19) — qty-drift safety net ────────────────────────
  // Nightly audit (convex/audit_qty_drift.ts) detects reservations whose
  // resolver output under-counts the raw Hygglo `items[]` array (root cause
  // of the FX3 double-book miss). One open row per drifted reservation.
  // Surfaced in dashboard via `qty_drift_count` field in getStatsDrawerData.
  qty_drift_alerts: defineTable({
    reservation_id: v.id("reservations"),
    hygglo_order_id: v.string(),
    renter_name: v.optional(v.string()),
    account_slug: v.optional(v.string()),
    drift_kind: v.union(
      v.literal("listing_count_lt_items"),
      v.literal("unique_sku_lt_items"),
    ),
    raw_n: v.number(),         // raw Hygglo items[].length
    expanded_n: v.number(),    // sum of expanded_items[].qty
    missing_skus: v.optional(v.array(v.string())),
    detected_at: v.number(),
    status: v.union(v.literal("open"), v.literal("resolved")),
  })
    .index("by_account_status", ["account_slug", "status"])
    .index("by_reservation", ["reservation_id"])
    .index("by_status", ["status"]),

  calendar_holds: defineTable({
    item_id: v.id("items"),
    reservation_id: v.optional(v.id("reservations")),
    // Legacy scaffold fields
    start_at: v.optional(v.number()),
    end_at: v.optional(v.number()),
    qty_held: v.optional(v.number()),
    // Phase 2.A v1 import fields
    account_slug: v.optional(v.string()),
    date: v.optional(v.string()),             // ISO date YYYY-MM-DD (one row per item per day)
    status: v.optional(v.string()),           // "confirmed" | "completed"
    v1_booking_id: v.optional(v.string()),
    imported_at: v.optional(v.number()),
    renter_name: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_item_date_range", ["item_id", "start_at"])
    .index("by_item_date", ["item_id", "date"])
    .index("by_reservation", ["reservation_id"])
    .index("by_account_date", ["account_slug", "date"])
    // Phase 7e (2026-05-24) — cross-account date-range scans for the
    // dashboard CalendarStrip + WeeklyCalendar when accountSlug is null.
    // Replaces a full-table .collect() with an indexed range read.
    .index("by_date", ["date"]),

  // ── Owner unavailability blocks (Phase 3 calendar) ───────────
  owner_unavailability: defineTable({
    item_id: v.id("items"),
    start_date: v.string(),       // YYYY-MM-DD inclusive
    end_date: v.string(),
    reason: v.optional(v.string()),
    created_by: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_item_date", ["item_id", "start_date"]),

  // ── Phase 2.A import audit (NEW table) ──────────────────────
  import_audit: defineTable({
    table_name: v.string(),
    v1_table_source: v.string(),
    v1_row_count: v.number(),
    v2_row_count: v.number(),
    drift: v.number(),
    sum_field: v.optional(v.string()),
    v1_sum: v.optional(v.number()),
    v2_sum: v.optional(v.number()),
    sum_drift: v.optional(v.number()),
    sample_count: v.number(),
    sample_pass_count: v.number(),
    sample_fail_count: v.number(),
    sample_failures: v.array(v.any()),
    import_started_at: v.number(),
    import_completed_at: v.optional(v.number()),
    status: v.string(),                       // "pending" | "ok" | "drift" | "audit_failed"
    notes: v.optional(v.string()),
  }).index("by_table", ["table_name"]),

  // ── Conversations (empty, Phase 4) ──────────────────────────
  conversations: defineTable({
    thread_id: v.string(),
    account_id: v.optional(v.id("accounts")),
    renter_id: v.optional(v.id("renters")),
    last_msg_at: v.number(),
    // Renter-bot Phase 1 — 7-stage state machine (INQUIRY → DEAD).
    // Optional: existing rows pre-Phase-1 have it undefined; the bot
    // backfills on first run by inferring from latest reservation.status.
    conversation_stage: v.optional(v.union(
      v.literal("INQUIRY"),
      v.literal("INTERESTED"),
      v.literal("READY_TO_BOOK"),
      v.literal("BOOKED"),
      v.literal("CONFIRMED"),
      v.literal("COMPLETED"),
      v.literal("DEAD"),
    )),
    stage_updated_at: v.optional(v.number()),
    // ── Reply Inbox (2026-06-22) — "needs my reply" queue support ──
    // Stamped by hygglo.upsertMessages on every new message so the reply
    // queue is a cheap indexed read (`by_last_sender`) instead of a per-thread
    // scan. A thread is "awaiting owner reply" iff last_sender === "renter".
    // Sending a reply flips last_sender → "owner" (recordSentReply), which
    // removes the tile from the queue until the renter messages again.
    last_sender: v.optional(v.union(v.literal("owner"), v.literal("renter"))),
    last_renter_msg_at: v.optional(v.number()),   // drives the urgency glow
    // Owner "× close" stamp. The thread leaves the Quick Reply widget until a
    // renter message newer than this arrives (then it re-surfaces).
    dismissed_at: v.optional(v.number()),
    account_slug: v.optional(v.string()),          // denormalised for filtering/colour
    // Cached AI draft reply (lazy, generated on tile expand). Invalidated when
    // a newer renter message arrives (ai_draft_for_message_id mismatch).
    ai_draft_text: v.optional(v.string()),
    ai_draft_for_message_id: v.optional(v.string()),
    ai_draft_generated_at: v.optional(v.number()),
    // Draft-logic version this draft was generated under. When settings.draft_epoch
    // is bumped (after a draft-logic fix), drafts with an older epoch are treated
    // as stale and auto-regenerated — so a fix reaches every thread without a
    // manual flush.
    ai_draft_epoch: v.optional(v.number()),
    // Output-policing result (Phase 1 draft guard): confidence 0..1 + the flags
    // raised on the draft (auto-fixed leaks + items flagged for owner review).
    ai_draft_confidence: v.optional(v.number()),
    ai_draft_flags: v.optional(
      v.array(
        v.object({
          type: v.string(),
          detail: v.string(),
          severity: v.union(
            v.literal("critical"),
            v.literal("high"),
            v.literal("medium"),
            v.literal("low"),
          ),
          action: v.union(
            v.literal("stripped"),
            v.literal("rewritten"),
            v.literal("flagged"),
          ),
        }),
      ),
    ),
    // ── Date-less inquiry product snapshot (2026-06-26) ──
    // A renter asking "is this available?" WITHOUT submitting dates produces a
    // Hygglo order with no rentalPeriod, so no reservation row is built and the
    // order's items[] (the listing + image) are discarded — leaving the Reply
    // Inbox tile blank. The poller snapshots the listing here so assembleTile
    // can fall back to it when there is no reservation.
    inquiry_items: v.optional(
      v.array(
        v.object({
          name: v.string(),
          qty: v.number(),
          image_url: v.optional(v.string()),
          product_id: v.optional(v.number()),
        })
      )
    ),
    inquiry_image_url: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_thread", ["thread_id"])
    .index("by_last_sender", ["last_sender"])
    // PERF: lets getReplyQueue's Pass 3 (browse-all) read only the recent
    // window instead of `.collect()`-ing the whole conversations table on every
    // reactive re-run. last_msg_at is non-optional so the range is exact.
    .index("by_last_msg_at", ["last_msg_at"]),

  conv_extracted_facts: defineTable({
    conversation_id: v.optional(v.id("conversations")),
    renter_id: v.optional(v.id("renters")),
    item_id: v.optional(v.id("items")),
    fact_kind: v.string(),
    fact_value: v.string(),
    created_at: v.number(),
  }).index("by_renter", ["renter_id"]).index("by_item", ["item_id"]),

  // ── Rules / overrides / denials (empty, Phase 4-5) ──────────
  // Renter-bot Phase 1 seeds 33 rules from V1 (categories: policy,
  // communication, pricing, faq, inventory, disclosure). category +
  // priority + source kept optional so legacy callers still compile.
  rules: defineTable({
    account_id: v.optional(v.id("accounts")),
    rule_kind: v.string(),                     // V1 "name" lives here (e.g. "Credential Security")
    rule_body: v.string(),
    enabled: v.boolean(),
    category: v.optional(v.string()),           // V1: policy | communication | pricing | faq | inventory | disclosure
    priority: v.optional(v.number()),           // V1: 1-10 (10 = absolute)
    source: v.optional(v.string()),             // "v1-port" | "manual"
    created_at: v.number(),
  }).index("by_account", ["account_id"])
    .index("by_category", ["category"]),

  rule_overrides: defineTable({
    rule_id: v.id("rules"),
    override_body: v.string(),
    actor: v.string(),
    created_at: v.number(),
  }).index("by_rule", ["rule_id"]),

  denial_records: defineTable({
    account_id: v.optional(v.id("accounts")),
    reason: v.string(),
    item_name: v.optional(v.string()),
    estimated_value: v.optional(v.number()),
    notes: v.optional(v.string()),
    created_at: v.number(),
    // Clean "Brand Model" extracted from the listing title via LLM. Used
    // by getSmartBuyRanking so the chat returns 'Sony FX6' instead of
    // 'Sony fx6 4k cinema camera + 24-70 gm + tripod...'. canonicalized_at
    // gates re-runs after item_name edits.
    canonical_product: v.optional(v.string()),
    canonical_brand: v.optional(v.string()),
    canonical_kind: v.optional(v.string()),
    canonicalized_at: v.optional(v.number()),
    // Phase 9.2 — FK resolved at write time via existing LLM item resolver.
    // Enables Missed-Revenue pie to group denials by inventory item kind
    // instead of dumping them into a single "Unmatched" slice.
    item_id: v.optional(v.id("items")),
    item_resolved_at: v.optional(v.number()),
    item_resolution_confidence: v.optional(v.number()),
    // Phase 3 — link denial to source reservation (back-fill in Phase 6).
    rental_id: v.optional(v.id("reservations")),
  }).index("by_account", ["account_id"]).index("by_reason", ["reason"]).index("by_item", ["item_id"]),

  // ── Audit log ────────────────────────────────────────────────
  audit_log: defineTable({
    table_name: v.string(),
    actor: v.string(),                 // "seed-script" | "system" | <user>
    op: v.string(),                    // "insert" | "update" | "delete"
    count: v.optional(v.number()),
    source_file: v.optional(v.string()),
    note: v.optional(v.string()),
    ts: v.number(),
  }).index("by_table", ["table_name"]).index("by_actor", ["actor"]).index("by_ts", ["ts"]),

  // ── Settings singleton ───────────────────────────────────────
  settings: defineTable({
    ALLOW_HYGGLO_SEND: v.boolean(),     // MASTER SAFETY RAIL — must stay false
    read_only_mode: v.boolean(),       // Umbrella safety flag (Phase 1.B.3): blocks send + auto_accept + decline + listing modify
    polling_interval_ms: v.number(),
    escalate_to_sonnet: v.boolean(),

    // Quick Reply availability check: when true, count not-yet-confirmed
    // (pending_review/VERIFIED) reservations as occupying stock when flagging a
    // would-be double-booking. Toggled from the widget. Default false.
    availability_include_pending: v.optional(v.boolean()),

    // Pickup / collection windows (Europe/London), editable in Settings. Fed to
    // the AI draft so it only confirms times inside these windows and stops
    // blindly agreeing to e.g. an 8am pickup. e.g. [{start:"10:00",end:"12:00"}].
    pickup_hours: v.optional(
      v.array(v.object({ start: v.string(), end: v.string() })),
    ),

    // ── Main rental hub (2026-06-27) ──
    // Where the gear physically lives. Set by postcode in Settings, confirmed
    // against postcodes.io (the register). Tile distance-to-listing + the
    // too-heavy tag are measured from here.
    hub_postcode: v.optional(v.string()),
    hub_label: v.optional(v.string()),             // confirmed admin district from postcodes.io
    hub_lat: v.optional(v.number()),
    hub_lng: v.optional(v.number()),
    hub_heavy_max_km: v.optional(v.number()),       // how far a heavy item can go (default 5)
    hub_max_km: v.optional(v.number()),             // absolute range (default 30)
    minimum_rental_gbp: v.optional(v.number()),     // RULE 10 min booking total (default 40)
    // Bump to invalidate all cached AI drafts after a draft-logic change.
    draft_epoch: v.optional(v.number()),

    // Phase 1.B.3 — operator policy fields
    read_only_mode_blocks: v.optional(v.array(v.string())),

    timezone: v.optional(v.string()),
    quiet_hours: v.optional(v.object({
      start: v.string(),
      end: v.string(),
      tz: v.string(),
    })),
    pickup_no_show_grace_minutes: v.optional(v.number()),
    price_objection_surfacing: v.optional(v.object({
      dashboard: v.boolean(),
      telegram_alerts: v.boolean(),
      weekly_digest: v.boolean(),
    })),
    policy_notes: v.optional(v.string()),
    updated_at: v.optional(v.number()),

    // Stage 2.5: AI boost parameters (replace hardcoded constants in revenue.ts)
    ai_boost_rate: v.optional(v.number()),      // e.g. 0.33 — fraction attributed to AI
    ai_active_from: v.optional(v.string()),     // "YYYY-MM" — first month AI was active

    // EQ-A: runtime-editable listing → MASTER_INVENTORY equivalence map.
    listing_equivalence_map: v.optional(v.record(v.string(), v.array(v.string()))),
  }),

  // ── Price recommendation dismissals (W17) ───────────────────
  recommendation_dismissals: defineTable({
    item_id: v.optional(v.id("items")),
    item_name_canonical: v.string(),
    dismissed_at: v.number(),
    dismissed_by: v.optional(v.string()),   // "user" | "applied"
  })
    .index("by_item_name", ["item_name_canonical"]),

  // ── Hygglo inbox messages (Phase 6.0) ─────────────────────
  hygglo_messages: defineTable({
    account_slug: v.string(),
    thread_id: v.string(),
    message_id: v.string(),
    sender: v.string(),
    sender_name: v.optional(v.string()),
    body_text: v.string(),
    hygglo_sent_at: v.optional(v.number()),
    fetched_at: v.number(),
    raw: v.optional(v.string()),
  }).index("by_account", ["account_slug"])
    .index("by_thread", ["thread_id"])
    .index("by_thread_and_message", ["thread_id", "message_id"])
    .index("by_fetched", ["fetched_at"]),

  // ── Insurance Claims (W03 chart series + W22 Claims widget) ─
  insurance_claims: defineTable({
    account_slug: v.optional(v.string()),
    account_id: v.optional(v.id("accounts")),
    item_id: v.optional(v.id("items")),
    item_name_canonical: v.optional(v.string()),
    amount_gbp: v.number(),
    claim_date: v.string(),            // ISO YYYY-MM-DD
    description: v.optional(v.string()),
    status: v.string(),                // "open" | "settled" | "denied"
    created_at: v.number(),
    credited_to_month: v.optional(v.string()), // YYYY-MM bucket for revenue chart
    payout_amount_gbp: v.optional(v.number()), // recovered amount (may differ from amount_gbp)
    credited_at: v.optional(v.number()),       // Date.now() when creditToRevenue ran
    // ── Case pipeline (build-out) ──
    stage: v.optional(v.string()),             // case_opened|in_for_repair|quote_received|payout_confirmation|added_to_revenue|denied
    reservation_id: v.optional(v.id("reservations")),
    renter_id: v.optional(v.id("renters")),
    renter_name: v.optional(v.string()),
    opened_from: v.optional(v.string()),       // "return_hub" | "manual"
    // Items physically OUT ON REPAIR for this case — reduce effective stock
    // until the case is closed (terminal stage).
    repair_item_ids: v.optional(v.array(v.id("items"))),
  }).index("by_account", ["account_slug"])
    .index("by_claim_date", ["claim_date"]),

  // ── Conflict dismissals — per-event flags so an owner can suppress
  // a known double-booking from the banner. Keyed by a hash of item_id +
  // sorted reservation IDs, so a NEW conflict (new reservation joins or
  // any reservation cancels/reschedules) ignores the dismissal.
  conflict_dismissals: defineTable({
    conflict_key: v.string(),         // "item_id|sorted reservation_ids"
    item_id: v.id("items"),
    reservation_ids: v.array(v.string()),
    note: v.optional(v.string()),
    dismissed_at: v.number(),
  }).index("by_key", ["conflict_key"]),

  // ── Competitor listings (informational, optional) ───────────
  competitor_listings: defineTable({
    listing_id: v.string(),
    title: v.optional(v.string()),
    price_per_day: v.optional(v.number()),
    url: v.optional(v.string()),
    notes: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_listing", ["listing_id"]),

  // ── Competitor Intel (additive, 2026-06-04) ───────────────────────────
  // PII-SAFE aggregates of a LIMITED sample of competitor vendors' public
  // rental history (via reviews) + current list prices. One row per distinct
  // item name, merged across all sampled vendors. NEVER stores reviewer names
  // or review text — only item/date/rating/price rollups (UK GDPR-safe; these
  // are non-personal). Written wholesale by `competitor_intel:replaceAll` from
  // the one-time ingest script; read by the dashboard widget. Not on poll path.
  competitor_intel: defineTable({
    itemName: v.string(),
    vendorIds: v.array(v.string()),        // vendor ids this item appears under
    rentalCount: v.number(),               // # reviews for the item (1 review ≈ 1 rental)
    lastRentedAt: v.string(),              // ISO — max review createdAt for the item
    avgRating: v.optional(v.number()),     // mean rating across sampled reviews (null if none had a rating)
    dailyPriceGbp: v.optional(v.number()), // matched from listings by item/slug; null if unmatched
    estRevenueGbp: v.number(),             // rentalCount × dailyPriceGbp × OWNER_SHARE (0 if unmatched)
    syncedAt: v.number(),                  // Date.now() of the ingest that wrote this row
  })
    .index("by_est_revenue", ["estRevenueGbp"])
    .index("by_rental_count", ["rentalCount"]),

  // Singleton meta for the competitor-intel sample (one logical row, key="latest").
  competitor_intel_meta: defineTable({
    key: v.string(),                       // always "latest"
    reviewsSampled: v.number(),            // total reviews pulled across vendors
    vendorsCount: v.number(),              // # vendors sampled
    itemCount: v.number(),                 // # distinct items aggregated
    totalEstRevenueGbp: v.number(),        // sum of estRevenueGbp
    totalRentalsSampled: v.number(),       // sum of rentalCount
    unmatchedPriceCount: v.number(),       // # items with no matched price (estRevenue 0)
    syncedAt: v.number(),
  }).index("by_key", ["key"]),

  // ── Historical revenue (retired accounts + damage overlay, 2022-2026) ──────
  // Source: v1 historical-revenue.ts static. v2 queries this table; no v1 ref at runtime.
  // Rows with total_revenue_gbp=0 are "damage-only" sentinels (overlay damageCosts only).
  historical_revenue: defineTable({
    month: v.string(),                    // "YYYY-MM"
    total_revenue_gbp: v.number(),        // base rental revenue across all accounts
    damage_costs_gbp: v.number(),         // insurance/damage claim payouts (additive)
    business_expenses_gbp: v.number(),    // deducted expenses (positive = expense)
    total_overall_made_gbp: v.number(),   // definitive total (0 for damage-only rows)
    // Per-account splits (v1 algorithm port — additive optional, approved 2026-05-12)
    dbcinema_revenue_gbp: v.optional(v.number()),
    leo_revenue_gbp: v.optional(v.number()),
    daniel_revenue_gbp: v.optional(v.number()),
    vertus_revenue_gbp: v.optional(v.number()),
    source: v.string(),                   // "v1-historical-static" | "v1-postgres-backfill"
    created_at: v.number(),
  }).index("by_month", ["month"]),


  // -- AI Memories (Phase B-2 scaffold; renter-bot Phase 1 seeds V1 corpus) --
  // Renter-bot Phase 1 widens scope set to include "template" (verbatim
  // texts the bot quotes directly) and "faq" (gear-specific Q&A). title
  // + priority added for richer ranking inside search_knowledge.
  memories: defineTable({
    scope: v.string(),                    // "general" | "pricing" | "operational" | "template" | "faq"
    title: v.optional(v.string()),         // human-readable label for ranking + dashboard surfaces
    content: v.string(),
    tags: v.optional(v.array(v.string())),
    priority: v.optional(v.number()),       // 1-10 (10 = absolute, e.g. DANIEL RULES)
    source: v.string(),                   // "manual" | "v1-import-pending" | "v1-port"
    created_at: v.number(),
    updated_at: v.optional(v.number()),
  }).index("by_scope", ["scope"])
    .index("by_created", ["created_at"]),

  // ── Account poller state (Phase 1 live-polling) ─────────────
  account_state: defineTable({
    account: v.string(),                          // e.g. "dbcinema" | "leo"
    lastSuccessfulPollAt: v.number(),
    lastTimestamp: v.optional(v.number()),        // cursor for differential polling if ever supported
    consecutiveFailures: v.number(),
    mode: v.union(
      v.literal("active"),                        // normal cadence
      v.literal("quiet"),                         // reduced cadence (off-peak)
      v.literal("paused"),                        // skip polling due to repeated failures
    ),
    modeChangedAt: v.number(),
    lastError: v.optional(v.string()),
  }).index("by_account", ["account"]),

  // ── Sync state (freshness tracking, Phase 1 live-data upgrade) ─
  sync_state: defineTable({
    source: v.string(),         // e.g. "hygglo_poller"
    lastRunAt: v.number(),       // ms since epoch
    lastRunSucceeded: v.boolean(),
    durationMs: v.optional(v.number()),
    rowsUpserted: v.optional(v.object({
      reservations: v.optional(v.number()),
      hygglo_messages: v.optional(v.number()),
      renters: v.optional(v.number()),
      conversations: v.optional(v.number()),
    })),
    errorMessage: v.optional(v.string()),
    kind: v.optional(v.union(v.literal("run"), v.literal("heartbeat"))),
  }).index("by_source", ["source"]),

  // -- Dashboard AI Chat (Phase B-1) ----
  dashboard_chat_messages: defineTable({
    thread_id: v.string(),
    role: v.string(),
    content: v.string(),
    tool_name: v.optional(v.string()),
    tool_call_id: v.optional(v.string()),
    metadata: v.optional(v.string()),
    created_at: v.number(),
  }).index('by_thread', ['thread_id'])
    .index('by_thread_and_time', ['thread_id', 'created_at']),

  // ── Materialized-view layer (Wave 3) ─────────────────────────
  // Singleton pattern: one row per `account` slug. Refreshers upsert.
  // `account = "all"` represents the cross-account aggregate.
  // Read paths: src/mastra/data/intelligence.ts, dashboard chat tools,
  // polling agent (Wave 4), renter-bot (Wave 5).
  daily_briefing: defineTable({
    account: v.string(),                  // "dbcinema" | "leo" | "all"
    generatedAt: v.number(),              // unix ms of last refresh
    todayEarningsGbp: v.number(),
    activeRentalsCount: v.number(),
    pendingRequestsCount: v.number(),
    overdueReturnsCount: v.number(),
    topItemsToday: v.array(v.object({
      name: v.string(),
      gbp: v.number(),
      count: v.number(),
    })),
    summary: v.string(),                  // pre-rendered narrative
    // W2a — incremental rebuild cursor. Records the ISO date used as the
    // 90-day window cutoff at last rebuild. If today's cutoff differs, the
    // window has shifted and a full rebuild is required.
    cutoffISO: v.optional(v.string()),
  }).index("by_account", ["account"]),

  top_earners_30d: defineTable({
    account: v.string(),
    generatedAt: v.number(),
    rows: v.array(v.object({
      itemName: v.string(),
      // Phase 1.2 (2026-05-24): NET take-home only. Legacy gross30dGbp
      // field is being migrated out — kept optional until the MV
      // refresher rewrites existing rows without it (next master.refreshSlow
      // tick). Schema can drop to non-optional after one full cron cycle.
      gross30dGbp: v.optional(v.number()),
      net30dGbp: v.number(),
      rentalCount: v.number(),
      utilizationPct: v.number(),
    })),
    // W2a — incremental rebuild cursor. Records the ISO date used as the
    // 30-day window cutoff at last rebuild. If today's cutoff differs the
    // window has shifted and a full rebuild is required.
    cutoffISO: v.optional(v.string()),
  }).index("by_account", ["account"]),

  purchase_signals: defineTable({
    account: v.string(),
    generatedAt: v.number(),
    signals: v.array(v.object({
      itemRequested: v.string(),
      requestCount30d: v.number(),
      projectedAnnualGbp: v.number(),
      aliasOfOwned: v.union(v.string(), v.null()),
      confidence: v.union(v.literal("high"), v.literal("med"), v.literal("low")),
    })),
    topInsight: v.string(),
  }).index("by_account", ["account"]),

  churn_risk_renters: defineTable({
    account: v.string(),
    generatedAt: v.number(),
    rows: v.array(v.object({
      renterName: v.string(),
      lastRentalDaysAgo: v.number(),
      lifetimeGbp: v.number(),
      lifetimeRentals: v.number(),
      risk: v.union(v.literal("high"), v.literal("med"), v.literal("low")),
      reason: v.string(),
    })),
  }).index("by_account", ["account"]),

  utilization_today: defineTable({
    account: v.string(),
    generatedAt: v.number(),
    rows: v.array(v.object({
      itemName: v.string(),
      capacity: v.number(),
      rentedNow: v.number(),
      idleDays7d: v.number(),
      utilization7dPct: v.number(),
    })),
    fleetUtilizationPct: v.number(),
  }).index("by_account", ["account"]),

  // Phase 7d (2026-05-24) — wrap-and-cache the 16-card getStatsDrawerData
  // megaquery. The refresher runs the existing handler internally per
  // (accountSlug) and stores the full payload as v.any(). Dashboard
  // subscriptions read a single indexed row instead of re-running the
  // 8-collect + 16-card compute on every reservation mutation.
  // Refreshed by master.refreshFast (hourly). One row per slug; "all"
  // represents accountSlug=null.
  mv_stats_drawer: defineTable({
    account: v.string(),                  // "dbcinema" | "leo" | "all"
    generatedAt: v.number(),
    payload: v.any(),                     // trimmed StatsDrawerData JSON (no fat rentals arrays — see mv_stats_drawer_rentals)
  }).index("by_account", ["account"]),

  // Pass 10b (2026-05-25) — drawer drill-down rentals split out of the
  // main mv_stats_drawer payload. The 4 rentals arrays
  // (active/ongoing/upcoming/confirmed) accounted for ~72KB of the 78KB
  // total, but are only consumed when a drawer is expanded. Splitting
  // lets the always-subscribed widgets read ~6KB while drawer detail
  // loads on-demand (frontend gates the fetch with `expandedId !== null`).
  mv_stats_drawer_rentals: defineTable({
    account: v.string(),
    generatedAt: v.number(),
    rentals: v.any(),                     // { active, ongoing, upcoming, confirmed } arrays
  }).index("by_account", ["account"]),

  // 2026-07-07 — wrap-and-cache getInsights (AI Investment Insights). The live
  // query scanned up to a full year of fat reservation docs on every reactive
  // re-run (poller writes every 5 min × every open tab) to produce ~5 static
  // analytics cards. Now refreshed once daily by master.refreshSlow; the widget
  // reads one indexed row. One row per slug; "all" = accountSlug=null.
  mv_ai_insights: defineTable({
    account: v.string(),
    generatedAt: v.number(),
    payload: v.any(),                     // the getInsights return array (5 cards)
  }).index("by_account", ["account"]),

  // 2026-07-07 — wrap-and-cache the reply-inbox queue (getReplyQueue). The live
  // query was the single biggest Convex bandwidth drain (~399 GB/mo): it read a
  // window of conversations + an N+1 full fat-reservation read per thread +
  // loadAvailCtx's confirmed-reservations scan, and it re-ran on EVERY poller
  // write (every 5 min) × every open tab. Now a 5-min cron (skip-when-clean)
  // computes the tile list once; the widget reads a single indexed row. Reply
  // freshness is unchanged — the poller itself only runs every 5 min. One row per
  // key: "all" (availability_include_pending off) / "all:pending" (on).
  mv_reply_queue: defineTable({
    account: v.string(),                  // "all" | "all:pending"
    generatedAt: v.number(),
    tiles: v.any(),                       // full sorted getReplyQueue tile array (pre account-filter / limit)
  }).index("by_account", ["account"]),

  // 2026-07-09 — wrap-and-cache the DEFAULT (current-week / today) views of
  // getWeeklyCalendar + getCalendarStrip. Both are LIVE reactive queries that
  // re-scanned a ~750-row `by_start_date` window on EVERY 5-min poller write ×
  // every open dashboard tab (unbounded per-tab drain). Now a 30-min cron
  // (skip-when-clean) computes them; the widget reads one indexed row. Only the
  // current anchor is cached — `anchor` stores the weekStartDate (weekly) or
  // startDate (strip) it was built for; the reader serves the row only when the
  // requested date matches, so week-navigation + the raw-UTC chat tool fall to
  // live (never stale). One row per key: "weekly:<slug>" / "strip:<slug>",
  // slug ∈ { "all", ...accounts.slug }.
  mv_calendar: defineTable({
    key: v.string(),                      // "weekly:all" | "strip:leo" | ...
    anchor: v.string(),                   // YYYY-MM-DD the payload was computed for
    days: v.optional(v.number()),         // strip only (7); absent for weekly
    generatedAt: v.number(),
    payload: v.any(),                     // verbatim getWeeklyCalendar {days:[…]} / getCalendarStrip […]
  }).index("by_key", ["key"]),

  // Pass 9d (2026-05-25) — wrap-and-cache the getMissedAndDeniedByCategory
  // handler. The live compute reads ~40MB of reservations data (full
  // obsolete scan + completed-scope collect) on every dashboard mount to
  // produce a ~100KB aggregate. Per Convex billing, this was 56.99 GB/day
  // — the single largest cost driver. Now refreshed once daily per
  // (account, days) combo; frontend reads a 1-row indexed lookup.
  mv_missed_and_denied_by_category: defineTable({
    account: v.string(),                  // "dbcinema" | "leo" | "all"
    days: v.number(),                     // 30 | 90 | 365 (or any window)
    generatedAt: v.number(),
    payload: v.any(),                     // full getMissedAndDeniedByCategory response
  }).index("by_account_days", ["account", "days"]),

  // Pass 10a (2026-05-25) — wrap-and-cache getRentalVolumeKindBreakdown.
  // Second-biggest query cost (24.27 GB + 62K calls/day pre-pass-9c).
  // Pre-computed per (account, days, kind). At ~8 kinds × 3 windows ×
  // 3 accounts = 72 rows.
  mv_rental_volume_kind_breakdown: defineTable({
    account: v.string(),                  // "dbcinema" | "leo" | "all"
    days: v.number(),                     // 30 | 90 | 365
    kind: v.string(),                     // "camera_body" | "lens" | etc.
    generatedAt: v.number(),
    payload: v.any(),                     // full getRentalVolumeKindBreakdown response
  }).index("by_account_days_kind", ["account", "days", "kind"]),

  // Pass 11 (2026-05-25) — four more wrap-and-cache MVs to eliminate
  // remaining gigabyte-scale Convex bandwidth costs. All follow the same
  // pattern as 9d/10a: live handler runs once daily, frontend reads
  // single indexed MV row.
  mv_lifetime_revenue: defineTable({
    account: v.string(),
    generatedAt: v.number(),
    payload: v.any(),                     // full getLifetimeByMonth response
  }).index("by_account", ["account"]),

  mv_investment_scorecard: defineTable({
    account: v.string(),
    generatedAt: v.number(),
    payload: v.any(),                     // full getInvestmentScorecard response
  }).index("by_account", ["account"]),

  mv_conversion_funnel: defineTable({
    account: v.string(),
    days: v.number(),                     // 30 | 90 | 365
    generatedAt: v.number(),
    payload: v.any(),                     // full getConversionFunnel response
  }).index("by_account_days", ["account", "days"]),

  mv_rental_volume_by_category: defineTable({
    account: v.string(),
    days: v.number(),                     // 30 | 90 | 365
    generatedAt: v.number(),
    payload: v.any(),                     // full getRentalVolumeByCategory response
  }).index("by_account_days", ["account", "days"]),

  // Pass 11h (2026-05-25) — single MV row per account holding ALL three
  // WallE-widget aggregates (active_conflicts, revenue_delta, utilization
  // _delta). Even with pass-8c's by_start_date indexed scans, each call
  // reads ~250 rich-payload rows × 3 queries × 3 widget subscribers =
  // multi-GB/day. Combine into one row keyed by (account); WallE widgets
  // read it instead of subscribing to 3 separate live queries.
  mv_walle_signals: defineTable({
    account: v.string(),
    generatedAt: v.number(),
    activeConflicts: v.any(),             // getActiveConflicts response
    revenueDelta: v.any(),                // getRevenueDelta response
    utilizationDelta: v.any(),            // getUtilizationDelta response
  }).index("by_account", ["account"]),

  // Pass 12a (2026-05-26) — wrap-and-cache getDueReturns. Live handler does
  // by_status("confirmed").collect() = ~250 rich rows × 50KB + N+1 renter
  // lookups per call. WallESignals (in eager StatsGrid) subscribes on every
  // dashboard cold-mount, and every reservation mutation triggers a reactive
  // re-eval. Cached payload is a small renter-name + due-date array.
  mv_due_returns: defineTable({
    account: v.string(),
    generatedAt: v.number(),
    payload: v.any(),                     // getDueReturns return array
  }).index("by_account", ["account"]),

  // Phase 6c (2026-05-24) — item ROI ranking, refreshed daily by
  // master.refreshSlow. Single "all" row holding the full ranking sorted by
  // annualizedROIPct desc. ItemROIPanel + chat tool + snapshot writer
  // slice from this row instead of re-running a 2y reservations.collect()
  // on every dashboard mutation.
  mv_item_roi_rankings: defineTable({
    account: v.string(),                  // "all" — ROI is global
    generatedAt: v.number(),
    rows: v.array(v.object({
      itemId: v.string(),
      name: v.string(),
      kind: v.optional(v.string()),
      qty: v.optional(v.number()),
      acquisitionCostGbp: v.union(v.number(), v.null()),
      lifetimeGrossGbp: v.number(),
      lifetimeNetGbp: v.number(),
      rentalCount: v.number(),
      monthsOwned: v.number(),
      monthlyAvgNetGbp: v.number(),
      roiPct: v.union(v.number(), v.null()),
      annualizedROIPct: v.union(v.number(), v.null()),
    })),
  }).index("by_account", ["account"]),

  // Phase 6b (2026-05-24) — earnings buckets per (account, granularity).
  // Stores 24 months of buckets so EarningsChart slices the requested window
  // server-side without re-collecting the reservations table on every
  // poller mutation. Refreshed by master.refreshFast (hourly).
  mv_earnings_by_period: defineTable({
    account: v.string(),                  // "dbcinema" | "leo" | "all"
    granularity: v.string(),              // "monthly" | "weekly"
    generatedAt: v.number(),
    // Buckets sorted ascending by period (YYYY-MM for monthly, YYYY-Www
    // for weekly). Caller slices the tail to keep N months/weeks.
    buckets: v.array(v.object({
      period: v.string(),
      revenue: v.number(),
      bookings: v.number(),
    })),
  }).index("by_account_granularity", ["account", "granularity"]),

  // Phase 6a (2026-05-24) — denial+gap rollup, pre-aggregated per
  // (account, days) so the dashboard panel + top tile read 1 indexed row
  // instead of collecting denial_records + pricing_catalog + 30d
  // reservations on every poller mutation. Refreshed by master.refreshFast
  // (hourly). One row per (account, days) — currently {30, 90} windows.
  mv_missed_revenue: defineTable({
    account: v.string(),                  // "dbcinema" | "leo" | "all"
    days: v.number(),                     // 30 | 90
    generatedAt: v.number(),
    totalMissed: v.number(),
    denialTotal: v.number(),
    gapTotal: v.number(),
    denialLosses: v.array(v.object({
      denialId: v.string(),
      reason: v.optional(v.string()),
      itemName: v.optional(v.string()),
      estimatedValue: v.number(),
      estimatedValueGross: v.number(),
      notes: v.optional(v.string()),
      createdAt: v.number(),
    })),
    gapLosses: v.array(v.object({
      itemName: v.string(),
      rentalDays: v.number(),
      idleDays: v.number(),
      estimatedGapLoss: v.number(),
    })),
  })
    .index("by_account_days", ["account", "days"])
    .index("by_account", ["account"]),

  upcoming_returns: defineTable({
    account: v.string(),
    generatedAt: v.number(),
    rows: v.array(v.object({
      rentalId: v.id("reservations"),
      renterName: v.string(),
      items: v.array(v.string()),
      returnDate: v.string(),               // ISO date YYYY-MM-DD
      daysUntilReturn: v.number(),
      overdue: v.boolean(),
    })),
    windowDays: v.number(),                 // typically 7
  }).index("by_account", ["account"]),

  // ── Wave 4 — polling-agent audit + concurrency control ───────
  /**
   * One row per Hygglo-poll cycle. Written by the Mastra
   * `hygglo_poll` workflow as a finally-block.
   */
  polling_runs: defineTable({
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    status: v.union(v.literal("running"), v.literal("ok"), v.literal("error")),
    newRentalsCount: v.number(),
    decisionsGeneratedCount: v.number(),
    mvRefreshesTriggered: v.array(v.string()),
    affectedAccounts: v.array(v.string()),
    errorMessage: v.optional(v.string()),
  })
    .index("by_startedAt", ["startedAt"])
    .index("by_status", ["status"]),

  /**
   * Per-(MV × account) lock taken by the polling workflow before
   * triggering an MV refresh. Released on completion. Stale locks
   * older than 5 min are ignored.
   */
  mv_refresh_locks: defineTable({
    mvName: v.string(),
    account: v.string(),
    lockedAt: v.number(),
    lockedBy: v.string(),
  }).index("by_mv_account", ["mvName", "account"]),

  /**
   * 2026-07-12 cost audit — generic widget MV rows. One row per widget
   * variant, keyed `<widget>:<slug>[:extra]` (e.g. "oos:all", "sell:leo",
   * "bundles:all:90", "tax:2026", "health:dbcinema"). Payload is the exact
   * live-query return value; writes content-skip so unchanged rebuilds never
   * re-fire subscriptions. Replaces six always-live reactive dashboard
   * queries that re-ran fat reservations scans on every poller write × tab.
   */
  mv_widgets: defineTable({
    key: v.string(),
    payload: v.any(),
    generatedAt: v.number(),
  }).index("by_key", ["key"]),

  /**
   * AI rental-acceptance decisions generated by the ai-decision
   * Mastra agent. READ-ONLY against Hygglo — Daniel approves
   * separately (Wave 4.5).
   */
  ai_decision: defineTable({
    reservation_id: v.id("reservations"),
    hygglo_order_id: v.optional(v.string()),
    account_slug: v.string(),
    decision: v.union(
      v.literal("accept"),
      v.literal("decline"),
      v.literal("ask_renter"),
    ),
    confidence: v.number(),
    reasoning: v.string(),
    suggestedReply: v.string(),
    redFlags: v.array(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("expired"),
      // Wave 4.5: Daniel edited the AI's draft reply before approving.
      v.literal("approved_modified"),
      // Wave 4.5: Daniel chose decline. Distinct from `rejected`, which the
      // poller writes when re-evaluating. Both surface as 'declined' to UI.
      v.literal("declined"),
    ),
    generatedAt: v.number(),
    generatedByAgent: v.string(),
    modelId: v.optional(v.string()),
    pollingRunId: v.optional(v.id("polling_runs")),
  })
    .index("by_reservation", ["reservation_id"])
    .index("by_status", ["status"])
    .index("by_account_status", ["account_slug", "status"])
    .index("by_generatedAt", ["generatedAt"]),

  // ── Wave 4.5 — ai_decision approval audit ────────────────────
  // Every approval/decline action on an ai_decision row writes an audit entry.
  // `hygglo.attempted=false` means READ_ONLY_MODE was on; intent is recorded
  // but no side effect was sent. Lets us reconcile "intent" vs "executed".
  ai_decision_audit: defineTable({
    decisionId: v.id("ai_decision"),
    action: v.union(
      v.literal("approve"),
      v.literal("decline"),
      v.literal("approve_modified"),
    ),
    actorSource: v.string(),          // 'dashboard_chat' for now; later 'daniel_telegram'
    actedAt: v.number(),
    finalReply: v.optional(v.string()),
    hygglo: v.object({
      attempted: v.boolean(),         // false if READ_ONLY_MODE
      status: v.union(
        v.literal("sent"),
        v.literal("skipped"),
        v.literal("failed"),
      ),
      error: v.optional(v.string()),
      httpStatus: v.optional(v.number()),
    }),
  }).index("by_decisionId", ["decisionId"]),

  // ── Wave 4.7 — monthly model auto-upgrade scanner audit ──────
  // One row per scan (cron: 1st of each month at 09:23 UTC). Records the
  // currently pinned chat model, the full Grok model list returned by xAI,
  // and the scanner's recommendation. Read by the
  // `get_model_upgrade_advisories` Mastra tool so the dashboard chat agent
  // can surface pending major-version / SKU-change advisories that
  // require human review (auto-PRs for minor bumps land directly).
  model_upgrade_scans: defineTable({
    scannedAt: v.number(),
    currentModel: v.string(),                  // e.g. "grok-4.3"
    availableModels: v.array(v.string()),
    recommendation: v.union(
      v.literal("no_change"),
      v.literal("auto_pr"),                    // newer minor version → PR opened
      v.literal("advisory"),                   // major/SKU change → human review
      v.literal("error"),
    ),
    recommendedModel: v.optional(v.string()),
    prUrl: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    dismissedAt: v.optional(v.number()),       // operator marks an advisory as handled
  }).index("by_scannedAt", ["scannedAt"]),

  // ── Dashboard Layout (per-user widget visibility + order) ──
  // userId is a free-form string — "default" today, real user id when auth lands.
  dashboardLayouts: defineTable({
    userId: v.string(),
    panelOrder: v.array(v.string()),
    hiddenPanels: v.array(v.string()),
    statOrder: v.array(v.string()),
    hiddenStats: v.array(v.string()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // ── Listing manual overrides — highest-priority tier ────────
  // Hand-curated mappings for the 1-2% of listings that consistently fool
  // both the LLM and vision pass. Keyed by title_hash so any title edit
  // automatically invalidates and falls back to LLM resolution.
  listing_overrides: defineTable({
    title_hash: v.string(),
    sample_title: v.string(),
    items: v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      qty: v.number(),
    })),
    note: v.optional(v.string()),
    set_by: v.optional(v.string()),
    set_at: v.number(),
  })
    .index("by_title_hash", ["title_hash"]),

    // ── Listing resolution cache (Hygglo title → resolved/expanded items) ────
  //  Keyed by hash of titles so the LLM resolver short-circuits on identical
  //  Hygglo listings the user has already paid to resolve.
  listing_resolutions: defineTable({
    title_hash: v.string(),
    // Phase 15.1: dual-keying. Primary cache lookup is by
    // (account_slug, hygglo_listing_id) — survives Hygglo title edits.
    // title_hash retained as secondary fallback for rows lacking listing_id.
    account_slug: v.optional(v.string()),
    hygglo_listing_id: v.optional(v.string()),
    sample_title: v.string(),
    resolved_items: v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      confidence: v.number(),
      qty: v.optional(v.number()),
    })),
    expanded_items: v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      qty: v.number(),
      via_bundle: v.optional(v.id("bundles")),
    })),
    resolution_method: v.string(),
    hit_count: v.number(),
    last_used_at: v.number(),
    created_at: v.number(),
  })
    .index("by_title_hash", ["title_hash"])
    .index("by_account_listing", ["account_slug", "hygglo_listing_id"]),

  // ── Per-Hygglo-product short canonical name cache (2026-05-23) ───────────
  //  Hygglo per-item names are SEO blobs ("2x JBL PartyBox Club 120 Speakers
  //  | Portable Bluetooth Party Speaker Pair + Bass Boost + RGB Light Show
  //  + 2x Stands (like JBL PartyBox 310 / PartyBox 710)"). Active-rentals
  //  cards need the canonical form ("2x JBL Club 120 Speakers"). One row
  //  per (account_slug, product_id) - derived once via DeepSeek, reused
  //  for every rental that touches the listing. Re-derived when the raw
  //  title hash changes.
  listing_short_names: defineTable({
    account_slug: v.string(),
    product_id: v.number(),                     // Hygglo product_id (stable per listing)
    raw_title: v.string(),                      // last raw title we derived from
    raw_title_hash: v.string(),                 // sha-256 of raw_title (invalidation key)
    short_name: v.string(),                     // "<qty>x <brand> <model> <noun>" (<=50 chars)
    derivation_method: v.string(),              // "llm" | "manual" | "passthrough"
    derived_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_account_product", ["account_slug", "product_id"])
    .index("by_account", ["account_slug"]),

  // ── Phase Listing-Pool: per-(account, product) info pool (2026-05-24) ────
  // Successor to listing_short_names. Source-grounded extraction of bundle
  // components with explicit source_spans + per-field manual override. One
  // row per (account_slug, product_id). See docs/listing-info-pool-plan.md
  // for the design rationale (Olivia FX3 bundle-collision bug, May 2026).
  listing_info_pool: defineTable({
    // ── Key ──
    account_slug: v.string(),
    product_id: v.number(),

    // ── Source provenance + cache-invalidation triggers ──
    source_title: v.string(),
    source_title_hash: v.string(),
    source_description: v.optional(v.string()),
    source_description_hash: v.optional(v.string()),
    // DEPRECATED 2026-05-24: vision pass removed. Optional so legacy rows
    // (written before the strip) remain valid.
    source_image_urls: v.optional(v.array(v.string())),
    source_image_phash_blob: v.optional(v.string()),
    derived_at: v.number(),
    derivation_method: v.union(
      v.literal("text"),
      v.literal("text+attrs"),
      // text+image / text+image+attrs deprecated 2026-05-24 (vision removed).
      // Kept in the union so already-persisted rows pass schema validation.
      v.literal("text+image"),
      v.literal("text+image+attrs"),
      v.literal("manual"),
      v.literal("passthrough_fallback"),
    ),

    // ── Display ──
    short_name: v.string(),
    bundle_summary: v.optional(v.string()),
    display_name: v.string(),

    // ── Equivalence (consumed by double-booking, out-of-stock, attribution) ──
    primary_item_id: v.optional(v.id("items")),
    primary_item_name_canonical: v.optional(v.string()),
    primary_item_confidence: v.number(),

    bundle_components: v.array(v.object({
      item_id: v.optional(v.id("items")),
      item_name_canonical: v.optional(v.string()),
      qty: v.number(),
      confidence: v.number(),
      source_kind: v.union(
        v.literal("primary"),
        v.literal("bundled_required"),
        v.literal("bundled_optional"),
        v.literal("comparison_reference"),
        v.literal("standard_included"),
      ),
      source_span: v.optional(v.string()),
    })),

    canonical_bundle_signature: v.string(),

    // ── Per-item attribution shares ──
    attribution_shares: v.array(v.object({
      item_id: v.optional(v.id("items")),
      item_name_canonical: v.optional(v.string()),
      share_pct: v.number(),
      weight_method: v.string(),
    })),

    // ── Confidence + review gate ──
    derivation_confidence: v.number(),
    needs_review: v.boolean(),
    review_reasons: v.array(v.string()),

    // ── Manual override (per-field; always wins over derivation) ──
    manual_override: v.optional(v.object({
      short_name: v.optional(v.string()),
      bundle_summary: v.optional(v.string()),
      bundle_components: v.optional(v.array(v.object({
        item_id: v.id("items"),
        qty: v.number(),
      }))),
      set_by: v.string(),
      set_at: v.number(),
      note: v.optional(v.string()),
    })),

    // ── Raw LLM dump for re-derivation under improved prompts ──
    llm_raw_response: v.optional(v.string()),
    llm_model_id: v.optional(v.string()),
    llm_cost_usd: v.optional(v.number()),

    updated_at: v.number(),
  })
    .index("by_account_product", ["account_slug", "product_id"])
    .index("by_canonical_bundle_signature", ["canonical_bundle_signature"])
    .index("by_primary_item", ["primary_item_id"])
    .index("by_needs_review", ["needs_review"]),


  // ── market_search 24h cache (Grok live-search results) ────────────────────
  market_search_cache: defineTable({
    query_norm: v.string(),     // lowercase trimmed query (with optional focus prefix)
    result_json: v.string(),    // serialized response
    fetched_at: v.number(),
    expires_at: v.number(),
  }).index("by_query_norm", ["query_norm"]),

  // ── Phase 12: product_id-keyed listing image bank ────────────────────────
  // Stable mapping product_id -> canonical image URL. Decouples display from
  // per-rental snapshot so historic rentals get correct photos automatically.
  // Fix once, fixes everywhere. See: /root/listing-image-bank-investigation.md
  listing_images: defineTable({
    product_id: v.number(),            // Hygglo's stable numeric product ID — PK semantics
    slug: v.optional(v.string()),       // /p/<slug> for backfill scraping later
    account_slug: v.string(),           // separate listings on same product_id across accounts
    image_url: v.string(),              // canonical photo URL
    name_at_capture: v.string(),        // listing title at time of last write — drift debugging
    source: v.union(
      v.literal("hygglo_api"),
      v.literal("hygglo_scrape"),
      v.literal("manual"),
    ),
    captured_at: v.number(),
    r2_key: v.optional(v.string()),     // optional R2 mirror (phase 12.4)
  }).index("by_product", ["product_id"])
    .index("by_account_product", ["account_slug", "product_id"])
    .index("by_slug", ["slug"]),

  // ── 2026-05-21: deterministic Hygglo product_id → item_id index ─────────
  // The LLM-based resolver (item_resolver.ts) reads listing titles and is
  // susceptible to keyword bleed from marketing copy ("Sony FX3 (same as A7s
  // III)" → spuriously resolves an A7 III). This table is the authoritative
  // override: when the poller writes a reservation whose hygglo_items[i]
  // carries a known product_id, expandedIdsOf consults this table first
  // and bypasses the LLM's choice for that position.
  //
  // Bootstrapped from history: scan reservations where hygglo_items + resolved
  // items align positionally and the same (account, product_id) consistently
  // resolves to the same item_id. Ambiguous product_ids stay unindexed and
  // fall through to the LLM with a sanity filter applied.
  //
  // source: "auto-bootstrap" | "manual" | "auto-tiebreak". manual entries
  // override auto ones; auto-tiebreak entries are derived by structural
  // sanity check (canonical name tokens must appear in the listing title
  // outside comparison parentheticals).
  hygglo_product_index: defineTable({
    account_slug: v.string(),
    product_id: v.number(),
    item_id: v.id("items"),
    source: v.union(
      v.literal("auto-bootstrap"),
      v.literal("auto-tiebreak"),
      v.literal("manual"),
    ),
    evidence_count: v.number(),
    created_at: v.number(),
    last_seen_at: v.number(),
    // Last listing title observed for this product_id — debugging only.
    sample_title: v.optional(v.string()),
  })
    .index("by_account_product", ["account_slug", "product_id"])
    .index("by_item_id", ["item_id"]),

  // Manual, audit-authoritative listing → inventory resolution. Wins over the
  // LLM's expanded/resolved cascade and the product index, so a mis-resolved or
  // unresolved Hygglo listing can be pinned to its true item composition.
  // Consumed by lib/reservations/itemUnits.ts (reservationItemUnits).
  listing_resolution_override: defineTable({
    account_slug: v.string(),
    product_id: v.number(),
    components: v.array(v.object({ item_id: v.id("items"), qty: v.number() })),
    note: v.optional(v.string()),
    source: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_account_product", ["account_slug", "product_id"]),

  // ── Phase 3: marketing-listings layer (ADDITIVE — data ingest only) ──────
  // Full Hygglo catalog snapshot per account, synced read-only from the v2
  // private API (GET /v2/my/products[/{id}]) by the `catalog-sync` Trigger
  // task. This is a MARKETING layer that mirrors what is *publicly listed* on
  // Hygglo — distinct from `items` (the LOCKED master inventory) and from
  // `hygglo_product_index` (the deterministic product_id → item_id override).
  //
  // Each row is keyed by (accountSlug, productId) and is idempotently upserted.
  // `masterItemId` links back to a matched `items` row (fuzzy name/slug match);
  // when no confident match is found the row is flagged `isMarketingOnly`.
  // NOT wired into any dashboard widget yet — widget consumption is a later,
  // review-gated step. Nothing here mutates `items`, `bundles` or the poll path.
  hygglo_products: defineTable({
    accountSlug: v.string(),
    productId: v.number(),
    name: v.optional(v.string()),
    isPublished: v.optional(v.boolean()),
    valuation: v.optional(v.number()),
    minimumRentalDays: v.optional(v.number()),
    // Mirror of HyggloProductPrice[] (src/hygglo-core/types.ts). Loosely typed
    // per-field because Hygglo's catalog schema varies across API versions.
    prices: v.optional(
      v.array(
        v.object({
          id: v.optional(v.number()),
          productId: v.optional(v.number()),
          pricePerDay: v.optional(v.number()),
          days: v.optional(v.number()),
          price: v.optional(v.number()),
        }),
      ),
    ),
    // Mirror of HyggloProductImage[].
    images: v.optional(
      v.array(
        v.object({
          id: v.optional(v.number()),
          thumbnailUrl: v.optional(v.string()),
          fullSizeUrl: v.optional(v.string()),
          filename: v.optional(v.string()),
          rotation: v.optional(v.number()),
          productId: v.optional(v.number()),
        }),
      ),
    ),
    // Blocked / booked dates from the product detail endpoint. Hygglo's shape
    // here is inconsistent (strings or {from,to} objects) so kept as v.any().
    unavailableDates: v.optional(v.array(v.any())),
    // Mirror of HyggloProductListing[].
    listings: v.optional(
      v.array(
        v.object({
          id: v.optional(v.number()),
          slug: v.optional(v.string()),
          productId: v.optional(v.number()),
          publicUrl: v.optional(v.string()),
          location: v.optional(v.any()),
        }),
      ),
    ),
    publicUrl: v.optional(v.string()),
    // Resolved master-inventory link (fuzzy match). Absent ⇒ marketing-only.
    masterItemId: v.optional(v.id("items")),
    isMarketingOnly: v.boolean(),
    // Best fuzzy-match score recorded for audit/tuning (coverage ratio).
    matchScore: v.optional(v.number()),
    lastSyncedAt: v.number(),
  })
    .index("by_account_product", ["accountSlug", "productId"])
    .index("by_master_item", ["masterItemId"])
    .index("by_account", ["accountSlug"]),

  // ===========================================================================
  // Ported Listings (Phase 2, Wave 0 — ADDITIVE).
  // Tracks dbcinema catalog products that are MISSING on the leo account and
  // the state of porting their listing image into R2. Purely additive: does
  // NOT touch hygglo_products, items, bundles, or the poll path.
  // ===========================================================================
  ported_listings: defineTable({
    productId: v.string(),
    accountSlug: v.string(),
    name: v.string(),
    dbImageUrl: v.string(),
    masterItemId: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("ported"),
      v.literal("error"),
    ),
    portedR2Key: v.optional(v.string()),
    portedUrl: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_product", ["productId"])
    .index("by_status", ["status"]),

  // Single-doc gradient/style profile for the leo account (key "leo").
  ported_listings_config: defineTable({
    key: v.string(),
    gradientProfile: v.any(),
    swatches: v.array(v.string()),
    orientation: v.optional(v.string()),
    leoSampleCount: v.optional(v.number()),
    detectedAt: v.optional(v.number()),
  }).index("by_key", ["key"]),

  // ── Phase W3b: reservation_vision side table (dual-write) ────────────────
  // Mirror of reservations.resolved_items so the heavy jsonb blob can move
  // off the hot reservations row. DUAL-WRITE phase: every existing
  // db.patch({resolved_items: ...}) site also writes here via
  // upsertReservationVision. Readers prefer this table and fall back to the
  // old column when absent. NULL-ing the old column is deferred to the
  // follow-up phase once dashboards have been live on the new path for ≥7d.
  reservation_vision: defineTable({
    reservation_id: v.id("reservations"),
    resolved_items: v.optional(v.any()), // mirror of the old column's shape
    vision_processed_at: v.optional(v.number()),
    last_synced_at: v.number(),
    // Phase 3c/W3b — which tier of the 4-tier vision pipeline produced the
    // resolution(s). 1=pHash, 2=vectorIndex, 3=Gemini Flash, 4=Grok Vision.
    resolved_via_tier: v.optional(v.number()),
  })
    .index("by_reservation_id", ["reservation_id"])
    .index("by_processed_at", ["vision_processed_at"]),

  // ── Phase 16.1 B1: denial_resolver result cache ──────────────────────────
  // Mirror of listing_resolutions for denial_records.item_name -> items._id.
  // Skips the LLM when the same product name + same active-inventory set is
  // seen again. Invalidated automatically when inventory_fingerprint changes
  // (inventory add/remove).
  denial_resolutions: defineTable({
    account_slug: v.string(),
    item_name_normalised: v.string(),   // lower-case, alphanum-only
    inventory_fingerprint: v.string(),  // sha1 of sorted active item_ids
    resolved_item_id: v.optional(v.id("items")),
    resolution_confidence: v.optional(v.number()),
    hit_count: v.number(),
    created_at: v.number(),
    last_used_at: v.number(),
  }).index("by_account_normname", ["account_slug", "item_name_normalised"])
    .index("by_fingerprint", ["inventory_fingerprint"]),

  // Phase 4 — Listing Resolution
  // Stores the deterministic + AI resolution result for each Hygglo listing.
  // The resolver pipeline (catalog → photo_ref → pattern → detail_api → ai → fuzzy → manual)
  // writes one row per listing. `resolved_items` is the final answer; `candidates` carries
  // near-misses for human review. `attempted_tiers` records which tiers ran for debugging.
  listing_resolution: defineTable({
    hygglo_listing_id: v.string(),
    hygglo_account: v.string(),
    hygglo_title: v.string(),
    hygglo_description: v.optional(v.string()),
    hygglo_detail_payload: v.optional(v.any()),
    resolved_items: v.array(v.object({
      item_name: v.string(),
      qty: v.number(),
      confidence: v.number(),
      source: v.union(
        v.literal("catalog"),
        v.literal("photo_ref"),
        v.literal("pattern"),
        v.literal("detail_api"),
        v.literal("ai"),
        v.literal("fuzzy"),
        v.literal("manual"),
        v.literal("equivalence"), // EQ-A: Tier 6.5 equivalence-map fallback
      ),
      via_equivalence: v.optional(v.boolean()), // EQ-A: audit flag for Tier 6.5
    })),
    status: v.union(
      v.literal("resolved"),
      v.literal("pending_review"),
      v.literal("unresolved"),
    ),
    candidates: v.optional(v.array(v.object({
      item_name: v.string(),
      score: v.number(),
      reason: v.string(),
    }))),
    image_url: v.optional(v.string()),
    reviewed_at: v.optional(v.number()),
    reviewed_by: v.optional(v.string()),
    attempted_tiers: v.array(v.string()),
  })
    .index("by_listing_id", ["hygglo_listing_id"])
    .index("by_status", ["status"])
    .index("by_account_status", ["hygglo_account", "status"]),

  // ── Renter-bot drafts (Phase 1 — READ-ONLY through Phase 3) ──────────
  // The bot writes one draft per (thread_id, last_inbound_message_id) pair.
  // It NEVER calls Hygglo write APIs. status transitions to "sent" only
  // when Daniel manually sends from Telegram + records that fact. Phase 4
  // may flip in auto-send for opt-in intents.
  renter_bot_drafts: defineTable({
    thread_id: v.string(),
    account_slug: v.string(),
    last_inbound_message_id: v.string(),
    last_inbound_at: v.number(),
    // The renter-facing draft. Empty string when `needs_human=true`.
    draft_text: v.string(),
    original_draft: v.optional(v.string()),     // verbatim first LLM emission (string-eq edit detect)
    final_sent_text: v.optional(v.string()),     // what Daniel actually sent (if any)
    draft_intent: v.string(),                  // one of 14 V1 intents
    draft_stage: v.optional(v.string()),         // one of 7 conversation stages
    draft_confidence: v.number(),
    draft_red_flags: v.array(v.string()),
    facts_claimed: v.optional(v.array(v.object({
      kind: v.string(),                          // price | availability | date | item_included | rule
      value: v.string(),
      sourceTool: v.string(),
      sourceCallId: v.string(),
      verified: v.boolean(),
    }))),
    needs_human: v.boolean(),
    needs_human_reason: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),                      // awaiting Daniel's review
      v.literal("dismissed"),                    // Daniel said no, archive
      v.literal("sent"),                          // Daniel manually sent
      v.literal("expired"),                       // newer inbound arrived, this draft stale
      v.literal("escalated"),                     // forwarded to human with red banner (filter failed 2×)
    ),
    generated_by: v.string(),                  // "renter-bot-v1"
    model_id: v.string(),                       // "deepseek/deepseek-v4-flash" etc
    generated_at: v.number(),
    cost_usd: v.optional(v.number()),
    regeneration_count: v.optional(v.number()),  // 0 | 1 | 2 (filter-driven retries)
    // Telegram audit
    telegram_chat_id: v.optional(v.string()),
    telegram_message_id: v.optional(v.string()),
    telegram_sent_at: v.optional(v.number()),
  })
    .index("by_thread", ["thread_id"])
    .index("by_thread_status", ["thread_id", "status"])
    .index("by_status", ["status"])
    .index("by_last_inbound", ["last_inbound_message_id"])
    .index("by_generated_at", ["generated_at"]),

  // ── Runtime feature flags (Phase 2 attribution cutover) ──────────────
  // Key/value boolean flags Daniel can flip instantly to switch code paths
  // (e.g. `use_new_attribution_engine`). Default OFF when row missing.
  feature_flags: defineTable({
    name: v.string(),
    enabled: v.boolean(),
    updated_at: v.number(),
    updated_by: v.string(),
  }).index("by_name", ["name"]),

  // ── Phase 5a — Weekly metrics rollup ─────────────────────────────────
  // Foundational analytics table. One row per
  //   (week_start × account_slug × granularity × (kind|item))
  // - granularity="global": one row per account per week (no kind/item)
  // - granularity="kind":   one row per account×kind×week
  // - granularity="item":   one row per account×item×week
  // Phase 5a populates: revenue (gross/attributed/net), volume (by denial
  // outcome), capacity/utilization, pricing.
  // Phase 5b will PATCH: gap detail (capacity/voluntary/marketing denied),
  // demand (unique/repeat renters, response time), co-occurrence,
  // substitution. Both phases share this table — non-overlapping fields.
  // Backfilled by convex/admin_backfill_weekly_metrics.ts. Recomputed
  // weekly by a cron at Sun 23:30 UTC (just-finished week, idempotent).
  weekly_metrics: defineTable({
    // ── Identifiers ─────────────────────────────────────────────
    week_start: v.string(),           // YYYY-MM-DD Monday
    week_end: v.string(),             // YYYY-MM-DD Sunday
    account_slug: v.string(),
    granularity: v.union(
      v.literal("global"),
      v.literal("kind"),
      v.literal("item"),
    ),
    kind: v.optional(v.string()),                  // set when granularity ∈ {kind, item}
    item_id: v.optional(v.id("items")),            // set when granularity = item
    item_name_canonical: v.optional(v.string()),   // denormalized convenience copy

    // ── REVENUE (Phase 5a) ──────────────────────────────────────
    revenue_gross_gbp: v.optional(v.number()),
    revenue_attributed_gbp: v.optional(v.number()),  // via attributeRevenue
    revenue_net_gbp: v.optional(v.number()),         // gross × 0.64 (Hygglo ~36% fees)

    // ── VOLUME (Phase 5a) ───────────────────────────────────────
    rentals_completed: v.optional(v.number()),
    rentals_requested: v.optional(v.number()),
    rentals_owner_denied: v.optional(v.number()),
    rentals_renter_cancelled: v.optional(v.number()),
    rentals_renter_ghosted: v.optional(v.number()),
    rentals_auto_cancelled: v.optional(v.number()),

    // ── CAPACITY / UTILIZATION (Phase 5a) ───────────────────────
    unit_days_rented: v.optional(v.number()),
    unit_days_capacity: v.optional(v.number()),
    utilization_rate: v.optional(v.number()),       // 0..1

    // ── PRICING (Phase 5a) ──────────────────────────────────────
    avg_daily_price_realized: v.optional(v.number()),
    avg_rental_duration_days: v.optional(v.number()),

    // ── GAP DETAIL (Phase 5b will populate) ─────────────────────
    capacity_denied_count: v.optional(v.number()),
    voluntary_denied_count: v.optional(v.number()),
    marketing_only_denied_count: v.optional(v.number()),
    capacity_denied_estimated_gbp: v.optional(v.number()),
    voluntary_denied_estimated_gbp: v.optional(v.number()),
    marketing_only_denied_estimated_gbp: v.optional(v.number()),
    // ── Phase 5c — "below minimum threshold" sub-bucket ─────────
    // Voluntary denials whose estimated gross < £39 (~£25 net
    // after ~36% Hygglo fees). Mutually exclusive with
    // voluntary_denied_* (moved out of voluntary bucket).
    below_minimum_threshold_denied_count: v.optional(v.number()),
    below_minimum_threshold_denied_estimated_gbp: v.optional(v.number()),

    // ── DEMAND (Phase 5b) ───────────────────────────────────────
    unique_renters: v.optional(v.number()),
    repeat_renter_count: v.optional(v.number()),
    new_renter_count: v.optional(v.number()),
    avg_response_time_minutes: v.optional(v.number()),

    // ── CO-OCCURRENCE (Phase 5b) ────────────────────────────────
    top_co_rented_canonicals: v.optional(v.array(v.string())),

    // ── SUBSTITUTION (Phase 5b) ─────────────────────────────────
    substitutes_booked_after_denial: v.optional(
      v.array(
        v.object({
          canonical_name: v.string(),
          count: v.number(),
        }),
      ),
    ),

    // ── META ────────────────────────────────────────────────────
    algorithm_version: v.string(),    // bumped when methodology changes; current = "v1"
    computed_at: v.number(),
  })
    .index("by_week_account_granularity", ["week_start", "account_slug", "granularity"])
    .index("by_week_item", ["week_start", "item_id"])
    .index("by_week_kind", ["week_start", "kind"])
    .index("by_account_week", ["account_slug", "week_start"]),

  // ── Phase 5a — Metrics backfill run log (observability) ──────────────
  // One row per backfill/cron invocation per (week × account). Lets us see
  // when a week was last recomputed, by whom, how many rows were written,
  // and any errors. Not used by the metrics math itself — purely audit.
  metrics_run_log: defineTable({
    run_id: v.string(),
    started_at: v.number(),
    finished_at: v.optional(v.number()),
    week_start: v.string(),
    account_slug: v.string(),
    rows_written: v.number(),
    errors: v.optional(v.string()),
  }).index("by_run", ["run_id"]),

  // ── Wave 4 — Poller staleness alert log + dedup ──────────────────────
  // One row each time the staleness check fires a Telegram alert. Used
  // for 60-min dedup (don't re-alert same account inside the window) and
  // for post-hoc visibility into how often the backup poller kicked in.
  poller_alerts: defineTable({
    account_slug: v.string(),
    sent_at: v.number(),
    stale_minutes: v.number(),
    auto_heal_attempted: v.boolean(),
    auto_heal_ok: v.optional(v.boolean()),
    telegram_ok: v.optional(v.boolean()),
  }).index("by_account_slug", ["account_slug"]),

  // ── Phase 3 (WallE) — per-user daily joke quota ───────────────────────
  // 2-jokes-per-day cap enforced by dashboard_chat.recordJoke. One row per
  // (user_id, day) where day is YYYY-MM-DD in UTC. count increments on
  // each joke until the cap is hit. Old rows can be pruned by a daily
  // cron; quota is per-calendar-day so no rollover logic needed.
  walle_joke_log: defineTable({
    user_id: v.string(),
    day: v.string(),                 // YYYY-MM-DD (UTC)
    count: v.number(),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
  })
    .index("by_user_day", ["user_id", "day"])
    .index("by_day", ["day"]),

  // ── Vacation Mode (GLOBAL) ────────────────────────────────────────────
  // One row per vacation window. Affects ALL accounts (DB Cinema, Vertus,
  // Daniel, Leo) — intentionally NO account_slug field. Soft-cancel via
  // is_active=false so we keep an audit trail of past vacations.
  // Date strings are YYYY-MM-DD in Europe/London (inclusive end_date),
  // matching the existing reservation date columns.
  vacation_periods: defineTable({
    start_date: v.string(),                  // "YYYY-MM-DD" Europe/London
    end_date: v.string(),                    // "YYYY-MM-DD" Europe/London (inclusive)
    reason: v.optional(v.string()),          // free text, optional
    created_at: v.number(),                  // Date.now()
    created_by: v.optional(v.string()),      // "dashboard" | "telegram" | username
    is_active: v.boolean(),                  // soft-cancel flag — false to "delete"
  })
    .index("by_active_start", ["is_active", "start_date"])
    .index("by_active_end", ["is_active", "end_date"]),

  // ── Pending Vacation Confirmations (Wave 4 — Telegram inbound) ─────────
  // Transient row written when /vacation set hits CONFIRMED_CONFLICTS.
  // User must reply `/vacation force` within 5 min — handler looks up
  // the row by chat_id, calls setVacation({force:true}), deletes the row.
  pending_vacation_confirmations: defineTable({
    chat_id: v.string(),                     // Telegram chat.id as string
    start_date: v.string(),                  // YYYY-MM-DD
    end_date: v.string(),                    // YYYY-MM-DD
    reason: v.optional(v.string()),
    expires_at: v.number(),                  // Date.now() + 5*60*1000
  })
    .index("by_chat", ["chat_id"])
    .index("by_expires", ["expires_at"]),

  // ── Web Push subscriptions (2026-06-23) ───────────────────────────────
  // One row per browser/PWA push endpoint that opted in via the dashboard
  // notification bell. Keyed by endpoint (unique). Dead endpoints (410/404
  // on send) are pruned by the dispatcher.
  push_subscriptions: defineTable({
    endpoint: v.string(),
    p256dh: v.string(),                      // client public key (base64url)
    auth: v.string(),                        // client auth secret (base64url)
    user_agent: v.optional(v.string()),
    created_at: v.number(),
    last_seen_at: v.number(),
  }).index("by_endpoint", ["endpoint"]),

  // ── Notification events (2026-06-23) ──────────────────────────────────
  // One row per push-worthy event the poller detected: a newly-confirmed
  // booking ("wohoo") or a new rental request landing in the Reply Inbox.
  // `delivered_at` gates the dispatcher (send-once); `read_at` drives the
  // bell's unread badge. `url` deep-links to the chat thread.
  notification_events: defineTable({
    type: v.union(
      v.literal("booking_confirmed"),
      v.literal("new_request"),
      v.literal("renter_message"),
    ),
    thread_id: v.string(),                   // hygglo_order_id → deep-link target
    account_slug: v.optional(v.string()),
    title: v.string(),
    body: v.string(),
    url: v.string(),                         // e.g. "/?thread=<id>&account=<slug>"
    created_at: v.number(),
    delivered_at: v.optional(v.number()),    // set once web-push/Telegram fired
    read_at: v.optional(v.number()),         // set when operator opens the bell
    // Dispatch outcome (2026-07-03): how many web-push endpoints actually
    // accepted the payload + whether Telegram accepted. "delivered_at set but
    // push_ok 0 / telegram_ok false" = the silent-death mode where every
    // channel failed and nobody noticed (how the wohoo went missing).
    push_ok: v.optional(v.number()),
    telegram_ok: v.optional(v.boolean()),
  })
    .index("by_created", ["created_at"])
    .index("by_delivered", ["delivered_at"])
    // De-dupe guard: at most one event per (thread, type) so a re-poll that
    // re-sees the same transition can't double-fire.
    .index("by_thread_type", ["thread_id", "type"]),

  // ── Canned responses (Quick Reply, 2026-06-26) ───────────────────────
  // Per-account saved quick-texts (delivery text, location, bank details, …).
  // Surfaced as chips in the chat that PASTE the text into the compose box (never
  // auto-send — you edit then Send yourself), editable via the manage overlay.
  // Per-account because each account has its own pickup address / bank / tone.
  canned_responses: defineTable({
    account_slug: v.string(),
    label: v.string(),          // short name shown on the chip ("Bank")
    symbol: v.string(),         // emoji / glyph on the chip ("🏦")
    text: v.string(),           // the message body pasted into the box
    sort: v.number(),           // manual ordering
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_account", ["account_slug"]),

  // ── Renter reviews (Quick Reply, 2026-06-27) ─────────────────────────
  // Individual reviews a renter RECEIVED, fetched from Hygglo's public
  // /v2/product-reviews?vendorId=<hygglo_user_id> endpoint (text + rating +
  // author + date). Cached so the chat can show them on star-click + flag any
  // review under 4★. Refreshed on demand.
  renter_reviews: defineTable({
    renter_id: v.id("renters"),
    hygglo_review_id: v.number(),
    rating: v.optional(v.number()),
    text: v.optional(v.string()),
    author: v.optional(v.string()),
    created_at: v.optional(v.string()), // ISO from Hygglo
    fetched_at: v.number(),
  })
    .index("by_renter", ["renter_id"])
    .index("by_renter_review", ["renter_id", "hygglo_review_id"]),

  // ── Online listings cache (order-edit Add-items picker, 2026-07-03) ───────
  // Slim mirror of an account's LIVE Hygglo listings, refreshed by the Settings
  // "Rescan listings" button (convex/online_listings_actions.rescan). Feeds the
  // searchable Add-items picker in the Reply-Inbox order editor. Additive: does
  // NOT touch hygglo_products / the poll / catalog-sync.
  online_listings: defineTable({
    account_slug: v.string(),
    product_id: v.number(),
    name: v.string(),
    image: v.optional(v.string()),
    description: v.optional(v.string()),
    daily_price: v.optional(v.number()),
    is_published: v.boolean(),
    public_url: v.optional(v.string()),
    updated_at: v.number(),
  })
    .index("by_account", ["account_slug"])
    .index("by_account_product", ["account_slug", "product_id"]),

  // ── Draft self-improvement (2026-07-03) ─────────────────────────
  // Lessons learned when the operator sends a reply DIFFERENT from the AI draft.
  // An LLM reasons about why the owner's reply was better + distils a general,
  // reusable rule; getThreadContext injects the relevant ones into future drafts
  // so the bot drafts more like the owner over time. Operator-prunable in Settings.
  draft_lessons: defineTable({
    account_slug: v.optional(v.string()),   // undefined = applies to all accounts
    applies_when: v.string(),               // short trigger, e.g. renter asks about delivery price
    tags: v.array(v.string()),              // keywords for relevance matching
    lesson: v.string(),                     // the corrected behaviour to apply
    draft_mistake: v.optional(v.string()),  // what the draft got wrong (for the operator's view)
    weight: v.number(),                     // reinforcement count (merged duplicates bump this)
    example_sent: v.optional(v.string()),   // the owner reply that taught it
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_account", ["account_slug"]),

  // Per-account rescan marker (last run + count) for the Settings caption.
  online_listings_sync: defineTable({
    account_slug: v.string(),
    last_rescan_at: v.number(),
    count: v.number(),
  }).index("by_account", ["account_slug"]),

  // ── Apple Calendar (CalDAV / iCloud) integration ─────────────────────────
  // Single-row connection (Daniel's iCloud). Connect once with Apple ID + an
  // app-specific password; we discover the CalDAV calendar and push confirmed
  // booking pickup/return times as events (with reminders), updating/removing
  // them when bookings change.
  calendar_connection: defineTable({
    provider: v.string(),                       // "apple"
    apple_id: v.optional(v.string()),
    app_password: v.optional(v.string()),       // Apple app-specific password (sensitive)
    principal_url: v.optional(v.string()),
    calendar_home: v.optional(v.string()),
    calendar_url: v.optional(v.string()),       // chosen calendar collection href (absolute)
    calendar_name: v.optional(v.string()),
    status: v.string(),                         // "disconnected" | "connected" | "error"
    reminder_lead_min: v.optional(v.number()),  // VALARM lead minutes (default 60)
    return_reminder_lead_min: v.optional(v.number()),
    auto_sync: v.optional(v.boolean()),         // auto-push confirmed bookings
    last_error: v.optional(v.string()),
    last_sync_at: v.optional(v.number()),
    connected_at: v.optional(v.number()),
    updated_at: v.number(),
  }),

  // One row per pushed event (a booking has up to 2: pickup + return) so we can
  // update/delete them when the booking changes.
  calendar_event_links: defineTable({
    thread_id: v.string(),                      // reservation hygglo_order_id
    kind: v.string(),                           // "pickup" | "return"
    event_uid: v.string(),
    event_href: v.string(),                     // absolute href on the CalDAV server
    etag: v.optional(v.string()),
    ics_hash: v.optional(v.string()),           // skip no-op re-PUTs
    synced_at: v.number(),
  }).index("by_thread", ["thread_id"]).index("by_uid", ["event_uid"]),
});