import { describe, expect, it } from "vitest";
import { confirmedHeadlineOrder } from "./confirmed_headline_order";
import type { ReservationRow } from "./reservations/predicates";

const row = (id: string, values: Partial<ReservationRow> = {}): ReservationRow => ({
  _id: id, _creationTime: Number(id), status: "confirmed", start_date: "2026-10-15", end_date: "2026-10-17", ...values,
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
});
