import { describe, expect, it } from "vitest";
import {
  hashBookingTimeTranscript,
  transcriptHasTimeLanguage,
} from "./booking-time-transcript";

describe("booking time transcript fingerprint", () => {
  const base = [{ sender: "renter", body_text: "7.30 works", hygglo_sent_at: 10 }];

  it("changes for sender, timestamp, or content changes", () => {
    const hash = hashBookingTimeTranscript(base);
    expect(hashBookingTimeTranscript([{ ...base[0], sender: "owner" }])).not.toBe(hash);
    expect(hashBookingTimeTranscript([{ ...base[0], hygglo_sent_at: 11 }])).not.toBe(hash);
    expect(hashBookingTimeTranscript([{ ...base[0], body_text: "8pm works" }])).not.toBe(hash);
  });

  it("recognises dotted and natural-language times", () => {
    expect(transcriptHasTimeLanguage(base)).toBe(true);
    expect(transcriptHasTimeLanguage([{ sender: "owner", body_text: "half past seven" }])).toBe(true);
    expect(transcriptHasTimeLanguage([{ sender: "owner", body_text: "thanks" }])).toBe(false);
  });
});
