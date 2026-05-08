import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

// Phase 1.A inventory seed mutations.
// All mutations write `audit_log` rows tagged with actor="seed-script".
// MASTER SAFETY RAIL: settings.ALLOW_HYGGLO_SEND must remain false.

const now = () => Date.now();

// ── ACCOUNTS ─────────────────────────────────────────────────
export const seedAccounts = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("accounts").collect();
    if (existing.length > 0) {
      return { skipped: true, count: existing.length };
    }
    const t = now();
    await ctx.db.insert("accounts", {
      slug: "leo",
      display_name: "Leo (rental-manager v2 owner)",
      hygglo_seller_id: undefined,
      hygglo_username: undefined,
      notes: "Personal account",
      created_at: t,
      updated_at: t,
    });
    await ctx.db.insert("accounts", {
      slug: "dbcinema",
      display_name: "DB Cinema",
      hygglo_seller_id: undefined,
      hygglo_username: undefined,
      notes: "Business account",
      created_at: t,
      updated_at: t,
    });
    await ctx.db.insert("audit_log", {
      table_name: "accounts",
      actor: "seed-script",
      op: "insert",
      count: 2,
      source_file: "hardcoded",
      note: "seedAccounts initial",
      ts: t,
    });
    return { skipped: false, count: 2 };
  },
});

