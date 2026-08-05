import { describe, expect, it } from "vitest";
import { calendarBarGeometry } from "./calendar-bar-geometry";

const desktopX = (day: number) => day * 150;

describe("calendar rental bar geometry", () => {
  it("turns a one-hour same-day rental into a readable card within its date", () => {
    const geometry = calendarBarGeometry({
      start_date: "2026-08-05",
      end_date: "2026-08-05",
      pickup_time: "19:00",
      return_time: "20:00",
    }, "2026-08-03", desktopX);
    expect(geometry).not.toBeNull();
    expect(geometry!.width).toBe(112);
    expect(geometry!.left).toBeGreaterThanOrEqual(304);
    expect(geometry!.left + geometry!.width).toBeLessThanOrEqual(446);
  });

  it("uses the full day when times are missing", () => {
    expect(calendarBarGeometry({
      start_date: "2026-08-05",
      end_date: "2026-08-05",
    }, "2026-08-03", desktopX)).toEqual({ left: 300, width: 150 });
  });

  it("does not inflate an already readable multi-day rental", () => {
    const geometry = calendarBarGeometry({
      start_date: "2026-08-04",
      end_date: "2026-08-06",
      pickup_time: "19:00",
      return_time: "10:00",
    }, "2026-08-03", desktopX);
    expect(geometry).not.toBeNull();
    expect(geometry!.width).toBeGreaterThan(150);
    expect(geometry!.left).toBeCloseTo(desktopX(1 + 10 / 13));
  });

  it("clamps the readable width inside a narrow mobile day column", () => {
    const mobileX = (day: number) => day * 96;
    const geometry = calendarBarGeometry({
      start_date: "2026-08-05",
      end_date: "2026-08-05",
      pickup_time: "19:00",
      return_time: "19:15",
    }, "2026-08-03", mobileX);
    expect(geometry).toMatchObject({ width: 88 });
    expect(geometry!.left).toBeGreaterThanOrEqual(196);
    expect(geometry!.left + geometry!.width).toBeLessThanOrEqual(284);
  });
});
