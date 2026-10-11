import { describe, it, expect, vi } from "vitest";
const fixtures = vi.hoisted(() => ({
  sources: { items: [{ _id: "physical-camera" }, { _id: "physical-lens" }] },
  result: {
    available: false,
    receipts: [
      { item_id: "physical-camera", available: false },
      { item_id: "physical-lens", available: true },
    ],
  },
}));
vi.mock("./lib/renter_stock", () => ({
  loadStockSources: vi.fn(async () => fixtures.sources),
}));
vi.mock("./lib/renter_order_stock", () => ({
  checkOrderRentalStock: vi.fn(async () => fixtures.result),
  resolveOrderPhysicalItems: vi.fn(async (_ctx, _account, lines) => ({
    items:
      lines[0].product_id === 99
        ? []
        : [
            {
              item_id:
                lines[0].product_id === 10
                  ? "physical-camera"
                  : "physical-lens",
            },
          ],
  })),
}));
import { loadStockSources } from "./lib/renter_stock";
import { checkOrderRentalStock } from "./lib/renter_order_stock";
import { check } from "./quick_reply_basket_stock";
const args = {
  account_slug: "leo",
  thread_id: "fixture",
  start: "2026-11-05",
  end: "2026-11-07",
  lines: [
    { name: "Camera", qty: 1, product_id: 10 },
    { name: "Camera bundle", qty: 1, product_id: 10 },
    { name: "Lens", qty: 1, product_id: 11 },
  ],
};
describe("fresh whole-basket stock line checks", () => {
  it("attributes joint component shortages to every affected listing using one stock snapshot", async () => {
    vi.clearAllMocks();
    const ctx = {
      runMutation: vi.fn(() => {
        throw Error("No writes allowed");
      }),
    };
    const result = await (check as any)._handler(ctx, {
      ...args,
      include_line_checks: true,
    });
    expect(result.line_checks).toEqual([
      { item_index: 0, available: false },
      { item_index: 1, available: false },
      { item_index: 2, available: true },
    ]);
    expect(loadStockSources).toHaveBeenCalledTimes(1);
    expect(checkOrderRentalStock).toHaveBeenCalledTimes(1);
    expect(checkOrderRentalStock).toHaveBeenCalledWith(
      ctx,
      args.account_slug,
      args.lines,
      args.start,
      args.end,
      args.thread_id,
      fixtures.sources,
    );
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });
  it("keeps an unresolved listing unknown instead of treating it as available", async () => {
    const result = await (check as any)._handler(
      {},
      {
        ...args,
        include_line_checks: true,
        lines: [{ name: "Unknown", qty: 1, product_id: 99 }],
      },
    );
    expect(result.line_checks).toEqual([{ item_index: 0, available: null }]);
  });
  it("keeps existing callers unchanged when line checks are not requested", async () => {
    expect(await (check as any)._handler({}, args)).toEqual(fixtures.result);
  });
});
