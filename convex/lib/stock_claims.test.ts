import { describe, expect, it } from "vitest";
import { stockRequestForInquiryQuote, unsupportedStockClaims, type StockReceipt, type StockRequest } from "./stock_claims";
import { guardDraft } from "./draft_guard";
const request: StockRequest = { start_date: "2026-10-02", end_date: "2026-10-04", items: [{ name: "Sony FX3", quantity: 1 }] };
const stock: StockReceipt = { item: "Sony FX3", start_date: "2026-10-02", end_date: "2026-10-04", quantity: 1, available: false, free_units: 0, checked_at: 1790850651000, call_id: "fx3-stock" };
const check = (text: string, receipts = [stock], scope = request) => unsupportedStockClaims(text, receipts, scope);
describe("named Native stock in an empty inquiry",()=>{
 const lens:StockReceipt={...stock,item:"TTArtisan 11mm f2.8 Fisheye (Sony E)",kind:"lens",start_date:"2026-10-22",end_date:"2026-10-23",available:true,free_units:1};
 const sentence="The TTArtisan 11mm f/2.8 fisheye lens from your friend's referral is available for 22 to 23 October.";
 const review=(text=sentence,evidence=[lens])=>unsupportedStockClaims(text,evidence,{items:[]});
 it("resolves a complete Native noun phrase independently of its source qualifier",()=>{
  expect(review()).toEqual([]);
  expect(review(sentence.replace("your friend's referral","the earlier conversation"))).toEqual([]);
  expect(review(`The ${lens.item} is available for 22 to 23 October.`)).toEqual([]);
  expect(review("Sony FX3 is available for 22 to 23 October.",[{...lens,item:"Sony FX3",kind:"camera"}])).toEqual([]);
 });
 it("keeps exact quantities, dates, model tokens and included components",()=>{
  for(const text of [sentence.replace("22 to 23","24 to 25"),sentence.replace("The TTArtisan","Two TTArtisan"),sentence.replace("11mm","12mm"),sentence.replace("f/2.8","f/1.8"),sentence.replace("TTArtisan","Sony"),sentence.replace("lens from","lens with Sony FX3 from")])expect(review(text)).not.toEqual([]);
  expect(review(sentence.replace("fisheye lens","fisheye (RF) lens"))).not.toEqual([]);
  expect(review(sentence,[])).not.toEqual([]);
  expect(review(sentence,[{...lens,available:false}])).not.toEqual([]);
 });
 it("does not choose a year or model between conflicting Native checks",()=>{
  expect(review(sentence,[lens,{...lens,start_date:"2027-10-22",end_date:"2027-10-23"}])).not.toEqual([]);
  expect(review(sentence.replace("f/2.8 ",""),[lens,{...lens,item:"TTArtisan 11mm f4 Fisheye (Sony E)"}])).not.toEqual([]);
  expect(review(sentence.replace("22 to 23 October","22 to 23 October 2027"))).not.toEqual([]);
 });
 it("anchors a generic reference to one rendered Native offer, never unselected alternatives",()=>{
  const quote={start_date:lens.start_date,end_date:lens.end_date,items:[{name:lens.item,quantity:1}]};
  const text="Hey! I've checked the gear from your friend's referral for 22–23 October, and it is available. Here's the quote:";
  const scope=stockRequestForInquiryQuote({items:[]},[quote]);
  expect(unsupportedStockClaims(text,[lens],scope)).toEqual([]);
  expect(unsupportedStockClaims("The gear from the earlier conversation is available.",[lens],scope)).toEqual([]);
  for(const failed of [{items:[]},stockRequestForInquiryQuote({items:[]},[quote,quote])])expect(unsupportedStockClaims(text,[lens],failed)).not.toEqual([]);
  expect(stockRequestForInquiryQuote(request,[quote])).toBe(request);
  for(const wrong of ["A camera is available.","Two copies are available.","It is available for 24 to 25 October.","Sony FX3 is unavailable, and it is available."])expect(unsupportedStockClaims(wrong,[lens],scope)).not.toEqual([]);
 });
 it("requires the entire selected generic basket to share a positive joint check",()=>{
  const members=[{name:lens.item,quantity:1},{name:"Sony FX3",quantity:1}],quote={start_date:lens.start_date,end_date:lens.end_date,items:members};
  const scope=stockRequestForInquiryQuote({items:[]},[quote]);
  const receipts=[lens,{...lens,item:"Sony FX3",kind:"camera"}];
  expect(unsupportedStockClaims("It is available.",receipts,scope)).not.toEqual([]);
  expect(unsupportedStockClaims("It is available.",receipts.map(r=>({...r,basket:{available:true,items:members}})),scope)).toEqual([]);
  expect(unsupportedStockClaims("It is available.",receipts.map((r,i)=>({...r,available:i===0,basket:{available:false,items:members}})),scope)).not.toEqual([]);
 });
});
it("does not promise a free camera as an extra when its shared proposal failed or remains unknown",()=>{
 const positive={...stock,available:true,owned:true,basket:{available:false,items:[{name:stock.item,quantity:1}]}};
 expect(check("Sony FX3 is available for 2 to 4 October.",[positive])).not.toEqual([]);
 expect(check("Sony FX3 is available for 2 to 4 October.",[{...positive,basket:{...positive.basket,available:null}}])).not.toEqual([]);
 expect(check("Sony FX3 is available for 2 to 4 October.",[{...positive,basket:{...positive.basket,available:true}}])).toEqual([]);
});
describe("requested lens-set shorthand",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
 const message="Can you quote your Blackmagic 6K Full Frame with the Great Joy 35mm, 50mm and 85mm anamorphic lens set for 20 to 21 October? Please quote only.";
 const members=[35,50,85].map(f=>({name:`Anamorphic Great Joy lens ${f}mm`,quantity:1}));
 const receipts:StockReceipt[]=members.map(i=>({...stock,item:i.name,quantity:1,start_date:scope.start_date!,end_date:scope.end_date!,available:false,owned:false,kind:"lens",basket:{available:false,items:members}}));
 const negative="The Great Joy anamorphic set isn't available for 20 to 21 October.";
 const positive="The Great Joy anamorphic set is available for 20 to 21 October.";
 const review=(text:string,evidence=receipts,latest=message)=>unsupportedStockClaims(text,evidence,scope,[],latest);
 it("resolves the actual deployed candidate using exact requested members",()=>expect(review(negative)).toEqual([]));
 it("allows a whole-set refusal when one exact member cannot be supplied",()=>{
  expect(review(negative,receipts.map((r,i)=>({...r,available:i!==0,owned:true})))).toEqual([]);
 });
 it("cannot borrow different families, focal lengths, dates, unknown or affirmative verdicts",()=>{
  for(const evidence of [[],receipts.slice(0,2),receipts.map(r=>({...r,available:true})),receipts.map(r=>({...r,available:null})),receipts.map(r=>({...r,end_date:"2026-10-22"})),receipts.map(r=>({...r,item:r.item.replace("Great Joy","Blazar Remus")}))]) expect(review(negative,evidence)).not.toEqual([]);
  for(const latest of ["Can I rent a Great Joy set?",message.replace("85mm","100mm"),message.replace("Great Joy","Blazar Remus")])expect(review(negative,receipts,latest)).not.toEqual([]);
 });
 it("requires a positive joint receipt for every member and the exact set quantity",()=>{
  const positiveReceipts=receipts.map(r=>({...r,available:true,owned:true,basket:{available:true,items:members}}));
  expect(review(positive,positiveReceipts)).toEqual([]);
  expect(review(positive,positiveReceipts.map(r=>({...r,basket:undefined})))).not.toEqual([]);
  expect(review(positive,positiveReceipts.map((r,i)=>({...r,available:i!==0})))).not.toEqual([]);
  expect(review(positive,positiveReceipts,message.replace("the Great Joy","two Great Joy"))).not.toEqual([]);
  expect(review(positive.replace("The Great Joy","Two Great Joy"),positiveReceipts)).not.toEqual([]);
 });
 it("does not let a whole-set negative prove that every member is unavailable",()=>{
  expect(review("Anamorphic Great Joy lens 50mm is unavailable for 20 to 21 October.",receipts.map((r,i)=>({...r,available:i!==0})))).not.toEqual([]);
 });
 it("keeps comma-separated focal lists together and refuses ambiguous family shorthand",()=>{
  expect(review("The Great Joy 35mm, 50mm and 85mm anamorphic lens set isn't available for 20 to 21 October.")).toEqual([]);
  for(const name of ["Great Joy 35mm, 50mm, and 85mm anamorphic set","Great Joy 35mm 50mm 85mm anamorphic lens set","Great Joy 35, 50, 85mm lens set"])
   expect(review(`The ${name} isn't available for 20 to 21 October.`)).toEqual([]);
  expect(review(negative,receipts,`${message} Or quote the Great Joy 35mm and 50mm lens set.`)).not.toEqual([]);
  expect(review("The Great Joy 35mm and 50mm lens set isn't available for 20 to 21 October.",receipts,`${message} Or quote the Great Joy 35mm and 50mm lens set.`)).toEqual([]);
 });
});
describe("references to an additional booked-kit lens",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"BMPCC 6K Full Frame + Canon EF 24-105mm f4",quantity:1}]};
 const lens:StockReceipt={...stock,item:"Canon EF 24-105mm f4",start_date:scope.start_date!,end_date:scope.end_date!,quantity:2,available:false,free_units:1};
 const text="We only have the one Canon EF 24-105mm f4 in total (which is already included in your kit), so a second one isn't available for those dates.";
 it("keeps an exact item reference through a non-stock kit description and checks two physical units",()=>expect(unsupportedStockClaims(text,[lens],scope)).toEqual([]));
 it("never substitutes an EF stock receipt for an explicit RF or Sony lens",()=>{
  const ef={...lens,item:"Canon EF 16-35mm f2.8",quantity:1,available:true,free_units:1};
  expect(unsupportedStockClaims("Canon EF 16-35mm is available for 20 to 21 October.",[ef],scope)).toEqual([]);
  expect(unsupportedStockClaims("EF 16-35mm is available for 20 to 21 October.",[ef],scope)).toEqual([]);
  for(const name of ["Canon RF 16-35mm","RF 16-35mm","Sony E 16-35mm"])
   for(const verdict of ["is available","is not available"])
    expect(unsupportedStockClaims(`${name} ${verdict} for 20 to 21 October.`,[ef],scope)).not.toEqual([]);
 });
 it("binds an ordinal exact-lens pronoun only to a preceding native lens",()=>{
  const reply=text.replace("a second one","a second unit of that exact lens");
  expect(unsupportedStockClaims(reply,[lens],scope)).toEqual([]);
  for(const r of [{...lens,end_date:"2026-10-22"},{...lens,quantity:1,available:true,free_units:null},{...lens,quantity:2,available:true,free_units:2}])
   expect(unsupportedStockClaims(reply,[r],scope)).not.toEqual([]);
  expect(unsupportedStockClaims("A second unit of that exact lens isn't available for those dates.",[lens],scope)).not.toEqual([]);
  expect(unsupportedStockClaims(`${scope.items[0].name} is your booked kit. A second unit of that exact lens isn't available for those dates.`,[{...lens,item:scope.items[0].name}],scope)).not.toEqual([]);
  expect(unsupportedStockClaims(reply.replace("a second unit","a third unit"),[{...lens,quantity:1,available:true,free_units:2}],scope)).toEqual([]);
 });
 it("resolves counted copy/unit references while preserving capacity and antecedent",()=>{
  for(const reference of ["a second copy","a second unit","two copies"]) {
   const reply=text.replace("a second one",reference);
   expect(unsupportedStockClaims(reply,[lens],scope)).toEqual([]);
   for(const r of [{...lens,available:true,free_units:2},{...lens,end_date:"2026-10-22"},{...lens,quantity:1,available:true,free_units:null}])
    expect(unsupportedStockClaims(reply,[r],scope)).not.toEqual([]);
  }
  expect(unsupportedStockClaims("A second copy isn't available.",[lens],scope)).not.toEqual([]);
  expect(unsupportedStockClaims(text.replace("a second one","a copy"),[lens],scope)).not.toEqual([]);
 });
 it("resolves a uniquely receipted ordinal focal range and brand shorthand",()=>{
  for(const name of ["a second 24-105mm","a second Canon 24-105mm lens","a 2nd Canon EF 24–105mm"])
   expect(unsupportedStockClaims(text.replace("a second one",name),[lens],scope),name).toEqual([]);
  expect(unsupportedStockClaims(text.replace("a second one","a third 24-105mm"),[{...lens,quantity:3}],scope)).toEqual([]);
 });
 it("does not borrow kit stock or guess among mounts and brands",()=>{
  const shorthand=text.replace("a second one","a second 24-105mm");
  expect(unsupportedStockClaims(shorthand,[{...lens,item:scope.items[0].name}],scope)).not.toEqual([]);
  expect(unsupportedStockClaims(shorthand,[{...lens,item:"Canon EF 24-105mm adapter"}],scope)).not.toEqual([]);
  for(const item of ["Canon RF 24-105mm f4","Sony E 24-105mm f4"])
   expect(unsupportedStockClaims(shorthand,[lens,{...lens,item}],scope)).not.toEqual([]);
  expect(unsupportedStockClaims(text.replace("a second one","a second Canon 24-105mm"),[lens,{...lens,item:"Sony E 24-105mm f4"}],scope)).toEqual([]);
  expect(unsupportedStockClaims(text.replace("a second one","a second Canon 24-105mm"),[lens,{...lens,item:"Canon RF 24-105mm f4"}],scope)).not.toEqual([]);
  expect(unsupportedStockClaims(text.replace("a second one","a second Canon EF 24-105mm"),[lens,{...lens,item:"Canon RF 24-105mm f4"}],scope)).toEqual([]);
  for(const r of [{...lens,end_date:"2026-10-22"},{...lens,quantity:1,available:true,free_units:null},{...lens,quantity:2,available:true,free_units:2}])
   expect(unsupportedStockClaims(shorthand,[r],scope)).not.toEqual([]);
 });
 it("cannot borrow the receipt for another model, dates, unknown capacity, or an unspecified first unit",()=>{
  for (const r of [{...lens,item:"Canon EF 16-35mm f2.8"},{...lens,end_date:"2026-10-22"},{...lens,quantity:1,available:true,free_units:null},{...lens,free_units:2,available:true}])
   expect(unsupportedStockClaims(text,[r],scope)).not.toEqual([]);
  expect(unsupportedStockClaims(text.replace("a second one","it"),[lens],scope)).not.toEqual([]);
  expect(unsupportedStockClaims("A second one isn't available for those dates.",[lens],scope)).not.toEqual([]);
 });
});
describe("equipment offers are stock promises",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"Sony FX3",quantity:1}]};
 const lens:StockReceipt={...stock,item:"Canon EF 16-35mm f2.8",kind:"lens",start_date:scope.start_date!,end_date:scope.end_date!,quantity:1,available:true,free_units:1};
 it("requires a matching current receipt for offer/supply/provide and retains dates/counts",()=>{
  for(const verb of ["offer","supply","provide"]) {
   const reply=`I can ${verb} the Canon EF 16-35mm f2.8 for 20 to 21 October.`;
   expect(unsupportedStockClaims(reply,[lens],scope)).toEqual([]);
   for(const receipts of [[],[{...lens,available:false,free_units:0}],[{...lens,end_date:"2026-10-22"}]])
    expect(unsupportedStockClaims(reply,receipts,scope)).not.toEqual([]);
   expect(unsupportedStockClaims(reply.replace("the Canon","two Canon"),[lens],scope)).not.toEqual([]);
   expect(unsupportedStockClaims(reply.replace("Canon EF","Canon RF"),[lens],scope)).not.toEqual([]);
  }
 });
 it("checks an undated alternative offer and does not classify service offers or conditional checks as stock",()=>{
  expect(unsupportedStockClaims("I can offer the Canon EF 16-35mm f2.8 zoom lens.",[lens],scope)).toEqual([]);
  expect(unsupportedStockClaims("I can offer the Canon EF 16-35mm f2.8 zoom lens.",[],scope)).not.toEqual([]);
  for(const reply of ["I can offer a refund.","I can provide some advice.","I can offer delivery for 20 October.","I could supply the Canon EF 16-35mm if it is available.","I can offer the Canon EF 16-35mm once I have checked availability."])
   expect(unsupportedStockClaims(reply,[],scope),reply).toEqual([]);
 });
 it("uses Native lens kind for descriptors without lending camera or wrong-mount stock",()=>{
  const prime={...lens,item:"Canon EF 50mm f1.8"};
  expect(unsupportedStockClaims("I can offer the Canon EF 50mm f1.8 lens at £20/day.",[prime],scope)).toEqual([]);
  expect(unsupportedStockClaims("I can offer the Canon RF 50mm f1.8 lens.",[prime],scope)).not.toEqual([]);
  expect(unsupportedStockClaims("I can offer the Sony FX3 lens.",[{...lens,item:"Sony FX3",kind:"camera"}],scope)).not.toEqual([]);
 });
});
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
  it("keeps an included-as-booked component list out of stock verdicts without hiding later refusals",()=>{
    const text="Your booking remains unchanged at £124 for the 2 days, with the 1 EF-to-L adapter, Canon EF 24-105mm f/4 lens, batteries, and CFexpress card all included as booked.";
    expect(unsupportedStockClaims(text,[],request)).toEqual([]);
    expect(unsupportedStockClaims("Canon EF 24-105mm f4 is supplied exactly as booked.",[],request)).toEqual([]);
    expect(unsupportedStockClaims(text+" Canon EF 24-105mm f4 is unavailable.",[],request)).toHaveLength(1);
    expect(unsupportedStockClaims("Canon EF 24-105mm f4 is included as booked out.",[],request)).not.toEqual([]);
  });
  it("still requires a negative receipt for actual bookings consuming stock", () => {
    for(const claim of ["Canon EF 24-105mm f4 is already booked.","Canon EF 24-105mm f4 is booked.","Your Canon EF 24-105mm f4 is booked out.","Your Canon EF 24-105mm f4 is booked-out.","My Canon EF 24-105mm f4 is booked.","Our Canon EF 24-105mm f4 is booked.","Your Canon EF 24-105mm f4 is booked by another customer."])
      expect(unsupportedStockClaims(claim,[],request)).toHaveLength(1);
  });
});

