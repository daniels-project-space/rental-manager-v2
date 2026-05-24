import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Phase 1.A schema. Tables with `Empty in this phase` are scaffolding for later phases
// (renters, reservations, conversations, rules, denial_records).
// MASTER SAFETY RAIL: settings.ALLOW_HYGGLO_SEND must remain false.
export default defineSchema({
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
    /** ms epoch — bumped by the poller on every upsert so we can detect rows
     *  Hygglo has stopped returning (i.e. silently completed). */
    last_polled_at: v.optional(v.number()),
    /** Last Hygglo filter the row was seen in: "pending" | "current" | "future" | "obsolete". */
    source_filter: v.optional(v.string()),
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
    .index("by_demand_loss_class", ["demand_loss_class"])
    // Phase 7a (2026-05-24) — composite for audit_qty_drift + dashboard
    // status-scoped queries. Cuts unindexed full-table scans down to the
    // confirmed-only slice (~300 rows vs ~1700).
    .index("by_account_status", ["account_slug", "status"]),

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
    .index("by_account_date", ["account_slug", "date"]),

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
    created_at: v.number(),
  }).index("by_thread", ["thread_id"]),

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
    payload: v.any(),                     // full StatsDrawerData JSON
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
   * Raw Hygglo payload inbox (for split-architecture or replay).
   * Polling agent writes; workflow steps read + mark processed.
   * payloadHash dedupes redrives.
   */
  hygglo_inbox: defineTable({
    receivedAt: v.number(),
    source: v.union(v.literal("vps_scraper"), v.literal("convex_http")),
    payloadHash: v.string(),
    payload: v.any(),
    processed: v.boolean(),
  })
    .index("by_processed", ["processed"])
    .index("by_payloadHash", ["payloadHash"]),

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

  // ── Wave 4.6 — Hygglo UI automation ──────────────────────────
  // Storage_state cookie blobs captured by `scripts/bootstrap-hygglo-session.mjs`
  // after Daniel performs a manual login locally. Restored by the
  // `hygglo-ui-action` Trigger task before each browser run so we never
  // log in inside the task container.
  //
  // SECURITY: storageStateJson contains live Hygglo session cookies in
  // plaintext. v1 stores it raw — v2 should encrypt at rest with
  // ENCRYPT_AT_REST_KEY once available. Marked future_work in PR body.
  hygglo_sessions: defineTable({
    accountSlug: v.union(v.literal("dbcinema"), v.literal("leo")),
    storageStateJson: v.string(),
    capturedAt: v.number(),
    expiresHintAt: v.optional(v.number()),     // operator-provided cookie expiry estimate
    lastUsedAt: v.optional(v.number()),
    lastUsedRunId: v.optional(v.string()),
  }).index("by_account", ["accountSlug"]),

  // Audit row per UI action attempt (one per correlationId). Idempotency
  // gate: the Trigger task short-circuits on a row whose status is in
  // ["shadow_complete","live_complete"]. Shadow rows always carry a
  // screenshot URL — that's the entire point of shadow mode.
  hygglo_ui_actions: defineTable({
    correlationId: v.string(),
    accountSlug: v.string(),
    orderId: v.optional(v.string()),
    action: v.string(),                        // accept | decline | apply_discount | ...
    args: v.any(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("shadow_complete"),
      v.literal("live_complete"),
      v.literal("failed"),
    ),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    strategyUsed: v.union(
      v.literal("recipe"),
      v.literal("ai_fallback"),                // recipe attempted then fell through
      v.literal("ai_first"),                   // started in AI mode (no recipe registered)
    ),
    llmCallCount: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    estCostUsd: v.optional(v.number()),
    screenshotR2Key: v.optional(v.string()),
    screenshotUrl: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    hyggloConfirmationText: v.optional(v.string()),
  })
    .index("by_correlation", ["correlationId"])
    .index("by_status_account", ["status", "accountSlug"])
    .index("by_startedAt", ["startedAt"]),

  // Per-account per-day LLM/API spend ledger for the UI automation loop.
  // Pre-flight gate: dispatchUiAction refuses with caveat
  // `daily_cost_cap_reached` when today's accumulated spend > $5.
  // Override: env HYGGLO_UI_COST_OVERRIDE=true (operator escape hatch).
  ui_cost_guards: defineTable({
    accountSlug: v.string(),
    isoDate: v.string(),                       // YYYY-MM-DD UTC
    spendUsd: v.number(),
    actionCount: v.number(),
    updatedAt: v.number(),
  }).index("by_account_date", ["accountSlug", "isoDate"]),

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
});