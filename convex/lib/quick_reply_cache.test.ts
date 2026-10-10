import { describe, it, expect } from "vitest";
import { currentQuickReplyCache } from "./quick_reply_cache";
describe("Quick Reply cache compatibility", () => {
  it("rejects cached tiles from before creation time and per-item stock", () =>
    expect(
      currentQuickReplyCache([{ items: [{}], availability: { items: [] } }]),
    ).toBe(false));
  it("rejects partial basket stock even with current sort metadata", () =>
    expect(
      currentQuickReplyCache([
        {
          request_created_at: 1,
          items: [{}, {}],
          availability: { items: [{}] },
        },
      ]),
    ).toBe(false));
  it("accepts complete item checks including explicit unknown results", () =>
    expect(
      currentQuickReplyCache([
        {
          request_created_at: 1,
          items: [{}],
          availability: {
            items: [{ available: null, reason: "Dates needed" }],
          },
        },
      ]),
    ).toBe(true));
  it("accepts the empty queue and rejects non-array snapshots", () => {
    expect(currentQuickReplyCache([])).toBe(true);
    expect(currentQuickReplyCache(null)).toBe(false);
  });
});
