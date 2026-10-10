import { describe, it, expect } from "vitest";
import { compareQuickReplies } from "./quick_reply_sort";
const row = (thread_id: string, overrides = {}) => ({
  thread_id,
  last_sender: "renter",
  last_renter_msg_at: 100,
  last_activity_at: 100,
  request_created_at: 100,
  net_to_owner_gbp: null,
  estimate_earnings_gbp: 100,
  ...overrides,
});
describe("independent Quick Reply sorting", () => {
  it("sorts earnings without wait weighting", () => {
    expect(
      compareQuickReplies(
        row("a", { estimate_earnings_gbp: 500, last_renter_msg_at: 999 }),
        row("b", { estimate_earnings_gbp: 100, last_renter_msg_at: 1 }),
        "earnings",
        1000,
      ),
    ).toBeLessThan(0);
  });
  it("equal earnings use stable identity rather than waiting time", () => {
    expect(
      compareQuickReplies(
        row("a", { last_renter_msg_at: 999 }),
        row("b", { last_renter_msg_at: 1 }),
        "earnings",
        1000,
      ),
    ).toBeLessThan(0);
  });
  it("sorts longest unanswered wait without earnings weighting", () => {
    expect(
      compareQuickReplies(
        row("a", { last_renter_msg_at: 1, estimate_earnings_gbp: 1 }),
        row("b", { last_renter_msg_at: 999, estimate_earnings_gbp: 5000 }),
        "waiting",
        1000,
      ),
    ).toBeLessThan(0);
  });
  it("does not put answered or missing timestamps ahead of waiting renters", () => {
    for (const overrides of [
      { last_sender: "owner" },
      { last_renter_msg_at: 0 },
      { last_renter_msg_at: NaN },
    ])
      expect(
        compareQuickReplies(row("a", overrides), row("b"), "waiting", 1000),
      ).toBeGreaterThan(0);
  });
  it("oldest request is unaffected by later chat activity", () => {
    expect(
      compareQuickReplies(
        row("a", { request_created_at: 1, last_activity_at: 999 }),
        row("b", { request_created_at: 2, last_activity_at: 3 }),
        "oldest",
        1000,
      ),
    ).toBeLessThan(0);
  });
  it("uses actual payout ahead of an estimate and keeps unknown money last", () => {
    expect(
      compareQuickReplies(
        row("a", { net_to_owner_gbp: 0, estimate_earnings_gbp: 1000 }),
        row("b", { estimate_earnings_gbp: 1 }),
        "earnings",
        1000,
      ),
    ).toBeGreaterThan(0);
    expect(
      compareQuickReplies(
        row("a", { estimate_earnings_gbp: null }),
        row("b"),
        "earnings",
        1000,
      ),
    ).toBeGreaterThan(0);
  });
  it("only Priority blends stock with money and wait", () => {
    expect(
      compareQuickReplies(
        row("a", { availability: { status: "available" } }),
        row("b", { availability: { status: "conflict" } }),
        "priority",
        1000,
      ),
    ).toBeLessThan(0);
  });
});
