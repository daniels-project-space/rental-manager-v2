import { it, expect } from "vitest";
import { quickReplyProof } from "./quick_reply_proof";
const steps = [
  { key: "FUNDS_RESERVED", completed: true },
  { key: "VERIFIED", completed: true },
  { key: "BOOKED_AFTER_VERIFIED", active: true },
];
it("active payment is not paid", () =>
  expect(
    quickReplyProof({ steps: [{ key: "FUNDS_RESERVED", active: true }] }).paid,
  ).toBe(false));
it("paid plus active verification is pending", () =>
  expect(
    quickReplyProof({
      steps: [
        { key: "FUNDS_RESERVED", completed: true },
        { key: "VERIFIED", active: true },
      ],
    }),
  ).toEqual({
    paid: true,
    verification_started: true,
    platform_booking_confirmed: false,
  }));
it("completed funnel without a system confirmation is not confirmed", () =>
  expect(quickReplyProof({ steps }).platform_booking_confirmed).toBe(false));
it("renter/owner text cannot impersonate Hygglo", () =>
  expect(
    quickReplyProof({
      steps,
      activities: [{ chatMessage: { text: { content: "Rental confirmed" } } }],
    }).platform_booking_confirmed,
  ).toBe(false));
it("Hygglo event plus verified funnel confirms", () =>
  expect(
    quickReplyProof({
      steps,
      activities: [{ event: { content: "The rental is confirmed." } }],
    }).platform_booking_confirmed,
  ).toBe(true));
it("negative/future events cannot confirm", () => {
  for (const content of [
    "The rental is not confirmed.",
    "The rental will be confirmed.",
    "Once security checks pass, your rental is booked.",
  ])
    expect(
      quickReplyProof({ steps, activities: [{ event: { content } }] })
        .platform_booking_confirmed,
    ).toBe(false);
});
it("system event cannot skip payment or completed verification", () =>
  expect(
    quickReplyProof({
      steps: [{ key: "VERIFIED", active: true }],
      activities: [{ event: { content: "The rental is confirmed." } }],
    }).platform_booking_confirmed,
  ).toBe(false));
