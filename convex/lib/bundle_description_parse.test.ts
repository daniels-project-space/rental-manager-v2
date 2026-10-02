import { describe, it, expect } from "vitest";
import { resolveBundleMapping } from "./bundle_mapping";
import { extractComponents } from "./bundle_description_parse";

/**
 * Every case below is REAL text from a live Hygglo listing that produced a
 * wrong mapping. These are regression tests, not illustrations: each one
 * failed before the corresponding fix, and a wrong result here means live
 * inventory would be held for gear that is actually on the shelf (or a rented
 * camera would read as free).
 */

const names = (d: string) => extractComponents(d).components.map((c) => c.name);
const qtyOf = (d: string, re: RegExp) =>
  extractComponents(d).components.find((c) => re.test(c.name))?.qty;

describe("extractComponents", () => {
  // diogo#1173566 — a 3-item kit followed by 25 lines of PAID add-ons. Parsing
  // the add-ons as included proposed 2x gimbal, a drone kit, two mic systems
  // and two filters for a £55 listing.
  const ADDONS = `I'm offering my powerful Blackmagic Pocket Cinema Camera 6K Pro alongside the industry-leading DJI RS 3 Pro gimbal for your next project. In this kit: * My Blackmagic Pocket Cinema Camera 6K Pro * My 1TB Samsung T5 SSD * My DJI RS 3 Pro Gimbal * 4x camera batteries * 1x DJI gimbal battery (upgradable) * 2x carrying cases * Various essential cables Direct Add-on Upgrades: * Upgrade to a Nanlite 500 Bi-color (2x lights) and 1x 300 setup for an additional 90/day. ADD-ONS Lights: * My 2x Nanlite 500 Bi-color key lights can be added for 50/day. Gimbals: * Add an additional DJI RS3 Pro gimbal for 25/day. Microphones: * My Sennheiser MKE 600 shotgun mic is available for 28/day.`;

  it("stops at the add-on section — paid extras are not part of the kit", () => {
    const out = names(ADDONS);
    expect(out.join(" | ")).not.toMatch(/nanlite|sennheiser|additional/i);
    // Only the real kit lines survive (cases/cables are non-tracked noise).
    expect(out).toHaveLength(5);
  });

  it("counts the gimbal once, not once per mention", () => {
    // "My DJI RS 3 Pro Gimbal" is included; "Add an additional DJI RS3 Pro
    // gimbal for 25/day" is an offer. Counting both gave 2x.
    const gimbals = extractComponents(ADDONS).components.filter((c) =>
      /gimbal/i.test(c.name),
    );
    expect(gimbals.every((g) => g.qty === 1)).toBe(true);
  });

  it("does not split product names that contain digits", () => {
    // "1x DJI RS 3 Pro Gimbal" split at the "3" and invented a phantom "3x".
    expect(qtyOf(ADDONS, /RS ?3/i)).toBe(1);
  });

  // diogo#1173807 — bullets are dashes here, and quantities are per-line.
  const DASHES = `In this kit: - Blackmagic BMPCC 6K Pro Digital Cinema Camera - 5x Camera Batteries - Canon 24-105mm f/4 USM Zoom Lens - 1x 2TB SSD - DJI RS 3 Pro Gimbal - 2x LED RGB Panel Lights (GVM, with stands)`;

  it("keeps per-line quantities from dash bullets", () => {
    expect(qtyOf(DASHES, /Camera Batteries/i)).toBe(5);
    expect(qtyOf(DASHES, /LED RGB/i)).toBe(2);
    expect(qtyOf(DASHES, /RS ?3/i)).toBe(1);
  });

  it("normalises model numbers so owned gear still matches", () => {
    // Inventory says "DJI RS3 Pro gimbal" and "Canon EF 24-105mm f4"; the
    // listing writes "RS 3" and "f/4", which tokenised differently and
    // silently dropped two genuinely-owned components.
    const joined = names(DASHES).join(" ");
    expect(joined).toMatch(/RS3/);
    expect(joined).toMatch(/f4/);
  });

  it("tags Blackmagic bodies with the BMPCC token used by inventory", () => {
    // "Blackmagic 6K Full Frame Cinema Camera body" has no "bmpcc" token, so
    // the CAMERA failed to match while its battery pack did — the listing
    // resolved to a battery pack alone.
    const out = names(
      `In this kit: * 1x Blackmagic 6K Full Frame Cinema Camera body * 1x Tilta camera cage * 3x NP-F570 batteries * 1x Lens mount cap`,
    );
    expect(out[0]).toMatch(/BMPCC/);
  });

  it("drops the marketing intro instead of parsing it as a component", () => {
    // "I'm offering a comprehensive, ready-to-shoot cinema kit" was parsed as
    // a component and matched "PL to EF mount" via the word "to".
    const out = names(ADDONS);
    expect(out.join(" ")).not.toMatch(/offering|ready-to-shoot/i);
  });

  it("treats a bullet with no leading number as exactly one", () => {
    // diogo writes both "1x Blackmagic ..." and "My Blackmagic ...".
    expect(qtyOf(ADDONS, /Samsung T5/i)).toBe(1);
  });

  it("falls back to the numeric split when there are no bullets", () => {
    const r = extractComponents(
      `Included in this rental: 1x Blackmagic Pocket Cinema Camera 6K Pro 2x V-mount batteries`,
    );
    expect(r.usedBullets).toBe(false);
    expect(r.components.length).toBeGreaterThan(0);
  });

  it("reports usedBullets so callers can decide whether to trust counts", () => {
    expect(extractComponents(DASHES).usedBullets).toBe(true);
  });

  it("returns nothing for an empty description rather than throwing", () => {
    expect(extractComponents("").components).toEqual([]);
  });
});


