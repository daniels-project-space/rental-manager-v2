import { describe, expect, it } from "vitest";
import {
  BOOKING_TIME_INSTRUCTIONS,
  buildBookingTimePrompt,
  parseBookingTimeResponse,
  sanitizeTime,
} from "./booking-time-extraction";

describe("booking time extraction contract", () => {
  it("normalises 12-hour, dotted and compact model output", () => {
    expect(sanitizeTime("7:00 PM")).toBe("19:00");
    expect(sanitizeTime("6.30pm")).toBe("18:30");
    expect(sanitizeTime("9:05")).toBe("09:05");
    expect(sanitizeTime("12 AM")).toBe("00:00");
    expect(sanitizeTime("NONE")).toBeUndefined();
  });

  it("parses full lines so AM/PM cannot be silently discarded", () => {
    const parsed = parseBookingTimeResponse(`PICKUP_TIME: 7:00 PM
PICKUP_DATE: 2026-08-05
PICKUP_METHOD: COLLECTION
RETURN_TIME: 19.30
RETURN_DATE: 2026-08-06
RETURN_METHOD: DELIVERY
STATUS: ACTIVE
CONFIDENCE: HIGH
NOTES: Changed from 18:00 and both agreed`);
    expect(parsed).toMatchObject({
      pickup_time: "19:00",
      return_time: "19:30",
      pickup_date: "2026-08-05",
      return_date: "2026-08-06",
      pickup_method: "collection",
      return_method: "delivery",
      confidence: "HIGH",
    });
  });

  it("keeps the static cacheable instructions before rental-specific context", () => {
    const prompt = buildBookingTimePrompt(
      "Sony FX3", "2026-08-05", "2026-08-06", "RENTER: 7pm works",
      new Date("2026-08-05T12:00:00Z"),
    );
    expect(prompt.startsWith(BOOKING_TIME_INSTRUCTIONS)).toBe(true);
    expect(prompt.indexOf("Sony FX3")).toBeGreaterThan(prompt.indexOf("NOTES:"));
  });
});
