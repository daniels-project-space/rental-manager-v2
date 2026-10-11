import { describe, expect, it } from "vitest";
import {
  hashBookingTimeTranscript,
  hasScheduleTimingLanguage,
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

  it("recognises context-bound whole hours without matching quantities or dates", () => {
    expect(transcriptHasTimeLanguage([{ sender: "renter", body_text: "Could I collect around 7?" }])).toBe(true);
    expect(transcriptHasTimeLanguage([{ sender: "owner", body_text: "Return by 6 please" }])).toBe(true);
    expect(transcriptHasTimeLanguage([{ sender: "renter", body_text: "I need 7 batteries for 2 days" }])).toBe(false);
    expect(transcriptHasTimeLanguage([{ sender: "renter", body_text: "The booking starts on 7 August" }])).toBe(false);
    expect(transcriptHasTimeLanguage([{ sender: "renter", body_text: "I will bring it back at five" }])).toBe(true);
    expect(transcriptHasTimeLanguage([{ sender: "renter", body_text: "Return at half past five in the afternoon" }])).toBe(true);
    expect(transcriptHasTimeLanguage([{ sender: "renter", body_text: "I need five batteries for two days" }])).toBe(false);
    expect(hasScheduleTimingLanguage("Can I bring it back at five instead?")).toBe(true);
    expect(hasScheduleTimingLanguage("We can meet tomorrow, thanks")).toBe(false);
  });
});