describe("joint recommendation availability",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
 const names=["Anamorphic Blazar Remus 100mm","PL to L mount adapter"];
 const independent=names.map(item=>({...stock,item,start_date:scope.start_date!,end_date:scope.end_date!,quantity:1,available:true,free_units:1}));
 const basket={available:true,items:names.map(name=>({name,quantity:1}))};
 const joint=independent.map(r=>({...r,basket}));
 const reply="- Anamorphic Blazar Remus 100mm: £50 for the 2 days (£25/day)\n- PL to L mount adapter: £20 for the 2 days (£10/day)\nBoth are available for 20 to 21 October.";
 it("requires actual joint basket evidence for a two-item bullet group",()=>{
  expect(check(reply,joint,scope)).toEqual([]);
  expect(check(reply,independent,scope)).not.toEqual([]);
  for(const proof of [{...basket,available:false},{...basket,items:basket.items.slice(0,1)}])
   expect(check(reply,independent.map(r=>({...r,basket:proof})),scope)).not.toEqual([]);
  expect(check(reply,joint.map(r=>({...r,end_date:"2026-10-22"})),scope)).not.toEqual([]);
 });
 it("does not borrow two bullets across an unknown item, a third item, or an unrelated sentence",()=>{
  for(const text of [reply.replace("PL to L mount adapter:","PL to E mount adapter:"),reply.replace("Both are","- Unknown lens: £10\nBoth are"),reply.replace("Both are","Your booking is unchanged. Both are")])
   expect(check(text,joint,scope)).not.toEqual([]);
 });
 it("checks explicitly coordinated names and quantities together",()=>{
  expect(check(`${names[0]} and ${names[1]} are available for 20 to 21 October.`,joint,scope)).toEqual([]);
  expect(check(`Two ${names[0]} and ${names[1]} are available for 20 to 21 October.`,joint,scope)).not.toEqual([]);
  expect(check(`${names[0]} and PL to E mount adapter are available.`,joint,scope)).not.toEqual([]);
 });
 it("rejects a stale or partial positive group when one member fails",()=>{
  expect(check(reply,[joint[0],{...joint[1],available:false,free_units:0,basket:{...basket,available:false}}],scope)).not.toEqual([]);
  expect(check(reply.replace("are available","are unavailable"),joint.map(r=>({...r,available:false,free_units:0,basket:{...basket,available:false}})),scope)).toEqual([]);
  expect(check(reply.replace("are available","are unavailable"),[joint[0],{...joint[1],available:false}],scope)).not.toEqual([]);
 });
});

