import { describe, expect, it } from "vitest";
import { claimDateScope } from "./claim_date_scope";
describe("explicit rental calendar scopes", () => {
  it("preserves ordinals and single days instead of borrowing a booking span", () => {
    expect(claimDateScope("available for 6th to 8th Oct", "2026-10-06")).toMatchObject({ valid: true, start_date: "2026-10-06", end_date: "2026-10-08" });
    expect(claimDateScope("booked on 8 October", "2026-10-06")).toMatchObject({ valid: true, start_date: "2026-10-08", end_date: "2026-10-08" });
  });
  it("handles a specified year and a rental crossing New Year", () => {
    expect(claimDateScope("6 to 8 October 2025", "2026-10-06")).toMatchObject({ start_date: "2025-10-06", end_date: "2025-10-08" });
    expect(claimDateScope("31 December to 2 January", "2026-12-31")).toMatchObject({ valid: true, start_date: "2026-12-31", end_date: "2027-01-02" });
  });
  it("does not guess unknown years, invalid dates or conflicting ranges", () => {
    for (const text of ["6 to 8 October", "30 to 31 February 2026", "6 to 8 October 2026 or 9 to 10 October 2026"]) expect(claimDateScope(text)).toMatchObject({ explicit: true, valid: false });
  });
  it("uses the supplied London date for relative availability", () => {
    expect(claimDateScope("available tomorrow", "2026-10-06", "2026-10-02")).toMatchObject({ start_date: "2026-10-03", end_date: "2026-10-03" });
    expect(claimDateScope("available for those dates", "2026-10-06")).toMatchObject({ explicit: false });
  });
});
