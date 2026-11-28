import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { insertAccountProfile, patchAccountProfile } from "./lib/account_hub_projection";
import { renterBotLabPickupPoint } from "./lib/renter_bot_lab_scenarios";
import { insertStockInput, patchStockInput } from "./lib/stock_input_writes";
import { insertProduct, patchProduct } from "./lib/product_context";
import { fetchLabCatalogSnapshot, type LabCatalogItem, type LabCatalogListing, type LabCatalogSnapshot } from "./lib/renter_bot_lab_catalog_snapshot";
import { v } from "convex/values";

const LOCAL_ACCOUNTS = [
  {
    slug: "leo",
    display_name: "Leo (isolated Renter Bot Lab)",
    notes: "Local Lab account fixture",
    persona_prompt: "You are Leo, a London-based individual camera-gear owner. Speak in the first person, warmly and concisely. Be clear about what is confirmed and say when you need to check.",
    response_style: { person: "first_person_singular", tone: "warm, casual, concise", emoji: "rare", sign_off: "none" },
  },
  {
    slug: "diogo",
    display_name: "Diogo (isolated Renter Bot Lab)",
    notes: "Local Lab account fixture",
    persona_prompt: "You are Diogo, an independent camera and film-gear owner renting out your own kit in the UK. Speak in the first person as the owner, warmly and directly. Confirm known details and say when you need to check.",
    response_style: { person: "first_person_singular", tone: "warm, casual, concise", emoji: "rare", sign_off: "none" },
  },
  {
    slug: "dbcinema",
    display_name: "DB Cinema (isolated Renter Bot Lab)",
    notes: "Local Lab account fixture",
    persona_prompt: "You are DB Cinema, a professional camera and film-gear rental team in London. Speak clearly and warmly as the business. Confirm known details and say when you need to check.",
    response_style: { person: "first_person_plural", tone: "professional, warm, concise", emoji: "rare", sign_off: "none" },
  },
] as const;

function assertLocalLab(env: Record<string, string | undefined> = process.env) {
  if (env.RENTER_BOT_LAB_DEPLOYMENT !== "local" || env.RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED !== "false" ||
      env.RENTER_BOT_LAB_SCENARIO_SEEDING !== "enabled") {
    throw new Error("Local Lab bootstrap is disabled outside the isolated, probe-only development deployment");
  }
}

/** Create only the account and pickup-profile fixtures needed by the local Lab. */
export const bootstrapLocalLab = internalMutation({
  args: {},
  handler: async (ctx) => {
    assertLocalLab();
    const now = Date.now();
    const pickupHours = [{ start: "10:00", end: "12:00" }, { start: "19:00", end: "21:00" }];
    const ready: string[] = [];
    for (const fixture of LOCAL_ACCOUNTS) {
      const point = renterBotLabPickupPoint(fixture.slug);
      if (!point) throw new Error(`Missing local Lab pickup fixture for ${fixture.slug}`);
      let account = await ctx.db.query("accounts")
        .withIndex("by_slug", (q) => q.eq("slug", fixture.slug)).unique();
      if (!account) {
        const id = await ctx.db.insert("accounts", {
          slug: fixture.slug,
          display_name: fixture.display_name,
          notes: fixture.notes,
          created_at: now,
          updated_at: now,
        });
        account = await ctx.db.get(id);
      }
      if (!account) throw new Error(`Could not create local Lab account ${fixture.slug}`);

      const existing = await ctx.db.query("account_profiles")
        .withIndex("by_account", (q) => q.eq("account_id", account._id)).unique();
      if (!existing) {
        await insertAccountProfile(ctx, {
          account_id: account._id,
          persona_prompt: fixture.persona_prompt,
          language: "en-GB",
          response_style: fixture.response_style,
          pickup_area: point.area,
          pickup_address: point.address,
          pickup_hours: pickupHours,
          created_at: now,
          updated_at: now,
        });
      } else {
        await patchAccountProfile(ctx, existing._id, {
          pickup_area: point.area,
          pickup_address: point.address,
          pickup_hours: pickupHours,
          updated_at: now,
        });
      }
      ready.push(fixture.slug);
    }
    return { ready, count: ready.length, isolated: true };
  },
});

