import { describe, expect, it } from "vitest";
import { unsupportedStockClaims, type StockReceipt, type StockRequest } from "./stock_claims";
import { guardDraft } from "./draft_guard";
const request: StockRequest = { start_date: "2026-10-02", end_date: "2026-10-04", items: [{ name: "Sony FX3", quantity: 1 }] };
const stock: StockReceipt = { item: "Sony FX3", start_date: "2026-10-02", end_date: "2026-10-04", quantity: 1, available: false, free_units: 0, checked_at: 1790850651000, call_id: "fx3-stock" };
const check = (text: string, receipts = [stock], scope = request) => unsupportedStockClaims(text, receipts, scope);
describe("amendment date claims", () => {
  const original = { start_date: "2026-10-06", end_date: "2026-10-07", items: [{ name: "Sony FX3", quantity: 1 }] };
  const proposed = { ...stock, start_date: "2026-10-06", end_date: "2026-10-08" };
  it("uses the explicitly stated proposed span rather than the unchanged original booking", () => {
    expect(unsupportedStockClaims("The Sony FX3 isn't available for 6 to 8 October.", [proposed], original)).toEqual([]);
  });
  it("requires a point-date check before calling one particular extra day booked", () => {
    const text = "The Sony FX3 is fully booked on 8 October.";
    expect(unsupportedStockClaims(text, [proposed], original)).toHaveLength(1);
    expect(unsupportedStockClaims(text, [{ ...proposed, start_date: "2026-10-08" }], original)).toEqual([]);
  });
  it("keeps years and neighbouring days distinct", () => {
    expect(unsupportedStockClaims("The FX3 isn't available for 6 to 8 October 2025.", [proposed], original)).toHaveLength(1);
    expect(unsupportedStockClaims("The FX3 is booked on 9 October.", [{ ...proposed, start_date: "2026-10-08" }], original)).toHaveLength(1);
  });
});
describe("catalogue rental eligibility is distinct from calendar stock", () => {
  const scope: StockRequest = { start_date: "2026-10-06", end_date: "2026-10-07", items: [{ name: "Sony FX6", quantity: 1 }] };
  const alternative: StockReceipt = { ...stock, item: "Sony FX3", start_date: scope.start_date!, end_date: scope.end_date!, available: true, free_units: 1 };
  const opts = { history: [], lastRenterMessage: "Is the FX6 available for 6 to 7 October?", hasItemGrounding: true,
    groundedDuringTurn: { availability: true, unavailability: false }, stockEvidence: [alternative], stockRequest: scope,
    factPack: { marketingItems: ["Sony FX6"] } };
  it("accepts the real inventory decline and separately checked owned alternative", () => {
    const result = guardDraft("The Sony FX6 isn't available for 6 to 7 October, but the Sony FX3 is available for those dates.", opts);
    expect(result.flags.filter(f => ["UNGROUNDED_UNAVAILABILITY", "UNGROUNDED_AVAILABILITY", "MARKETING_ITEM_AVAILABLE"].includes(f.type))).toEqual([]);
  });
  it("does not turn eligibility into a booking or other stock-cause receipt", () => {
    for (const text of ["The FX6 is already booked.", "The FX6 is out of stock.", "The FX6 is currently rented.", "The FX6 isn't available because it's booked out.", "The FX6 isn't available due to a repair."]) {
      expect(guardDraft(text, opts).flags).toContainEqual(expect.objectContaining({ type: "UNGROUNDED_UNAVAILABILITY", severity: "critical" }));
    }
  });
  it("keeps unsupported items, variants and positive offers blocked", () => {
    for (const text of ["The FX30 isn't available.", "The A7 II isn't available.", "The FX3 isn't available.", "The FX6 is available."]) {
      expect(guardDraft(text, opts).flags.some(f => f.severity === "critical" && f.action === "flagged")).toBe(true);
    }
    expect(guardDraft("The FX6 isn't available.", { ...opts, factPack: undefined }).flags).toContainEqual(expect.objectContaining({ type: "UNGROUNDED_UNAVAILABILITY" }));
  });
  it("does not use one ineligible item to decline a mixed basket", () => {
    const stockRequest = { ...scope, items: [...scope.items, { name: "Sony FX3", quantity: 1 }] };
    expect(guardDraft("They're unavailable for your dates.", { ...opts, stockRequest }).flags).toContainEqual(expect.objectContaining({ type: "UNGROUNDED_UNAVAILABILITY" }));
  });
  it("accepts exact native model identity without lending the alternative's stock verdict", () => {
    const stockRequest = { ...scope, items: [{ name: "Sony A7S III", quantity: 1 }] };
    const result = guardDraft("That exact Sony A7S III isn't available for 6th to 7th October, but the Sony FX3 is available for those dates.", {
      ...opts, stockRequest, factPack: { marketingItems: ["Sony A7S III"] },
    });
    expect(result.flags.filter(f => f.type.startsWith("UNGROUNDED_"))).toEqual([]);
    expect(guardDraft("The FX6 isn't available, but the FX3 is available.", { ...opts, stockEvidence: [{ ...alternative, start_date: "2026-10-08" }] }).flags)
      .toContainEqual(expect.objectContaining({ type: "UNGROUNDED_AVAILABILITY" }));
  });
  it("does not attach a later pronoun to the excluded request after naming an owned alternative", () => {
    expect(guardDraft("The FX6 isn't available. The FX3 is available. It isn't available for your dates.", opts).flags)
      .toContainEqual(expect.objectContaining({ type: "UNGROUNDED_UNAVAILABILITY" }));
  });
});
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
it("resolves a selected kit's named lens without borrowing another manufacturer's stock",()=>{
 const scope:StockRequest={...request,items:[{name:"Sony A7 II",quantity:1,complete:true,components:[{name:"Sony A7 II",quantity:1},{name:"Sony 28-70mm",quantity:1}]}]};
 const receipts=[{...stock,item:"Sony A7 II",available:true},{...stock,item:"Sony 28-70mm",available:true}];
 expect(check("The Sony A7 II kit with the 28-70mm lens is available for those dates.",receipts,scope)).toEqual([]);
 for(const descriptor of ["Canon 28-70mm lens","24-70mm lens","two 28-70mm lenses"])expect(check(`The Sony A7 II kit with ${descriptor} is available.`,receipts,scope)).toHaveLength(1);
 expect(check("The Sony A7 II kit with the 28-70mm lens is available.",[{...receipts[0]},{...receipts[1],available:false}],scope)).toHaveLength(1);
 expect(check("The Sony A7 II body is available.",[{...receipts[0]},{...receipts[1],available:false}],scope)).toEqual([]);
});

