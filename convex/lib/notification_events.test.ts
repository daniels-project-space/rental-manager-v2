import { describe, expect, it } from "vitest";
import {
  bookingBecameConfirmed,
  buildConfirmedBookingNotificationCopy,
  formatNotificationAmounts,
  notificationAttemptDue,
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
