import { describe, expect, it } from "vitest";
import { confirmedHeadlineOrder, confirmedPickupWindow } from "./confirmed_headline_order";
import type { ReservationRow } from "./reservations/predicates";

const row = (id: string, values: Partial<ReservationRow> = {}): ReservationRow => ({
  _id: id, _creationTime: Number(id), status: "confirmed", start_date: "2026-10-15", end_date: "2026-10-17", ...values,
});

describe("reused confirmed pickup window", () => {
  it("includes both bounds, excludes missing/outside dates, and preserves full records", () => {
    const first = row("1", { pickup_date: "2026-07-01", net_to_owner_gbp: 123.456789 });
    const last = row("2", { pickup_date: "2026-10-31" });
    const input = [last, row("3"), first, row("4", { pickup_date: "2026-06-30" }), row("5", { pickup_date: "2026-11-01" })];
    const result = confirmedPickupWindow(input, "2026-07-01", "2026-10-31")!;
    expect(result).toEqual([first, last]);
    expect(result[0]).toBe(first);
    expect(input[0]).toBe(last);
    expect(result[0].net_to_owner_gbp).toBe(123.456789);
  });
  it("uses the final headline comparator rather than the pickup index start-date suffix", () => {
    const rows = [row("2", { pickup_date: "2026-10-20", start_date: "2026-10-01" }),
      row("1", { pickup_date: "2026-10-20", start_date: "2026-10-15" })];
    expect(confirmedPickupWindow(rows, "2026-10-01", "2026-10-31")?.map((r) => r._id)).toEqual(["1", "2"]);
  });
  it("requests the original database order for tied final keys even with different start dates", () => {
    const rows = [row("2", { _creationTime: 1, pickup_date: "2026-10-20", start_date: "2026-10-01" }),
      row("1", { pickup_date: "2026-10-20", start_date: "2026-10-15" })];
    expect(confirmedPickupWindow(rows, "2026-10-01", "2026-10-31")).toBeNull();
  });
  it("does not fall back because of tied rows outside the window", () => {
    expect(confirmedPickupWindow([row("1"), row("2", { _creationTime: 1 })], "2026-10-01", "2026-10-31")).toEqual([]);
  });
});
describe("confirmed headline input order", () => {
  it("preserves end-date order before the later index partitions", () => {
    const rows = [row("1", { end_date: "2026-10-18" }), row("2", { end_date: "2026-10-16" }),
      row("3", { end_date: "2026-10-01", return_date: "2026-10-19" }),
      row("4", { start_date: "2026-09-01", end_date: "2026-09-02" })];
    expect(confirmedHeadlineOrder(rows, "2026-10-16")?.map((r) => r._id)).toEqual(["2", "1", "3", "4"]);
    expect(confirmedHeadlineOrder(rows, "2026-10-16")).toHaveLength(rows.length);
  });
  it("uses creation time for equal dates, independent of input ordering", () => {
    expect(confirmedHeadlineOrder([row("2"), row("1")], "2026-10-16")?.map((r) => r._id)).toEqual(["1", "2"]);
  });
  it("requests the original indexes for fully tied keys", () => {
    expect(confirmedHeadlineOrder([row("2", { _creationTime: 1 }), row("1")], "2026-10-16")).toBeNull();
  });
  it("uses the pickup index's start-date suffix before creation time", () => {
    const rows = [row("1", { start_date: "2026-10-18", end_date: "2026-10-01", pickup_date: "2026-10-20" }),
      row("2", { start_date: "2026-10-17", end_date: "2026-10-01", pickup_date: "2026-10-20" })];
    expect(confirmedHeadlineOrder(rows, "2026-10-16")?.map((r) => r._id)).toEqual(["2", "1"]);
  });
});
