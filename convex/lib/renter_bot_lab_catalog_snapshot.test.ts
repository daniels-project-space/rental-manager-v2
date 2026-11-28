import { describe, expect, it, vi } from "vitest";
import { buildLabCatalogSnapshot, fetchLabCatalogSnapshot, preparedLabItemPatch } from "./renter_bot_lab_catalog_snapshot";

const now = 1_800_000_000_000;
const item = { _id: "physical-fx3", name: "Sony FX3", rental_name: "Sony FX3", display_name: "Sony FX3",
  aliases: ["FX3"], qty: 2, status: "active", is_marketing_only: false };
const product = (accountSlug: string, productId: number, patch: Record<string, unknown> = {}) => ({
  accountSlug, productId, name: `${accountSlug} camera listing`, description: "Verified current listing contents",
  descriptionSyncedAt: now - 1000, publicUrl: "https://hygglo.com/uk/i/test-listing", isPublished: true,
  isMarketingOnly: false, lastSyncedAt: now - 1000, masterItemId: "physical-fx3",
  prices: [{ days: 1, pricePerDay: 20 }, { days: 3, pricePerDay: 15 }], ...patch,
});
const override = (account_slug: string, product_id: number, item_id = "physical-fx3", qty = 1) => ({
  account_slug, product_id, components: [{ item_id, qty }],
});
const website = (productId: number, patch: Record<string, unknown> = {}) => ({
  slug: `verified-listing-${productId}`, bookable: true, marketingOnly: false, displayOnly: false,
  inventoryFacts: { owned: true, reviewRequired: false }, ...patch,
});

function snapshot(patch: Record<string, unknown> = {}) {
  return buildLabCatalogSnapshot({
    inventory: [item],
    inventoryDetails: [{ item_id: item._id, kind: "camera", aliases: ["Cinema Line FX3"], replacement_cost_gbp: 3300 }],
    overrides: [override("dbcinema", 110010), override("dbcinema", 110011), override("dbcinema", 110012),
      override("leo", 120020), override("diogo", 117030)],
    productsByAccount: {
      leo: [product("leo", 120020, { isMarketingOnly: true, isMarketingOnlyOverride: false, masterItemId: "wrong-fuzzy-match" })],
      diogo: [product("diogo", 117030, { isMarketingOnly: true })],
      dbcinema: [product("dbcinema", 110010, { isMarketingOnly: true, masterItemId: "wrong-fuzzy-match" }),
        product("dbcinema", 110011), product("dbcinema", 110012)],
    },
    dbCinemaWebsiteListings: [website(110010), website(110011, { bookable: false }), website(110012, { bookable: false })],
    now,
    ...patch,
  } as Parameters<typeof buildLabCatalogSnapshot>[0]);
}

