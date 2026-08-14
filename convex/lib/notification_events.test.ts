import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_CLAIM_STALE_MS,
  bookingBecameConfirmed,
  buildConfirmedBookingNotificationCopy,
  formatNotificationAmounts,
  notificationAttemptDue,
  notificationClaimAvailable,
  notificationRetryDelayMs,
  subscriptionReceivesNotification,
  telegramNotificationMode,
} from "./notification_events";

describe("confirmed booking notification transitions", () => {
  it("fires when a broad current/confirmed order reaches genuine confirmation", () => {
    expect(bookingBecameConfirmed({
      previousStep: "FUNDS_RESERVED",
      previousStatus: "confirmed",
      incomingStep: "BOOKED_AFTER_VERIFIED",
      incomingStatus: "confirmed",
    })).toBe(true);
  });

  it("does not fire for approval/payment-pending steps or repeated confirmed polls", () => {
    expect(bookingBecameConfirmed({
      previousStep: "REQUEST",
      previousStatus: "pending",
      incomingStep: "FUNDS_RESERVED",
      incomingStatus: "confirmed",
    })).toBe(false);
    expect(bookingBecameConfirmed({
      previousStep: "BOOKED_AFTER_VERIFIED",
      previousStatus: "confirmed",
      incomingStep: "DELIVERED",
      incomingStatus: "confirmed",
    })).toBe(false);
  });

  it("keeps gross and net pence exact and labelled", () => {
    expect(formatNotificationAmounts(35.75, 22.4, "GBP"))
      .toBe("£35.75 paid · £22.40 earnings");
    expect(formatNotificationAmounts(undefined, 19, "GBP")).toBe("£19 earnings");
    // Values sampled from a real rental row (order 4116374) during the read-only
    // validation pass: this previously collapsed to a rounded single amount.
    expect(formatNotificationAmounts(37.5, 24, "GBP"))
      .toBe("£37.50 paid · £24 earnings");
  });

  it("uses only first name, short item, and exact owner earnings for wohoo copy", () => {
    expect(buildConfirmedBookingNotificationCopy({
      renterName: "Samantha Jones",
      itemName: "Sony FX3",
      gross: 37.5,
      net: 24,
      currency: "GBP",
    })).toEqual({
      title: "🎉 Wohooo! £24 made",
      body: "Samantha · Sony FX3",
    });
  });

  it("falls back to gross when owner earnings are unavailable", () => {
    expect(buildConfirmedBookingNotificationCopy({
      renterName: "Leo Adams",
      itemName: "Aputure 600D",
      gross: 35.75,
    }).title).toBe("🎉 Wohooo! £35.75 made");
  });

  it("strips bundle detail and clips a long listing at a word boundary", () => {
    expect(buildConfirmedBookingNotificationCopy({
      renterName: "Sam Green",
      itemName: "Sony FX3 Full Frame Cinema Camera (body only) | 4K filming bundle + batteries",
      net: 88.4,
    })).toEqual({
      title: "🎉 Wohooo! £88.40 made",
      body: "Sam · Sony FX3 Full Frame Cinema Camera",
    });
  });
});

describe("per-device notification modes", () => {
  it("keeps all existing subscriptions on every event by default", () => {
    expect(subscriptionReceivesNotification(undefined, "new_request")).toBe(true);
    expect(subscriptionReceivesNotification("all", "renter_message")).toBe(true);
  });

  it("sends money-only subscriptions confirmed bookings and nothing else", () => {
    expect(subscriptionReceivesNotification("money_only", "booking_confirmed")).toBe(true);
    expect(subscriptionReceivesNotification("money_only", "new_request")).toBe(false);
    expect(subscriptionReceivesNotification("money_only", "renter_message")).toBe(false);
  });

  it("defaults Daniel's Telegram fallback to money-only with an explicit all override", () => {
    expect(telegramNotificationMode(undefined)).toBe("money_only");
    expect(telegramNotificationMode("money_only")).toBe("money_only");
    expect(telegramNotificationMode("all")).toBe("all");
  });
});

describe("bounded notification delivery retries", () => {
  const now = Date.parse("2026-08-05T12:00:00Z");

  it("retries after five then thirty minutes", () => {
    expect(notificationRetryDelayMs(1)).toBe(5 * 60 * 1000);
    expect(notificationRetryDelayMs(2)).toBe(30 * 60 * 1000);
    expect(notificationAttemptDue({ delivery_attempts: 1, last_attempt_at: now - 5 * 60 * 1000 }, now)).toBe(true);
    expect(notificationAttemptDue({ delivery_attempts: 2, last_attempt_at: now - 29 * 60 * 1000 }, now)).toBe(false);
  });

  it("stops after three failed attempts", () => {
    expect(notificationAttemptDue({ delivery_attempts: 3, last_attempt_at: now - 60 * 60 * 1000 }, now)).toBe(false);
  });
});

describe("dispatch claim (duplicate-send guard)", () => {
  const now = Date.parse("2026-08-14T12:00:00Z");

  it("lets a fresh, unclaimed event be claimed", () => {
    expect(notificationClaimAvailable({}, now)).toBe(true);
  });

  /**
   * The actual race: two dispatchPending runs overlap on one row. Convex
   * mutations are serializable, so the second one always reads the first one's
   * write — modelled here as claim-then-re-check on the same row.
   */
  it("refuses a second claim while the first dispatcher is still sending", () => {
    const event: { delivered_at?: number; dispatch_claimed_at?: number } = {};

    // Dispatcher A wins the claim.
    expect(notificationClaimAvailable(event, now)).toBe(true);
    event.dispatch_claimed_at = now;

    // Dispatcher B runs 1ms later, mid-send, and must NOT re-send.
    expect(notificationClaimAvailable(event, now + 1)).toBe(false);
    // Still held moments before the staleness window closes.
    expect(
      notificationClaimAvailable(event, now + NOTIFICATION_CLAIM_STALE_MS - 1),
    ).toBe(false);
  });

  it("reclaims a stale claim left behind by a crashed dispatcher", () => {
    expect(
      notificationClaimAvailable(
        { dispatch_claimed_at: now - NOTIFICATION_CLAIM_STALE_MS },
        now,
      ),
    ).toBe(true);
  });

  it("never re-sends an event that already delivered", () => {
    expect(notificationClaimAvailable({ delivered_at: now - 1 }, now)).toBe(false);
    // Even once its claim looks stale.
    expect(
      notificationClaimAvailable(
        { delivered_at: now - 1, dispatch_claimed_at: now - 10 * 60 * 1000 },
        now,
      ),
    ).toBe(false);
  });

  it("gives a released claim straight back to the next dispatcher", () => {
    // markDelivered clears dispatch_claimed_at on a failed send, so the retry
    // ladder in notificationAttemptDue stays in control of when it goes again.
    const afterFailedSend = { dispatch_claimed_at: undefined, delivery_attempts: 1, last_attempt_at: now };
    expect(notificationClaimAvailable(afterFailedSend, now)).toBe(true);
    expect(notificationAttemptDue(afterFailedSend, now)).toBe(false);
    expect(notificationAttemptDue(afterFailedSend, now + 5 * 60 * 1000)).toBe(true);
  });
});
