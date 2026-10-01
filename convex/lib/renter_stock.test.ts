import { describe, it, expect } from "vitest";
import { evaluateStockWindow, stockWindowPeak, validIsoDate } from "./renter_stock";

const request = { item_name: "Sony FX3", start_date: "2026-10-02", end_date: "2026-10-04" };
const evaluate = (overrides: Partial<Parameters<typeof evaluateStockWindow>[0]> = {}) => evaluateStockWindow({ request, owned: true, total: 4, repair: 0, occupancy: [], blackouts: [], vacations: [], ...overrides });
const hire = (qty: number, renter_name = "A") => ({ start: "2026-10-02T00:00", end: "2026-10-05T00:00", qty, renter_name });

describe("renter stock verdicts", () => {
  it("never rents marketing or inactive stock even with no competing bookings", () => {
    expect(evaluate({ owned: false }).available).toBe(false);
    expect(evaluate({ owned: false }).reason).toBe("not_rentable");
  });
  it("allows remaining units when another rental overlaps", () => {
    expect(evaluate({ occupancy: [hire(1)] }).free_units).toBe(3);
    expect(evaluate({ occupancy: [hire(1)] }).available).toBe(true);
  });
  it("checks the quantity the renter requests rather than any free unit", () => {
    expect(evaluate({ occupancy: [hire(3)], request: { ...request, quantity: 2 } }).available).toBe(false);
  });
  it("deducts multi-unit bookings and independent renters", () => {
    expect(evaluate({ occupancy: [hire(2), hire(1, "B")] }).free_units).toBe(1);
  });
  it("counts an extension once, preserving a larger extended quantity", () => {
    expect(evaluate({ occupancy: [hire(1), hire(2)] }).free_units).toBe(2);
  });
  it("does not total rentals that do not overlap each other", () => {
    const occupancy = [{ ...hire(3), end: "2026-10-03T00:00" }, { ...hire(3, "B"), start: "2026-10-03T00:00" }];
    expect(evaluate({ occupancy }).free_units).toBe(1);
  });
  it("checks every day including a later conflict", () => {
    expect(evaluate({ occupancy: [{ ...hire(4), start: "2026-10-04T00:00" }] }).available).toBe(false);
  });
  it("deducts repairs", () => {
    expect(evaluate({ repair: 3, occupancy: [hire(1)] }).available).toBe(false);
  });
  it("honors item blackouts and global vacations", () => {
    expect(evaluate({ blackouts: [{ start_date: "2026-10-03", end_date: "2026-10-03" }] }).reason).toBe("owner_blocked");
    expect(evaluate({ vacations: [{ start_date: "2026-10-04", end_date: "2026-10-06" }] }).reason).toBe("owner_away");
  });
  it("allows a same-day handover only after the actual buffered return", () => {
    const occupancy = [{ ...hire(1), end: "2026-10-02T12:00" }];
    expect(evaluate({ total: 1, occupancy, request: { ...request, pickup_time: "11:59" } }).available).toBe(false);
    expect(evaluate({ total: 1, occupancy, request: { ...request, pickup_time: "12:00" } }).available).toBe(true);
  });
  it("does not count a booking outside the requested window", () => {
    expect(evaluate({ occupancy: [{ ...hire(4), start: "2026-10-05T00:00", end: "2026-10-06T00:00" }] }).available).toBe(true);
  });
  it.each(["2026-02-30", "2026-13-01", "tomorrow", "2026-10-2"])("rejects invalid date %s rather than claiming free", (date) => {
    expect(validIsoDate(date)).toBe(false);
    expect(evaluate({ request: { ...request, start_date: date } }).available).toBeNull();
  });
  it("rejects reversed, excessively long and invalid-time windows", () => {
    expect(evaluate({ request: { ...request, end_date: "2026-10-01" } }).available).toBeNull();
    expect(evaluate({ request: { ...request, end_date: "2028-01-01" } }).available).toBeNull();
    expect(evaluate({ request: { ...request, pickup_time: "25:00" } }).available).toBeNull();
  });
  it("never implies available when requested stock quantity is invalid", () => {
    expect(evaluate({ request: { ...request, quantity: 0 } }).available).toBeNull();
    expect(evaluate({ request: { ...request, quantity: 1.5 } }).available).toBeNull();
  });
  it("has no arbitrary calendar horizon that can hide later bookings", () => {
    expect(evaluate({ request: { ...request, end_date: "2027-01-01" }, occupancy: [{ ...hire(4), start: "2026-12-01T00:00", end: "2026-12-02T00:00" }] }).available).toBe(false);
  });
  it("reports no competing renter identity in the tool result", () => {
    expect(JSON.stringify(evaluate({ occupancy: [hire(1, "Private customer")] }))).not.toContain("Private customer");
  });
  it("does not merge unnamed renters", () => {
    expect(stockWindowPeak([{ ...hire(1), renter_name: undefined }, { ...hire(1), renter_name: undefined }], "2026-10-02T00:00", "2026-10-03T00:00")).toBe(2);
  });
});
