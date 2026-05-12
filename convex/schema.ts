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
    pickup_arrival_confirmed: v.optional(v.boolean()),
    is_obsolete: v.optional(v.boolean()),           // mirrors Hygglo filter=obsolete
    obsolete_reason: v.optional(v.union(
      v.literal("owner_denied"),                    // REQUEST step never advanced
      v.literal("renter_cancelled"),                // CANCELED step active
      v.literal("verification_failed"),             // VERIFIED/FUNDS_RESERVED but obsolete
      v.literal("other"),
    )),
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
    created_at: v.number(),
  })
    .index("by_item_date_range", ["item_id", "start_at"])
    .index("by_item_date", ["item_id", "date"])
    .index("by_reservation", ["reservation_id"])
    .index("by_account_date", ["account_slug", "date"]),

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
    source: v.string(),                   // "v1-historical-static"
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
});