it("matches Native directional adapter names without confusing mount ends",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
 const items=[{name:"Anamorphic Blazar Remus 100mm",quantity:1},{name:"PL to L mount",quantity:1}];
 const joint=items.map(i=>({...stock,item:i.name,quantity:i.quantity,start_date:scope.start_date!,end_date:scope.end_date!,available:true,free_units:1,basket:{available:true,items}}));
 for(const pronoun of ["Both","All","They"])
  expect(check(`- Anamorphic Blazar Remus 100mm: £50\n- PL to L mount adapter: £20\n${pronoun} are available for 20 to 21 October.`,joint,scope)).toEqual([]);
 for(const adapter of ["PL to E mount adapter","L to PL mount adapter","EF to L mount adapter"])
  expect(check(`- Anamorphic Blazar Remus 100mm: £50\n- ${adapter}: £20\nBoth are available.`,joint,scope)).not.toEqual([]);
});

it("sums shared kit components and scales explicitly requested kit units",()=>{
 const items=[{name:"Kit A",quantity:1,components:[{name:"NP-F570 batteries",quantity:5}]},{name:"Kit B",quantity:1,components:[{name:"NP-F570 batteries",quantity:5}]}];
 const scope:StockRequest={...request,items};
 const proof=(quantity:number):StockReceipt=>({...stock,item:"NP-F570 batteries",quantity,available:true,free_units:quantity,basket:{available:true,items:[{name:"NP-F570 batteries",quantity}]}});
 expect(check("Kit A and Kit B are available.",[proof(5)],scope)).not.toEqual([]);
 expect(check("Kit A and Kit B are available.",[proof(10)],scope)).toEqual([]);
 expect(check("Two Kit A and Kit B are available.",[proof(10)],scope)).not.toEqual([]);
 expect(check("Two Kit A and Kit B are available.",[proof(15)],scope)).toEqual([]);
});

