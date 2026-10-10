/** Owner-confirmed physical inventory intake and exact external listing linkage.
 * No marketplace write, renter message, or insurance email is sent here. */
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { internalAction, internalMutation, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { FunctionReference } from "convex/server";
import { mutation, query, requireOwner } from "./owner_functions";
import { normalizeItemName } from "./lib/item_matcher";
import { validIsoDate, loadStockSources } from "./lib/renter_stock";

const formValidator = v.object({
  name: v.string(), exact_model: v.string(), kind: v.string(), quantity: v.string(),
  ownership: v.union(v.literal("owned"), v.literal("hired_in"), v.literal("marketing_only")),
  serials: v.string(), missing_serial_reasons: v.string(), specifications: v.string(),
  compatibility_note: v.string(), included_accessories: v.string(), lens_mount: v.string(),
  owner_name: v.string(), acquisition_date: v.string(), purchase_price_gbp: v.string(),
  purchase_value_basis: v.string(), replacement_value_gbp: v.string(),
  replacement_value_basis: v.string(), vat_basis: v.string(), valuation_source: v.string(),
  valuation_date: v.string(), requested_cover_date: v.string(),
});
const accessoryIdsValidator = v.array(v.id("items"));
const targetAccountsValidator = v.array(v.string());
const PROPAGATION_STALE_AFTER_MS = 10 * 60 * 1000;
const internalOnboarding = internal as unknown as {
  inventory_onboarding: {
    refreshConsumers: FunctionReference<"action", "internal">;
    setPropagationResult: FunctionReference<"mutation", "internal">;
  };
};

const required = (value: string, label: string, max = 240) => {
  const s = value.trim();
  if (!s || s.length > max) throw Error(`${label} is required (maximum ${max} characters)`);
  return s;
};
const money = (n: number | undefined, label: string) => {
  if (n !== undefined && (!Number.isFinite(n) || n < 0 || n > 10_000_000 || Math.round(n * 100) !== n * 100))
    throw Error(`Invalid ${label}; enter a GBP amount to the nearest penny`);
  return n;
};
const date = (s: string | undefined, label: string) => {
  if (s && !validIsoDate(s)) throw Error(`Invalid ${label}`);
  return s;
};
const lines = (raw: string, label: string, max = 100) => {
  const result = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (result.length > max) throw Error(`Too many ${label}`);
  return result;
};
const normalizeSerial = (s: string) => required(s, "Serial", 100).normalize("NFKC").toLocaleLowerCase("en-GB");
const safeUrl = (raw: string) => {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw Error("A full public listing URL is required"); }
  if (u.protocol !== "https:" || !/(^|\.)hygglo\.(com|se)$/.test(u.hostname) ||
      u.username || u.password || u.search || u.hash)
    throw Error("Listing URL must be a public HTTPS Hygglo URL without credentials or tracking parameters");
  return `https://${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, "") || "/"}`;
};
const moneyPerUnit = (amount: number | undefined, basis: "per_unit" | "total" | undefined, quantity: number) => {
  if (amount === undefined || !basis) return undefined;
  return basis === "per_unit" ? amount : amount / quantity;
};
const insuranceReady = (args: {
  ownership: "owned" | "hired_in" | "marketing_only"; owner_name?: string; acquisition_date?: string;
  purchase_price_gbp?: number; purchase_value_basis?: "per_unit" | "total"; replacement_value_gbp?: number;
  replacement_value_basis?: "per_unit" | "total"; vat_basis?: string; valuation_source?: string;
  valuation_date?: string; requested_cover_date?: string;
}) => args.ownership === "owned" && !!args.owner_name?.trim() && !!args.acquisition_date &&
  args.purchase_price_gbp !== undefined && !!args.purchase_value_basis &&
  args.replacement_value_gbp !== undefined && !!args.replacement_value_basis &&
  !!args.vat_basis && args.vat_basis !== "to_confirm" && !!args.valuation_source?.trim() &&
  !!args.valuation_date && !!args.requested_cover_date;

async function assertTargets(ctx: QueryCtx, slugs: string[]) {
  if (new Set(slugs).size !== slugs.length) throw Error("Duplicate target account");
  if (slugs.some(s => !s.trim() || s.length > 80)) throw Error("Invalid target account");
  if (!slugs.length) return;
  const rows = await Promise.all(slugs.map(slug =>
    ctx.db.query("accounts").withIndex("by_slug", q => q.eq("slug", slug)).unique()));
  if (rows.some(row => !row)) throw Error("Every target listing account must exist in Rental Manager");
}

