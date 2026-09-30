#!/usr/bin/env node
import { readFileSync } from "node:fs";

// The September 2026 incident came from rebuilding each transcript in its
// caller with UTC toISOString(), which changed the London date of "tomorrow".
for (const path of [
  "src/trigger/extract-booking-times.ts",
  "convex/extract_booking_times.ts",
]) {
  const source = readFileSync(path, "utf8");
  if (!source.includes("buildBookingTimeTranscript(messages)") &&
      !source.includes("buildBookingTimeTranscript(c.messages)")) {
    throw new Error(`${path}: use the shared London transcript builder`);
  }
  if (/\.toISOString\s*\(/.test(source)) {
    throw new Error(`${path}: UTC serialization can shift a London chat date`);
  }
}
console.log("Booking-time extractors use the shared London transcript builder.");
