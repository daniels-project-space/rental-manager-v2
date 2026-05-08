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

  // ── Renters / reservations / calendar (empty, Phase 2) ──────
  renters: defineTable({
    hygglo_user_id: v.string(),
    display_name: v.optional(v.string()),
    notes: v.optional(v.string()),
    blacklist: v.optional(v.boolean()),
    created_at: v.number(),
  }).index("by_hygglo_user_id", ["hygglo_user_id"]),

  reservations: defineTable({
    account_id: v.id("accounts"),
    renter_id: v.optional(v.id("renters")),
    listing_id: v.optional(v.string()),
    status: v.string(),               // "confirmed" | "pending_review" | "declined"
    start_at: v.number(),
    end_at: v.number(),
    notes: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_account", ["account_id"]).index("by_status", ["status"]),

  calendar_holds: defineTable({
    item_id: v.id("items"),
    reservation_id: v.optional(v.id("reservations")),
    start_at: v.number(),
    end_at: v.number(),
    qty_held: v.number(),
    created_at: v.number(),
  }).index("by_item_date_range", ["item_id", "start_at"]),

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
    read_only_mode: v.boolean(),
    polling_interval_ms: v.number(),
    escalate_to_sonnet: v.boolean(),
    troubleshooting_policy: v.optional(v.object({
      classification: v.array(v.string()),
      resolvable_action: v.string(),
      web_search_tool: v.string(),
      money_action: v.string(),
      missing_items_action: v.string(),
      broken_action: v.string(),
      unknown_action: v.string(),
    })),
    updated_at: v.optional(v.number()),
  }),

  // ── Competitor listings (informational, optional) ───────────
  competitor_listings: defineTable({
    listing_id: v.string(),
    title: v.optional(v.string()),
    price_per_day: v.optional(v.number()),
    url: v.optional(v.string()),
    notes: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_listing", ["listing_id"]),
});