async function queuePropagation(ctx: MutationCtx, itemId: Id<"items">, now: number, nextAttempt: number) {
  const intake = await ctx.db.query("inventory_intakes")
    .withIndex("by_item", q => q.eq("item_id", itemId)).unique();
  if (intake) await ctx.db.patch(intake._id, {
    propagation_status: "pending", propagation_attempts: nextAttempt,
    propagation_error: undefined, propagation_updated_at: now,
  });
  await ctx.scheduler.runAfter(0, internalOnboarding.inventory_onboarding.refreshConsumers, { item_id: itemId, attempt: nextAttempt });
}

export const saveDraft = mutation({
  args: { request_key: v.string(), form: formValidator, compatible_accessory_ids: accessoryIdsValidator, target_account_slugs: targetAccountsValidator },
  handler: async (ctx, args) => {
    await requireOwner(ctx, true);
    const key = required(args.request_key, "Draft key", 100);
    const name = args.form.name.trim();
    const model = args.form.exact_model.trim();
    if (name.length > 240 || model.length > 240 || args.form.specifications.length > 3000 ||
        args.form.compatibility_note.length > 1000 || args.form.included_accessories.length > 2000)
      throw Error("Draft exceeds a field limit");
    const serials = lines(args.form.serials, "serials");
    const normalized = serials.map(normalizeSerial);
    if (new Set(normalized).size !== normalized.length) throw Error("Duplicate serial within this draft");
    await assertTargets(ctx, args.target_account_slugs);
    if (new Set(args.compatible_accessory_ids.map(String)).size !== args.compatible_accessory_ids.length)
      throw Error("Duplicate compatible accessory");
    const now = Date.now();
    const existing = await ctx.db.query("inventory_onboarding_drafts")
      .withIndex("by_request_key", q => q.eq("request_key", key)).unique();
    if (existing) await ctx.db.patch(existing._id, {
      form: args.form, compatible_accessory_ids: args.compatible_accessory_ids,
      target_account_slugs: args.target_account_slugs, updated_at: now,
    });
    else await ctx.db.insert("inventory_onboarding_drafts", {
      request_key: key, form: args.form, compatible_accessory_ids: args.compatible_accessory_ids,
      target_account_slugs: args.target_account_slugs, updated_at: now,
    });
    return { saved: true, updated_at: now };
  },
});

export const recentDrafts = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx, true);
    return await ctx.db.query("inventory_onboarding_drafts")
      .withIndex("by_updated_at").order("desc").take(12);
  },
});

export const getDraft = query({
  args: { request_key: v.string() },
  handler: async (ctx, { request_key }) => {
    await requireOwner(ctx, true);
    return await ctx.db.query("inventory_onboarding_drafts")
      .withIndex("by_request_key", q => q.eq("request_key", request_key)).unique();
  },
});

export const accounts = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx, true);
    // Account cardinality is the small, owner-managed set configured for Hygglo.
    return (await ctx.db.query("accounts").collect())
      .map(a => ({ slug: a.slug, display_name: a.display_name }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  },
});

