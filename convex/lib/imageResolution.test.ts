/**
 * Unit tests for image-resolution helpers.
 * Run: npx tsx --test convex/lib/imageResolution.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  basenameFromUrl,
  buildSharedImageBlacklist,
  normaliseItemName,
  resolveImageForReservationItem,
  type ImageHint,
} from "./imageResolution.js";

function hint(over: Partial<ImageHint> = {}): ImageHint {
  return {
    item_name: "Sony A7",
    item_name_normalised: "sony a7",
    image_url: "https://cdn.example.com/products/sony-a7.jpg",
    source: "hygglo_per_item",
    ...over,
  };
}

describe("normaliseItemName", () => {
  it("lowercases + collapses whitespace", () => {
    assert.equal(normaliseItemName("Sony  A7  III"), "sony a7 iii");
  });
  it("collapses dashes/underscores/slashes", () => {
    assert.equal(normaliseItemName("Sony-A7_III/Camera"), "sony a7 iii camera");
  });
  it("strips leading 2x prefix", () => {
    assert.equal(normaliseItemName("2x Sony A7"), "sony a7");
    assert.equal(normaliseItemName("3X Sony A7"), "sony a7");
    assert.equal(normaliseItemName("10x Sony A7"), "sony a7");
  });
  it("trims", () => {
    assert.equal(normaliseItemName("  Sony A7  "), "sony a7");
  });
  it("empty input returns empty string", () => {
    assert.equal(normaliseItemName(""), "");
  });
});

describe("basenameFromUrl", () => {
  it("strips query string", () => {
    assert.equal(
      basenameFromUrl("https://cdn.example.com/products/foo.jpg?w=200"),
      "foo.jpg",
    );
  });
  it("strips fragment", () => {
    assert.equal(basenameFromUrl("https://x/a/b.png#anchor"), "b.png");
  });
  it("handles URL with no path", () => {
    assert.equal(basenameFromUrl("foo.jpg"), "foo.jpg");
  });
});

describe("buildSharedImageBlacklist", () => {
  it("flags basenames appearing on >=2 items", () => {
    const set = buildSharedImageBlacklist([
      { image_url: "https://x/a.jpg" },
      { image_url: "https://y/a.jpg?w=1" },
      { image_url: "https://z/b.jpg" },
    ]);
    assert.equal(set.has("a.jpg"), true);
    assert.equal(set.has("b.jpg"), false);
  });
  it("ignores nullish image_url", () => {
    const set = buildSharedImageBlacklist([
      { image_url: null },
      { image_url: undefined },
      { image_url: "https://x/a.jpg" },
    ]);
    assert.equal(set.size, 0);
  });
});

describe("resolveImageForReservationItem", () => {
  const blacklist = new Set<string>();

  it("exact item_name match wins", () => {
    const r = resolveImageForReservationItem({
      imageHints: [hint({ item_name: "Sony A7", image_url: "https://x/exact.jpg" })],
      itemName: "Sony A7",
      sharedBlacklist: blacklist,
    });
    assert.equal(r.source, "hint_exact");
    assert.equal(r.confidence, 1.0);
    assert.equal(r.url, "https://x/exact.jpg");
  });

  it("normalised match wins over items_table", () => {
    const r = resolveImageForReservationItem({
      imageHints: [
        hint({
          item_name: "Sony A7 III Camera",
          item_name_normalised: "sony a7 iii camera",
          image_url: "https://x/norm.jpg",
        }),
      ],
      itemName: "Sony-A7_III/Camera", // normalises to same key
      itemsTableEntry: { image_url: "https://x/table.jpg" },
      resolvedConfidence: 1.0,
      sharedBlacklist: blacklist,
    });
    assert.equal(r.source, "hint_normalised");
    assert.equal(r.confidence, 0.95);
    assert.equal(r.url, "https://x/norm.jpg");
  });

  it("2x prefix stripped: 2x Sony A7 matches Sony A7 hint", () => {
    const r = resolveImageForReservationItem({
      imageHints: [
        hint({
          item_name: "Sony A7",
          item_name_normalised: "sony a7",
          image_url: "https://x/sony.jpg",
        }),
      ],
      itemName: "2x Sony A7",
      sharedBlacklist: blacklist,
    });
    assert.equal(r.source, "hint_normalised");
    assert.equal(r.url, "https://x/sony.jpg");
  });

  it("items_table fallback used when resolverConfidence>=0.8 and not blacklisted", () => {
    const r = resolveImageForReservationItem({
      imageHints: [],
      itemName: "Mystery Item",
      itemsTableEntry: { image_url: "https://x/unique.jpg" },
      resolvedConfidence: 0.9,
      sharedBlacklist: new Set<string>(),
    });
    assert.equal(r.source, "items_table");
    assert.equal(r.confidence, 0.7);
    assert.equal(r.url, "https://x/unique.jpg");
  });

  it("items_table BLOCKED when basename is in shared-blacklist", () => {
    const r = resolveImageForReservationItem({
      imageHints: [],
      itemName: "Mystery Item",
      itemsTableEntry: { image_url: "https://x/shared.jpg" },
      resolvedConfidence: 1.0,
      sharedBlacklist: new Set(["shared.jpg"]),
    });
    assert.equal(r.source, "placeholder");
    assert.equal(r.url, null);
  });

  it("items_table BLOCKED when resolverConfidence<0.8", () => {
    const r = resolveImageForReservationItem({
      imageHints: [],
      itemName: "Mystery Item",
      itemsTableEntry: { image_url: "https://x/u.jpg" },
      resolvedConfidence: 0.7,
      sharedBlacklist: new Set<string>(),
    });
    assert.equal(r.source, "placeholder");
  });

  it("placeholder when nothing resolves", () => {
    const r = resolveImageForReservationItem({
      imageHints: [],
      itemName: "Nothing",
      sharedBlacklist: blacklist,
    });
    assert.equal(r.source, "placeholder");
    assert.equal(r.confidence, 0);
    assert.equal(r.url, null);
  });
});
