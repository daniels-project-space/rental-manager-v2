import { describe, expect, it } from "vitest";
import { isWithinActivePollingWindow } from "./poller_window";

describe("isWithinActivePollingWindow", () => {
  it("includes the 07:00 start and excludes the 23:00 overnight pause", () => {
    expect(isWithinActivePollingWindow(6 * 60 + 59)).toBe(false);
    expect(isWithinActivePollingWindow(7 * 60)).toBe(true);
    expect(isWithinActivePollingWindow(22 * 60 + 59)).toBe(true);
    expect(isWithinActivePollingWindow(23 * 60)).toBe(false);
  });
});
