import { describe, it, expect } from "vitest";
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
