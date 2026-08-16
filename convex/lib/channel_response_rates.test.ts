import { describe, expect, it } from "vitest";
import { extractHyggloResponseRate } from "../channel_response_rates";

describe("extractHyggloResponseRate", () => {
  it("reads the public Hygglo profile statistic", () => {
    expect(extractHyggloResponseRate('<p>66% response rate</p>')).toBe(0.66);
  });

  it("rejects missing and invalid values", () => {
    expect(extractHyggloResponseRate("Usually responds within an hour")).toBeNull();
    expect(extractHyggloResponseRate("120% response rate")).toBeNull();
  });
});
