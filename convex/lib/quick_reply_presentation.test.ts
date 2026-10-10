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
    has_reservation: false,
    status: null,
    booking_status: null,
    order_step: null,
    is_request: false,
  };
  it.each(["cancelled", "declined", "expired"])(
    "does not mark %s as confirmed",
    (status) =>
      expect(
        quickReplyStage({
          ...base,
          has_reservation: true,
          status,
          booking_status: "confirmed",
          order_step: "BOOKED_AFTER_VERIFIED",
        }),
      ).toBe("closed"),
  );
  it("shows enquiries without a reservation", () =>
    expect(quickReplyStage(base)).toBe("enquiry"));
  it.each(["REQUEST", "APPROVED", "FUNDS_RESERVED", "VERIFIED"])(
    "shows Hygglo %s as pending",
    (step) =>
      expect(
        quickReplyStage({ ...base, has_reservation: true, order_step: step }),
      ).toBe("pending"),
  );
  it.each(["confirmed", "active", "returned"])(
    "shows website %s as confirmed",
    (status) =>
      expect(
        quickReplyStage({
          ...base,
          has_reservation: true,
          source: "dbcinema_web",
          booking_status: status,
        }),
      ).toBe("confirmed"),
  );
  it("shows unpaid website requests as pending", () =>
    expect(
      quickReplyStage({
        ...base,
        has_reservation: true,
        source: "dbcinema_web",
        status: "pending_payment",
      }),
    ).toBe("pending"));
  it("reads confirmation from the latest row", () => {
    const pending = { ...base, has_reservation: true, order_step: "REQUEST" };
    expect(quickReplyStage(pending)).toBe("pending");
    expect(
      quickReplyStage({ ...pending, order_step: "BOOKED_AFTER_VERIFIED" }),
    ).toBe("confirmed");
  });
});