const LAB_CATALOG_KEY = "current:v1";
const LAB_CATALOG_VERSION = "renter-bot-lab-catalog-v1";
const LAB_CATALOG_SOURCE = "isolated Rental Manager read-only source snapshot";
const LAB_CATALOG_ACCOUNTS = new Set(["leo", "diogo", "dbcinema"]);

function assertCatalogSyncLocal() {
  assertLocalLab();
  if (process.env.RENTER_BOT_LAB_DEPLOYMENT !== "local")
    throw new Error("Source catalogue import is restricted to the local Renter Bot Lab");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, max = 500): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export const getCatalogStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    assertCatalogSyncLocal();
    const row = await ctx.db.query("renter_bot_lab_catalog_snapshots")
      .withIndex("by_key", (q) => q.eq("snapshot_key", LAB_CATALOG_KEY)).unique();
    if (!row) return { status: "missing" as const, fetched_at: null, inventory_count: 0, listing_count: 0,
      eligible_listing_count: 0, blocked_listing_count: 0, source_receipts: [] };
    return { status: row.sync_status ?? "missing", fetched_at: row.fetched_at, inventory_count: row.inventory_count,
      listing_count: row.listing_count, eligible_listing_count: row.eligible_listing_count,
      blocked_listing_count: row.blocked_listing_count, source_receipts: row.source_receipts,
      error_code: row.error_code ?? null };
  },
});

export const beginCatalogSync = internalMutation({
  args: { sync_id: v.string(), fetched_at: v.number() },
  handler: async (ctx, { sync_id, fetched_at }) => {
    assertCatalogSyncLocal();
    const existing = await ctx.db.query("renter_bot_lab_catalog_snapshots")
      .withIndex("by_key", (q) => q.eq("snapshot_key", LAB_CATALOG_KEY)).unique();
    const fields = { snapshot_key: LAB_CATALOG_KEY, version: LAB_CATALOG_VERSION, sync_id,
      sync_status: "syncing" as const, error_code: undefined, fetched_at, source_receipts: [],
      inventory_count: 0, listing_count: 0, eligible_listing_count: 0, blocked_listing_count: 0 };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("renter_bot_lab_catalog_snapshots", fields);
    return { sync_id };
  },
});

export const applyCatalogItemChunk = internalMutation({
  args: { sync_id: v.string(), rows: v.array(v.any()) },
  handler: async (ctx, { sync_id, rows }) => {
    assertCatalogSyncLocal();
    if (rows.length > 100) throw new Error("Lab catalogue item chunk exceeds its bound");
    const state = await ctx.db.query("renter_bot_lab_catalog_snapshots")
      .withIndex("by_key", (q) => q.eq("snapshot_key", LAB_CATALOG_KEY)).unique();
    if (!state || state.sync_status !== "syncing" || state.sync_id !== sync_id) throw new Error("Lab catalogue sync lease is stale");
    for (const raw of rows) {
      if (!isRecord(raw) || !boundedString(raw.source_id, 120) || !boundedString(raw.name, 240) ||
          !boundedString(raw.display_name, 240) || !boundedString(raw.kind, 60) || !boundedString(raw.status, 40) ||
          (raw.contents_source !== undefined && !boundedString(raw.contents_source, 120)) ||
          (raw.rental_facts !== undefined && (!isRecord(raw.rental_facts) ||
            !boundedString(raw.rental_facts.name, 240) || !boundedString(raw.rental_facts.source, 120))) ||
          !Number.isSafeInteger(raw.qty) || (raw.qty as number) < 0 || typeof raw.is_marketing_only !== "boolean" ||
          !["unit", "kit", "set"].includes(String(raw.unit_kind)) || !Array.isArray(raw.aliases) ||
          raw.aliases.length > 100 || raw.aliases.some((x) => !boundedString(x, 240)) ||
          !Array.isArray(raw.included_with_rental) || raw.included_with_rental.length > 100 ||
          raw.included_with_rental.some((x) => !boundedString(x, 1000))) throw new Error("Lab catalogue item row is malformed");
      const item = raw as unknown as LabCatalogItem;
      const bySource = await ctx.db.query("items").withIndex("by_lab_source_inventory_id", (q) =>
        q.eq("lab_source_inventory_id", item.source_id)).unique();
      const sameName = bySource ? null : await ctx.db.query("items")
        .withIndex("by_canonical_name", (q) => q.eq("name_canonical", item.name)).unique();
      if (sameName?.lab_source_inventory_id && sameName.lab_source_inventory_id !== item.source_id)
        throw new Error("Lab catalogue source identity conflicts with a local inventory row");
      const existing = bySource ?? sameName;
      const compatibility = { ...(existing?.compatibility ?? {}), included_with_rental: item.included_with_rental };
      const fields = {
        lab_source_inventory_id: item.source_id, lab_catalog_revision: sync_id,
        name_canonical: item.name, display_name: item.display_name, name_input: item.name,
        slug: `lab-src-${item.source_id.toLowerCase()}`, aliases: item.aliases,
        kind: item.kind, qty: item.qty, unit_kind: item.unit_kind, status: item.status,
        is_marketing_only: item.is_marketing_only, description_source: item.contents_source ?? LAB_CATALOG_SOURCE,
        owner_verified_kit: item.contents_source && item.included_with_rental.length
          ? { source: item.contents_source, contents: item.included_with_rental }
          : undefined,
        compatibility,
        ...(item.rental_facts ? { rental_facts: item.rental_facts } : {}),
        ...(item.replacement_cost_gbp ? { replacement_cost_gbp: item.replacement_cost_gbp } : {}),
        updated_at: Date.now(),
      };
      if (existing) await patchStockInput(ctx, existing._id, fields);
      else await insertStockInput(ctx, "items", { ...fields, created_at: Date.now() });
    }
    return { imported: rows.length };
  },
});

