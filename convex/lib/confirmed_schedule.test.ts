import { describe, it, expect } from "vitest";
import {
  confirmedChatClock,
  recoverConfirmedChatClock,
} from "../../src/lib/booking-schedule-evidence";
import { londonStockInstant, confirmedClock } from "./confirmed_schedule";
const messages = (values: [string, string][]) =>
  values.map(([sender, body_text], i) => ({
    sender,
    body_text,
    hygglo_sent_at: Date.UTC(2026, 9, 7, 10, i),
  }));
const proof = (
  values: [string, string][],
  side: "pickup" | "return" = "return",
  time = "17:00",
  date = "2026-10-09",
) =>
  confirmedChatClock(messages(values), side, time, date, "2026-10-09", "hash");
describe("independent exact schedule agreement", () => {
  it("requires both parties, not model confidence or lone proposal", () =>
    expect(proof([["renter", "Return at 5pm"]])).toBeUndefined());
  it("accepts literal opposite-party agreement", () =>
    expect(
      proof([
        ["renter", "Return at 5pm"],
        ["owner", "Yes!"],
      ])?.time,
    ).toBe("17:00"));
  it("does not invent morning/evening clocks", () =>
    expect(
      proof(
        [
          ["renter", "Return during the evening"],
          ["owner", "Yes!"],
        ],
        "return",
        "19:00",
      ),
    ).toBeUndefined());
  it("does not retain an earlier clock after a different unaccepted proposal", () =>
    expect(
      proof([
        ["renter", "Return at 5pm"],
        ["owner", "Yes!"],
        ["renter", "Return at 7pm instead"],
      ]),
    ).toBeUndefined());
  it("does not mistake a conditional answer for agreement", () =>
    expect(
      proof([
        ["renter", "Return at 5pm"],
        ["owner", "Yes but could you return at 7pm?"],
      ]),
    ).toBeUndefined());
  it("preserves a repeated agreed return while negotiating the pickup", () =>
    expect(
      proof([
        ["renter", "Return at 5pm"],
        ["owner", "Yes!"],
        ["renter", "Pickup at 7pm and return at 5pm"],
        ["owner", "Pickup at 8pm"],
        ["renter", "Alright"],
      ])?.time,
    ).toBe("17:00"));
  it("accepts an agreed literal noon without inventing broad daypart clocks",()=>expect(proof([["renter","Return at noon"],["owner","Yes!"]],"return","12:00")?.time).toBe("12:00"));
  it("cannot authorize an extension without a matching date", () =>
    expect(
      proof(
        [
          ["renter", "Return at 5pm"],
          ["owner", "Yes!"],
        ],
        "return",
        "17:00",
        "2026-10-10",
      ),
    ).toBeUndefined());
  it("never converts a time range into a precise handover", () =>
    expect(
      proof(
        [
          ["renter", "Pickup 9-9:30am"],
          ["owner", "Yes!"],
        ],
        "pickup",
        "09:30",
      ),
    ).toBeUndefined());
  it("recovers an accepted counterproposal and earlier date from actual correspondence", () => {
    const m = messages([
      ["renter", "Pickup 8th at 7pm and return 9th at 5pm"],
      ["owner", "Pickup at 8pm"],
      ["renter", "Alright"],
    ]);
    expect(
      recoverConfirmedChatClock(m, "pickup", "2026-10-09", "hash"),
    ).toMatchObject({ date: "2026-10-08", time: "20:00" });
  });
  it("does not turn an approximate reversed phrase into a precise return",()=>expect(proof([["renter","About 5pm return"],["owner","Yes!"]])).toBeUndefined());
  it("ignores travel ETAs", () =>
    expect(
      proof([
        ["renter", "Return ETA 5pm"],
        ["owner", "Yes!"],
      ]),
    ).toBeUndefined());
});
describe("true UTC London stock boundaries", () => {
  it("converts summer clocks using BST", () =>
    expect(londonStockInstant("2026-10-09T17:00", "end")).toBe(
      Date.UTC(2026, 9, 9, 16),
    ));
  it("converts winter clocks using GMT", () =>
    expect(londonStockInstant("2026-12-09T17:00", "end")).toBe(
      Date.UTC(2026, 11, 9, 17),
    ));
  it("uses earliest pickup and latest return for an ambiguous autumn clock", () => {
    expect(londonStockInstant("2026-10-25T01:30", "start")).toBe(
      Date.UTC(2026, 9, 25, 0, 30),
    );
    expect(londonStockInstant("2026-10-25T01:30", "end")).toBe(
      Date.UTC(2026, 9, 25, 1, 30),
    );
  });
  it("widens a nonexistent spring clock instead of returning 503 or freeing stock", () =>
    expect(londonStockInstant("2026-03-29T01:30", "end")).toBe(
      Date.UTC(2026, 2, 29, 23),
    ));
  it("rejects invalid civil dates without recursive fallback",()=>expect(()=>londonStockInstant("2026-02-30T12:00","end")).toThrow("Invalid stock schedule label"));
  it("does not grant precision to legacy model clocks", () =>
    expect(
      confirmedClock({ return_time: "17:00" }, "return", "2026-10-09"),
    ).toBeUndefined());
});