export const create = mutation({
  args: {
    request_key: v.string(), name: v.string(), exact_model: v.string(), kind: v.string(),
    quantity: v.number(), ownership: v.union(v.literal("owned"), v.literal("hired_in"), v.literal("marketing_only")),
    serials: v.array(v.string()), missing_serial_reasons: v.array(v.string()),
    specifications: v.string(), compatibility_note: v.string(), included_accessories: v.string(),
    lens_mount: v.optional(v.string()), compatible_accessory_ids: accessoryIdsValidator,
    target_account_slugs: targetAccountsValidator, details_confirmed: v.boolean(),
    owner_name: v.optional(v.string()), acquisition_date: v.optional(v.string()),
    purchase_price_gbp: v.optional(v.number()), purchase_value_basis: v.optional(v.union(v.literal("per_unit"), v.literal("total"))),
    replacement_value_gbp: v.optional(v.number()), replacement_value_basis: v.optional(v.union(v.literal("per_unit"), v.literal("total"))),
    vat_basis: v.optional(v.union(v.literal("including_vat"), v.literal("excluding_vat"), v.literal("not_applicable"), v.literal("to_confirm"))),
    valuation_source: v.optional(v.string()), valuation_date: v.optional(v.string()), requested_cover_date: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, true);
    const key = required(args.request_key, "Submission key", 100);
    const prior = await ctx.db.query("inventory_intakes")
      .withIndex("by_request_key", q => q.eq("request_key", key)).unique();
    if (prior) return { item_id: prior.item_id, intake_id: prior._id, repeated: true, insurance_status: prior.insurance_status };
    if (!args.details_confirmed) throw Error("Review and confirm the exact details before committing inventory");
    const name = required(args.name, "Item name");
    const model = required(args.exact_model, "Exact make and model");
    const kind = required(args.kind, "Category", 60);
    const specifications = required(args.specifications, "Specifications or explicit unknown", 3000);
    const compatibilityNote = required(args.compatibility_note, "Compatibility or explicit unknown", 1000);
    const includedAccessories = required(args.included_accessories, "Included accessories or explicit none/unknown", 2000);
    if (normalizeItemName(name) !== normalizeItemName(model))
      throw Error("Canonical item name must match the exact make and model");
    if (!Number.isSafeInteger(args.quantity) || args.quantity < 0 || args.quantity > 100 ||
        (args.ownership !== "marketing_only" && args.quantity < 1) ||
        (args.ownership === "marketing_only" && args.quantity !== 0))
      throw Error("Owned or hired-in quantity must be 1–100; marketing-only quantity must be zero");
    const serials = args.serials.map(s => required(s, "Serial", 100));
    const serialExceptions = args.missing_serial_reasons.map(s => required(s, "Per-unit missing-serial exception", 300));
    if (serials.length + serialExceptions.length !== args.quantity)
      throw Error("Serials plus one explicit exception per unserialised unit must equal physical quantity");
    const normalizedSerials = serials.map(normalizeSerial);
    if (new Set(normalizedSerials).size !== serials.length) throw Error("Duplicate serial within this intake");
    for (const serial of normalizedSerials) {
      const taken = await ctx.db.query("inventory_unit_serials")
        .withIndex("by_serial", q => q.eq("normalized_serial", serial)).first();
      if (taken) throw Error("Serial already belongs to another physical unit");
    }
    if (args.ownership !== "marketing_only" && !args.owner_name?.trim())
      throw Error("Verified legal owner or equipment provider is required");
    await assertTargets(ctx, args.target_account_slugs);
    money(args.purchase_price_gbp, "purchase price");
    money(args.replacement_value_gbp, "replacement value");
    date(args.acquisition_date, "acquisition date");
    date(args.valuation_date, "valuation date");
    date(args.requested_cover_date, "requested cover date");
    if (args.ownership === "owned" && args.replacement_value_gbp !== undefined && !args.replacement_value_basis)
      throw Error("Replacement value must be explicitly per unit or total");
    if (args.ownership === "owned" && args.purchase_price_gbp !== undefined && !args.purchase_value_basis)
      throw Error("Purchase price must be explicitly per unit or total");
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) throw Error("Invalid item name");
    const exactDuplicate = await ctx.db.query("items")
      .withIndex("by_canonical_name", q => q.eq("name_canonical", name)).first();
    const slugDuplicate = await ctx.db.query("items")
      .withIndex("by_slug", q => q.eq("slug", slug)).first();
    const duplicate = exactDuplicate ?? slugDuplicate;
    if (duplicate) throw Error(`Existing master item: ${duplicate.name_canonical}. Review and update the existing stock pool.`);

    if (new Set(args.compatible_accessory_ids.map(String)).size !== args.compatible_accessory_ids.length)
      throw Error("Duplicate compatible accessory");
    const accessories = [];
    for (const id of args.compatible_accessory_ids) {
      const item = await ctx.db.get(id);
      if (!item || item.status !== "active" || item.is_marketing_only || item.qty < 1)
        throw Error("Compatible accessory must be an existing owned item");
      accessories.push(item.name_canonical);
    }
    const included = lines(includedAccessories, "included accessory details", 30);
    const now = Date.now();
    const owned = args.ownership === "owned";
    const bookableQuantity = owned ? args.quantity : 0;
    const insuranceStatus = insuranceReady(args) ? "ready_for_review" as const : "needs_details" as const;
    const itemId = await ctx.db.insert("items", {
      name_canonical: name, name_input: name, slug, kind, qty: bookableQuantity, unit_kind: "unit",
      lens_mount: args.lens_mount?.trim() || undefined,
      compatibility: {
        accessories: accessories.length ? accessories : undefined,
        included_with_rental: included.length ? included : undefined,
      },
      notes: [
        `Owner-entered specifications (not independently verified): ${specifications}`,
        `Compatibility: ${compatibilityNote}`,
        `Included accessories: ${includedAccessories}`,
        args.ownership === "hired_in" ? "Hired-in units are recorded but not offered as bookable stock without a dated availability agreement." : "",
      ].filter(Boolean).join("\n"),
      replacement_cost_gbp: owned ? moneyPerUnit(args.replacement_value_gbp, args.replacement_value_basis, args.quantity) : undefined,
      acquisition_cost_gbp: owned ? moneyPerUnit(args.purchase_price_gbp, args.purchase_value_basis, args.quantity) : undefined,
      is_marketing_only: !owned, status: owned ? "active" : args.ownership === "hired_in" ? "inactive" : "marketing_only",
      quantity_basis: owned ? { basis: "owner_exact", source: "walle-owner-confirmed-intake", note: `Confirmed ${args.quantity} physical unit(s)`, recorded_at: now } : undefined,
      created_at: now, updated_at: now,
    });
    for (let i = 0; i < args.quantity; i++) {
      const serial = serials[i];
      const exceptionReason = serial ? undefined : serialExceptions[i - serials.length];
      await ctx.db.insert("inventory_unit_serials", {
        item_id: itemId, unit_number: i + 1, serial,
        normalized_serial: serial ? normalizedSerials[i] : undefined,
        exception_reason: exceptionReason, recorded_at: now,
      });
    }
    const detailsEvidence = `Owner reviewed and confirmed make/model, category, quantity, every serial or per-unit exception, ownership, specifications, compatibility and included accessories at ${new Date(now).toISOString()}.`;
    const intakeId = await ctx.db.insert("inventory_intakes", {
      request_key: key, item_id: itemId, item_name: name, ownership: args.ownership,
      physical_quantity: args.quantity, serials, missing_serial_count: serialExceptions.length,
      missing_serial_reasons: serialExceptions, exact_model: model, specifications,
      compatibility_note: compatibilityNote, included_accessories: includedAccessories,
      target_account_slugs: args.target_account_slugs, details_verified_at: now, details_evidence: detailsEvidence,
      propagation_status: "pending", propagation_attempts: 1, propagation_updated_at: now,
      owner_name: args.owner_name?.trim() || undefined, acquisition_date: args.acquisition_date,
      purchase_price_gbp: args.purchase_price_gbp, purchase_value_basis: args.purchase_value_basis,
      replacement_value_gbp: args.replacement_value_gbp, replacement_value_basis: args.replacement_value_basis,
      currency_code: "GBP", vat_basis: args.vat_basis, valuation_source: args.valuation_source?.trim() || undefined,
      valuation_date: args.valuation_date, requested_cover_date: args.requested_cover_date,
      insurance_status: insuranceStatus, created_at: now, updated_at: now,
    });
    await ctx.db.insert("audit_log", {
      table_name: "items", actor: "walle-owner-confirmed-intake", op: "insert", count: 1,
      source_file: "convex/inventory_onboarding.ts:create",
      note: `item=${itemId}; intake=${intakeId}; ownership=${args.ownership}; physical_qty=${args.quantity}; bookable_qty=${bookableQuantity}; serials=${serials.length}; exceptions=${serialExceptions.length}`,
      ts: now,
    });
    const draft = await ctx.db.query("inventory_onboarding_drafts")
      .withIndex("by_request_key", q => q.eq("request_key", key)).unique();
    if (draft) await ctx.db.delete(draft._id);
    await ctx.scheduler.runAfter(0, internalOnboarding.inventory_onboarding.refreshConsumers, { item_id: itemId, attempt: 1 });
    return { item_id: itemId, intake_id: intakeId, repeated: false, insurance_status: insuranceStatus };
  },
});