export const applyCatalogListingChunk = internalMutation({
  args: { sync_id: v.string(), rows: v.array(v.any()) },
  handler: async (ctx, { sync_id, rows }) => {
    assertCatalogSyncLocal();
    if (rows.length > 30) throw new Error("Lab catalogue listing chunk exceeds its bound");
    const state = await ctx.db.query("renter_bot_lab_catalog_snapshots")
      .withIndex("by_key", (q) => q.eq("snapshot_key", LAB_CATALOG_KEY)).unique();
    if (!state || state.sync_status !== "syncing" || state.sync_id !== sync_id) throw new Error("Lab catalogue sync lease is stale");
    const inventory = await ctx.db.query("items").collect();
    const itemsBySourceId = new Map(inventory.flatMap((item) => item.lab_source_inventory_id
      ? [[item.lab_source_inventory_id, item] as const] : []));
    for (const raw of rows) {
      if (!isRecord(raw) || typeof raw.account_slug !== "string" || !LAB_CATALOG_ACCOUNTS.has(raw.account_slug) ||
          !Number.isSafeInteger(raw.product_id) || (raw.product_id as number) < 1 || !boundedString(raw.name, 500) ||
          typeof raw.is_published !== "boolean" || typeof raw.is_marketing_only !== "boolean" ||
          typeof raw.last_synced_at !== "number" || !Array.isArray(raw.components) || !Array.isArray(raw.prices))
        throw new Error("Lab catalogue listing row is malformed");
      const listing = raw as unknown as LabCatalogListing;
      const components = listing.components.flatMap((component) => {
        const item = itemsBySourceId.get(component.source_item_id);
        return item && Number.isSafeInteger(component.qty) && component.qty > 0
          ? [{ item_id: item._id, qty: component.qty, source_item_id: component.source_item_id }] : [];
      });
      const exactMapping = listing.source_receipt.override_present && components.length === listing.components.length;
      const available = !listing.is_marketing_only && exactMapping && components.length > 0;
      const masterSourceId = listing.source_receipt.product_master_item_id;
      const primary = components.find((component) => component.source_item_id === masterSourceId) ?? components[0];
      const product = await ctx.db.query("hygglo_products").withIndex("by_account_product", (q) =>
        q.eq("accountSlug", listing.account_slug).eq("productId", listing.product_id)).unique();
      const productFields = {
        accountSlug: listing.account_slug, productId: listing.product_id, name: listing.name,
        description: listing.description,
        descriptionSyncedAt: listing.description_synced_at,
        publicUrl: listing.public_url,
        minimumRentalDays: listing.minimum_rental_days,
        valuation: listing.valuation_gbp,
        unavailableDates: listing.unavailable_dates,
        isPublished: listing.is_published && available, isMarketingOnly: !available,
        isMarketingOnlyOverride: !available,
        ...(primary ? { masterItemId: primary.item_id } : { masterItemId: undefined }),
        prices: listing.prices.map((tier) => ({ days: tier.days, pricePerDay: tier.pricePerDay })),
        lastSyncedAt: listing.last_synced_at, lab_catalog_revision: sync_id,
      };
      if (product) await patchProduct(ctx, product._id, productFields, product);
      else await insertProduct(ctx, productFields as never);

      const mapping = await ctx.db.query("listing_resolution_override").withIndex("by_account_product", (q) =>
        q.eq("account_slug", listing.account_slug).eq("product_id", listing.product_id)).unique();
      const pickupAvailability = mapping?.pickup_availability ?? {
        status: "account_area_only" as const,
        source: "owner-confirmed Lab account pickup area",
        verified_at: Date.now(),
      };
      const mappingFields = { components: components.map(({ item_id, qty }) => ({ item_id, qty })),
        ...(primary ? { stock_item_id: primary.item_id } : { stock_item_id: undefined }),
        public_url: listing.public_url, source: listing.source_receipt.mapping_source ?? LAB_CATALOG_SOURCE,
        note: listing.unavailable_reason ?? undefined, pickup_availability: pickupAvailability,
        lab_catalog_revision: sync_id, updated_at: Date.now() };
      if (mapping) await ctx.db.patch(mapping._id, mappingFields);
      else await ctx.db.insert("listing_resolution_override", { account_slug: listing.account_slug,
        product_id: listing.product_id, ...mappingFields });

      const dailyPrice = listing.prices.find((tier) => tier.days === 1)?.pricePerDay;
      const onlineListing = await ctx.db.query("online_listings").withIndex("by_account_product", (q) =>
        q.eq("account_slug", listing.account_slug).eq("product_id", listing.product_id)).unique();
      const onlineFields = { name: listing.name, description: listing.description,
        daily_price: dailyPrice, is_published: listing.is_published && available,
        public_url: listing.public_url, lab_catalog_revision: sync_id, updated_at: Date.now() };
      if (onlineListing) await ctx.db.patch(onlineListing._id, onlineFields);
      else await ctx.db.insert("online_listings", { account_slug: listing.account_slug,
        product_id: listing.product_id, ...onlineFields });
    }
    return { imported: rows.length };
  },
});

