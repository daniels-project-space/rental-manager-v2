import { describe, expect, it } from "vitest";
import { unsupportedStockClaims, type StockReceipt, type StockRequest } from "./stock_claims";
import { guardDraft } from "./draft_guard";
const request: StockRequest = { start_date: "2026-10-02", end_date: "2026-10-04", items: [{ name: "Sony FX3", quantity: 1 }] };
const stock: StockReceipt = { item: "Sony FX3", start_date: "2026-10-02", end_date: "2026-10-04", quantity: 1, available: false, free_units: 0, checked_at: 1790850651000, call_id: "fx3-stock" };
const check = (text: string, receipts = [stock], scope = request) => unsupportedStockClaims(text, receipts, scope);
describe("scoped stock claims", () => {
  it("blocks unrelated negatives even if a different item has a real negative receipt", () => {
    expect(check("The Pyxis isn't available for those dates.")).toHaveLength(1);
    const guarded = guardDraft("The Pyxis isn't available for those dates.", { history: [], lastRenterMessage: "Do you have a Pyxis?", hasItemGrounding: true,
      groundedDuringTurn: { availability: true, unavailability: true }, stockEvidence: [stock], stockRequest: request });
    expect(guarded.flags).toContainEqual(expect.objectContaining({ type: "UNGROUNDED_UNAVAILABILITY", severity: "critical" }));
  });
  it("accepts the exact checked subject, preserved camera shorthand and request pronoun", () => {
    for (const text of ["The Sony FX3 isn't available for those dates.", "The FX3 is unavailable.", "It isn't available for your dates.", "That exact kit isn't available for your dates.", "That requested camera isn't available."]) expect(check(text)).toEqual([]);
  });
  it("rejects wrong date spans for either sign", () => {
    for (const available of [false, true]) {
      const text = available ? "The FX3 is available for your dates." : "The FX3 isn't available for your dates.";
      expect(check(text, [{ ...stock, available, start_date: "2026-10-05" }])).toHaveLength(1);
    }
    expect(check("The FX3 is unavailable for 2026-10-05 to 2026-10-07.")).toHaveLength(1);
  });
  it("does not license two units with a one-unit boolean verdict", () => {
    const scope = { ...request, items: [{ name: "Sony FX3", quantity: 2 }] };
    expect(check("The FX3 is available for your dates.", [{ ...stock, available: true }], scope)).toHaveLength(1);
    expect(check("Two FX3 cameras are available.", [{ ...stock, available: true, free_units: null }], scope)).toHaveLength(1);
  });
  it("allows an explicit smaller offer only when receipt capacity proves it", () => {
    expect(check("One FX3 is available.", [{ ...stock, quantity: 2, available: false, free_units: 1 }])).toEqual([]);
    expect(check("Two FX3 cameras are available.", [{ ...stock, quantity: 2, available: false, free_units: 1 }])).toHaveLength(1);
  });
  it("keeps unknown verdicts and missing receipts unverified", () => {
    expect(check("The FX3 is unavailable.", [{ ...stock, available: null }])).toHaveLength(1);
    expect(check("The FX3 is available.", [])).toHaveLength(1);
  });
  it("does not confuse nearby camera variants or lens manufacturers", () => {
    expect(check("The FX30 is unavailable.")).toHaveLength(1);
    expect(check("The A7 II is unavailable.", [{ ...stock, item: "Sony A7 III" }])).toHaveLength(1);
    expect(check("The Sony 24-70mm is unavailable.", [{ ...stock, item: "Canon 24-70mm" }])).toHaveLength(1);
  });
  it("preserves conditional planning and capability or pickup statements", () => {
    for (const text of ["If the FX3 is unavailable, I can suggest a camera.", "I'll check whether the FX3 is unavailable.", "4K isn't available on the A7 II.", "That pickup slot isn't available."]) expect(check(text, [])).toEqual([]);
    expect(check("If the Sony is unavailable, the Pyxis is unavailable for your dates.")).toHaveLength(1);
  });
  it("checks each local item rather than letting another clause excuse it", () => {
    const scope = { ...request, items: [...request.items, { name: "Sony A7 V", quantity: 1 }] };
    const receipts = [stock, { ...stock, item: "Sony A7 V", available: true }];
    expect(check("The FX3 isn't available, but the A7 V is available.", receipts, scope)).toEqual([]);
    expect(check("The FX3 is available, but the A7 V isn't available.", receipts, scope)).toHaveLength(2);
    expect(check("They're available for your dates.", receipts, scope)).toHaveLength(1);
  });
  it("requires every mapped kit component for a positive, and a real failed component for a negative", () => {
    const scope: StockRequest = { ...request, items: [{ name: "Sony FX3", quantity: 1, complete: true,
      components: [{ name: "Sony FX3", quantity: 1 }, { name: "Sony GM 24-70", quantity: 1 }] }] };
    const receipts = [{ ...stock, available: true }, { ...stock, item: "Sony GM 24-70", available: false }];
    expect(check("The kit is available for your dates.", receipts, scope)).toHaveLength(1);
    expect(check("The kit isn't available for your dates.", receipts, scope)).toEqual([]);
    expect(check("The FX3 kit isn't available for your dates.", receipts, scope)).toEqual([]);
    expect(check("The FX3 isn't available for your dates.", receipts, scope)).toHaveLength(1);
    expect(check("The kit is available for your dates.", receipts.map(r => ({ ...r, available: true })), scope)).toEqual([]);
    expect(check("The kit is available for your dates.", receipts.slice(0, 1), scope)).toHaveLength(1);
  });
  it("resolves exact body references without borrowing failed kit-component verdicts", () => {
    const scope: StockRequest = { ...request, items: [{ name: "Sony FX3", quantity: 1, complete: true, aliases: ["FX3 rental kit"],
      components: [{ name: "Sony FX3", quantity: 1 }, { name: "Sony GM 24-70", quantity: 1 }] }] };
    expect(check("That exact body isn't available.", [stock], scope)).toEqual([]);
    expect(check("That exact body isn't available.", [{ ...stock, available: true }, { ...stock, item: "Sony GM 24-70" }, { ...stock, item: "FX3 rental kit" }], scope)).toHaveLength(1);
    expect(check("That exact body is available.", [{ ...stock, available: true }, { ...stock, item: "Sony GM 24-70" }], scope)).toEqual([]);
    expect(check("That exact body isn't available.", [{ ...stock, start_date: "2026-10-05" }], scope)).toHaveLength(1);
  });
  it("does not confirm an incompletely mapped kit", () => {
    expect(check("The kit is available.", [{ ...stock, available: true }], { ...request, items: [{ ...request.items[0], complete: false }] })).toHaveLength(1);
  });

  it("does not silently reduce the requested quantity when naming an alternative", () => {
    const scope = { ...request, items: [{ name: "Sony FX3", quantity: 2 }] };
    const receipt = { ...stock, item: "Sony A7 V", available: true, quantity: 1 };
    expect(check("The A7 V is available.", [receipt], scope)).toHaveLength(1);
    expect(check("One A7 V is available.", [receipt], scope)).toEqual([]);
  });
  it("uses reviewed display aliases while retaining lens manufacturer identity", () => {
    expect(check("The Sony 24-70 GM is unavailable.", [{ ...stock, item: "Sony GM 24-70" }])).toEqual([]);
    expect(check("The Canon 24-70 GM is unavailable.", [{ ...stock, item: "Sony GM 24-70" }])).toHaveLength(1);
  });

});
