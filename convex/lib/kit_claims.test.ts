import { renterItemNames } from "./renter_item_names";
import { describe, expect, it } from "vitest";
import { unsupportedKitClaims } from "./kit_claims";
const kit = { names: ["Sony A7 V"], contents: ["Sony A7 V", "NP-FZ100 batteries", "256GB card"] };
describe("inclusion owner scopes in actual booked-kit replies", () => {
 const camera={names:renterItemNames("BMPCC 6K Full Frame"),contents:["Canon EF-to-L mount adapter"],booked_camera:true};
 const lens={names:["Canon EF 16-35mm f2.8"],contents:["Canon EF 16-35mm f2.8"]};
 const adapter={names:["EF to L mount"],contents:["EF to L mount"]};
 const evidence=[camera,lens,adapter];
 const reply="I checked our stock for 20 to 21 October, and we only have 1 EF-to-L mount adapter in total, which is already included with your booked Blackmagic 6K Full Frame kit. Because of that capacity limit, we aren't able to add a second EF-to-L adapter to the basket. Your booking remains unchanged with the 1 included adapter at £124 for the 2 days.";
 it("accepts the live refusal's relative clause and possessive booking follow-up",()=>expect(unsupportedKitClaims(reply,evidence)).toEqual([]));
 it("attributes an alternative's mount to the booked kit, not to the lens",()=>{
  expect(unsupportedKitClaims("Canon EF 16-35mm f2.8 fits the EF-to-L adapter included in your kit.",evidence)).toEqual([]);
  expect(unsupportedKitClaims("Canon EF 16-35mm f2.8 fits the EF-to-L adapter included with the Blackmagic 6K Full Frame kit.",evidence)).toEqual([]);
  expect(unsupportedKitClaims("Canon EF 16-35mm f2.8 fits the EF-to-L adapter included as part of your confirmed Blackmagic 6K Full Frame kit.",evidence)).toEqual([]);
  expect(unsupportedKitClaims("Your booked kit comes with 1 EF-to-L adapter.",evidence)).toEqual([]);
  expect(unsupportedKitClaims("Your booked kit comes with 2 EF-to-L adapters.",evidence)).not.toEqual([]);
  expect(unsupportedKitClaims("Your booked kit comes with 1 EF-to-L adapter.",[{...camera,booked_camera:false}])).not.toEqual([]);
  expect(unsupportedKitClaims("Your booked kit comes with an EF-to-L adapter.",[{...camera,contents:["2 EF-to-L adapters"]}])).toEqual([]);
  expect(unsupportedKitClaims("Your booked kit comes with 1 EF-to-L adapter.",[{...camera,contents:["EF-to-L adapters"]}])).not.toEqual([]);
 });
 it("does not authorize unbooked cameras, another camera's adapter, or extra quantities",()=>{
  expect(unsupportedKitClaims(reply,[{...camera,booked_camera:false},lens,adapter])).not.toEqual([]);
  expect(unsupportedKitClaims(reply.replaceAll("EF-to-L","PL-to-L"),evidence)).not.toEqual([]);
  expect(unsupportedKitClaims(reply.replace("1 included adapter","2 included adapters"),evidence)).not.toEqual([]);
  expect(unsupportedKitClaims("Canon EF 16-35mm f2.8 fits the EF-to-L adapter included with your booked Sony FX3 kit.",[...evidence,{names:["Sony FX3"],contents:["PL-to-E adapter"],booked_camera:true}])).not.toEqual([]);
 });
 it("retains subsequent component claims and does not borrow an alternative's kit facts",()=>{
  expect(unsupportedKitClaims("Canon EF 16-35mm f2.8 includes an EF-to-L adapter included with your camera and a charger.",evidence).map(f=>f.content)).toEqual(["charger"]);
  expect(unsupportedKitClaims("Canon EF 16-35mm f2.8 uses the EF-to-L adapter included with your camera kit with 2 PL-to-L adapters.",evidence).map(f=>f.content)).toEqual(["adapter"]);
  expect(unsupportedKitClaims("Canon EF 16-35mm f2.8 includes the Blackmagic 6K Full Frame adapter.",evidence)).not.toEqual([]);
 });
});
describe("an alternative lens using the booked camera's supplied adapter",()=>{
 const camera={names:["BMPCC 6K Full Frame"],contents:["Canon EF-to-L mount adapter"],booked_camera:true};
 const lens={names:["Canon EF 16-35mm f2.8"],contents:["Canon EF 16-35mm f2.8"]};
 const text="As a compatible alternative, I have the Canon EF 16-35mm f2.8 available for 20 to 21 October (which fits right onto the EF-to-L adapter included with your camera).";
 it("attributes the expressly booked-camera component separately from the named alternative",()=>expect(unsupportedKitClaims(text,[camera,lens])).toEqual([]));
 it("requires an actual booked camera, correct mount pair and unambiguous camera record",()=>{
  expect(unsupportedKitClaims(text,[{...camera,booked_camera:false},lens])).toHaveLength(1);
  expect(unsupportedKitClaims(text.replace("EF-to-L adapter","PL-to-L adapter"),[camera,lens])).toHaveLength(1);
  expect(unsupportedKitClaims(text.replace("EF-to-L adapter","EF-to-E adapter"),[camera,lens])).toHaveLength(1);
  expect(unsupportedKitClaims(text,[camera,lens,{names:["Sony FX3"],contents:["PL-to-E adapter"],booked_camera:true}])).toHaveLength(1);
  expect(unsupportedKitClaims(text.replace("your camera","the lens"),[camera,lens])).toHaveLength(1);
 });
 it("keeps other alternative-kit components separate",()=>{
  expect(unsupportedKitClaims("Canon EF 16-35mm f2.8 includes a case and an EF-to-L adapter included with your camera.",[camera,lens]).map(f=>f.content)).toEqual(["case"]);
 });
});
describe("per-item included-content claims", () => {
  it("checks the actual multiline inclusion list instead of only its empty heading", () => {
    const text = "Sony A7 V is available.\n\nThe kit includes:\n- NP-FZ100 batteries (plus charger)\n- 256GB card\n\nLet me know if you would like it.";
    expect(unsupportedKitClaims(text, [kit]).map(f => f.content)).toEqual(["charger"]);
    expect(unsupportedKitClaims(text.replace("includes:\n", "includes:\n\n"), [kit]).map(f => f.content)).toEqual(["charger"]);
    expect(unsupportedKitClaims(text.replace(" (plus charger)", ""), [kit])).toEqual([]);
  });
  it("rejects an unlisted charger even though batteries and a card are known", () => {
    expect(unsupportedKitClaims("Sony A7 V is £110. That includes the body, batteries, charger, and a 256GB card.", [kit]).map(f => f.content)).toEqual(["charger"]);
  });
  it("also checks contents stated before the word included", () => {
    expect(unsupportedKitClaims("Sony A7 V charger included at no extra cost.", [kit]).map(f => f.content)).toEqual(["charger"]);
  });
  it("accepts actual included contents and preserves negative qualifications", () => {
    expect(unsupportedKitClaims("Sony A7 V comes with batteries and a card, but not a charger.", [kit])).toEqual([]);
    expect(unsupportedKitClaims("Sony A7 V does not include a charger.", [kit])).toEqual([]);
  });
  it("does not borrow a different model's inclusions", () => {
    const other = { names: ["Sony FX3"], contents: ["charger"] };
    expect(unsupportedKitClaims("Sony A7 V includes a charger.", [kit, other]).map(f => f.content)).toEqual(["charger"]);
  });
  it("requires the recorded battery type and individual count", () => {
    const bm = { names: ["Blackmagic 6K Full Frame"], contents: ["5 × NP-F570 batteries", "1 × 1TB CFexpress Type B card"] };
    expect(unsupportedKitClaims("Blackmagic 6K Full Frame includes five NP-F570 batteries and a 1TB CFexpress Type B card.", [bm])).toEqual([]);
    expect(unsupportedKitClaims("Blackmagic 6K Full Frame includes 5 × NP-F570 batteries and 1 × 1TB CF Express B card.", [bm])).toEqual([]);
    expect(unsupportedKitClaims("Blackmagic 6K Full Frame includes six NP-F570 batteries.", [bm]).map(f => f.content)).toEqual(["battery"]);
    expect(unsupportedKitClaims("Blackmagic 6K Full Frame includes three NP-F570 batteries.", [bm]).map(f => f.content)).toEqual(["battery"]);
    expect(unsupportedKitClaims("Blackmagic 6K Full Frame includes five LP-E6NH batteries.", [bm]).map(f => f.content)).toEqual(["battery"]);
  });
  it("does not infer individual batteries from ambiguous sets", () => {
    const sony = { names: ["Sony FX3"], contents: ["Sony NP-FZ100 batteries 2x sets"] };
    expect(unsupportedKitClaims("Sony FX3 includes two NP-FZ100 batteries.", [sony]).map(f => f.content)).toEqual(["battery"]);
    expect(unsupportedKitClaims("Sony FX3 includes NP-FZ100 batteries.", [sony])).toEqual([]);
  });
  it("checks storage interface, capacity and count without adding duplicate descriptions", () => {
    const bm = { names: ["Blackmagic 6K Full Frame"], contents: ["1 × 1TB CFexpress Type B card", "CFexpress Type B card"] };
    for (const contents of ["a 1TB CFast card", "a 1TB CFexpress Type A card", "a 2TB CFexpress Type B card", "two CFexpress Type B cards"]) {
      expect(unsupportedKitClaims(`Blackmagic 6K Full Frame includes ${contents}.`, [bm]).map(f => f.content)).toEqual(["card"]);
    }
  });
  it("does not combine attributes from different supplied cards", () => {
    const mixed = { names: ["Sony FX3"], contents: ["1 × 256GB CFexpress Type A card", "1 × 1TB SD card"] };
    expect(unsupportedKitClaims("Sony FX3 includes a 1TB CFexpress Type A card.", [mixed]).map(f => f.content)).toEqual(["card"]);
    expect(unsupportedKitClaims("Sony FX3 includes a 256GB CFexpress Type A card and a 1TB SD card.", [mixed])).toEqual([]);
  });
  it("attributes Roman numeral model names exactly", () => {
    const older = { names: ["Sony A7 II"], contents: ["NP-FW50 batteries"] };
    const newer = { names: ["Sony A7 III"], contents: ["NP-FZ100 batteries"] };
    expect(unsupportedKitClaims("Sony A7 III includes NP-FZ100 batteries.", [older, newer])).toEqual([]);
    expect(unsupportedKitClaims("Sony A7 II includes NP-FZ100 batteries.", [older, newer]).map(f => f.content)).toEqual(["battery"]);
  });
  it("preserves actual-kit clarification without treating excluded types as inclusions", () => {
    const bm = { names: ["Blackmagic 6K Full Frame"], contents: ["5 × NP-F570 batteries", "1 × 1TB CFexpress Type B card"] };
    const text = "Blackmagic 6K Full Frame comes with 5x NP-F570 batteries (the native battery type for this camera, not LP-E6) and 1x 1TB CFexpress Type B card (the 6K FF uses CFexpress Type B rather than CFast).";
    expect(unsupportedKitClaims(text, [bm])).toEqual([]);
    expect(unsupportedKitClaims("Blackmagic 6K Full Frame includes a 1TB CFexpress Type B card, not a 2TB CFast card.", [bm])).toEqual([]);
    expect(unsupportedKitClaims("Blackmagic 6K Full Frame includes a 2TB CFast card, not a 1TB CFexpress Type B card.", [bm]).map(f => f.content)).toEqual(["card"]);
  });
});


