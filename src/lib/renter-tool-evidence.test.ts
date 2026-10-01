import { describe, expect, it } from "vitest";
import { recommendationKitEvidence, renterToolReceipts, stockReceipts, successfulGrounding } from "./renter-tool-evidence";
import { normalizeClaimedFacts } from "../../convex/lib/renter_draft_evidence";

describe("untrusted claimed-fact diagnostics", () => {
  it("accepts missing call attribution without manufacturing proof or crashing Lab persistence", () => {
    expect(normalizeClaimedFacts([{ kind: "item_included", value: "Battery charger, cables", sourceTool: "preloaded_facts" }]))
      .toEqual([{ kind: "item_included", value: "Battery charger, cables", sourceTool: "preloaded_facts", sourceCallId: "", verified: false }]);
  });
  it("rejects malformed rows and overrides model-supplied verification", () => {
    expect(normalizeClaimedFacts({ kind: "item_included" })).toEqual([]);
    expect(normalizeClaimedFacts([null, { kind: 1, value: "Bad" }, { kind: "spec", value: 42 }])).toEqual([]);
    expect(normalizeClaimedFacts([{ kind: "spec", value: "Claim", verified: true, sourceCallId: 7 }]))
      .toEqual([{ kind: "spec", value: "Claim", sourceTool: "unattributed", sourceCallId: "", verified: false }]);
  });
});

const stock = { available: true, owned: true, item_name: "Sony FX3", start_date: "2026-10-02", end_date: "2026-10-04", requested_units: 1, free_units: 1, checked_at: 12345 };
describe("successful tool receipts", () => {
  it("carries authoritative alternative kits without accepting call arguments or marketing prose", () => {
    const a = { name: "BMPCC 6K Full Frame", listing_name: "Misleading SEO title", kit_source: "physical_mapping_and_inventory", kit_contents: ["NP-F570 batteries", "1TB CFexpress Type B"] };
    const argsOnly = renterToolReceipts([{ payload: { toolName: "find_owned_alternatives", args: { alternatives: [a] } } }]);
    expect(recommendationKitEvidence(argsOnly)).toEqual([]);
    const receipts = renterToolReceipts([{ payload: { toolName: "find_owned_alternatives", result: { alternatives: [a, { ...a, name: "Unknown kit", kit_source: "unknown", included: "SEO says charger" }] } } }]);
    expect(recommendationKitEvidence(receipts)).toEqual([{ names: ["BMPCC 6K Full Frame", "Blackmagic 6K Full Frame", "Blackmagic Pocket Cinema Camera 6K Full Frame", "Blackmagic Cinema Camera 6K Full Frame", "BMPCC 6K FF", "Blackmagic 6K FF", a.listing_name], contents: a.kit_contents }]);
  });
  it("never grounds a call that has no successful result", () => {
    const receipts = renterToolReceipts([{ toolCalls: [{ payload: { toolName: "check_availability", args: stock } }] }]);
    expect(successfulGrounding(receipts).availability).toBe(false);
  });
  it("reads real Mastra nested and older result shapes", () => {
    for (const steps of [[{ type: "tool-result", payload: { toolName: "check_availability", toolCallId: "one", result: stock } }], [{ toolResults: [{ toolName: "check_availability", toolCallId: "one", output: stock }] }]]) {
      expect(renterToolReceipts(steps)[0].call_id).toBe("one");
      expect(successfulGrounding(renterToolReceipts(steps)).availability).toBe(true);
    }
  });
  it("does not authorize positive claims from errors, unknowns or unowned stock", () => {
    for (const result of [{ ...stock, error: "timeout" }, { ...stock, available: null }, { ...stock, owned: false }, { ...stock, found: false }])
      expect(successfulGrounding(renterToolReceipts([{ payload: { toolName: "check_availability", result } }])).availability).toBe(false);
  });
  it("a negative verdict never authorizes a positive verdict", () => {
    const grounded = successfulGrounding(renterToolReceipts([{ payload: { toolName: "check_availability", result: { ...stock, available: false } } }]));
    expect(grounded).toMatchObject({ availability: false, unavailability: true });
  });
  it("knowledge and failed pricing searches are not stock or price evidence", () => {
    const receipts = renterToolReceipts([{ payload: { toolName: "search_knowledge", result: { price: 20 } } }, { payload: { toolName: "lookup_pricing", result: { found: false } } }]);
    expect(successfulGrounding(receipts)).toEqual({ availability: false, unavailability: false, price: false, specs: false });
  });
  it("keeps date-checked alternatives scoped to the checked option", () => {
    const receipts = renterToolReceipts([{ payload: { toolName: "find_owned_alternatives", toolCallId: "alternatives", result: { alternatives: [{ name: "Sony FX3", availability: { ...stock, quantity: 2 } }, { name: "Sony A7 III", availability: null }] } } }]);
    expect(successfulGrounding(receipts).availability).toBe(true);
    expect(receipts.filter((r) => r.tool === "check_availability")).toHaveLength(1);
    expect(receipts[1].result.requested_units).toBe(2);
  });
  it("keeps successful stock proof from a simulated order change", () => {
    const receipts = renterToolReceipts([{ payload: { toolName: "modify_booking", toolCallId: "change", result: { ok: true, stock_receipt: stock } } }]);
    expect(successfulGrounding(receipts).availability).toBe(true);
    expect(receipts[1].call_id).toBe("change:mutation-stock");
  });
  it("drops partial telemetry and duplicate receipt events before persistence", () => {
    const steps = [{ payload: { toolName: "check_availability", toolCallId: "one", result: stock } }, { payload: { toolName: "check_availability", toolCallId: "one", result: { ...stock } } }, { payload: { toolName: "check_availability", toolCallId: "one", result: { toolCallId: "one" } } }];
    expect(stockReceipts(renterToolReceipts(steps))).toHaveLength(1);
    expect(successfulGrounding(renterToolReceipts(steps)).availability).toBe(true);
  });
  it("retains independent stock receipts inside a whole-kit result", () => {
    const steps = [{ payload: { toolName: "check_availability", toolCallId: "kit", result: { ...stock, item_name: "Two camera kit", available: false, components: [{ ...stock, item_id: "camera", requested_units: 2, available: false }, { ...stock, item_name: "Sony GM 24-70", item_id: "lens", requested_units: 2 }] } } }];
    const receipts = stockReceipts(renterToolReceipts(steps));
    expect(receipts).toHaveLength(3);
    expect(receipts.map((r) => r.result.item_name)).toEqual(["Two camera kit", "Sony FX3", "Sony GM 24-70"]);
    expect(receipts[1].result.requested_units).toBe(2);
  });

});
