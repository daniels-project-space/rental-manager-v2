import { describe, expect, it } from "vitest";
import { currentDraftApproval, sameDraftApproval, amendedDraftContext, currentDraftReview, draftContextKey, draftReviewSummary, type DraftContextTransition, type DraftReview } from "./draft_review";
const booking = { start_date: "2026-10-02", end_date: "2026-10-04", status: "PENDING", items: [{ name: "Sony FX3", qty: 1 }] };
const review: DraftReview = { reason: "needs_human:guard_blocked", flags: [{ type: "KIT_HALLUCINATION", detail: "Unverified charger", severity: "critical", action: "flagged" }],
  for_message_id: "renter-1", epoch: 2, context_key: draftContextKey(booking), stage: "INQUIRY", created_at: 1 };
describe("message-scoped human review", () => {
  it("invalidates on new inbound, logic version, dates, quantity and order state", () => {
    const scope = { message_id: "renter-1", epoch: 2, context_key: draftContextKey(booking) };
    expect(currentDraftReview(review, scope)).toBe(review);
    for (const changed of [{ ...scope, message_id: "renter-2" }, { ...scope, epoch: 3 },
      ...[{ end_date: "2026-10-05" }, { items: [{ name: "Sony FX3", qty: 2 }] }, { status: "CONFIRMED" }, {is_obsolete:true}, {pickup_date:"2026-10-03"}]
        .map(patch => ({ ...scope, context_key: draftContextKey({ ...booking, ...patch }) }))]) {
      expect(currentDraftReview(review, changed)).toBeNull();
    }
  });
  it("does not retry because a poll timestamp or item ordering changed", () => {
    const items = [{ name: "Sony FX3", qty: 1 }, { name: "Lens", qty: 1 }];
    expect(draftContextKey({ ...booking, items, updated_at: 1 })).toBe(draftContextKey({ ...booking, items: items.slice().reverse(), updated_at: 2 }));
  });
  it("invalidates on a real stage transition at London midnight without daily timestamp churn", () => {
    const confirmed={...booking,status:"confirmed",start_date:"2026-10-03"};
    expect(draftContextKey(confirmed,[],null,"2026-10-01")).toBe(draftContextKey(confirmed,[],null,"2026-10-02"));
    expect(draftContextKey(confirmed,[],null,"2026-10-02")).not.toBe(draftContextKey(confirmed,[],null,"2026-10-03"));
    const inUse={...booking,status:"ongoing",end_date:"2026-10-04"};
    expect(draftContextKey(inUse,[],null,"2026-10-04")).not.toBe(draftContextKey(inUse,[],null,"2026-10-05"));
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

describe("generation-owned native context transitions", () => {
  const t = (before: string, after: string, revision = 0): DraftContextTransition => ({
    source: "native_lab_amendment", thread_id: "__probe__context", before_context_key: before,
    after_context_key: after, before_revision: revision, after_revision: revision + 1,
  });
  it("adopts the exact changed native context, including a changed lifecycle stage", () => {
    const before = draftContextKey({ ...booking, status: "ongoing", end_date: "2026-10-01" }, [], null, "2026-10-02");
    const after = draftContextKey({ ...booking, status: "ongoing" }, [], null, "2026-10-02");
    expect(JSON.parse(before).stage).not.toBe(JSON.parse(after).stage);
    expect(amendedDraftContext(before, "__probe__context", [t(before, after)])).toBe(after);
  });
  it("requires the original generation snapshot, rather than accepting a fresh context by itself", () => {
    expect(amendedDraftContext("original", "__probe__context", [t("owner-edited", "after")])).toBeNull();
    expect(amendedDraftContext("original", "__probe__context", [])).toBeNull();
  });
  it("rejects foreign threads, production mutations and untrusted source labels", () => {
    for (const changed of [{ thread_id: "__probe__different" }, { source: "model_prose" }])
      expect(amendedDraftContext("before", "__probe__context", [{ ...t("before", "after"), ...changed } as DraftContextTransition])).toBeNull();
    expect(amendedDraftContext("before", "real-order", [t("before", "after")])).toBeNull();
  });
  it("supports successive tool writes regardless of trace traversal order", () => {
    expect(amendedDraftContext("before", "__probe__context", [t("middle", "after", 1), t("before", "middle")])).toBe("after");
  });
  it("rejects an intervening owner write and a missing native revision", () => {
    expect(amendedDraftContext("before", "__probe__context", [t("before", "middle"), t("owner-edited", "after", 1)])).toBeNull();
    expect(amendedDraftContext("before", "__probe__context", [t("before", "middle"), t("middle", "after", 2)])).toBeNull();
  });
});


describe("owner approval of a copied draft", () => {
  const scope = { message_id: "renter-1", context_key: draftContextKey(booking), epoch: 2 };
  const source = { ai_draft_text: "Your total is £90.", ai_draft_for_message_id: scope.message_id,
    ai_draft_context_key: scope.context_key, ai_draft_epoch: scope.epoch, ai_draft_generated_at: 100 };
  it("keeps a current accepted preview available for human approval", () => {
    expect(currentDraftApproval(source, scope)).toEqual({ ...scope, generated_at: 100 });
  });
  it("rejects an older inbound, amended booking or changed logic version", () => {
    for (const changed of [{ ...scope, message_id: "renter-2" }, { ...scope, epoch: 3 },
      { ...scope, context_key: draftContextKey({ ...booking, end_date: "2026-10-05" }) }])
      expect(currentDraftApproval(source, changed)).toBeNull();
  });
  it("holds a rejected preview and refuses missing legacy provenance", () => {
    expect(currentDraftApproval({ ...source, ai_draft_review: review }, scope)).toBeNull();
    expect(currentDraftApproval({ ...source, ai_draft_generated_at: undefined }, scope)).toBeNull();
    expect(currentDraftApproval({ ...source, ai_draft_text: " " }, scope)).toBeNull();
    expect(currentDraftApproval(source, { ...scope, message_id: null })).toBeNull();
  });
  it("does not refresh copied approval when another draft replaces the preview", () => {
    const copied = currentDraftApproval(source, scope);
    const regenerated = currentDraftApproval({ ...source, ai_draft_generated_at: 101 }, scope);
    expect(sameDraftApproval(copied, regenerated)).toBe(false);
    expect(sameDraftApproval(copied, currentDraftApproval(source, scope))).toBe(true);
    expect(sameDraftApproval(copied, null)).toBe(false);
  });
});
