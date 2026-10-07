import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { listBatch } from "./reconciliation";
import { computeHoldsForReservations } from "../src/lib/reconcile-holds";

afterEach(() => vi.unstubAllEnvs());

function context(rows: any[], holds: any[]) {
  const reads: any[] = [];
  const ctx: any = { db: { get: async (id: string) => { const row=rows.find(r=>r._id===id); if(row)reads.push(row); return row??null; }, query: (table: string) => {
    let selected = table === "calendar_holds" ? holds : rows;
    const chain: any = {
      withIndex: (_index: string, fn: any) => {
        const range: any = {
          eq: (key: string, value: any) => { selected = selected.filter(row => row[key] === value); return range; },
          gte: (key: string, value: any) => { selected = selected.filter(row => row[key] >= value); return range; },
        };
        fn(range); return chain;
      },
      collect: async () => { reads.push(...selected); return selected; },
      take: async (n: number) => { const page=selected.slice(0,n);reads.push(...page);return page; },
    };
    return chain;
  } } };
  return { ctx, reads };
}

function engine(rows: any[], today: Date) {
  return computeHoldsForReservations({
    today, items: [{ _id: "camera", name: "Camera", account_slug: "leo" }],
    reservations: rows.map(row => ({
      ...row, pickup_at: row.pickup_date && row.pickup_date < row.start_date ? Date.parse(row.pickup_date + "T00:00:00Z") : undefined,
      return_at: row.return_date && row.return_date > row.end_date ? Date.parse(row.return_date + "T00:00:00Z") : undefined,
    })),
    productIndex: new Map(), bundleOverrides: new Map(),
  });
}

describe("indexed hold reconciliation candidates", () => {
  it("retains identical holds, terminal cleanup and unresolved warnings while avoiding expired history", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    vi.useFakeTimers();
    const today = new Date("2026-10-07T12:00:00Z");
    vi.setSystemTime(today);
    const row = (id: string, start: string, end: string | null, extra: object = {}) => ({
      _id: id, _creationTime: Number(id.replace(/\D/g, "")) || 1, account_slug: "leo", start_date: start, end_date: end,
      order_step: "DELIVERED", status: "confirmed", items: [{ item_name: "Camera" }],
      image_hints: "x".repeat(2000), ...extra,
    });
    const rows = [
      ...Array.from({ length: 600 }, (_, i) => row(`old-${i}`, "2026-01-01", "2026-01-03")),
      row("current-1", "2026-10-06", "2026-10-09"), row("recent-2", "2026-09-06", "2026-09-07"),
      row("just-expired-15", "2026-09-05", "2026-09-06"),
      row("future-3", "2026-10-20", "2026-10-22"),
      row("extended-4", "2026-07-01", "2026-07-02", { return_date: "2026-10-08" }),
      row("pickup-5", "2026-10-08", "2026-10-09", { pickup_date: "2026-10-07" }),
      row("cancelled-6", "2026-01-01", "2026-01-02", { order_step: "CANCELED" }),
      row("failed-7", "2026-02-01", "2026-02-02", { order_step: "VERIFICATION_FAILED" }),
      row("obsolete-8", "2026-03-01", "2026-03-02", { is_obsolete: true }),
      row("overlap-9", "2026-10-07", "2026-10-09", { is_obsolete: true, order_step: "CANCELED", return_date: "2026-10-10" }),
      row("unmatched-10", "2026-10-07", "2026-10-08", { items: [{ item_name: "Unknown" }] }),
      row("pending-11", "2026-10-07", "2026-10-08", { order_step: "REQUEST" }),
      row("no-end-12", "2026-10-07", null), row("too-old-13", "2024-01-01", "2026-10-08"),
      row("foreign-14", "2026-10-07", "2026-10-08", { account_slug: "dbcinema" }),
    ];
    const previous = rows.filter(r => r.account_slug === "leo" && r.start_date >= "2025-09-02")
      .sort((a,b) => a.start_date.localeCompare(b.start_date) || a._creationTime-b._creationTime);
    // Wrong denormalized account slugs cannot prevent cancellation cleanup.
    const held = ["cancelled-6","failed-7","obsolete-8","overlap-9"].map((reservation_id,i)=>({ _id:`hold-${i}`,reservation_id,account_slug:"dbcinema" }));
    const { ctx, reads } = context(rows,held);
    try {
      const batch = await (listBatch as any)._handler(ctx, { account_slugs: ["leo"] });
      const selected = batch.groups[0].reservations;
      const before = engine(previous, today), after = engine(selected, today);
      expect(after.holds).toEqual(before.holds);
      expect(after.deleteReservationIds).toEqual(before.deleteReservationIds);
      expect(after.unmatchedItemNames).toEqual(before.unmatchedItemNames);
      expect(after.unresolvedLines).toEqual(before.unresolvedLines);
      expect(new Set(selected.map((r: any) => r._id)).size).toBe(selected.length);
      expect(selected.some((r: any) => r._id === "extended-4")).toBe(true);
      expect(reads.length).toBeLessThan(previous.length * .05);
    } finally { vi.useRealTimers(); }
  });

  it("falls back to complete history rather than truncating a large hold index", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    const rows=[{_id:"booking",_creationTime:1,account_slug:"leo",start_date:"2099-01-01",end_date:"2099-01-02",status:"confirmed"}];
    const holds=Array.from({length:4001},(_,i)=>({_id:`hold-${i}`,reservation_id:`reservation-${i}`}));
    const {ctx}=context(rows,holds);
    const batch=await (listBatch as any)._handler(ctx,{account_slugs:["leo","leo"]});
    expect(batch.strategy).toBe("history-fallback");
    expect(batch.groups).toHaveLength(1);
    expect(batch.groups[0].reservations.map((r:any)=>r._id)).toEqual(["booking"]);
  });
});