export const updateListingTargets = mutation({
  args: { item_id: v.id("items"), target_account_slugs: targetAccountsValidator },
  handler: async (ctx, args) => {
    await requireOwner(ctx, true);
    await assertTargets(ctx, args.target_account_slugs);
    const intake = await ctx.db.query("inventory_intakes")
      .withIndex("by_item", q => q.eq("item_id", args.item_id)).unique();
    if (!intake) throw Error("Owner-confirmed intake required");
    const now = Date.now();
    await ctx.db.patch(intake._id, { target_account_slugs: args.target_account_slugs, updated_at: now });
    await ctx.db.insert("audit_log", {
      table_name: "inventory_intakes", actor: "owner-listing-targets", op: "update", count: 1,
      source_file: "convex/inventory_onboarding.ts:updateListingTargets",
      note: `item=${args.item_id}; target_accounts=${args.target_account_slugs.join(",") || "none selected"}`, ts: now,
    });
    return { target_account_slugs: args.target_account_slugs };
  },
});

export const registerListing = mutation({
  args: {
    item_id: v.id("items"), account_slug: v.string(), product_id: v.number(), public_url: v.string(),
    stock_components: v.array(v.object({ item_id: v.id("items"), qty: v.number() })),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, true);
    const account = required(args.account_slug, "Account", 80);
    const accountRow = await ctx.db.query("accounts")
      .withIndex("by_slug", q => q.eq("slug", account)).unique();
    if (!accountRow) throw Error("Account is not registered in Rental Manager");
    if (!Number.isSafeInteger(args.product_id) || args.product_id < 1)
      throw Error("Exact positive marketplace product ID required");
    const url = safeUrl(args.public_url);
    const item = await ctx.db.get(args.item_id);
    if (!item) throw Error("Inventory item no longer exists");
    const intake = await ctx.db.query("inventory_intakes")
      .withIndex("by_item", q => q.eq("item_id", args.item_id)).unique();
    if (!intake) throw Error("Listing registration requires an owner-confirmed intake");
    if (!intake.target_account_slugs.includes(account))
      throw Error("Choose this account in the item's listing checklist before registration");
    const owned = intake.ownership === "owned";
    const mirror = await ctx.db.query("hygglo_products")
      .withIndex("by_account_product", q => q.eq("accountSlug", account).eq("productId", args.product_id)).unique();
    if (!mirror) throw Error("Listing is not in Rental Manager's read-only account catalogue yet. Wait for catalogue sync, then retry.");
    if (mirror.isPublished !== true)
      throw Error("Listing is not confirmed public in the account catalogue. Registration never publishes listings.");
    const mirroredUrls = (mirror.listings ?? []).map(l => l.publicUrl).filter((s): s is string => !!s).map(safeUrl);
    if (!mirroredUrls.includes(url))
      throw Error("The public URL does not match this account and product ID in the synced catalogue");
    if (mirror.masterItemId && mirror.masterItemId !== args.item_id)
      throw Error("Catalogue currently maps this product ID to another item; resolve it before registering");
    const [override, index] = await Promise.all([
      ctx.db.query("listing_resolution_override")
        .withIndex("by_account_product", q => q.eq("account_slug", account).eq("product_id", args.product_id)).unique(),
      ctx.db.query("hygglo_product_index")
        .withIndex("by_account_product", q => q.eq("account_slug", account).eq("product_id", args.product_id)).unique(),
    ]);
    const stockComponents = args.stock_components;
    if (stockComponents.length > 20 || new Set(stockComponents.map(c => String(c.item_id))).size !== stockComponents.length)
      throw Error("Listing stock components must be unique and contain at most 20 rows");
    for (const component of stockComponents) {
      if (!Number.isSafeInteger(component.qty) || component.qty < 1 || component.qty > 100)
        throw Error("Each listing component must have a positive exact quantity");
      const componentItem = await ctx.db.get(component.item_id);
      if (!componentItem || componentItem.status !== "active" || componentItem.is_marketing_only || componentItem.qty < 1)
        throw Error("Every mapped listing component must be active owned inventory");
    }
    if (owned) {
      const primary = stockComponents.filter(component => component.item_id === args.item_id);
      if (primary.length !== 1 || primary[0].qty !== 1)
        throw Error("An owned listing must consume exactly one primary inventory unit");
    } else if (stockComponents.length) {
      throw Error("Hired-in and marketing-only listings cannot claim owned stock");
    }
    const components = owned ? stockComponents : [];
    const sameComponents = override && JSON.stringify(override.components.map(c => ({ id: String(c.item_id), qty: c.qty })) ) ===
      JSON.stringify(components.map(c => ({ id: String(c.item_id), qty: c.qty })));
    if (override && (!sameComponents || (override.public_url && safeUrl(override.public_url) !== url)))
      throw Error("Existing audited listing composition or URL differs; review before changing it");
    if (index && index.item_id !== args.item_id)
      throw Error("Listing ID already maps to another physical item");
    const now = Date.now();
    if (mirror.masterItemId !== args.item_id || mirror.isMarketingOnly !== !owned)
      await ctx.db.patch(mirror._id, { masterItemId: args.item_id, isMarketingOnly: !owned });
    if (override) {
      if (!override.public_url || !override.stock_item_id)
        await ctx.db.patch(override._id, {
          public_url: url, stock_item_id: args.item_id, updated_at: now,
          note: `Owner-confirmed public listing ${url}; one canonical physical stock pool.`,
        });
    } else {
      await ctx.db.insert("listing_resolution_override", {
        account_slug: account, product_id: args.product_id, components,
        stock_item_id: args.item_id, public_url: url, source: "walle-owner-confirmed-listing",
        note: `Owner-confirmed public listing ${url}; one canonical physical stock pool.`, updated_at: now,
      });
    }
    if (owned && !index) await ctx.db.insert("hygglo_product_index", {
      account_slug: account, product_id: args.product_id, item_id: args.item_id, source: "manual",
      evidence_count: 1, sample_title: mirror.name, created_at: now, last_seen_at: now,
    });
    await ctx.db.insert("audit_log", {
      table_name: "listing_resolution_override", actor: "walle-owner-confirmed-listing",
      op: override ? "confirm" : "insert", count: 1, source_file: "convex/inventory_onboarding.ts:registerListing",
      note: `account=${account}; product=${args.product_id}; item=${args.item_id}; url=${url}; physical_qty_added=0`, ts: now,
    });
    await queuePropagation(ctx, args.item_id, now, intake.propagation_attempts + 1);
    return { item_id: args.item_id, account_slug: account, product_id: args.product_id, registered: true, repeated: !!override, stock_units_added: 0 };
  },
});

