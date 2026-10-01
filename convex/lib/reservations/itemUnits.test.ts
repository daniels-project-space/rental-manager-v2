import { describe, expect, it } from "vitest";
import { reservationItemUnits, type OverrideMap } from "./itemUnits";
const overrides: OverrideMap = new Map([
  ["leo#1", [{ item_id: "camera", qty: 2 }, { item_id: "lens", qty: 2 }]],
  ["leo#2", [{ item_id: "gopro", qty: 3 }]],
]);
describe("held units from fully mapped listing quantities", () => {
  it("counts two reserved kits as four cameras and four lenses", () => {
    expect(Object.fromEntries(reservationItemUnits({ account_slug: "leo", hygglo_items: [{ product_id: 1, qty: 2 }] }, new Map(), overrides)))
      .toEqual({ camera: 4, lens: 4 });
  });
  it("does not multiply the title's built-in unit count a second time", () => {
    const units = reservationItemUnits({ account_slug: "leo", hygglo_items: [{ name: "3x GoPro set", product_id: 2 }] }, new Map(), overrides);
    expect(units.get("gopro")).toBe(3);
  });
  it("combines the same physical item across multiple reserved lines", () => {
    const units = reservationItemUnits({ account_slug: "leo", hygglo_items: [{ product_id: 1 }, { product_id: 1, qty: 2 }] }, new Map(), overrides);
    expect(units.get("camera")).toBe(6);
  });
  it("authoritative mappings replace a stale expanded primary lens", () => {
    const units = reservationItemUnits({ account_slug: "leo", expanded_items: [{ item_id: "wrong lens", qty: 1 }], hygglo_items: [{ product_id: 1, qty: 2 }] }, new Map(), overrides);
    expect(units.has("wrong lens")).toBe(false);
    expect(units.get("lens")).toBe(4);
  });
});