describe("isolated Lab source catalog snapshot", () => {
  it("fetches only current inventory, listing maps, listings, and DB Cinema bookability", async () => {
    const calls: Array<{ url: string; path: string; args: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { path: string; args: Record<string, unknown> };
      calls.push({ url: String(url), ...request });
      const values: Record<string, unknown> = {
        "items:listForReconcile": [item],
        "listing_info_pool:admin_getDerivationBatch": { inventory: [{ item_id: item._id, kind: "camera",
          aliases: ["FX3"], included_with_rental: ["3 NP-FZ100 batteries"], replacement_cost_gbp: 3300 }] },
        "listing_overrides:getAll": [override("leo", 120021), override("diogo", 117031), override("dbcinema", 110013)],
        "hygglo_products:list:leo": [product("leo", 120021)],
        "hygglo_products:list:diogo": [product("diogo", 117031)],
        "hygglo_products:list:dbcinema": [product("dbcinema", 110013)],
        "catalog:listListings": [website(110013)],
      };
      const key = request.path === "hygglo_products:list" ? `${request.path}:${request.args.accountSlug}` : request.path;
      return new Response(JSON.stringify({ status: "success", value: values[key] }));
    });
    const result = await fetchLabCatalogSnapshot(fetcher as typeof fetch, now);
    expect(calls).toHaveLength(7);
    expect(calls.some(call => /reservations|renters|conversation|message/i.test(call.path))).toBe(false);
    expect(calls.find(call => call.path === "listing_info_pool:admin_getDerivationBatch")?.args).toEqual({ force: true, targets: [] });
    expect(result.items[0]).toMatchObject({ source_id: item._id, included_with_rental: ["3 NP-FZ100 batteries"] });
    expect(result.eligible_listings).toBe(3);
    expect(result.source_receipts.map(receipt => receipt.row_count)).toEqual([1, 3, 1, 1, 1, 1, 5]);
  });

  it("uses owner-confirmed shared camera contents when imported item descriptions conflict", () => {
    const confirmed = [
      ["kn737xq0jcc8a011f6x2m6srt986az25", "BMPCC 6K Pro", ["5× NP-F570 batteries", "1× 2TB SSD", "1× camera cage", "1× hard carrying case"]],
      ["kn7bw2cr1ye5hqj3x770b332ks86atzw", "Sony FX3", ["3× Sony NP-FZ100 batteries", "1× 320GB CFexpress Type A card", "Sony dual battery charger"]],
      ["kn74p93r60ndmmb0qghjqg84yh86abvh", "Sony A7 III", ["3× Sony NP-FZ100 batteries", "2× 128GB SD cards", "Sony dual battery charger"]],
      ["kn71951h7f9z8p3cea06v6zjjx86bgn4", "Sony A7 V", ["3× Sony NP-FZ100 batteries", "1× 256GB SDXC V90 card", "Sony dual battery charger"]],
      ["kn71src7p25m5ppzkxnjwadm1s86azfk", "Sony A7 II", ["2× 128GB SD cards", "Sony dual battery charger"]],
    ] as const;
    const result = buildLabCatalogSnapshot({
      inventory: confirmed.map(([id, name]) => ({ _id: id, name, display_name: name, qty: 1, status: "active", is_marketing_only: false })),
      inventoryDetails: confirmed.map(([id]) => ({ item_id: id, kind: "camera", included_with_rental: ["stale kit contents"] })),
      overrides: [], productsByAccount: { leo: [], diogo: [], dbcinema: [] }, dbCinemaWebsiteListings: [], now,
    });
    for (const [id, name, contents] of confirmed) {
      expect(result.items.find((entry) => entry.source_id === id)).toMatchObject({
        name, included_with_rental: contents, contents_source: "owner-confirmed kit contents",
      });
    }
    expect(result.source_receipts.at(-1)).toMatchObject({ source: "owner-confirmed kit contents", row_count: 5 });
  });

  it("carries owner-confirmed capacity onto the same physical CFexpress stock row", () => {
    const cardId = "kn78qeqezcrpjr12gzmynyfgb986b1rn";
    const result = buildLabCatalogSnapshot({
      inventory: [{ _id: cardId, name: "CF Express Type A card", display_name: "CF Express Type A card",
        aliases: [], qty: 4, status: "active", is_marketing_only: false }],
      inventoryDetails: [{ item_id: cardId, kind: "storage_card" }],
      overrides: [], productsByAccount: { leo: [], diogo: [], dbcinema: [] },
      dbCinemaWebsiteListings: [], now,
    });
    expect(result.items[0]).toMatchObject({ source_id: cardId, name: "CF Express Type A card", qty: 4,
      rental_facts: { name: "320GB CFexpress Type A card", source: "owner-confirmed physical stock detail" } });
  });

  it("keeps source-synced physical identity and quantity when a scenario adds kit facts", () => {
    const existing = { lab_source_inventory_id: "physical-fx3", name_canonical: "Sony FX3", qty: 2,
      kind: "camera", unit_kind: "kit", status: "active", is_marketing_only: false,
      supplied_stock: [{ item_id: "existing-battery-pool", qty: 3, source: "owner source" }] };
    const patch = preparedLabItemPatch(existing, { name_canonical: "Sony FX3 Full-Frame Camera Kit", qty: 1,
      kind: "camera", is_marketing_only: false, lab_source_inventory_id: "different-physical-item" },
      [{ item_id: "scenario-battery-pool", qty: 3, source: "scenario" }], now);
    expect(patch).toEqual({ updated_at: now });
    expect(patch).not.toHaveProperty("name_canonical");
    expect(patch).not.toHaveProperty("qty");
    expect(patch).not.toHaveProperty("supplied_stock");
    const missingPool = preparedLabItemPatch({ lab_source_inventory_id: "physical-fx3", name_canonical: "Sony FX3", qty: 2 },
      { name_canonical: "Sony FX3 Full-Frame Camera Kit", qty: 1 },
      [{ item_id: "confirmed-battery-pool", qty: 3, source: "owner-confirmed" }], now);
    expect(missingPool).toEqual({ supplied_stock: [{ item_id: "confirmed-battery-pool", qty: 3, source: "owner-confirmed" }], updated_at: now });
    const missingIdentity = preparedLabItemPatch({ name_canonical: "Sony FX3", qty: 4 },
      { name_canonical: "Sony FX3", qty: 4, lab_source_inventory_id: "verified-physical-fx3" }, undefined, now);
    expect(missingIdentity).toMatchObject({ lab_source_inventory_id: "verified-physical-fx3", updated_at: now });
  });

  it("uses exact overrides for stock identity and the DB Cinema website for bookability", () => {
    const result = snapshot();
    const listing = (account: string, id: number) => result.listings.find((x) => x.account_slug === account && x.product_id === id)!;
    expect(result.eligible_listings).toBe(2);
    expect(listing("dbcinema", 110010)).toMatchObject({ is_marketing_only: false,
      components: [{ source_item_id: "physical-fx3", qty: 1 }],
      source_receipt: { product_master_item_id: "wrong-fuzzy-match", website_bookable: true, override_present: true } });
    expect(listing("dbcinema", 110011)).toMatchObject({ is_marketing_only: true, unavailable_reason: "website_not_bookable" });
    expect(listing("leo", 120020)).toMatchObject({ is_marketing_only: false,
      components: [{ source_item_id: "physical-fx3", qty: 1 }] });
    expect(listing("diogo", 117030)).toMatchObject({ is_marketing_only: true, unavailable_reason: "owner_marked_unavailable" });
  });

  it("admits only the two owner-confirmed FX3 prepared listings without a broad fuzzy-link fallback", () => {
    const fx3Id = "kn7bw2cr1ye5hqj3x770b332ks86atzw";
    const fx3 = { ...item, _id: fx3Id, name: "Sony FX3", rental_name: "Sony FX3", display_name: "Sony FX3", qty: 4 };
    const fx3Product = (accountSlug: string, productId: number) => product(accountSlug, productId, {
      name: "Sony FX3 Camera FX 3 4K Camera FX3 Full Frame",
      masterItemId: fx3Id,
    });
    const result = buildLabCatalogSnapshot({
      inventory: [fx3], inventoryDetails: [{ item_id: fx3Id, kind: "camera", aliases: ["FX3"], included_with_rental: [] }],
      overrides: [],
      productsByAccount: { leo: [fx3Product("leo", 1097510)], diogo: [fx3Product("diogo", 1173763), fx3Product("diogo", 1173764)], dbcinema: [] },
      dbCinemaWebsiteListings: [], now,
    });
    const listing = (account: string, id: number) => result.listings.find(row => row.account_slug === account && row.product_id === id)!;
    expect(result.eligible_listings).toBe(2);
    expect(listing("leo", 1097510)).toMatchObject({ is_marketing_only: false,
      components: [{ source_item_id: fx3Id, qty: 1 }], source_receipt: {
        override_present: true, mapping_source: "owner-confirmed prepared Lab Sony FX3 mapping",
      } });
    expect(listing("diogo", 1173763).is_marketing_only).toBe(false);
    expect(listing("diogo", 1173764)).toMatchObject({ is_marketing_only: true, unavailable_reason: "exact_stock_mapping_missing" });
  });

  it("blocks products with no exact override, insufficient stock, or stale descriptions", () => {
    const result = buildLabCatalogSnapshot({
      inventory: [item], inventoryDetails: [],
      overrides: [override("dbcinema", 130010, item._id, 3), override("dbcinema", 130013)],
      productsByAccount: { leo: [], diogo: [], dbcinema: [product("dbcinema", 130010),
        product("dbcinema", 130012), product("dbcinema", 130013, { descriptionSyncedAt: now - 49 * 60 * 60 * 1000 })] },
      dbCinemaWebsiteListings: [website(130010), website(130012), website(130013)], now,
    });
    expect(result.listings.find((x) => x.product_id === 130010)).toMatchObject({
      is_marketing_only: true, unavailable_reason: "mapped_stock_not_available",
    });
    expect(result.listings.find((x) => x.product_id === 130012)).toMatchObject({
      is_marketing_only: true, unavailable_reason: "exact_stock_mapping_missing",
    });
    expect(result.listings.find((x) => x.product_id === 130013)).toMatchObject({
      is_marketing_only: true, unavailable_reason: "listing_details_stale_or_missing",
    });
  });

  it("rejects duplicate inventory identities and duplicate account listing overrides", () => {
    expect(() => buildLabCatalogSnapshot({
      inventory: [item, item], inventoryDetails: [], overrides: [],
      productsByAccount: { leo: [], diogo: [], dbcinema: [] }, dbCinemaWebsiteListings: [], now,
    })).toThrow(/ambiguous/);
    expect(() => buildLabCatalogSnapshot({
      inventory: [item], inventoryDetails: [], overrides: [override("leo", 20), override("leo", 20)],
      productsByAccount: { leo: [], diogo: [], dbcinema: [] }, dbCinemaWebsiteListings: [], now,
    })).toThrow(/Duplicate exact listing override/);
  });
});