export const confirmAvailability = mutation({
  args: { item_id: v.id("items") },
  handler: async (ctx, { item_id }) => {
    await requireOwner(ctx, true);
    const [item, intake] = await Promise.all([
      ctx.db.get(item_id),
      ctx.db.query("inventory_intakes").withIndex("by_item", q => q.eq("item_id", item_id)).unique(),
    ]);
    if (!item || !intake) throw Error("Committed inventory item required");
    const sources = await loadStockSources(ctx);
    const observed = sources.items.find(i => i._id === item_id);
    if (!observed) throw Error("The availability service did not load this master item");
    const rentable = intake.ownership === "owned" && observed.status === "active" &&
      !observed.is_marketing_only && observed.qty === intake.physical_quantity;
    const evidence = rentable
      ? `Live stock service loaded active owned item ${item_id} with ${observed.qty} unit(s); calendar and bot resolve this shared item row.`
      : intake.ownership === "hired_in"
        ? `Live stock service intentionally exposes 0 bookable units for hired-in item ${item_id} until a dated supply agreement is recorded.`
        : intake.ownership === "marketing_only"
          ? `Live stock service correctly exposes no owned availability for marketing-only item ${item_id}.`
          : "Availability did not match the committed owned quantity; review the stock source before confirming.";
    if (intake.ownership === "owned" && !rentable) throw Error(evidence);
    const now = Date.now();
    await ctx.db.patch(intake._id, { availability_confirmed_at: now, availability_evidence: evidence, updated_at: now });
    await ctx.db.insert("audit_log", {
      table_name: "inventory_intakes", actor: "owner-availability-confirmation", op: "update", count: 1,
      source_file: "convex/inventory_onboarding.ts:confirmAvailability", note: evidence, ts: now,
    });
    return { confirmed: true, evidence, bookable_quantity: observed.qty };
  },
});