describe("exact evidence for equipment refusals",()=>{
 const missing:StockReceipt={...stock,item:"Sony FX3",available:false,free_units:0,owned:false};
 const busy:StockReceipt={...missing,owned:true};
 const options={history:[],lastRenterMessage:"Can you quote a Sony FX3?",hasItemGrounding:true,
  groundedDuringTurn:{availability:false,unavailability:true},stockRequest:request};
 it("blocks unrelated negatives, unknown ownership, busy gear and unknown results",()=>{
  for(const receipt of [{...missing,item:"Sony FX6"},{...missing,owned:undefined},busy,{...missing,available:null}])
   expect(guardDraft("I don't have that Sony FX3 to quote.",{...options,stockEvidence:[receipt]}).flags)
    .toContainEqual(expect.objectContaining({type:"UNGROUNDED_UNAVAILABILITY"}));
  expect(guardDraft("I don't have that Sony FX3 to quote.",options).flags)
   .toContainEqual(expect.objectContaining({type:"UNGROUNDED_UNAVAILABILITY"}));
 });
 it("accepts exact Native exclusions but never transfers them to another model",()=>{
  for(const text of ["I don't have that Sony FX3 to quote.","We do not have the Sony FX3 for rental.","Unfortunately, we currently don't have that Sony FX3."])
   expect(guardDraft(text,{...options,stockEvidence:[missing]}).flags.filter(f=>f.type==="UNGROUNDED_UNAVAILABILITY")).toEqual([]);
  expect(guardDraft("I don't have that Sony FX6 to quote.",{...options,stockEvidence:[missing]}).flags)
   .toContainEqual(expect.objectContaining({type:"UNGROUNDED_UNAVAILABILITY"}));
  expect(guardDraft("I don't have that Sony FX3 to quote.",{...options,stockEvidence:[],groundedDuringTurn:{unavailability:false},factPack:{marketingItems:["Sony FX3"]}}).flags.filter(f=>f.type==="UNGROUNDED_UNAVAILABILITY")).toEqual([]);
 });
 it("allows scoped date refusals for busy owned gear while preserving counts and dates",()=>{
  const text="We don't have the Sony FX3 for 2 to 4 October.";
  expect(check(text,[busy])).toEqual([]);
  for(const receipt of [{...busy,end_date:"2026-10-05"},{...busy,available:true},{...busy,quantity:2,free_units:null}])expect(check(text,[receipt])).not.toEqual([]);
 });
 it("does not treat missing information or a service as an equipment decline",()=>{
  for(const text of ["I don't have that price.","We can't get a discount.","I don't have enough information.","We do not have your address.",
    "I don't have verified pricing or availability to quote for the Great Joy anamorphic set right now, so your current booking remains unchanged.",
    "We don't have confirmed rates for the Sony FX3.","I don't have verified information for the Sony FX3."])
   expect(guardDraft(text,{...options,groundedDuringTurn:{unavailability:false},stockEvidence:[]}).flags.filter(f=>f.type==="UNGROUNDED_UNAVAILABILITY")).toEqual([]);
 });
 it("still reviews a separate equipment refusal after missing-price information",()=>{
  expect(guardDraft("I don't have verified pricing for the Sony FX3. We don't have the Sony FX6 for rental.",{...options,stockEvidence:[]}).flags)
   .toContainEqual(expect.objectContaining({type:"UNGROUNDED_UNAVAILABILITY"}));
 });
});