describe("actual Unicode catalogue contents", () => {
  it("keeps Unicode bullet boundaries and multiplication quantities", () => {
    const result = extractComponents("📦 Included in this rental: • 1× Blackmagic 6K Full Frame • 2× Canon 24-105mm lenses • 1× Carrying bag 🚀 About this kit Optional extras: 1x DJI RS3 Pro gimbal");
    expect(result.usedBullets).toBe(true);
    expect(result.components).toEqual([{qty:1,name:"Blackmagic BMPCC 6K Full Frame"},{qty:2,name:"Canon 24-105mm lenses"}]);
  });
  it("trusts two explicit bullets without requiring a third accessory", () => {
    const result = extractComponents("In this kit: • 1x BMPCC 6K Pro • 1x DJI RS 3 Pro Gimbal");
    expect(result.usedBullets).toBe(true);
    expect(result.components.map(c=>c.name)).toEqual(["BMPCC 6K Pro","DJI RS3 Pro Gimbal"]);
  });
  it("preserves an explicit shortage rather than reducing the listed units", () => {
    expect(extractComponents("Included in this rental: • 12× RGB lights • 1× Camera").components[0].qty).toBe(12);
  });
});


describe("inventory mapping from structured contents", () => {
  const camera = {_id:"body",name_canonical:"BMPCC 6K Full Frame",kind:"camera",qty:1,lens_mount:"L mount"};
  const lens = {_id:"zoom",name_canonical:"Canon EF 24-105mm f4",kind:"lens",qty:1,lens_mount:"Canon EF mount"};
  it("maps the whole actual Unicode kit instead of its body alone", () => {
    const result=resolveBundleMapping("⭐ Included in this rental: • 1x Blackmagic 6k Full frame cinema camera • 1x 24-105mm Cannon Zoom lens L series • 1x Carrying bag 🚀 About this kit",[camera,lens]);
    expect(result.structured).toBe(true);expect(result.unmatched).toEqual([]);
    expect(result.components.map(c=>[c.item_id,c.qty])).toEqual([["body",1],["zoom",1]]);
  });
  it("keeps required quantities higher than stock, including repeated explicit units", () => {
    const result=resolveBundleMapping("Included in this rental: • 1x BMPCC 6K Full Frame • 1x Canon EF 24-105mm f4 • 2x Canon EF 24-105mm f4",[camera,lens]);
    expect(result.components.find(c=>c.item_id==="zoom")?.qty).toBe(3);
  });
  it("retains a marketed component so the whole bundle cannot be falsely owned", () => {
    const marketed={_id:"market",name_canonical:"Anamorphic Great Joy lens 35mm",aliases:["Great Joy 35mm"],kind:"lens",qty:0};
    const result=resolveBundleMapping("Included in this kit: • 1x BMPCC 6K Full Frame • 1x Great Joy 35mm",[camera,marketed]);
    expect(result.components.some(c=>c.item_id==="market")).toBe(true);
  });
  it("does not substitute EF inventory for an explicitly RF lens", () => {
    const result=resolveBundleMapping("Included in this kit: • 1x BMPCC 6K Full Frame • 1x Canon RF 24-105mm f4",[camera,lens]);
    expect(result.components.some(c=>c.item_id==="zoom")).toBe(false);expect(result.unmatched).toHaveLength(1);
  });
  it("does not drop a gimbal because its component line also mentions a battery", () => {
    const gimbal={_id:"gimbal",name_canonical:"DJI RS3 Pro gimbal",kind:"gimbal",qty:2};
    const result=resolveBundleMapping("Included in this kit: • 1x BMPCC 6K Full Frame • 1x DJI RS3 Pro gimbal with battery",[camera,gimbal]);
    expect(result.components.some(c=>c.item_id==="gimbal")).toBe(true);
  });
});


