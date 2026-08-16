import { describe, expect, it } from "vitest";
import {
  BOOKING_TIME_INSTRUCTIONS,
  BookingTimeSchema,
  buildBookingTimeMessages,
  sanitizeTime,
} from "./booking-time-extraction";

describe("booking time extraction contract", () => {
  it("normalises 12-hour, dotted and compact model output", () => {
    expect(sanitizeTime("7:00 PM")).toBe("19:00");
    expect(sanitizeTime("6.30pm")).toBe("18:30");
    expect(sanitizeTime("9:05")).toBe("09:05");
    expect(sanitizeTime("12 AM")).toBe("00:00");
    expect(sanitizeTime("NONE")).toBeUndefined();
    expect(sanitizeTime(null)).toBeUndefined();
  });

  it("accepts a well-formed extraction and passes valid times through unchanged", () => {
    const parsed = BookingTimeSchema.parse({
      pickup_time: "19:00",
      return_time: "19:30",
      pickup_date: "2026-08-05",
      return_date: "2026-08-06",
      pickup_method: "collection",
      return_method: "delivery",
      status: "active",
      confidence: "high",
      notes: "Changed from 18:00 and both agreed",
    });
    expect(sanitizeTime(parsed.pickup_time)).toBe("19:00");
    expect(sanitizeTime(parsed.return_time)).toBe("19:30");
    expect(parsed.pickup_method).toBe("collection");
    expect(parsed.return_method).toBe("delivery");
  });

  it("allows null times when no handoff was discussed, but never null dates", () => {
    const parsed = BookingTimeSchema.parse({
      pickup_time: null,
      return_time: null,
      pickup_date: "2026-08-05",
      return_date: "2026-08-06",
      pickup_method: "unknown",
      return_method: "unknown",
      status: "active",
      confidence: "low",
      notes: "",
    });
    expect(parsed.pickup_time).toBeNull();
    expect(BookingTimeSchema.safeParse({
      pickup_time: null,
      return_time: null,
      pickup_date: null,
      return_date: "2026-08-06",
      pickup_method: "unknown",
      return_method: "unknown",
      status: "active",
      confidence: "low",
      notes: "",
    }).success).toBe(false);
  });

  it("rejects the exact malformed shapes that used to be silently dropped by regex parsing", () => {
    // 12-hour format in the time field — previously the model could emit
    // this and the old lineValue regex would just fail to match, silently
    // dropping the field. Now the whole call rejects instead.
    expect(BookingTimeSchema.safeParse({
      pickup_time: "7:00 PM",
      return_time: "19:30",
      pickup_date: "2026-08-05",
      return_date: "2026-08-06",
      pickup_method: "collection",
      return_method: "delivery",
      status: "active",
      confidence: "high",
      notes: "",
    }).success).toBe(false);

    // Uppercase enum values — the old text format used uppercase; the new
    // contract is lowercase and a model reverting to the old casing must
    // fail loudly rather than have the field vanish.
    expect(BookingTimeSchema.safeParse({
      pickup_time: "19:00",
      return_time: "19:30",
      pickup_date: "2026-08-05",
      return_date: "2026-08-06",
      pickup_method: "COLLECTION",
      return_method: "DELIVERY",
      status: "ACTIVE",
      confidence: "HIGH",
      notes: "",
    }).success).toBe(false);

    // Out-of-range hour.
    expect(BookingTimeSchema.safeParse({
      pickup_time: "25:00",
      return_time: null,
      pickup_date: "2026-08-05",
      return_date: "2026-08-06",
      pickup_method: "unknown",
      return_method: "unknown",
      status: "active",
      confidence: "low",
      notes: "",
    }).success).toBe(false);
  });

  it("keeps the static instructions as an isolated, cacheable system message", () => {
    const { system, user } = buildBookingTimeMessages(
      "Sony FX3", "2026-08-05", "2026-08-06", "RENTER: 7pm works",
      new Date("2026-08-05T12:00:00Z"),
    );
    expect(system).toBe(BOOKING_TIME_INSTRUCTIONS);
    // Rental-specific content lives ONLY in the user message, so the system
    // message is byte-identical across every call (cache-safe).
    expect(system).not.toContain("Sony FX3");
    expect(user).toContain("Sony FX3");
    expect(user).toContain("RENTER: 7pm works");
  });
});
