import { describe, it, expect, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { computeAvailability } from "./replyInbox";
const gear = (id: string, name: string, qty = 1) => ({
  _id: id,
  name_canonical: name,
  qty,
  status: "active",
  kind: "camera",
});
function context(items: any[], extras: any = {}) {
  const stockSources = {
    items,
    reservations: [],
    productIndex: new Map(),
    overrides: new Map(),
    claims: [],
    blackouts: [],
    vacations: [],
    ...extras,
  };
  return {
    stockSources,
    confirmed: stockSources.reservations,
    pending: [],
    productIndex: stockSources.productIndex,
    overrideMap: stockSources.overrides,
    itemRows: items,
    includePending: false,
  } as any;
}
const booking = {
  start_date: "2026-10-12",
  end_date: "2026-10-13",
  account_slug: "fixture",
  hygglo_order_id: "fixture-order",
} as any;
const line = (name: string, qty = 1) => ({ name, qty, image_url: null });
describe("Quick Reply full-basket shared stock checks", () => {
  it("checks every requested item beyond the old six-item limit", () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      gear(String(i), `Gear ${i}`),
    );
    const result = computeAvailability(
      booking,
      context(items),
      items.map((i) => line(i.name_canonical)),
    );
    expect(result.items).toHaveLength(8);
    expect(result.items.every((i) => i.available === true)).toBe(true);
    expect(result.status).toBe("available");
  });
  it("retains unknown mappings alongside checked items", () => {
    const result = computeAvailability(
      booking,
      context([gear("a", "Camera")]),
      [line("Camera"), line("Unknown gear")],
    );
    expect(result.items.map((i) => i.available)).toEqual([true, null]);
    expect(result.items[1].reason).toContain("mapping");
    expect(result.status).toBe("unknown");
  });
  it("retains all inquiry items with an explicit missing-date reason", () => {
    const result = computeAvailability(null, context([gear("a", "Camera")]), [
      line("Camera"),
      line("Lens"),
    ]);
    expect(result.items).toHaveLength(2);
    expect(
      result.items.every((i) => i.reason === "Dates needed to check stock"),
    ).toBe(true);
  });
  it("aggregates overlapping demand within the requested basket", () => {
    const result = computeAvailability(
      booking,
      context([gear("a", "Camera")]),
      [line("Camera"), line("Camera")],
    );
    expect(result.items.map((i) => i.available)).toEqual([false, false]);
    expect(result.status).toBe("conflict");
  });
  it("uses shared owner blackouts", () => {
    const result = computeAvailability(
      booking,
      context([gear("a", "Camera")], {
        blackouts: [
          { item_id: "a", start_date: "2026-10-12", end_date: "2026-10-13" },
        ],
      }),
      [line("Camera")],
    );
    expect(result.status).toBe("conflict");
  });
  it("does not guess ambiguous canonical mappings", () => {
    const result = computeAvailability(
      booking,
      context([gear("a", "Camera"), gear("b", "Camera")]),
      [line("Camera")],
    );
    expect(result.status).toBe("unknown");
  });
  it("excludes the requesting booking from its own stock occupancy", () => {
    const reservation = {
      ...booking,
      _id: "r",
      status: "confirmed",
      order_step: "DELIVERED",
      resolved_items: [{ item_id: "a", qty: 1 }],
    };
    expect(
      computeAvailability(
        booking,
        context([gear("a", "Camera")], { reservations: [reservation] }),
        [line("Camera")],
      ).status,
    ).toBe("available");
  });
});