describe("established camera identity aliases in mixed kits", () => {
  const ff = { names: renterItemNames("BMPCC 6K Full Frame"), contents: ["NP-F570 batteries 5x", "1x 1TB CFexpress Type B card", "Canon EF-to-L mount adapter"] };
  const pro = { names: renterItemNames("BMPCC 6K Pro"), contents: ["5x NP-F570 battery", "1x 1TB SSD", "1x camera cage"] };
  it("accepts the actual Full Frame shorthand with several other kits in context", () => {
    expect(unsupportedKitClaims("That exact Blackmagic 6K Full Frame kit comes with 5x NP-F570 batteries, a 1TB CFexpress Type B card, and a Canon EF-to-L mount adapter.", [ff, pro])).toEqual([]);
  });
  it("keeps the two camera variants' storage and accessories separate", () => {
    expect(unsupportedKitClaims("Blackmagic 6K Full Frame comes with a 1TB SSD and a camera cage.", [ff, pro])).not.toEqual([]);
    expect(unsupportedKitClaims("Blackmagic 6K Pro includes a 1TB CFexpress Type B card.", [ff, pro])).not.toEqual([]);
  });
  it("never expands a comparison model from advertising prose", () => {
    const advertising = "BMPCC 6K Full Frame Set (like Canon R5C / Sony FX3)";
    expect(renterItemNames(advertising)).toEqual([advertising]);
    expect(renterItemNames("BMPCC 6K Full Frame")).not.toContain("Blackmagic 6K Pro");
  });
});

