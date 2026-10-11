import { describe, it, expect } from "vitest";
import {
  rentalCalendarParts,
  rentalCalendarTimestamp,
} from "./rental-calendar-time";
describe("rental calendar London handover times", () => {
  it("preserves winter and summer clock times", () => {
    for (const date of ["2026-01-12", "2026-07-12"]) {
      const at = rentalCalendarTimestamp(date, "14:30");
      expect(rentalCalendarParts(at)).toEqual({ date, time: "14:30" });
    }
  });
  it("rejects invalid and daylight saving edge times", () => {
    for (const [date, time] of [
      ["2026-03-29", "01:30"],
      ["2026-10-25", "01:30"],
      ["2026-02-30", "10:00"],
      ["2026-10-12", "25:00"],
    ])
      expect(() => rentalCalendarTimestamp(date, time)).toThrow();
  });
});
