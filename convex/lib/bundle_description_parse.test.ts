import { describe, it, expect } from "vitest";
import { resolveBundleMapping } from "./bundle_mapping";
import { resolveListingComponents } from "./listing_inventory";
import cameraSpacing from "../fixtures/sony-camera-model-spacing.json";
import supportDescriptions from "../fixtures/bundled-support-accessories.json";
import fullDescriptions from "../fixtures/full-description-boundaries.json";
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


it("ignores plural quantity-prefixed headings without inventing flash inventory",()=>{
 const description="Included in this rental: • 1x Cameras: • 1x 3× DJI Osmo Action 5 Pro cameras • 1x Carrying bag About this item: Camera kit.";
 const inventory=[{_id:"action",name_canonical:"DJI Osmo Action Pro 5",kind:"camera"},{_id:"flash",name_canonical:"Camera flash",kind:"lighting"}];
 const parsed=extractComponents(description);expect(parsed.usedBullets).toBe(true);expect(parsed.components).toEqual([{qty:1,name:"3x DJI Osmo Action 5 Pro cameras"}]);
 const mapped=resolveBundleMapping(description,inventory);expect(mapped.components).toEqual([]);expect(mapped.unmatched).toEqual(["Ambiguous quantity: 1x 3x DJI Osmo Action 5 Pro cameras"]);
});
it("uses a single explicit bullet without splitting a digit-bearing product name",()=>{
 const description="Included in this rental: • 3x DJI Osmo Action 5 Pro cameras";
 expect(extractComponents(description)).toMatchObject({usedBullets:true,components:[{qty:3,name:"DJI Osmo Action 5 Pro cameras"}]});
 const mapped=resolveBundleMapping(description,[{_id:"action",name_canonical:"DJI Osmo Action Pro 5",kind:"camera"}]);
 expect(mapped).toMatchObject({structured:true,components:[{item_id:"action",qty:3}],unmatched:[]});
});


it("does not allocate a gimbal twice when its named carry case is also supplied",()=>{
 const description="Included in this rental: • 1x Sony FX3 • 1x DJI RS 3 Pro gimbal • 1x DJI RS 3 Pro carry case About this item: Cinema kit.";
 const inventory=[{_id:"fx3",name_canonical:"Sony FX3",kind:"camera"},{_id:"rs3",name_canonical:"DJI RS3 Pro gimbal",kind:"gimbal"}];
 expect(resolveBundleMapping(description,inventory)).toMatchObject({components:[{item_id:"fx3",qty:1},{item_id:"rs3",qty:1}],unmatched:[]});
 expect(extractComponents("Included in this rental: • Sony FX3 with DJI RS 3 Pro carry case").components).toHaveLength(1);
});


