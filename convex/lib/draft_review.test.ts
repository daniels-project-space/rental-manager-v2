import { describe, expect, it } from "vitest";
import { currentDraftReview, draftContextKey, draftReviewSummary, type DraftReview } from "./draft_review";
const booking = { start_date: "2026-10-02", end_date: "2026-10-04", status: "PENDING", items: [{ name: "Sony FX3", qty: 1 }] };
const review: DraftReview = { reason: "needs_human:guard_blocked", flags: [{ type: "KIT_HALLUCINATION", detail: "Unverified charger", severity: "critical", action: "flagged" }],
  for_message_id: "renter-1", epoch: 2, context_key: draftContextKey(booking), stage: "INQUIRY", created_at: 1 };
describe("message-scoped human review", () => {
  it("invalidates on new inbound, logic version, dates, quantity and order state", () => {
    const scope = { message_id: "renter-1", epoch: 2, context_key: draftContextKey(booking) };
    expect(currentDraftReview(review, scope)).toBe(review);
    for (const changed of [{ ...scope, message_id: "renter-2" }, { ...scope, epoch: 3 },
      ...[{ end_date: "2026-10-05" }, { items: [{ name: "Sony FX3", qty: 2 }] }, { status: "CONFIRMED" }]
        .map(patch => ({ ...scope, context_key: draftContextKey({ ...booking, ...patch }) }))]) {
      expect(currentDraftReview(review, changed)).toBeNull();
    }
  });
  it("does not retry because a poll timestamp or item ordering changed", () => {
    const items = [{ name: "Sony FX3", qty: 1 }, { name: "Lens", qty: 1 }];
    expect(draftContextKey({ ...booking, items, updated_at: 1 })).toBe(draftContextKey({ ...booking, items: items.slice().reverse(), updated_at: 2 }));
  });
  it("detects changes using the actual reservation item_name field", () => {
    expect(draftContextKey({ items: [{ item_name: "Sony FX3", qty: 1 }] }))
      .not.toBe(draftContextKey({ items: [{ item_name: "Sony A7 V", qty: 1 }] }));
  });
  it("scopes dated Lab inquiries to their virtual order even without a booking row", () => {
    const order = { items: [{ name: "BMPCC 6K Full Frame", qty: 1 }], start_date: "2026-10-02", end_date: "2026-10-04" };
    expect(draftContextKey(null, [], order)).not.toBe(draftContextKey(null, [], { ...order, end_date: "2026-10-05" }));
    expect(draftContextKey(null, [], order)).not.toBe(draftContextKey(null, []));
  });
  it("explains the actual category instead of calling every block a price issue", () => {
    expect(draftReviewSummary(review)).toBe("Kit contents need verification.");
    expect(draftReviewSummary({ reason: "needs_human:model_declined", flags: [] })).toContain("judgement");
  });
});