export const updateInsuranceDetails = mutation({
  args: {
    item_id: v.id("items"), serials: v.array(v.string()), missing_serial_reasons: v.array(v.string()),
    owner_name: v.optional(v.string()), acquisition_date: v.optional(v.string()),
    purchase_price_gbp: v.optional(v.number()), purchase_value_basis: v.optional(v.union(v.literal("per_unit"), v.literal("total"))),
    replacement_value_gbp: v.optional(v.number()), replacement_value_basis: v.optional(v.union(v.literal("per_unit"), v.literal("total"))),
    vat_basis: v.optional(v.union(v.literal("including_vat"), v.literal("excluding_vat"), v.literal("not_applicable"), v.literal("to_confirm"))),
    valuation_source: v.optional(v.string()), valuation_date: v.optional(v.string()), requested_cover_date: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, true);
    const intake = await ctx.db.query("inventory_intakes").withIndex("by_item", q => q.eq("item_id", args.item_id)).unique();
    const item = await ctx.db.get(args.item_id);
    if (!intake || !item || intake.ownership !== "owned") throw Error("Owned intake required for this equipment cover workflow");
    if (intake.insurance_status === "addition_confirmed") throw Error("Confirmed addition requires a separate reviewed correction");
    const serials = args.serials.map(s => required(s, "Serial", 100));
    const missing = args.missing_serial_reasons.map(s => required(s, "Per-unit missing-serial exception", 300));
    if (serials.length + missing.length !== intake.physical_quantity)
      throw Error("Serials plus one explicit exception per unserialised unit must equal physical quantity");
    const normalized = serials.map(normalizeSerial);
    if (new Set(normalized).size !== normalized.length) throw Error("Duplicate serial");
    const existingUnits = await ctx.db.query("inventory_unit_serials")
      .withIndex("by_item", q => q.eq("item_id", args.item_id)).collect();
    const ownUnitIds = new Set(existingUnits.map(u => String(u._id)));
    for (const serial of normalized) {
      const taken = await ctx.db.query("inventory_unit_serials")
        .withIndex("by_serial", q => q.eq("normalized_serial", serial)).first();
      if (taken && !ownUnitIds.has(String(taken._id))) throw Error("Serial belongs to another physical unit");
    }
    money(args.purchase_price_gbp, "purchase price");
    money(args.replacement_value_gbp, "replacement value");
    date(args.acquisition_date, "acquisition date");
    date(args.valuation_date, "valuation date");
    date(args.requested_cover_date, "requested cover date");
    const ready = insuranceReady({ ...args, ownership: "owned" });
    const now = Date.now();
    for (const unit of existingUnits) await ctx.db.delete(unit._id);
    for (let i = 0; i < intake.physical_quantity; i++) {
      const serial = serials[i];
      await ctx.db.insert("inventory_unit_serials", {
        item_id: args.item_id, unit_number: i + 1, serial,
        normalized_serial: serial ? normalized[i] : undefined,
        exception_reason: serial ? undefined : missing[i - serials.length], recorded_at: now,
      });
    }
    await ctx.db.patch(intake._id, {
      serials, missing_serial_count: missing.length, missing_serial_reasons: missing,
      owner_name: args.owner_name?.trim() || undefined, acquisition_date: args.acquisition_date,
      purchase_price_gbp: args.purchase_price_gbp, purchase_value_basis: args.purchase_value_basis,
      replacement_value_gbp: args.replacement_value_gbp, replacement_value_basis: args.replacement_value_basis,
      currency_code: "GBP", vat_basis: args.vat_basis, valuation_source: args.valuation_source?.trim() || undefined,
      valuation_date: args.valuation_date, requested_cover_date: args.requested_cover_date,
      insurance_status: ready ? "ready_for_review" : "needs_details",
      broker_evidence: undefined, broker_evidence_kind: undefined, confirmed_cover_date: undefined, updated_at: now,
    });
    await ctx.db.patch(item._id, {
      replacement_cost_gbp: moneyPerUnit(args.replacement_value_gbp, args.replacement_value_basis, intake.physical_quantity),
      acquisition_cost_gbp: moneyPerUnit(args.purchase_price_gbp, args.purchase_value_basis, intake.physical_quantity),
      updated_at: now,
    });
    await ctx.db.insert("audit_log", {
      table_name: "inventory_intakes", actor: "owner-insurance-details", op: "update", count: 1,
      source_file: "convex/inventory_onboarding.ts:updateInsuranceDetails",
      note: `item=${args.item_id}; ready=${ready}; serials=${serials.length}; exceptions=${missing.length}`, ts: now,
    });
    await queuePropagation(ctx, args.item_id, now, intake.propagation_attempts + 1);
    return { insurance_status: ready ? "ready_for_review" : "needs_details" };
  },
});

