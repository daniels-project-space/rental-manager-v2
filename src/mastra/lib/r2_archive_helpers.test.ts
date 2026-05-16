/**
 * W3a — Unit tests for the R2 cold-storage archiver helpers.
 *
 * These cover the pure functions that drive `convex/archive_to_r2.ts`:
 *   - 90d cutoff calc
 *   - UTC date-key derivation (handles DST-free UTC semantics)
 *   - R2 key shape (table + min creation date)
 *   - per-day grouping (essential for stable, idempotent R2 keys)
 *   - inclusive date-key iteration for the symmetric reader
 *   - shouldSkipExistingKey decision (idempotency guard)
 *
 * No AWS / no Convex runtime — pure TS round-trips.
 */
import { describe, it, expect } from "vitest";
import {
  ARCHIVE_NINETY_DAYS_MS,
  archiveCutoffMs,
  archiveKeyFor,
  groupRowsByCreationDate,
  iterUtcDateKeys,
  shouldSkipExistingKey,
  utcDateKey,
} from "./r2_archive_helpers";

const DAY = 86_400_000;

describe("archive cutoff", () => {
  it("90 days in ms is the constant", () => {
    expect(ARCHIVE_NINETY_DAYS_MS).toBe(90 * DAY);
  });

  it("archiveCutoffMs subtracts 90d from now", () => {
    const now = Date.UTC(2026, 4, 15);
    expect(archiveCutoffMs(now)).toBe(now - 90 * DAY);
  });
});

describe("utcDateKey", () => {
  it("formats UTC midnight as yyyy-mm-dd", () => {
    expect(utcDateKey(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01");
  });

  it("uses UTC, ignoring local timezone", () => {
    // 2026-05-15 23:59 UTC is still 2026-05-15
    expect(utcDateKey(Date.UTC(2026, 4, 15, 23, 59, 59))).toBe("2026-05-15");
    // 2026-05-16 00:00 UTC is the next day
    expect(utcDateKey(Date.UTC(2026, 4, 16, 0, 0, 0))).toBe("2026-05-16");
  });
});

describe("archiveKeyFor", () => {
  it("uses cold/archive/<table>/<yyyy-mm-dd>.jsonl.gz shape", () => {
    const key = archiveKeyFor(
      "hygglo_messages",
      Date.UTC(2026, 4, 15, 12, 0, 0),
    );
    expect(key).toBe("cold/archive/hygglo_messages/2026-05-15.jsonl.gz");
  });

  it("encodes both archivable tables", () => {
    const a = archiveKeyFor("audit_log", Date.UTC(2025, 11, 31));
    expect(a).toBe("cold/archive/audit_log/2025-12-31.jsonl.gz");
  });
});

describe("groupRowsByCreationDate", () => {
  it("groups rows by UTC creation date, ascending dateKey", () => {
    const rows = [
      { _id: "c", _creationTime: Date.UTC(2026, 4, 14, 23, 59) },
      { _id: "a", _creationTime: Date.UTC(2026, 4, 13, 12, 0) },
      { _id: "b", _creationTime: Date.UTC(2026, 4, 14, 1, 0) },
      { _id: "d", _creationTime: Date.UTC(2026, 4, 15, 0, 0) },
    ];
    const groups = groupRowsByCreationDate(rows);
    expect(groups.map((g) => g.dateKey)).toEqual([
      "2026-05-13",
      "2026-05-14",
      "2026-05-15",
    ]);
    expect(groups[0]!.rows.map((r) => r._id)).toEqual(["a"]);
    expect(groups[1]!.rows.map((r) => r._id)).toEqual(["c", "b"]);
    expect(groups[2]!.rows.map((r) => r._id)).toEqual(["d"]);
  });

  it("returns empty array for empty input", () => {
    expect(groupRowsByCreationDate([])).toEqual([]);
  });

  it("all-same-day rows form a single group", () => {
    const t = Date.UTC(2026, 4, 15);
    const rows = [
      { _id: "x", _creationTime: t + 1 },
      { _id: "y", _creationTime: t + 2 },
      { _id: "z", _creationTime: t + 3 },
    ];
    const groups = groupRowsByCreationDate(rows);
    expect(groups.length).toBe(1);
    expect(groups[0]!.dateKey).toBe("2026-05-15");
    expect(groups[0]!.rows.length).toBe(3);
  });
});

describe("iterUtcDateKeys", () => {
  it("yields inclusive date keys [from, to]", () => {
    const from = Date.UTC(2026, 4, 13, 0, 0);
    const to = Date.UTC(2026, 4, 15, 23, 59);
    expect([...iterUtcDateKeys(from, to)]).toEqual([
      "2026-05-13",
      "2026-05-14",
      "2026-05-15",
    ]);
  });

  it("single day for same-day from+to", () => {
    const t = Date.UTC(2026, 4, 15);
    expect([...iterUtcDateKeys(t, t + 3600_000)]).toEqual(["2026-05-15"]);
  });

  it("empty when to < from", () => {
    expect([...iterUtcDateKeys(Date.UTC(2026, 4, 15), Date.UTC(2026, 4, 14))]).toEqual([]);
  });

  it("crosses a month boundary cleanly", () => {
    const from = Date.UTC(2026, 3, 29);
    const to = Date.UTC(2026, 4, 2);
    expect([...iterUtcDateKeys(from, to)]).toEqual([
      "2026-04-29",
      "2026-04-30",
      "2026-05-01",
      "2026-05-02",
    ]);
  });
});

describe("shouldSkipExistingKey (idempotency guard)", () => {
  it("returns true when target key already present", () => {
    const existing = [
      "cold/archive/hygglo_messages/2026-05-13.jsonl.gz",
      "cold/archive/hygglo_messages/2026-05-14.jsonl.gz",
    ];
    expect(
      shouldSkipExistingKey(
        existing,
        "cold/archive/hygglo_messages/2026-05-13.jsonl.gz",
      ),
    ).toBe(true);
  });

  it("returns false when target key is novel", () => {
    expect(
      shouldSkipExistingKey(
        [],
        "cold/archive/hygglo_messages/2026-05-13.jsonl.gz",
      ),
    ).toBe(false);
  });
});

describe("end-to-end key planning", () => {
  it("90-day cutoff + per-day grouping yields a stable key list", () => {
    const now = Date.UTC(2026, 4, 15);
    const cutoff = archiveCutoffMs(now);
    // 3 fake rows spread across two cold days, 1 row inside the hot window.
    const oldDay1 = cutoff - 2 * DAY;
    const oldDay2 = cutoff - DAY;
    const hot = cutoff + DAY; // not eligible
    const rows = [
      { _id: "a", _creationTime: oldDay1 + 1000 },
      { _id: "b", _creationTime: oldDay1 + 2000 },
      { _id: "c", _creationTime: oldDay2 + 500 },
      { _id: "d", _creationTime: hot },
    ];
    const eligible = rows.filter((r) => r._creationTime < cutoff);
    const groups = groupRowsByCreationDate(eligible);
    const keys = groups.map((g) =>
      archiveKeyFor("hygglo_messages", g.rows[0]!._creationTime),
    );
    expect(eligible.length).toBe(3);
    expect(groups.length).toBe(2);
    expect(keys.length).toBe(2);
    expect(keys[0]!.startsWith("cold/archive/hygglo_messages/")).toBe(true);
    expect(keys[1]!.startsWith("cold/archive/hygglo_messages/")).toBe(true);
    // Each key is unique
    expect(new Set(keys).size).toBe(keys.length);
  });
});
