import { describe, expect, it } from "vitest";
import { renterMessageWatermark } from "./renter_message_watermark";
describe("genuine renter queue watermark", () => {
  it("keeps a message-less request stable after owner follow-ups", () => {
    expect(renterMessageWatermark([], undefined, 100)).toBe(100);
    expect(renterMessageWatermark([{ sender: "owner", hygglo_sent_at: 300, fetched_at: 500 }], undefined, 100)).toBe(100);
  });
  it("finds the actual renter behind a newer owner message", () => {
    expect(renterMessageWatermark([{ sender: "owner", hygglo_sent_at: 300 }, { sender: "renter", hygglo_sent_at: 200, fetched_at: 600 }], undefined, 100)).toBe(200);
  });
  it("preserves cached renter history beyond the bounded transcript", () => {
    expect(renterMessageWatermark([{ sender: "owner", fetched_at: 800 }], 400, 100)).toBe(400);
  });
  it("ignores system, invalid and missing times without inventing current activity", () => {
    expect(renterMessageWatermark([{ sender: "system", fetched_at: 900 }, { sender: "renter", hygglo_sent_at: NaN }], undefined, 0)).toBe(0);
    expect(renterMessageWatermark([{ sender: "renter", hygglo_sent_at: NaN, fetched_at: 200 }], undefined, 100)).toBe(200);
  });
});