export const recordInsuranceProgress = mutation({
  args: {
    item_id: v.id("items"),
    status: v.union(v.literal("sent_to_broker"), v.literal("awaiting_confirmation"), v.literal("addition_confirmed")),
    evidence_kind: v.union(v.literal("sent_message"), v.literal("broker_reply"), v.literal("endorsement")),
    evidence_reference: v.string(), confirmed_cover_date: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, true);
    const intake = await ctx.db.query("inventory_intakes").withIndex("by_item", q => q.eq("item_id", args.item_id)).unique();
    if (!intake || intake.ownership !== "owned") throw Error("Owned intake required");
    const transitions: Record<string, string[]> = {
      ready_for_review: ["sent_to_broker"], sent_to_broker: ["awaiting_confirmation"],
      awaiting_confirmation: ["addition_confirmed"],
    };
    if (!transitions[intake.insurance_status]?.includes(args.status))
      throw Error("Insurance status must advance one evidence-backed step at a time");
    const expectedKind = args.status === "sent_to_broker" ? "sent_message" :
      args.status === "awaiting_confirmation" ? "broker_reply" : "endorsement";
    if (args.evidence_kind !== expectedKind) throw Error("Evidence type does not match the requested insurance stage");
    const evidence = required(args.evidence_reference, "Email or document evidence reference", 500);
    if (args.status === "addition_confirmed" && !date(args.confirmed_cover_date, "confirmed cover date"))
      throw Error("Broker/endorsement effective date is required before confirming cover");
    const now = Date.now();
    await ctx.db.patch(intake._id, {
      insurance_status: args.status, broker_evidence: evidence, broker_evidence_kind: args.evidence_kind,
      confirmed_cover_date: args.status === "addition_confirmed" ? args.confirmed_cover_date : undefined,
      updated_at: now,
    });
    await ctx.db.insert("audit_log", {
      table_name: "inventory_intakes", actor: "owner-insurance-review", op: "update", count: 1,
      source_file: "convex/inventory_onboarding.ts:recordInsuranceProgress",
      note: `item=${args.item_id}; status=${args.status}; evidence_kind=${args.evidence_kind}; evidence=${evidence}`, ts: now,
    });
    return { insurance_status: args.status };
  },
});

export const retryPropagation = mutation({
  args: { item_id: v.id("items") },
  handler: async (ctx, { item_id }) => {
    await requireOwner(ctx, true);
    const intake = await ctx.db.query("inventory_intakes").withIndex("by_item", q => q.eq("item_id", item_id)).unique();
    if (!intake) throw Error("Owner-confirmed intake required");
    const now = Date.now();
    if (intake.propagation_status === "pending" && now - intake.propagation_updated_at < PROPAGATION_STALE_AFTER_MS)
      throw Error("Consumer refresh is still running; retry is available if it remains pending for 10 minutes");
    const nextAttempt = intake.propagation_attempts + 1;
    await queuePropagation(ctx, item_id, now, nextAttempt);
    await ctx.db.insert("audit_log", {
      table_name: "inventory_intakes", actor: "owner-propagation-retry", op: "retry", count: 1,
      source_file: "convex/inventory_onboarding.ts:retryPropagation",
      note: `item=${item_id}; attempt=${nextAttempt}`, ts: now,
    });
    return { status: "pending", attempt: nextAttempt };
  },
});

