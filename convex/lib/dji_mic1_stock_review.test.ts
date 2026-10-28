import { describe, expect, it, vi } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { DJI_MIC1_OFFERS, DJI_MIC1_REVIEW_SOURCE, djiMic1StockReview } from "./dji_mic1_stock_review";
import { resolveListingComponents } from "./listing_components";
import { canonicalKitContents } from "./canonical_kit_contents";
import { reconcileDjiMic1Stock, runDjiMic1StockReview, convexRunArguments, convexDiagnosticArguments, parseConvexRunOutput } from "../../scripts/run-dji-mic1-stock-review.mjs";

function fixture() {
  const items = [
    { _id: "mic1", name_canonical: "DJI Wireless Mics", aliases: ["dji wireless mics"], kind: "audio", unit_kind: "set", status: "active", is_marketing_only: false, qty: 1, compatibility: { included_with_rental: ["2x transmitter", "1x receiver", "1x charging case"] } },
    { _id: "mic2", name_canonical: "DJI Mic 2 wireless", kind: "audio", unit_kind: "set", status: "active", is_marketing_only: false, qty: 1 },
    { _id: "boom", name_canonical: "Audio boom mic Sennheiser", kind: "audio", unit_kind: "set", status: "active", is_marketing_only: false, qty: 1 },
    { _id: "rode", name_canonical: "Rode Video Mic Go", kind: "audio", unit_kind: "unit", status: "active", is_marketing_only: false, qty: 1 },
  ] as unknown as Doc<"items">[];
  const products = [{ _id: "product", accountSlug: "dbcinema", productId: 852812, name: "Dji mic wireless + 2x lav mics 2x transmitters (like rode go 2)", masterItemId: "rode", isMarketingOnly: false }] as unknown as Doc<"hygglo_products">[];
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

function packingReviewFixture() {
  const { items, products, overrides } = fixture();
  const title = products[0].name!;
  items[0].aliases = ["dji wireless mics", "DJI Mic 1", "DJI Mic One", "DJI Mic 1st generation", "original DJI Mic"];
  items[0].listing_stock_rules = [{
    title_pattern: `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    source: DJI_MIC1_REVIEW_SOURCE,
    components: [{ item_id: "mic1" as Doc<"items">["_id"], qty: 1 }],
    excludes: [],
    packing_review_required: true,
  }];
  products[0].masterItemId = "mic1" as Doc<"items">["_id"];
  products[0].stockIdentityOverride = { itemId: "mic1" as Doc<"items">["_id"], title, source: DJI_MIC1_REVIEW_SOURCE };
  overrides[0].components = [{ item_id: "mic1" as Doc<"items">["_id"], qty: 1 }];
  return { items, products, overrides };
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
    expect(first.items[0].listing_stock_rules).toEqual([expect.objectContaining({
      source: DJI_MIC1_REVIEW_SOURCE,
      components: [{ item_id: "mic1", qty: 1 }],
      packing_review_required: false,
      description_override: "Contents: • 1x DJI Wireless Mics",
      supplied_parts: expect.arrayContaining([
        { name: "DJI Mic transmitters", qty: 2 },
        { name: "DJI Mic receiver", qty: 1 },
        { name: "DJI audio cable", qty: 1 },
        { name: "DJI Mic charging case", qty: 1 },
        { name: "DJI Mic carrying case", qty: 1 },
        { name: "DJI Lavalier microphones", qty: 2 },
      ]),
    })]);
    const replay = djiMic1StockReview(first.items, first.products, first.overrides);
    expect(replay).toEqual({ items: [], products: [], mappingChanges: [], inserts: [] });
  });

  it("reconciles the exact owner-listed parts while holding only one physical Mic 1 set", () => {
    const first = applyFixture();
    const resolved = resolveListingComponents(
      first.items,
      [{ item_id: "mic1", qty: 1 }],
      "mic1",
      1,
      "Dji mic wireless + 2x lav mics 2x transmitters",
      undefined,
      first.products[0].name,
    );
    expect(resolved.complete).toBe(true);
    expect(resolved.owned).toBe(true);
    expect(resolved.components).toHaveLength(1);
    expect(resolved.components[0]).toMatchObject({ item_id: "mic1", units_per_listing: 1, owned: true });
    const contents = canonicalKitContents(resolved.components, first.items);
    expect(contents.unreconciled_contents).toEqual([]);
    expect(contents.contents).toEqual(expect.arrayContaining([
      "2x DJI Mic transmitters",
      "1x DJI Mic receiver",
      "1x DJI audio cable",
      "1x DJI Mic charging case",
      "1x DJI Mic carrying case",
      "2x DJI Lavalier microphones",
    ]));
  });

  it("repairs the live post-identity state by clearing only the exact packing-review rule", () => {
    const current = packingReviewFixture();
    const plan = djiMic1StockReview(current.items, current.products, current.overrides);
    expect(plan.items).toHaveLength(1);
    expect(plan.products).toHaveLength(0);
    expect(plan.mappingChanges).toHaveLength(0);
    expect(plan.inserts).toHaveLength(0);
    expect(plan.items[0].patch).not.toHaveProperty("qty");
    expect(plan.items[0].patch.listing_stock_rules).toEqual([expect.objectContaining({ packing_review_required: false })]);
  });

  it("refuses a generation-specific title or a changed owner mapping", () => {
    const wrongGeneration = fixture();
    wrongGeneration.products[0].name = "DJI Mic 2 Wireless Kit";
    expect(() => djiMic1StockReview(wrongGeneration.items, wrongGeneration.products, wrongGeneration.overrides)).toThrow(/identity/i);
    const changedMapping = fixture();
    changedMapping.overrides[0].components = [{ item_id: "unexpected" as Doc<"items">["_id"], qty: 2 }];
    expect(() => djiMic1StockReview(changedMapping.items, changedMapping.products, changedMapping.overrides)).toThrow(/allocation changed/i);
    const unknownMaster = fixture();
    unknownMaster.products[0].masterItemId = "unexpected" as Doc<"items">["_id"];
    expect(() => djiMic1StockReview(unknownMaster.items, unknownMaster.products, unknownMaster.overrides)).toThrow(/master changed/i);
  });

  it("uses the supported Convex CLI against only the fixed mutation", async () => {
    const summary = { dryRun: true, reviewedOffers: 1, itemWrites: 1, productWrites: 0, mappingWrites: 0, ownedQuantityChanged: false, rentalChanges: 0, messagesSent: 0, packingReviewRequired: false };
    const execute = vi.fn().mockResolvedValue(summary);
    const result = await runDjiMic1StockReview({ dryRun: true, key: "fixture-secret", execute });
    expect(result.itemWrites).toBe(1);
    expect(execute).toHaveBeenCalledWith({ dryRun: true, key: "fixture-secret" });
    expect(convexRunArguments(true)).toEqual(["run", "seed/dji_mic1_stock_review:apply", "{\"dryRun\":true}", "--typecheck", "disable", "--codegen", "disable"]);
    expect(convexRunArguments(false)).not.toContain("--push");
    expect(convexDiagnosticArguments().slice(0, 2)).toEqual(["run", "--inline-query"]);
    expect(parseConvexRunOutput(`Running mutation\n${JSON.stringify(summary)}`)).toEqual(summary);
  });

  it("reports unexpected live identity read-only and never applies through a blocked preflight", async () => {
    const diagnostic = { productFound: true, productMaster: { name: "unexpected master", quantity: 1 }, mappings: [] };
    const execute = vi.fn().mockRejectedValue(new Error("Reviewed DJI Mic 1 offer master changed: dbcinema#852812"));
    const diagnose = vi.fn().mockResolvedValue(diagnostic);
    const run = (args: { dryRun?: boolean } = {}) => runDjiMic1StockReview({ ...args, key: "fixture-secret", execute, diagnose });
    const result = await reconcileDjiMic1Stock({ apply: true, verifyIdentity: vi.fn(), run });
    expect(result).toEqual({ mode: "blocked", diagnostic });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(diagnose).toHaveBeenCalledWith({ key: "fixture-secret" });
  });

  it("applies only the exact reviewed write plan and verifies a clean second dry-run", async () => {
    const plan = (dryRun: boolean, writes: [number, number, number]) => ({ dryRun, reviewedOffers: 1, itemWrites: writes[0], productWrites: writes[1], mappingWrites: writes[2], ownedQuantityChanged: false, rentalChanges: 0, messagesSent: 0, packingReviewRequired: false });
    const run = vi.fn().mockResolvedValueOnce(plan(true, [1, 0, 0])).mockResolvedValueOnce(plan(false, [1, 0, 0])).mockResolvedValueOnce(plan(true, [0, 0, 0]));
    const result = await reconcileDjiMic1Stock({ apply: true, verifyIdentity: vi.fn(), run });
    expect(result.mode).toBe("applied-and-verified");
    expect(run.mock.calls.map(([args]) => args.dryRun)).toEqual([true, false, true]);
  });

  it("still permits the exact combined stock-link repair when the packing review is not yet applied", async () => {
    const plan = (dryRun: boolean, writes: [number, number, number]) => ({ dryRun, reviewedOffers: 1, itemWrites: writes[0], productWrites: writes[1], mappingWrites: writes[2], ownedQuantityChanged: false, rentalChanges: 0, messagesSent: 0, packingReviewRequired: false });
    const run = vi.fn().mockResolvedValueOnce(plan(true, [1, 1, 1])).mockResolvedValueOnce(plan(false, [1, 1, 1])).mockResolvedValueOnce(plan(true, [0, 0, 0]));
    const result = await reconcileDjiMic1Stock({ apply: true, verifyIdentity: vi.fn(), run });
    expect(result.mode).toBe("applied-and-verified");
    expect(run.mock.calls.map(([args]) => args.dryRun)).toEqual([true, false, true]);
  });

  it("recognizes an already-correct mapping without writing and rejects unexpected plans", async () => {
    const clean = { dryRun: true, reviewedOffers: 1, itemWrites: 0, productWrites: 0, mappingWrites: 0, ownedQuantityChanged: false, rentalChanges: 0, messagesSent: 0, packingReviewRequired: false };
    const alreadyApplied = vi.fn().mockResolvedValue(clean);
    const result = await reconcileDjiMic1Stock({ apply: true, verifyIdentity: vi.fn(), run: alreadyApplied });
    expect(result.mode).toBe("already-in-sync");
    expect(alreadyApplied).toHaveBeenCalledTimes(1);

    const unexpected = vi.fn().mockResolvedValue({ ...clean, itemWrites: 2 });
    await expect(reconcileDjiMic1Stock({ apply: true, verifyIdentity: vi.fn(), run: unexpected })).rejects.toThrow("Dry-run did not match either reviewed DJI Mic 1 repair plan.");
    expect(unexpected).toHaveBeenCalledTimes(1);
  });
});
