import { describe, expect, it } from "vitest";
import { londonTime, pickupIsUpcoming } from "./effectiveDates";

describe("same-day pickup category", () => {
  const rental = { start_date: "2026-09-30", pickup_date: "2026-09-30", pickup_time: "12:00" };

  it("keeps a booked pickup upcoming until its London handover time", () => {
    expect(londonTime(new Date("2026-09-30T09:30:00Z"))).toBe("10:30");
    expect(pickupIsUpcoming(rental, "2026-09-30", "10:30")).toBe(true);
    expect(pickupIsUpcoming(rental, "2026-09-30", "12:00")).toBe(false);
    expect(pickupIsUpcoming(rental, "2026-09-30", "12:01")).toBe(false);
  });

  it("handles future days and unknown pickup times", () => {
    expect(pickupIsUpcoming(rental, "2026-09-29", "23:59")).toBe(true);
    expect(pickupIsUpcoming({ ...rental, pickup_time: null }, "2026-09-30", "10:30")).toBe(false);
    expect(londonTime(new Date("2026-12-30T09:30:00Z"))).toBe("09:30");
  });
});