export const setPropagationResult = internalMutation({
  args: { item_id: v.id("items"), attempt: v.number(), status: v.union(v.literal("complete"), v.literal("partial")), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const intake = await ctx.db.query("inventory_intakes")
      .withIndex("by_item", q => q.eq("item_id", args.item_id)).unique();
    if (!intake || intake.propagation_attempts !== args.attempt || intake.propagation_status !== "pending")
      return { saved: false, stale: true };
    const now = Date.now();
    await ctx.db.patch(intake._id, { propagation_status: args.status, propagation_error: args.error, propagation_updated_at: now, updated_at: now });
    await ctx.db.insert("audit_log", {
      table_name: "inventory_intakes", actor: "inventory-consumer-refresh", op: args.status, count: 1,
      source_file: "convex/inventory_onboarding.ts:setPropagationResult",
      note: `item=${args.item_id}; status=${args.status}; ${args.error ?? "all dependent refresh steps completed"}`, ts: now,
    });
    return { saved: true };
  },
});

export const refreshConsumers = internalAction({
  args: { item_id: v.id("items"), attempt: v.number() },
  handler: async (ctx: ActionCtx, { item_id, attempt }) => {
    const results: Array<{ name: string; ok: boolean; error?: string }> = [];
    for (const name of ["fast inventory widgets", "slow inventory widgets"] as const) {
      try {
        const result = name === "fast inventory widgets"
          ? await ctx.runAction(internal.mv.master.refreshFast, { force: true })
          : await ctx.runAction(internal.mv.master.refreshSlow, {});
        const steps = result && typeof result === "object" && "results" in result && Array.isArray(result.results)
          ? result.results as Array<{ name: string; ok: boolean; error?: string }>
          : [];
        const failed = steps.filter(step => !step.ok);
        results.push({ name, ok: failed.length === 0, error: failed.map(step => `${step.name}: ${step.error ?? "failed"}`).join("; ") || undefined });
      } catch (error) {
        results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const failed = results.filter(r => !r.ok);
    const status = failed.length ? "partial" as const : "complete" as const;
    const error = failed.map(r => `${r.name}: ${r.error ?? "refresh incomplete"}`).join("; ");
    await ctx.runMutation(internalOnboarding.inventory_onboarding.setPropagationResult, {
      item_id, attempt, status, error: error || undefined,
    });
    return { status, results };
  },
});

export const get = query({
  args: { item_id: v.id("items") },
  handler: async (ctx, { item_id }) => {
    await requireOwner(ctx, true);
    const [item, intake, listings] = await Promise.all([
      ctx.db.get(item_id),
      ctx.db.query("inventory_intakes").withIndex("by_item", q => q.eq("item_id", item_id)).unique(),
      ctx.db.query("listing_resolution_override").withIndex("by_stock_item", q => q.eq("stock_item_id", item_id)).collect(),
    ]);
    return { item, intake, listings };
  },
});

export const recent = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx, true);
    const rows = await ctx.db.query("inventory_intakes").withIndex("by_created_at").order("desc").take(30);
    const items = await Promise.all(rows.map(r => ctx.db.get(r.item_id)));
    return rows.map((r, i) => ({
      intake_id: r._id, item_id: r.item_id, name: r.item_name, ownership: r.ownership,
      physical_quantity: r.physical_quantity, insurance_status: r.insurance_status,
      propagation_status: r.propagation_status, availability_confirmed_at: r.availability_confirmed_at,
      target_account_slugs: r.target_account_slugs,
      form: {
        name: r.item_name, exact_model: r.exact_model, kind: items[i]?.kind ?? "",
        quantity: String(r.physical_quantity), ownership: r.ownership,
        serials: r.serials.join("\n"), missing_serial_reasons: r.missing_serial_reasons.join("\n"),
        specifications: r.specifications, compatibility_note: r.compatibility_note,
        included_accessories: r.included_accessories, lens_mount: items[i]?.lens_mount ?? "",
        owner_name: r.owner_name ?? "", acquisition_date: r.acquisition_date ?? "",
        purchase_price_gbp: r.purchase_price_gbp === undefined ? "" : String(r.purchase_price_gbp),
        purchase_value_basis: r.purchase_value_basis ?? "",
        replacement_value_gbp: r.replacement_value_gbp === undefined ? "" : String(r.replacement_value_gbp),
        replacement_value_basis: r.replacement_value_basis ?? "", vat_basis: r.vat_basis ?? "to_confirm",
        valuation_source: r.valuation_source ?? "", valuation_date: r.valuation_date ?? "",
        requested_cover_date: r.requested_cover_date ?? "",
      },
    }));
  },
});

export const accessoryChoices = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx, true);
    // The master inventory is the intentionally small, curated stock catalogue.
    return (await ctx.db.query("items").collect())
      .filter(i => i.status === "active" && !i.is_marketing_only && i.qty > 0)
      .map(i => ({ id: i._id, name: i.name_canonical, kind: i.kind }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
