import { describe, expect, it } from "vitest";
import {
  filterImminentHandoffs,
  nearbyCalendarDates,
  type ImminentHandoffCandidate,
} from "./imminent_handoffs";

function handoff(date: string, time: string, thread_id: string): ImminentHandoffCandidate {
  return {
    thread_id,
    account_slug: "dbcinema",
    renter_name: `Renter ${thread_id}`,
    items: ["Sony FX3"],
    kind: "pickup",
    date,
    time,
  };
}

describe("imminent handoff window", () => {
  it("shows exactly one hour before through one hour after, then removes cards", () => {
    const candidates = [
      handoff("2026-08-05", "13:00", "edge-future"),
      handoff("2026-08-05", "11:00", "edge-past"),
      handoff("2026-08-05", "13:01", "too-early"),
      handoff("2026-08-05", "10:59", "expired"),
    ];
    expect(filterImminentHandoffs(candidates, "2026-08-05", "12:00").map((x) => x.thread_id))
      .toEqual(["edge-past", "edge-future"]);
  });

  it("works across midnight instead of comparing time-of-day alone", () => {
    const candidates = [
      handoff("2026-08-06", "00:30", "tomorrow"),
      handoff("2026-08-05", "22:30", "too-old"),
    ];
    const result = filterImminentHandoffs(candidates, "2026-08-05", "23:45");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ thread_id: "tomorrow", minutes_away: 45 });
  });

  it("uses yesterday, today and tomorrow for the materialized candidate set", () => {
    expect([...nearbyCalendarDates("2026-08-05")]).toEqual([
      "2026-08-04", "2026-08-05", "2026-08-06",
    ]);
  });
});
