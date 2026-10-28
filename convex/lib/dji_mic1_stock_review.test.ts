import { describe, expect, it, vi } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { DJI_MIC1_OFFERS, djiMic1StockReview } from "./dji_mic1_stock_review";
import { reconcileDjiMic1Stock, runDjiMic1StockReview, convexRunArguments, convexDiagnosticArguments, parseConvexRunOutput } from "../../scripts/run-dji-mic1-stock-review.mjs";

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

  it("uses the supported Convex CLI against only the fixed mutation", async () => {
    const summary = { dryRun: true, reviewedOffers: 1, itemWrites: 1, productWrites: 1, mappingWrites: 1, ownedQuantityChanged: false, rentalChanges: 0, messagesSent: 0, packingReviewRequired: true };
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
    const plan = (writes: number) => ({ reviewedOffers: 1, itemWrites: writes, productWrites: writes, mappingWrites: writes, ownedQuantityChanged: false, rentalChanges: 0, messagesSent: 0, packingReviewRequired: true });
    const run = vi.fn().mockResolvedValueOnce(plan(1)).mockResolvedValueOnce(plan(1)).mockResolvedValueOnce(plan(0));
    const result = await reconcileDjiMic1Stock({ apply: true, verifyIdentity: vi.fn(), run });
    expect(result.mode).toBe("applied-and-verified");
    expect(run.mock.calls.map(([args]) => args.dryRun)).toEqual([true, false, true]);
  });

  it("recognizes an already-correct mapping without writing and rejects unexpected plans", async () => {
    const clean = { reviewedOffers: 1, itemWrites: 0, productWrites: 0, mappingWrites: 0, ownedQuantityChanged: false, rentalChanges: 0, messagesSent: 0, packingReviewRequired: true };
    const alreadyApplied = vi.fn().mockResolvedValue(clean);
    const result = await reconcileDjiMic1Stock({ apply: true, verifyIdentity: vi.fn(), run: alreadyApplied });
    expect(result.mode).toBe("already-in-sync");
    expect(alreadyApplied).toHaveBeenCalledTimes(1);

    const unexpected = vi.fn().mockResolvedValue({ ...clean, itemWrites: 2 });
    await expect(reconcileDjiMic1Stock({ apply: true, verifyIdentity: vi.fn(), run: unexpected })).rejects.toThrow("itemWrites");
    expect(unexpected).toHaveBeenCalledTimes(1);
  });
});
