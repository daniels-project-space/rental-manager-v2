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
