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
    pickup_time: v.optional(v.string()),           // "HH:MM" or free-text from chat extraction
    return_time: v.optional(v.string()),
    pickup_method: v.optional(v.string()),         // "delivery" | "self_pickup" | etc
    return_method: v.optional(v.string()),
    photos_urls: v.optional(v.array(v.string())),  // raw Hygglo CDN URLs
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
    booking_status: v.optional(v.string()),         // raw Hygglo booking status (e.g. "pending_review", "confirmed")
    /** ms epoch — bumped by the poller on every upsert so we can detect rows
     *  Hygglo has stopped returning (i.e. silently completed). */
    last_polled_at: v.optional(v.number()),
    /** Last Hygglo filter the row was seen in: "pending" | "current" | "future" | "obsolete". */
    source_filter: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_account", ["account_id"])
    .index("by_status", ["status"])
    .index("by_renter", ["renter_id"])
    .index("by_account_slug", ["account_slug"])
    .index("by_start_date", ["start_date"])
    .index("by_v1_rental_id", ["v1_rental_id"])
    .index("by_hygglo_order_id", ["hygglo_order_id"]),

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
  rules: defineTable({
    account_id: v.optional(v.id("accounts")),
    rule_kind: v.string(),
    rule_body: v.string(),
    enabled: v.boolean(),
    created_at: v.number(),
  }).index("by_account", ["account_id"]),

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
  }).index("by_account", ["account_id"]).index("by_reason", ["reason"]),

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
  }).index("by_account", ["account_slug"])
    .index("by_claim_date", ["claim_date"]),

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


  // -- AI Memories (Phase B-2 scaffold; seed deferred to B-3) --
  memories: defineTable({
    scope: v.string(),                    // "general" | "pricing" | "operational"
    content: v.string(),
    tags: v.optional(v.array(v.string())),
    source: v.string(),                   // "manual" | "v1-import-pending"
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
  }).index("by_account", ["account"]),

  top_earners_30d: defineTable({
    account: v.string(),
    generatedAt: v.number(),
    rows: v.array(v.object({
      itemName: v.string(),
      gross30dGbp: v.number(),
      net30dGbp: v.number(),
      rentalCount: v.number(),
      utilizationPct: v.number(),
    })),
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
});