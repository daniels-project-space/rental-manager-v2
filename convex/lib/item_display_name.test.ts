import { describe, expect, it } from "vitest";
import { listingDisplayName, shortItemName, shortListingTitle } from "./item_display_name";
const items = new Map([
  ["ff", { _id: "ff", name_canonical: "BMPCC 6K Full Frame", kind: "camera" }],
  ["pro", { _id: "pro", name_canonical: "BMPCC 6K Pro", kind: "camera" }],
  ["fx3", { _id: "fx3", name_canonical: "Sony FX3", kind: "camera" }],
  ["lens", { _id: "lens", name_canonical: "Sony GM 24-70mm f2.8", kind: "lens" }],
  ["card", { _id: "card", name_canonical: "256GB card", kind: "storage_card" }],
]);
describe("shared item presentation identity", () => {
  it("keeps distinguishing Full Frame, Pro and 4K model words", () => {
    expect(shortListingTitle("BMPCC 6K Full Frame | like Sony FX3 / 4K camera")).toBe("BMPCC 6K Full Frame");
    expect(shortListingTitle("ViewSonic 4K Projector + screen")).toBe("ViewSonic 4K Projector");
    expect(shortListingTitle("BMPCC 6K Pro + lenses")).toBe("BMPCC 6K Pro");
  });
  it("uses exact mapped identity even when the advertising title names another model", () => {
    expect(listingDisplayName("Sony FX3 / Sony A7 V | like Canon R5", { components: [{ item_id: "ff", qty: 1 }] }, items)).toBe("BMPCC 6K Full Frame");
  });
  it("retains quantities and lens models, without bundled-card clutter", () => {
    expect(listingDisplayName("SEO blob", { components: [{ item_id: "lens", qty: 2 }, { item_id: "fx3", qty: 2 }, { item_id: "card", qty: 4 }] }, items)).toBe("2× Sony FX3 + 2× Sony 24-70mm f2.8 GM");
  });
  it("cannot turn a missing or marketing mapping into an owned item", () => {
    for (const components of [[], [{ item_id: "missing", qty: 1 }]]) expect(listingDisplayName("RED Komodo | like Sony FX3", { components }, items)).toBe("RED Komodo");
  });
  it("preserves manual labels and explicit item names", () => {
    expect(listingDisplayName("SEO", { components: [{ item_id: "pro", qty: 1 }] }, items, "Owner's Pro kit")).toBe("Owner's Pro kit");
    expect(shortItemName({ _id: "x", name_canonical: "GoPro 12 Hero", display_name: "HERO12 body" })).toBe("HERO12 body");
    expect(shortItemName("DJI Osmo Action Pro 5")).toBe("DJI Osmo Action 5 Pro");
  });
  it("does not borrow a comparison model or GM branding from marketing copy", () => {
    expect(shortListingTitle("Sigma art 24-70mm f2.8 lens Sony e mount gm gmaster full frame cinema")).toBe("Sigma 24-70mm f/2.8 Art");
    expect(shortListingTitle("Sony a7 IV 4k camera full frame body set Sony a74 a7iv")).toBe("Sony A7 IV");
    expect(shortListingTitle("Sony A7S III camera | like Sony FX3")).toBe("Sony A7S III");
    expect(shortItemName("Sony GM 90mm f2.8")).toBe("Sony 90mm f/2.8 Macro G OSS");
  });
});
