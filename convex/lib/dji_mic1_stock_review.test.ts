import { describe, expect, it } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { DJI_MIC1_OFFERS, djiMic1StockReview } from "./dji_mic1_stock_review";

function fixture() {
  const items = [
    { _id: "mic1", name_canonical: "DJI Wireless Mics", aliases: ["dji wireless mics"], kind: "audio", unit_kind: "set", status: "active", is_marketing_only: false, qty: 1, compatibility: { included_with_rental: ["2x transmitter", "1x receiver", "1x charging case"] } },
    { _id: "mic2", name_canonical: "DJI Mic 2 wireless", kind: "audio", unit_kind: "set", status: "active", is_marketing_only: false, qty: 1 },
    { _id: "boom", name_canonical: "Audio boom mic Sennheiser", kind: "audio", unit_kind: "set", status: "active", is_marketing_only: false, qty: 1 },
  ] as unknown as Doc<"items">[];
  const products = [{ _id: "product", accountSlug: "dbcinema", productId: 852812, name: "Dji mic wireless + 2x lav mics 2x transmitters (like rode go 2)", masterItemId: "boom", isMarketingOnly: false }] as unknown as Doc<"hygglo_products">[];
  const overrides = [{ _id: "mapping", account_slug: "dbcinema", product_id: 852812, source: "manual_audit", components: [{ item_id: "mic2", qty: 1 }] }] as unknown as Doc<"listing_resolution_override">[];
  return { items, products, overrides };
}

function applyFixture() {
  const { items, products, overrides } = fixture();
  const plan = djiMic1StockReview(items, products, overrides);
  for (const row of plan.items) Object.assign(items.find(item => item._id === row.id)!, row.patch);
  for (const row of plan.products) Object.assign(products.find(product => product._id === row.id)!, row.patch);
  for (const row of plan.mappingChanges) Object.assign(overrides.find(mapping => mapping._id === row.id)!, row.patch);
  for (const row of plan.inserts) overrides.push(row as Doc<"listing_resolution_override">);
  return { items, products, overrides, plan };
}

describe("owner-confirmed DJI Mic 1 stock review", () => {
  it("moves the listing from the Mic 2 pool to the separate Mic 1 set and is idempotent", () => {
    expect(DJI_MIC1_OFFERS).toEqual([["dbcinema", 852812]]);
    const first = applyFixture();
    expect(first.plan.mappingChanges).toHaveLength(1);
    expect(first.plan.inserts).toHaveLength(0);
    expect(first.overrides[0].components).toEqual([{ item_id: "mic1", qty: 1 }]);
    expect(first.products[0].masterItemId).toBe("mic1");
    expect(first.items[0].qty).toBe(1);
    expect(first.items[0].aliases).toEqual(expect.arrayContaining(["DJI Mic 1", "DJI Mic One"]));
    expect(first.plan.items[0].patch).not.toHaveProperty("qty");
    const replay = djiMic1StockReview(first.items, first.products, first.overrides);
    expect(replay).toEqual({ items: [], products: [], mappingChanges: [], inserts: [] });
  });

  it("refuses a generation-specific title or a changed owner mapping", () => {
    const wrongGeneration = fixture();
    wrongGeneration.products[0].name = "DJI Mic 2 Wireless Kit";
    expect(() => djiMic1StockReview(wrongGeneration.items, wrongGeneration.products, wrongGeneration.overrides)).toThrow(/identity/i);
    const changedMapping = fixture();
    changedMapping.overrides[0].components = [{ item_id: "unexpected" as Doc<"items">["_id"], qty: 2 }];
    expect(() => djiMic1StockReview(changedMapping.items, changedMapping.products, changedMapping.overrides)).toThrow(/allocation changed/i);
  });
});