it("resolves compact BMPCC names and CFexpress media in actual listings", () => {
  const camera={_id:"pro",name_canonical:"BMPCC 6K Pro",kind:"camera",qty:1};
  const result=resolveBundleMapping("Included in this rental: • 1x BMPCC6k Pro • 1x 1TB Lexar Professional CFexpress Type-B card • 1x Camera cage",[camera]);
  expect(result.components.map(c=>c.item_id)).toEqual(["pro"]);expect(result.unmatched).toEqual([]);
});


it("requires clarification when a contents line omits an aperture shared by two models", () => {
  const lenses=[{_id:"f4",name_canonical:"Canon EF 24-105mm f4",kind:"lens",qty:1},{_id:"f28",name_canonical:"Canon EF 24-105mm f2.8",kind:"lens",qty:1}];
  const result=resolveBundleMapping("Included in this kit: • 1x Canon 24-105mm lens • 1x Carrying bag",lenses);
  expect(result.components).toEqual([]);expect(result.unmatched).toHaveLength(1);
});


it("retains the live FX3 body list when its heading has no colon before a later policy note",()=>{
 const desc="The mighty Sony FX3 is the smallest netflix approved camera commercially avaliable on the market right now. ⭐️Included in this rental ⭐️ 1x Sony Fx3 Camera 1x 128gb V90 SD card 1x Cage 3x Batteries 1x carrying case Please kindly note: We always provide chargers with the equipment but only supply the needed cable if it is proprietary.";
 expect(extractComponents(desc).components).toContainEqual({qty:1,name:"Sony Fx3 Camera"});
 const inventory=[{_id:"fx3",name_canonical:"Sony FX3",kind:"camera",qty:4}];
 expect(resolveBundleMapping(desc,inventory)).toMatchObject({explicit:true,components:[{item_id:"fx3",qty:1}],unmatched:[]});
});
it("does not turn the live optional Sony XLR handle into mandatory kit stock",()=>{
 const desc="📦 Included in this Sony FX3 + 24–70 GM Rental Set Camera & Lens: • 1× Sony FX3 full-frame cinema camera • 1× Sony 24–70mm f/2.8 GM / G Master lens • 1× 256GB SanDisk Extreme Pro SD card Power: • 3× NP-FZ100 batteries • 1× dual battery charger Audio: • 1× Sony XLR top handle (built-in XLR audio interface) ( optional ) 🚀 About this FX3 Cinema Package This is a high-end, all-round cinema setup";
 expect(names(desc).join(" ")).not.toMatch(/XLR|About this/i);
 expect(names(desc).join(" ")).toMatch(/Sony FX3/);
});