export const finishCatalogSync = internalMutation({
  args: { sync_id: v.string(), snapshot: v.any() },
  handler: async (ctx, { sync_id, snapshot: rawSnapshot }) => {
    assertCatalogSyncLocal();
    if (!isRecord(rawSnapshot)) throw new Error("Lab catalogue summary is malformed");
    const state = await ctx.db.query("renter_bot_lab_catalog_snapshots")
      .withIndex("by_key", (q) => q.eq("snapshot_key", LAB_CATALOG_KEY)).unique();
    if (!state || state.sync_status !== "syncing" || state.sync_id !== sync_id) throw new Error("Lab catalogue sync lease is stale");

    const [items, products, listings, mappings] = await Promise.all([
      ctx.db.query("items").collect(), ctx.db.query("hygglo_products").collect(),
      ctx.db.query("online_listings").collect(), ctx.db.query("listing_resolution_override").collect(),
    ]);
    for (const item of items) {
      if (item.lab_source_inventory_id && item.lab_catalog_revision !== sync_id) {
        await patchStockInput(ctx, item._id, { status: "archived", qty: 0, is_marketing_only: true,
          lab_catalog_revision: sync_id, updated_at: Date.now() });
      } else if (!item.lab_source_inventory_id && item.name_canonical === "Sony FX3 Full-Frame Camera Kit" &&
        item.description_source === "owner-confirmed prepared Lab scenario") {
        // Retire the old listing-shaped synthetic item. The source catalogue
        // now binds this account listing to the shared physical Sony FX3 row.
        await patchStockInput(ctx, item._id, { status: "archived", qty: 0, is_marketing_only: true,
          updated_at: Date.now() });
      }
    }
    for (const product of products) if (product.lab_catalog_revision && product.lab_catalog_revision !== sync_id)
      await patchProduct(ctx, product._id, { isPublished: false, isMarketingOnly: true,
        isMarketingOnlyOverride: true, lab_catalog_revision: sync_id }, product);
    for (const listing of listings) if (listing.lab_catalog_revision && listing.lab_catalog_revision !== sync_id)
      await ctx.db.patch(listing._id, { is_published: false, lab_catalog_revision: sync_id, updated_at: Date.now() });
    for (const mapping of mappings) if (mapping.lab_catalog_revision && mapping.lab_catalog_revision !== sync_id)
      await ctx.db.patch(mapping._id, { components: [], stock_item_id: undefined,
        note: "Listing mapping is no longer present in the current Rental Manager source snapshot",
        lab_catalog_revision: sync_id, updated_at: Date.now() });

    const fetchedAt = typeof rawSnapshot.fetched_at === "number" ? rawSnapshot.fetched_at : Date.now();
    const sourceReceipts = Array.isArray(rawSnapshot.source_receipts) ? rawSnapshot.source_receipts : [];
    const sourceCounts = isRecord(rawSnapshot.source_counts) ? rawSnapshot.source_counts : {};
    const inventoryCount = Number.isSafeInteger(sourceCounts.inventory) ? sourceCounts.inventory as number : 0;
    const listingCount = Number.isSafeInteger(sourceCounts.listings) ? sourceCounts.listings as number : 0;
    const eligibleListingCount = Number.isSafeInteger(rawSnapshot.eligible_listings) ? rawSnapshot.eligible_listings as number : 0;
    await ctx.db.patch(state._id, { sync_status: "ready", error_code: undefined,
      fetched_at: fetchedAt, source_receipts: sourceReceipts as Array<{ source: string; fetched_at: number; row_count: number }>,
      inventory_count: inventoryCount, listing_count: listingCount,
      eligible_listing_count: eligibleListingCount, blocked_listing_count: listingCount - eligibleListingCount });
    return { status: "ready", fetched_at: fetchedAt, inventory_count: inventoryCount,
      listing_count: listingCount, eligible_listing_count: eligibleListingCount };
  },
});