describe("full retained provider descriptions", () => {
  it.each(["881269", "1039965", "875984"] as const)("does not invent a contents heading from the optional-item footer in %s", id => {
    expect(extractComponents(fullDescriptions[id]).hasContentsSection).toBe(false);
  });
  it.each(["981778", "955170", "869038", "823200"] as const)("excludes catalogue and picture prose after the actual contents in %s", id => {
    const rows=names(fullDescriptions[id]);
    expect(rows.some(name=>/we (?:also offer|offer a variety)|what you see|weekend hires|drones|sliders \(motorized/i.test(name))).toBe(false);
  });
  it("retains true quantities on hyphen bullets after preserving newlines", () => {
    const rows=extractComponents(fullDescriptions["869038"]).components;
    expect(rows.find(c=>/GVM RGB/i.test(c.name))?.qty).toBe(2);
    expect(rows.some(c=>/^\d+x\s/.test(c.name))).toBe(false);
  });
  it.each(["1103081", "1097753"] as const)("excludes a protective case/pouch without excluding the real equipment in %s", id => {
    const rows=names(fullDescriptions[id]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(name=>/^protective case/i.test(name))).toBe(false);
  });
  it("preserves the first Camera contents and removes the singular Lens heading", () => {
    const rows=names(fullDescriptions["1122877"]);
    expect(rows.some(name=>/Sony A7 V/.test(name))).toBe(true);
    expect(rows.some(name=>/16-35mm/.test(name))).toBe(true);
    expect(rows.some(name=>/^Lens:$/i.test(name))).toBe(false);
  });
  it("still retains independently rented camera, lens and support equipment", () => {
    const rows=names("Included in this kit:\n- 1x Sony A7S III\n- 2x Sony 24-70mm GM lenses\n- 1x tripod\nWe also offer:\n- Drone");
    expect(rows).toEqual(["Sony A7S III", "Sony 24-70mm GM lenses", "tripod"]);
  });
});


describe("supplied hardware and independently tracked stock", () => {
  const tubes={_id:"tubes",name_canonical:"Nanlite Pavotube 30x II",kind:"lighting",qty:4,status:"active",is_marketing_only:false};
  it.each([["1048230",2],["1048231",4]] as const)("resolves actual PavoTube %s without inventing a clamp pool", (id,qty) => {
    const r=resolveBundleMapping(supportDescriptions[id],[tubes]);
    expect(r.components).toEqual([{item_id:"tubes",name:tubes.name_canonical,qty,kind:"lighting"}]);
    expect(r.unmatched).toEqual([]);
  });
  it("keeps an explicitly tracked clamp pool and its actual requested quantity", () => {
    const clamp={_id:"clamps",name_canonical:"Clamp",kind:"grip",qty:1,status:"active",is_marketing_only:false,track_independent_stock:true};
    const r=resolveBundleMapping(supportDescriptions["1048231"],[tubes,clamp]);
    expect(r.components.find(c=>c.item_id==="clamps")?.qty).toBe(4);
  });
  it("does not select a fuzzy C-stand proxy for supplied clamps", () => {
    const stand={_id:"stand",name_canonical:"C-stand",kind:"grip",aliases:["stand"],qty:1};
    expect(resolveBundleMapping(supportDescriptions["1048230"],[tubes,stand]).components.map(c=>c.item_id)).toEqual(["tubes"]);
  });
  it.each(["clamps","mounting clips","brackets","antennas","side handles","barn doors","soft diffusion","power adapters","charging case"])("treats only the whole supplied hardware line %s as incidental", name=>{
    expect(resolveBundleMapping("Included in this kit:\n- 1x "+name,[]).unmatched).toEqual([]);
    expect(resolveBundleMapping("Included in this kit:\n- 1x "+name+" with Sony FX3 camera",[]).unmatched.length).toBe(1);
  });
  it("retains unknown light stands and mount adapters for review", () => {
    const r=resolveBundleMapping("Included in this kit:\n- 1x Light stand\n- 1x PL to EF mount adapter",[]);
    expect(r.unmatched).toEqual(["1x Light stand","1x PL to EF mount adapter"]);
  });
  it("rejects ambiguous tracked clamp identities", () => {
    const clamp={name_canonical:"Clamp",kind:"grip",qty:4,track_independent_stock:true};
    const r=resolveBundleMapping(supportDescriptions["1048230"],[tubes,{...clamp,_id:"one"},{...clamp,_id:"two"}]);
    expect(r.unmatched).toContain("2x clamps");
  });
});


describe("bundled hardware listing safety", () => {
  const tubes={_id:"tubes",name_canonical:"Nanlite Pavotube 30x II",kind:"lighting",qty:4,status:"active",is_marketing_only:false};
  const clamp={_id:"clamps",name_canonical:"Studio clamp",aliases:["clamp"],kind:"grip",qty:1,status:"active",is_marketing_only:false,track_independent_stock:true};
  it("fails closed when a reviewed kit has too few of an independently tracked clamp pool", () => {
    const r=resolveListingComponents([tubes,clamp] as any,[{item_id:"tubes",qty:4},{item_id:"clamps",qty:1}],undefined,1,supportDescriptions["1048231"]);
    expect(r.complete).toBe(false);
    expect(r.coverage?.missing).toEqual([{item_id:"clamps",name:"Studio clamp",qty:4}]);
  });
  it("keeps marketing-only independently tracked hardware blocked", () => {
    const r=resolveListingComponents([tubes,{...clamp,is_marketing_only:true}] as any,[{item_id:"tubes",qty:4},{item_id:"clamps",qty:4}],undefined,1,supportDescriptions["1048231"]);
    expect(r.owned).toBe(false);
    expect(r.ownership_blockers[0]?.reason).toBe("marketing_only");
  });
  it("does not suppress an unknown named mounting bracket", () => {
    expect(resolveBundleMapping("Included in this kit:\n- 1x Sony camera mounting bracket",[]).unmatched).toEqual(["1x Sony camera mounting bracket"]);
  });
});


describe("equivalent Sony camera model spacing", () => {
  const fx3={_id:"fx3",name_canonical:"Sony FX3",kind:"camera_body",qty:2,status:"active",is_marketing_only:false};
  const fx30={_id:"fx30",name_canonical:"Sony FX30",kind:"camera_body",qty:1,status:"active",is_marketing_only:false};
  it("recognizes Sony fx 3 from the actual complete source description", () => {
    const r=resolveBundleMapping(cameraSpacing["1048271"],[fx3,fx30]);
    expect(r.components.find(c=>c.item_id==="fx3")?.qty).toBe(1);
    expect(r.unmatched).not.toContain("1x Sony fx 3");
  });
  it("preserves model digits and real requested quantities", () => {
    const r=resolveBundleMapping("Included in this kit:\n- 2x Sony fx 3\n- 1x Sony FX30",[fx3,fx30]);
    expect(r.components.map(c=>({id:c.item_id,qty:c.qty}))).toEqual([{id:"fx3",qty:2},{id:"fx30",qty:1}]);
  });
  it("does not map FX30 or FX6 to FX3 when their physical pools do not exist", () => {
    expect(resolveBundleMapping("Included in this kit:\n- 1x Sony fx 30\n- 1x Sony FX6",[fx3]).unmatched).toEqual(["1x Sony fx 30","1x Sony FX6"]);
  });
  it("preserves the marketing blocker for a real advertised different model", () => {
    const r=resolveListingComponents([fx3,{...fx30,is_marketing_only:true}] as any,[{item_id:"fx3",qty:1}],undefined,1,"Included in this kit:\n- 1x Sony fx 30");
    expect(r.owned).toBe(false);
    expect(r.ownership_blockers[0]?.reason).toBe("marketing_only");
  });
});
