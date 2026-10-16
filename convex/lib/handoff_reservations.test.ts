import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("../auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { getNextRentals } from "../dashboard";
import { loadHandoffReservations } from "./handoff_reservations";

type Row = Record<string, any>;
const today = "2026-10-16";
const cutoff = "2026-09-16";
const row = (id: string, fields: Row = {}): Row => ({
  _id: id, _creationTime: 1, status: "confirmed", account_slug: "diogo",
  start_date: today, end_date: today, items: [], ...fields,
});

function fixture(tables: Record<string, Row[]>) {
  const reads: Array<{ table: string; index: string; rows: number }> = [];
  const ctx: any = { db: { query(table: string) {
    let data = [...(tables[table] ?? [])];
    let index = "";
    const q: any = {
      withIndex(name: string, select: (range: any) => any) {
        index = name;
        const range: any = {
          eq(key: string, value: any) { data = data.filter((r) => r[key] === value); return range; },
          gte(key: string, value: any) { data = data.filter((r) => r[key] !== undefined && r[key] >= value); return range; },
        };
        select(range);
        return q;
      },
      async collect() {
        reads.push({ table, index, rows: data.length });
        return data;
      },
    };
    return q;
  } } };
  return { ctx, reads };
}

function legacyCandidates(rows: Row[], target: string, slug: string | null) {
  return rows.filter((r) => r.start_date >= cutoff && (!slug || r.account_slug === slug))
    .filter((r) => r.status === "confirmed" && !r.is_obsolete && r.start_date !== undefined && r.end_date !== undefined)
    .filter((r) => (r.pickup_date ?? r.start_date) === target || (r.return_date ?? r.end_date) === target)
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a._creationTime - b._creationTime);
}

describe("indexed handoff candidates", () => {
  const rows = [
    row("same-day"),
    row("agreed-pickup", { start_date: "2026-10-20", pickup_date: today, end_date: "2026-10-22" }),
    row("agreed-return", { start_date: "2026-10-01", end_date: "2026-10-20", return_date: today }),
    row("provider-return", { start_date: "2026-10-01" }),
    row("moved-pickup", { pickup_date: "2026-10-17", end_date: "2026-10-20" }),
    row("moved-return", { start_date: "2026-10-01", return_date: "2026-10-17" }),
    row("old-source", { start_date: "2026-09-01", return_date: today }),
    row("cancelled", { status: "cancelled" }),
    row("obsolete", { is_obsolete: true }),
    row("other-account", { account_slug: "leo" }),
    row("no-end", { end_date: undefined }),
    row("tie-2", { _creationTime: 4 }), row("tie-1", { _creationTime: 3 }),
  ];

  it.each([null, "diogo", "leo", "empty"])('preserves effective dates, cutoff and stable order for %s', async (slug) => {
    const { ctx } = fixture({ reservations: rows });
    const candidates = await loadHandoffReservations(ctx, today, cutoff, slug);
    expect(legacyCandidates(candidates, today, slug).map((r) => r._id))
      .toEqual(legacyCandidates(rows, today, slug).map((r) => r._id));
    expect(new Set(candidates.map((r) => r._id)).size).toBe(candidates.length);
  });

  it("does not read unrelated cancelled, historic or future bookings", async () => {
    const unrelated = Array.from({ length: 1000 }, (_, n) => row(`unrelated-${n}`, {
      status: n % 2 ? "cancelled" : "confirmed", start_date: "2026-11-01", end_date: "2026-11-02",
    }));
    const { ctx, reads } = fixture({ reservations: [...rows, ...unrelated] });
    await loadHandoffReservations(ctx, today, cutoff, null);
    expect(reads).toHaveLength(4);
    expect(reads.every((r) => r.index.startsWith("by_status_"))).toBe(true);
    expect(reads.reduce((n, r) => n + r.rows, 0)).toBeLessThan(35);
  });

  it("returns an empty day without reading the item or image catalogs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    try {
      const { ctx, reads } = fixture({ reservations: [row("moved", { pickup_date: "2026-10-17", return_date: "2026-10-17" })] });
      const result = await (getNextRentals as any)._handler(ctx, { accountSlug: null, day: "today" });
      expect(result).toEqual({ targetDate: today, pickups: [], unpairedReturns: [] });
      expect(reads.every((r) => r.table === "reservations")).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it.runIf(!!process.env.RM_HANDOFF_SOURCE_SNAPSHOT)("matches captured production output across both days and all accounts", async () => {
    const snapshot = JSON.parse(fs.readFileSync(process.env.RM_HANDOFF_SOURCE_SNAPSHOT!, "utf8"));
    const before = JSON.parse(fs.readFileSync(process.env.RM_HANDOFF_BEFORE_RESULTS!, "utf8"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${snapshot.today}T12:00:00Z`));
    try {
      const { ctx } = fixture(snapshot);
      for (const [key, expected] of Object.entries(before)) {
        expect(await (getNextRentals as any)._handler(ctx, JSON.parse(key)), key).toEqual(expected);
      }
    } finally { vi.useRealTimers(); }
  });
});
