import { describe, it, expect } from "vitest";
import {
  quickReplyDuplicateIds,
  quickReplyStage,
} from "./quick_reply_presentation";
const row = {
  thread_id: "a",
  renter_identity: "person1",
  account_slug: "a",
  items: [{ name: "Sony FX6", qty: 1 }],
  net_to_owner_gbp: null,
  estimate_earnings_gbp: 100,
};
describe("Quick Reply duplicate requests", () => {
  it("prefers higher earnings across accounts for the same basket", () =>
    expect([
      ...quickReplyDuplicateIds([
        row,
        {
          ...row,
          thread_id: "b",
          account_slug: "b",
          estimate_earnings_gbp: 200,
        },
      ]),
    ]).toEqual(["a"]));
  it("keeps separate hire dates for the same gear", () =>
    expect(
      quickReplyDuplicateIds([
        { ...row, start_date: "2030-01-01", end_date: "2030-01-02" },
        {
          ...row,
          thread_id: "b",
          account_slug: "b",
          start_date: "2030-02-01",
          end_date: "2030-02-02",
        },
      ]).size,
    ).toBe(0));
  it("keeps different items from the same person", () =>
    expect(
      quickReplyDuplicateIds([
        row,
        {
          ...row,
          thread_id: "b",
          account_slug: "b",
          items: [{ name: "Sigma 35mm", qty: 1 }],
        },
      ]).size,
    ).toBe(0));
  it("keeps requests on the same account", () =>
    expect(quickReplyDuplicateIds([row, { ...row, thread_id: "b" }]).size).toBe(
      0,
    ));
  it("requires authoritative identity", () =>
    expect(
      quickReplyDuplicateIds([
        { ...row, renter_identity: null },
        { ...row, thread_id: "b", account_slug: "b", renter_identity: null },
      ]).size,
    ).toBe(0));
  it("does not merge different quantities", () =>
    expect(
      quickReplyDuplicateIds([
        row,
        {
          ...row,
          thread_id: "b",
          account_slug: "b",
          items: [{ name: "Sony FX6", qty: 2 }],
        },
      ]).size,
    ).toBe(0));
  it("normalizes spacing and case while retaining full models", () =>
    expect([
      ...quickReplyDuplicateIds([
        row,
        {
          ...row,
          thread_id: "b",
          account_slug: "b",
          items: [{ name: " Sony  FX6 ", qty: 1 }],
        },
      ]),
    ]).toEqual(["b"]));
});
describe("Quick Reply live lifecycle", () => {
  const base = {
    has_reservation: true,
    status: null,
    booking_status: null,
    order_step: null,
    is_request: false,
  };
  it.each(["REQUEST", "APPROVED", "FUNDS_RESERVED"])(
    "unpaid %s remains an enquiry",
    (step) =>
      expect(quickReplyStage({ ...base, order_step: step })).toBe("enquiry"),
  );
  it("a price or coarse confirmed status is not payment proof", () =>
    expect(quickReplyStage({ ...base, booking_status: "confirmed" })).toBe(
      "enquiry",
    ));
  it("payment alone cannot claim verification started", () =>
    expect(quickReplyStage({ ...base, paid: true })).toBe("enquiry"));
  it("verified process start after payment is pending", () =>
    expect(
      quickReplyStage({ ...base, paid: true, verification_started: true }),
    ).toBe("pending"));
  it("requires authoritative platform confirmation", () =>
    expect(
      quickReplyStage({
        ...base,
        paid: true,
        verification_started: true,
        platform_booking_confirmed: true,
      }),
    ).toBe("confirmed"));
  it("website payment without verified archive remains pending", () =>
    expect(
      quickReplyStage({
        ...base,
        source: "dbcinema_web",
        paid: true,
        verification_started: true,
        platform_booking_confirmed: false,
      }),
    ).toBe("pending"));
  it.each(["cancelled", "declined", "expired"])(
    "terminal %s wins over historical proof",
    (status) =>
      expect(
        quickReplyStage({
          ...base,
          status,
          paid: true,
          verification_started: true,
          platform_booking_confirmed: true,
        }),
      ).toBe("closed"),
  );
});