it("treats an extension through a new return date as the retained pickup span",()=>{
 const scope:StockRequest={...request,start_date:"2026-10-06",end_date:"2026-10-07"};
 const receipt={...stock,start_date:"2026-10-06",end_date:"2026-10-08",available:false};
 expect(check("I can't extend the Sony FX3 through 8 October as it's fully booked for that period.",[receipt],scope)).toEqual([]);
 expect(check("The Sony FX3 is fully booked on 8 October.",[receipt],scope)).toHaveLength(1);
 expect(check("I can't extend the Sony FX3 through 9 October as it's fully booked for that period.",[receipt],scope)).toHaveLength(1);
});


describe("booked-kit references versus negative stock claims", () => {
  const request={items:[{name:"Canon EF 24-105mm f4",quantity:1}],start_date:"2026-10-20",end_date:"2026-10-21"};
  it("allows the exact affirmative kit answer found in managed generation", () => {
    expect(unsupportedStockClaims("Yes, your booked kit already includes the Canon EF 24-105mm f4 lens (along with the Canon EF-to-L mount adapter).",[],request)).toEqual([]);
    expect(unsupportedStockClaims("Your already booked kit includes the Canon lens.",[],request)).toEqual([]);
    expect(unsupportedStockClaims("Your Canon EF 24-105mm f4 is booked for you.",[],request)).toEqual([]);
  });
  it("still checks a later negative availability verdict after a booking adjective", () => {
    expect(unsupportedStockClaims("Your booked kit is unavailable.",[],request)).toHaveLength(1);
  });
  it("still requires a negative receipt for actual bookings consuming stock", () => {
    for(const claim of ["Canon EF 24-105mm f4 is already booked.","Canon EF 24-105mm f4 is booked.","Your Canon EF 24-105mm f4 is booked out.","Your Canon EF 24-105mm f4 is booked-out.","My Canon EF 24-105mm f4 is booked.","Our Canon EF 24-105mm f4 is booked.","Your Canon EF 24-105mm f4 is booked by another customer."])
      expect(unsupportedStockClaims(claim,[],request)).toHaveLength(1);
  });
});