describe("Native lens and directional adapter references",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
 const items=[{name:"Anamorphic Blazar Remus 100mm",quantity:1},{name:"PL to L mount",quantity:1}];
 const joint=items.map(i=>({...stock,item:i.name,quantity:i.quantity,start_date:scope.start_date!,end_date:scope.end_date!,available:true,free_units:1,kind:i.name.includes("Remus")?"lens":"accessory",owned:true,basket:{available:true,items}}));
 const text="Yes, both the Blazar Remus 100mm anamorphic lens and the PL to L mount adapter are available together with your booked gear for 20 to 21 October.";
 it("resolves the actual model's coordinated sentence without treating both as two lens units",()=>{
  expect(check(text,joint,scope)).toEqual([]);
  for(const changed of [text.replace("100mm","85mm"),text.replace("PL to L","PL to E"),text.replace("both the","two"),text.replace("21 October","22 October")])expect(check(changed,joint,scope)).not.toEqual([]);
  expect(check(text,joint.map(r=>({...r,basket:undefined})),scope)).not.toEqual([]);
 });
 it("binds which only to the immediately preceding exact Native item",()=>{
  const relative="You would also need a PL to L mount adapter, which is available for 20 to 21 October.";
  expect(check(relative,joint,scope)).toEqual([]);
  for(const changed of [relative.replace("PL to L","PL to E"),relative.replace(", which",". Pickup is on Saturday, which"),"Which is available for 20 to 21 October."])
   expect(check(changed,joint,scope)).not.toEqual([]);
  expect(check(relative,joint.map(r=>({...r,end_date:"2026-10-22"})),scope)).not.toEqual([]);
 });
});