// ── ITEMS ─────────────────────────────────────────────────────
export const seedItems = internalMutation({
  args: {
    items: v.array(v.object({
      name_canonical: v.string(),
      name_input: v.string(),
      slug: v.string(),
      kind: v.string(),
      sub_kind: v.optional(v.string()),
      qty: v.number(),
      unit_kind: v.string(),
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
      status: v.string(),
      description_source: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { items }) => {
    const existing = await ctx.db.query("items").collect();
    if (existing.length > 0) {
      return { skipped: true, count: existing.length };
    }
    const t = now();
    let inserted = 0;
    for (const it of items) {
      await ctx.db.insert("items", { ...it, created_at: t, updated_at: t });
      inserted++;
    }
    await ctx.db.insert("audit_log", {
      table_name: "items",
      actor: "seed-script",
      op: "insert",
      count: inserted,
      source_file: "v1: utils/item-matcher.ts MASTER_INVENTORY + data/*",
      note: "seedItems batch",
      ts: t,
    });
    return { skipped: false, count: inserted };
  },
});

// ── ITEM SPECS ────────────────────────────────────────────────
export const seedItemSpecs = internalMutation({
  args: {
    specs: v.array(v.object({
      item_name_canonical: v.string(),
      description: v.string(),
      specs_long: v.optional(v.string()),
      source: v.string(),
    })),
  },
  handler: async (ctx, { specs }) => {
    const existing = await ctx.db.query("item_specs").collect();
    if (existing.length > 0) return { skipped: true, count: existing.length };
    const t = now();
    let inserted = 0;
    for (const s of specs) {
      const item = await ctx.db
        .query("items")
        .withIndex("by_canonical_name", (q) => q.eq("name_canonical", s.item_name_canonical))
        .first();
      if (!item) continue; // skip if item not seeded
      await ctx.db.insert("item_specs", {
        item_id: item._id,
        item_name_canonical: s.item_name_canonical,
        description: s.description,
        specs_long: s.specs_long,
        source: s.source,
        created_at: t,
      });
      inserted++;
    }
    await ctx.db.insert("audit_log", {
      table_name: "item_specs",
      actor: "seed-script",
      op: "insert",
      count: inserted,
      source_file: "v1: data/item-specs.ts + grok",
      note: "seedItemSpecs batch",
      ts: t,
    });
    return { skipped: false, count: inserted };
  },
});

// ── BUNDLES ────────────────────────────────────────────────────
export const seedBundles = internalMutation({
  args: {
    bundles: v.array(v.object({
      slug: v.string(),
      bundle_name: v.string(),
      daily_price_min: v.optional(v.number()),
      daily_price_max: v.optional(v.number()),
      use_cases: v.optional(v.array(v.string())),
      trigger_keywords: v.optional(v.array(v.string())),
      savings_note: v.optional(v.string()),
      delivery_note: v.optional(v.string()),
      account_scope: v.optional(v.string()),
      items: v.array(v.object({
        item_name_canonical: v.string(),
        qty: v.number(),
      })),
    })),
  },
  handler: async (ctx, { bundles }) => {
    const existing = await ctx.db.query("bundles").collect();
    if (existing.length > 0) return { skipped: true, bundles: existing.length, items: 0 };
    const t = now();
    let bundleCount = 0;
    let itemCount = 0;
    for (const b of bundles) {
      const bundleId = await ctx.db.insert("bundles", {
        slug: b.slug,
        bundle_name: b.bundle_name,
        daily_price_min: b.daily_price_min,
        daily_price_max: b.daily_price_max,
        use_cases: b.use_cases,
        trigger_keywords: b.trigger_keywords,
        savings_note: b.savings_note,
        delivery_note: b.delivery_note,
        account_scope: b.account_scope ?? "both",
        created_at: t,
      });
      bundleCount++;
      for (const bi of b.items) {
        const item = await ctx.db
          .query("items")
          .withIndex("by_canonical_name", (q) => q.eq("name_canonical", bi.item_name_canonical))
          .first();
        await ctx.db.insert("bundle_items", {
          bundle_id: bundleId,
          item_id: item?._id,
          item_name_canonical: bi.item_name_canonical,
          qty: bi.qty,
        });
        itemCount++;
      }
    }
    await ctx.db.insert("audit_log", {
      table_name: "bundles",
      actor: "seed-script",
      op: "insert",
      count: bundleCount,
      source_file: "v1: data/bundle-suggestions.ts",
      note: `${bundleCount} bundles, ${itemCount} bundle_items`,
      ts: t,
    });
    return { skipped: false, bundles: bundleCount, items: itemCount };
  },
});

// ── MARKETING REDIRECTS ─────────────────────────────────────────
export const seedMarketingRedirects = internalMutation({
  args: {
    redirects: v.array(v.object({
      marketing_name: v.string(),
      real_item_name_canonical: v.string(),
      selling_point: v.optional(v.string()),
      category: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { redirects }) => {
    const existing = await ctx.db.query("marketing_redirects").collect();
    if (existing.length > 0) return { skipped: true, count: existing.length };
    const t = now();
    let inserted = 0;
    for (const r of redirects) {
      const item = await ctx.db
        .query("items")
        .withIndex("by_canonical_name", (q) => q.eq("name_canonical", r.real_item_name_canonical))
        .first();
      await ctx.db.insert("marketing_redirects", {
        marketing_name: r.marketing_name,
        real_item_id: item?._id,
        real_item_name_canonical: r.real_item_name_canonical,
        selling_point: r.selling_point,
        category: r.category,
        created_at: t,
      });
      inserted++;
    }
    await ctx.db.insert("audit_log", {
      table_name: "marketing_redirects",
      actor: "seed-script",
      op: "insert",
      count: inserted,
      source_file: "v1: data/marketing-redirects.ts",
      note: "seedMarketingRedirects",
      ts: t,
    });
    return { skipped: false, count: inserted };
  },
});

// ── PRICING CATALOG ─────────────────────────────────────────────
export const seedPricingCatalog = internalMutation({
  args: {
    rows: v.array(v.object({
      item_name_canonical: v.string(),
      category: v.optional(v.string()),
      daily_price_min: v.number(),
      daily_price_max: v.number(),
      is_bundle: v.boolean(),
      bundle_items: v.optional(v.array(v.string())),
      multi_day_notes: v.optional(v.string()),
      marketing_only: v.optional(v.boolean()),
      account_slug: v.optional(v.string()),  // "leo" | "dbcinema" | undefined => both
    })),
  },
  handler: async (ctx, { rows }) => {
    const existing = await ctx.db.query("pricing_catalog").collect();
    if (existing.length > 0) return { skipped: true, count: existing.length };
    const t = now();
    const accounts = await ctx.db.query("accounts").collect();
    const accBySlug = Object.fromEntries(accounts.map((a) => [a.slug, a._id]));
    let inserted = 0;
    for (const r of rows) {
      const item = await ctx.db
        .query("items")
        .withIndex("by_canonical_name", (q) => q.eq("name_canonical", r.item_name_canonical))
        .first();
      const accountIds = r.account_slug ? [accBySlug[r.account_slug]] : Object.values(accBySlug);
      for (const aid of accountIds) {
        await ctx.db.insert("pricing_catalog", {
          item_id: item?._id,
          item_name_canonical: r.item_name_canonical,
          account_id: aid,
          category: r.category,
          daily_price_min: r.daily_price_min,
          daily_price_max: r.daily_price_max,
          is_bundle: r.is_bundle,
          bundle_items: r.bundle_items,
          multi_day_notes: r.multi_day_notes,
          marketing_only: r.marketing_only,
          created_at: t,
        });
        inserted++;
      }
    }
    await ctx.db.insert("audit_log", {
      table_name: "pricing_catalog",
      actor: "seed-script",
      op: "insert",
      count: inserted,
      source_file: "v1: data/pricing-catalog.ts",
      note: "seedPricingCatalog x both accounts",
      ts: t,
    });
    return { skipped: false, count: inserted };
  },
});

// ── LISTING PHOTOS ──────────────────────────────────────────────
export const seedListingPhotos = internalMutation({
  args: {
    rows: v.array(v.object({
      listing_id: v.string(),
      account_slug: v.string(),
      items: v.array(v.object({ item_name: v.string(), qty: v.number() })),
      included: v.optional(v.array(v.string())),
      notes: v.optional(v.string()),
      photo_file: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { rows }) => {
    const existing = await ctx.db.query("listing_photos").collect();
    if (existing.length > 0) return { skipped: true, count: existing.length };
    const t = now();
    const accounts = await ctx.db.query("accounts").collect();
    const accBySlug = Object.fromEntries(accounts.map((a) => [a.slug, a._id]));
    let inserted = 0;
    for (const r of rows) {
      await ctx.db.insert("listing_photos", {
        listing_id: r.listing_id,
        account_id: accBySlug[r.account_slug],
        account_slug: r.account_slug,
        items: r.items,
        included: r.included,
        notes: r.notes,
        photo_file: r.photo_file,
        created_at: t,
      });
      inserted++;
    }
    await ctx.db.insert("audit_log", {
      table_name: "listing_photos",
      actor: "seed-script",
      op: "insert",
      count: inserted,
      source_file: "v1: data/listing-photo-reference.ts",
      note: "seedListingPhotos",
      ts: t,
    });
    return { skipped: false, count: inserted };
  },
});

// ── SETTINGS ───────────────────────────────────────────────────
export const seedSettings = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("settings").collect();
    const t = now();
    if (existing.length > 0) {
      const s = existing[0];
      await ctx.db.patch(s._id, {
        ALLOW_HYGGLO_SEND: false,
        read_only_mode: true,
        polling_interval_ms: s.polling_interval_ms ?? 30000,
        escalate_to_sonnet: s.escalate_to_sonnet ?? true,
        troubleshooting_policy: {
          classification: ["resolvable", "money_issue", "missing_items", "broken_item", "unknown"],
          resolvable_action: "research_online_then_help",
          web_search_tool: "tavily_or_serper",
          money_action: "escalate_telegram",
          missing_items_action: "prompt_double_check_bags_first_then_escalate_if_still_missing",
          broken_action: "escalate_telegram",
          unknown_action: "escalate_telegram",
        },
        updated_at: t,
      });
      return { skipped: false, patched: true };
    }
    await ctx.db.insert("settings", {
      ALLOW_HYGGLO_SEND: false,
      read_only_mode: true,
      polling_interval_ms: 30000,
      escalate_to_sonnet: true,
      troubleshooting_policy: {
        classification: ["resolvable", "money_issue", "missing_items", "broken_item", "unknown"],
        resolvable_action: "research_online_then_help",
        web_search_tool: "tavily_or_serper",
        money_action: "escalate_telegram",
        missing_items_action: "prompt_double_check_bags_first_then_escalate_if_still_missing",
        broken_action: "escalate_telegram",
        unknown_action: "escalate_telegram",
      },
      updated_at: t,
    });
    await ctx.db.insert("audit_log", {
      table_name: "settings",
      actor: "seed-script",
      op: "insert",
      count: 1,
      source_file: "hardcoded",
      note: "settings singleton seeded",
      ts: t,
    });
    return { skipped: false, patched: false };
  },
});

// ── SAMPLE FINGERPRINTS (3 items + spec + compat) ────────────────
export const sampleFingerprints = internalMutation({
  args: {},
  handler: async (ctx) => {
    const sampleNames = ["Sony FX3", "BMPCC 6K Pro", "DJI RS3 Pro gimbal"];
    const out = [];
    for (const name of sampleNames) {
      const item = await ctx.db
        .query("items")
        .withIndex("by_canonical_name", (q) => q.eq("name_canonical", name))
        .first();
      if (!item) { out.push({ name, missing: true }); continue; }
      const spec = await ctx.db
        .query("item_specs")
        .withIndex("by_item", (q) => q.eq("item_id", item._id))
        .first();
      out.push({
        name_canonical: item.name_canonical,
        kind: item.kind,
        sub_kind: item.sub_kind,
        qty: item.qty,
        unit_kind: item.unit_kind,
        lens_mount: item.lens_mount,
        battery_type: item.battery_type,
        weight_kg: item.weight_kg,
        replacement_cost_gbp: item.replacement_cost_gbp,
        acquisition_cost_gbp: item.acquisition_cost_gbp,
        spec_chars: spec?.description?.length ?? 0,
        spec_source: spec?.source,
        has_compatibility: !!item.compatibility,
      });
    }
    return out;
  },
});

// ── VERIFY COUNTS ───────────────────────────────────────────────
export const verifyCounts = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tables = [
      "accounts",
      "items",
      "item_specs",
      "bundles",
      "bundle_items",
      "marketing_redirects",
      "pricing_catalog",
      "listing_photos",
      "settings",
      "audit_log",
    ] as const;
    const counts: Record<string, number> = {};
    for (const tn of tables) {
      const rows = await ctx.db.query(tn as any).collect();
      counts[tn] = rows.length;
    }
    const settings = await ctx.db.query("settings").first();
    return {
      counts,
      ALLOW_HYGGLO_SEND: settings?.ALLOW_HYGGLO_SEND,
      read_only_mode: settings?.read_only_mode,
    };
  },
});