export const failCatalogSync = internalMutation({
  args: { sync_id: v.string(), error_code: v.string() },
  handler: async (ctx, { sync_id, error_code }) => {
    assertCatalogSyncLocal();
    const state = await ctx.db.query("renter_bot_lab_catalog_snapshots")
      .withIndex("by_key", (q) => q.eq("snapshot_key", LAB_CATALOG_KEY)).unique();
    if (state?.sync_id === sync_id) await ctx.db.patch(state._id, { sync_status: "failed", error_code: error_code.slice(0, 80) });
  },
});

export const refreshSourceCatalog = internalAction({
  args: {},
  handler: async (ctx: ActionCtx): Promise<{ status: "ready"; fetched_at: number; inventory_count: number;
    listing_count: number; eligible_listing_count: number }> => {
    assertCatalogSyncLocal();
    const syncId = crypto.randomUUID();
    await ctx.runMutation(internal.renter_bot_lab_local_setup.beginCatalogSync, { sync_id: syncId, fetched_at: Date.now() });
    try {
      const snapshot: LabCatalogSnapshot = await fetchLabCatalogSnapshot();
      for (let index = 0; index < snapshot.items.length; index += 80) {
        await ctx.runMutation(internal.renter_bot_lab_local_setup.applyCatalogItemChunk, {
          sync_id: syncId, rows: snapshot.items.slice(index, index + 80),
        });
      }
      for (let index = 0; index < snapshot.listings.length; index += 20) {
        await ctx.runMutation(internal.renter_bot_lab_local_setup.applyCatalogListingChunk, {
          sync_id: syncId, rows: snapshot.listings.slice(index, index + 20),
        });
      }
      await ctx.runMutation(internal.renter_bot_lab_local_setup.finishCatalogSync, { sync_id: syncId, snapshot });
      return { status: "ready", fetched_at: snapshot.fetched_at, inventory_count: snapshot.source_counts.inventory,
        listing_count: snapshot.source_counts.listings, eligible_listing_count: snapshot.eligible_listings };
    } catch {
      await ctx.runMutation(internal.renter_bot_lab_local_setup.failCatalogSync, { sync_id: syncId, error_code: "catalog_source_or_import_failed" });
      throw new Error("Local Lab catalogue sync failed; chat stays isolated and the source error is recorded.");
    }
  },
});
