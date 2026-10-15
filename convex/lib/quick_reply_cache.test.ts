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
          requested_items: [],
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
          requested_items: [],
          items: [{}],
          availability: {
            stock_rules_version:7,
            items: [{ available: null, reason: "Dates needed" }],
          },
        },
      ]),
    ).toBe(true));
  it("rejects complete old checks that did not enforce marketing-only tags",()=>expect(currentQuickReplyCache([{request_created_at:1,requested_items:[],items:[{}],availability:{items:[{available:true}]}}])).toBe(false));
  it("rejects version-two checks that skipped completed-booking listings",()=>expect(currentQuickReplyCache([{request_created_at:1,requested_items:[],items:[{}],availability:{stock_rules_version:2,items:[{available:true}]}}])).toBe(false));
  it("accepts the empty queue and rejects non-array snapshots", () => {
    expect(currentQuickReplyCache([])).toBe(true);
    expect(currentQuickReplyCache(null)).toBe(false);
  });
});

it("rejects previous account-photo and message-order snapshots",()=>expect(currentQuickReplyCache([{request_created_at:1,requested_items:[],items:[],availability:{stock_rules_version:3,items:[]}}])).toBe(false));