it("seeds this-kit references from the selected request instead of unrelated alternatives", () => {
  const ff = { names: renterItemNames("BMPCC 6K Full Frame"), contents: ["NP-F570 batteries 5x", "1x 1TB CFexpress Type B card", "Canon EF-to-L mount adapter"] };
  const sony = { names: ["Sony A7 V"], contents: ["NP-FZ100 batteries", "256GB card"] };
  const text = "For this kit, our records include 5x NP-F570 batteries and 1x 1TB CFexpress Type B card (along with a Canon EF-to-L mount adapter).";
  expect(unsupportedKitClaims(text, [ff, sony], ["BMPCC 6K Full Frame"])).toEqual([]);
  expect(unsupportedKitClaims(text, [ff, sony])).not.toEqual([]);
  expect(unsupportedKitClaims("This kit includes NP-FZ100 batteries.", [ff, sony], ["BMPCC 6K Full Frame"])).not.toEqual([]);
});
it("keeps built-in ND out of the physical accessory check", () => {
  const pro = { names: renterItemNames("BMPCC 6K Pro"), contents: ["5x NP-F570 batteries", "1TB SSD", "camera cage"] };
  expect(unsupportedKitClaims("Blackmagic 6K Pro comes with NP-F570 batteries, a 1TB SSD and a camera cage (native EF, built-in ND filters).", [pro])).toEqual([]);
  expect(unsupportedKitClaims("Blackmagic 6K Pro comes with an external ND filter.", [pro])).not.toEqual([]);
});
it("checks set counts without treating sets as individual batteries",()=>{
 const e=[{names:["Sony A7 II"],contents:["Sony NP-FW50 batteries 2x sets","256GB card"]}];
 expect(unsupportedKitClaims("The Sony A7 II includes two sets of NP-FW50 batteries and a 256GB card.",e)).toEqual([]);
 expect(unsupportedKitClaims("The Sony A7 II includes three sets of NP-FW50 batteries.",e)).toHaveLength(1);
 expect(unsupportedKitClaims("The Sony A7 II includes two NP-FW50 batteries.",e)).toHaveLength(1);
 expect(unsupportedKitClaims("The Sony A7 II includes a 256GB SD card.",e)).toHaveLength(1);
});
