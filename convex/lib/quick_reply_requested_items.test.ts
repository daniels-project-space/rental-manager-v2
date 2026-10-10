import { displayImageMappings } from "./listing_display_catalog";
import { describe, it, expect } from "vitest";
import {
  requestedImageItems,
  requestedDisplayMatch,
} from "./quick_reply_requested_items";
const catalogue = [
  { name_canonical: "Sony FX6", aliases: ["FX6"], image_url: "/fx6" },
  { name_canonical: "Sigma 24-70", image_url: "/lens" },
  { name_canonical: "Sony FX3", aliases: ["FX3"] },
];
describe("requested equipment image context", () => {
  it("keeps quantities for multiple basket lines of the same model", () =>
    expect(
      requestedImageItems(
        [
          { name: "Sony FX6", qty: 1, image_url: null },
          { name: "FX6", qty: 2, image_url: null },
        ],
        [],
        [],
        catalogue,
      )[0].qty,
    ).toBe(3));
  it("retains every basket line and supplements images from catalogue", () => {
    const lines = Array.from({ length: 9 }, (_, i) => ({
      name: i ? `Item ${i}` : "Sony FX6",
      qty: 2,
      image_url: null,
    }));
    const result = requestedImageItems(lines, [], [], catalogue);
    expect(result).toHaveLength(9);
    expect(result[0]).toMatchObject({
      image_url: "/fx6",
      qty: 2,
      origin: "basket",
    });
    expect(lines[0].image_url).toBeNull();
  });
  it("includes enquiry snapshots and additional exact models mentioned in chat", () =>
    expect(
      requestedImageItems(
        [{ name: "Sony FX6", qty: 1, image_url: null }],
        [],
        ["Can I also rent the Sigma 24-70 and FX3?"],
        catalogue,
      ).map((i) => [i.name, i.origin]),
    ).toEqual([
      ["Sony FX6", "basket"],
      ["Sigma 24-70", "chat"],
      ["Sony FX3", "chat"],
    ]));
  it("deduplicates aliases without changing booked quantity", () =>
    expect(
      requestedImageItems(
        [{ name: "Sony FX6", qty: 2, image_url: null }],
        [{ name: "FX6", qty: 1, image_url: null }],
        ["FX6 please"],
        catalogue,
      ),
    ).toHaveLength(1));
  it("does not match substrings, generic nouns or ambiguous aliases", () =>
    expect(
      requestedImageItems(
        [],
        [],
        ["camera FX30 mini"],
        [
          ...catalogue,
          { name_canonical: "Other model", aliases: ["camera", "FX3"] },
        ],
      ),
    ).toEqual([]));
  it("includes captured inquiry items even without catalogue evidence", () =>
    expect(
      requestedImageItems(
        [],
        [{ name: "Imported light", qty: 3, image_url: "/light" }],
        [],
        [],
      )[0],
    ).toMatchObject({ name: "Imported light", qty: 3, origin: "chat" }));
});

describe("exact equipment image identity", () => {
  it("resolves reordered Osmo model tokens for images only", () => {
    const model = {
      name_canonical: "DJI Osmo Action 5 Pro",
      image_url: "/osmo",
    };
    expect(requestedDisplayMatch("DJI Osmo Action Pro 5", [model])).toBe(model);
    expect(requestedDisplayMatch("DJI Osmo Action Pro 4", [model])).toBeNull();
    expect(requestedDisplayMatch("Osmo Action Pro 5", [model])).toBeNull();
  });
  it("does not choose between ambiguous reordered names", () => {
    expect(
      requestedDisplayMatch("DJI Osmo Action Pro 5", [
        { name_canonical: "DJI Osmo Action 5 Pro" },
        { name_canonical: "DJI Action 5 Osmo Pro" },
      ]),
    ).toBeNull();
  });
  it("retains all exact image fallback sources on repeated mentions", () => {
    const rows = requestedImageItems(
      [{ name: "Sony FX6", qty: 1, image_url: "/old" }],
      [{ name: "FX6", qty: 1, image_url: "/fresh", image_urls: ["/second"] }],
      [],
      catalogue,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].image_urls).toEqual(["/old", "/fx6", "/fresh", "/second"]);
  });
});

describe("exact mapped model image fallback", () => {
  const map = (
    id: number,
    components: Array<{ item_id: string; qty: number }>,
    account_slug = "leo",
  ) => ({ product_id: id, account_slug, components });
  it("falls back to real kit photographs for the exact model without confusing look-alikes", () => {
    const choices = displayImageMappings("fx3", "leo", [
      map(1, [{ item_id: "blackmagic", qty: 1 }]),
      map(3, [
        { item_id: "fx3", qty: 1 },
        { item_id: "lens", qty: 1 },
      ]),
      map(2, [{ item_id: "fx3", qty: 1 }]),
      map(4, [{ item_id: "fx30", qty: 1 }]),
    ]);
    expect(choices.map((c) => c.product_id)).toEqual([2, 3]);
  });
  it("accepts exact multi-copy mappings for display while preserving their quantities", () => {
    const original = map(5, [
      { item_id: "osmo5", qty: 2 },
      { item_id: "card", qty: 2 },
    ]);
    expect(displayImageMappings("osmo5", "leo", [original])).toEqual([
      original,
    ]);
    expect(original.components[0].qty).toBe(2);
  });
  it("prefers exact primary-model images over a kit that only contains that accessory", () => {
    expect(
      displayImageMappings("lens", "leo", [
        map(1, [
          { item_id: "camera", qty: 1 },
          { item_id: "lens", qty: 1 },
        ]),
        map(2, [
          { item_id: "lens", qty: 1 },
          { item_id: "card", qty: 1 },
        ]),
      ])[0].product_id,
    ).toBe(2);
  });
  it("excludes invalid quantities and bounds indexed image reads to two mappings", () => {
    const all = [
      map(0, [{ item_id: "fx3", qty: 0 }]),
      map(1, [{ item_id: "fx3", qty: NaN }]),
      ...Array.from({ length: 10 }, (_, i) =>
        map(i + 2, [{ item_id: "fx3", qty: 1 }]),
      ),
    ];
    expect(
      displayImageMappings("fx3", "leo", all).map((c) => c.product_id),
    ).toEqual([2, 3]);
  });
});