it("binds a lens availability relative clause across equivalent aperture spelling",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"TTArtisan 11mm f2.8 Fisheye (Sony E)",quantity:1}]};
 const lens:StockReceipt={...stock,item:"Sony GM 16-35mm f2.8",kind:"lens",available:true,free_units:1,quantity:1,start_date:scope.start_date!,end_date:scope.end_date!};
 const text="For an autofocus full-frame Sony E option reaching at least 16mm, we have the Sony GM 16-35mm f/2.8, which is available for 20 to 21 October.";
 expect(check(text,[lens],scope)).toEqual([]);
 expect(check(text.replace("f/2.8","f / 2.8"),[lens],scope)).toEqual([]);
 for(const wrong of [text.replace("f/2.8","f/4"),text.replace("f/2.8","T/2.8"),text.replace("16-35mm","24-70mm"),text.replace("16-35mm","16-35mm GM II"),text.replace("21 October","22 October")])expect(check(wrong,[lens],scope)).not.toEqual([]);
 expect(check(text,[],scope)).not.toEqual([]);
 expect(check(text,[{...lens,available:false,free_units:0}],scope)).not.toEqual([]);
});

describe("offer headings bind only their immediate named basket",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"Canon R5",quantity:1}]};
 const names=["Sony FX3","Sony GM 16-35mm f2.8"];
 const joint={available:true,items:names.map(name=>({name,quantity:1}))};
 const proof:StockReceipt[]=names.map((item,index)=>({...stock,item,start_date:scope.start_date!,end_date:scope.end_date!,available:true,free_units:1,basket:joint,kind:index ? "lens":"camera"}));
 const text="I can offer our Sony setup:\n• Sony FX3 body: £98 for 2 days\n• Sony GM 16-35mm f2.8 lens: £40 for 2 days";
 it("uses the named lines and positive joint check instead of a prior declined request",()=>expect(unsupportedStockClaims(text,proof,scope)).toEqual([]));
 it("does not borrow independent, failed or differently dated checks",()=>{
  for(const changed of [proof.map(r=>({...r,basket:undefined})),proof.map(r=>({...r,basket:{...joint,available:false}})),proof.map(r=>({...r,end_date:"2026-10-22"})),proof.slice(0,1)])expect(unsupportedStockClaims(text,changed,scope)).not.toEqual([]);
 });
 it("rejects an unknown item, different heading brand, intervening paragraph or duplicate member",()=>{
  for(const changed of [text.replace("Sony setup","Canon setup"),text.replace("Sony setup","Sony FX6 setup"),text.replace("Sony GM","Canon RF"),text.replace("\n• Sony FX3","\nPlease let me know.\n• Sony FX3"),text.replace("Sony GM 16-35mm f2.8 lens","Sony FX3 body")])expect(unsupportedStockClaims(changed,proof,scope)).not.toEqual([]);
 });
});
