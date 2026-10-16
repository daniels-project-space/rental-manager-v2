import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { ackDirty, listBatch, listDirtyBatch } from "./reconciliation";
import { tryClaimFullReconciliation } from "./account_state";
import { markReservationDirty } from "./lib/reconciliation_dirty";
import { computeHoldsForReservations } from "../src/lib/reconcile-holds";

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

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

function mutableContext() {
  const state = new Map<string, any>();
  let nextId = 0;
  const ctx: any = { db: {
    query(table: string) {
      let values = [...state.values()].filter((row) => row._table === table);
      const chain: any = {
        withIndex(_index: string, build: (q: any) => void) {
          const range: any = {
            eq(key: string, value: unknown) { values = values.filter((row) => row[key] === value); return range; },
            gt(key: string, value: number) { values = values.filter((row) => row[key] > value); return range; },
          };
          build(range); return chain;
        },
        first: async () => values[0] ?? null,
        take: async (limit: number) => values.slice(0, limit),
      };
      return chain;
    },
    get: async (id: string) => state.get(id) ?? null,
    insert: async (table: string, doc: any) => {
      const id = `${table}-${++nextId}`;
      state.set(id, { _id: id, _table: table, ...doc });
      return id;
    },
    patch: async (id: string, patch: any) => { state.set(id, { ...state.get(id), ...patch }); },
    delete: async (id: string) => { state.delete(id); },
  } };
  return { ctx, state };
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

  it("uses reservation indexes rather than scanning a large hold index", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    const rows=[{_id:"booking",_creationTime:1,account_slug:"leo",start_date:"2099-01-01",end_date:"2099-01-02",status:"confirmed"}];
    const holds=Array.from({length:4001},(_,i)=>({_id:`hold-${i}`,reservation_id:`reservation-${i}`}));
    const {ctx}=context(rows,holds);
    const batch=await (listBatch as any)._handler(ctx,{account_slugs:["leo","leo"]});
    expect(batch.strategy).toBe("reservation-index");
    expect(batch.groups).toHaveLength(1);
    expect(batch.groups[0].reservations.map((r:any)=>r._id)).toEqual(["booking"]);
  });
});

describe("durable dirty-row reconciliation", () => {
  it("coalesces repeated changes and protects newer queue versions from stale acknowledgements", async () => {
    const { ctx, state } = mutableContext();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T11:00:00Z"));
    const reservationId = "reservations-1" as any;
    await markReservationDirty(ctx, reservationId, "leo");
    await markReservationDirty(ctx, reservationId, "leo");
    const markers = [...state.values()].filter((row) => row._table === "reservation_reconcile_dirty");
    expect(markers).toHaveLength(1);
    expect(markers[0].version).toBe(Date.now() + 1);

    const id = markers[0]._id;
    const result = await (ackDirty as any)._handler(ctx, { markers: [{ id, version: Date.now() }] });
    expect(result.deleted).toBe(0);
    expect(state.has(id)).toBe(true);
  });

  it("projects account-scoped dirty rows and keeps deleted IDs for stale-hold cleanup", async () => {
    const { ctx, state } = mutableContext();
    state.set("reservations-1", { _id: "reservations-1", _table: "reservations", account_slug: "leo", start_date: "2026-10-20", end_date: "2026-10-21", items: [{ item_name: "Camera" }] });
    state.set("reservation_reconcile_dirty-1", { _id: "reservation_reconcile_dirty-1", _table: "reservation_reconcile_dirty", reservation_id: "reservations-1", account_slug: "leo", version: 10 });
    state.set("reservation_reconcile_dirty-2", { _id: "reservation_reconcile_dirty-2", _table: "reservation_reconcile_dirty", reservation_id: "reservations-deleted", account_slug: "leo", version: 11 });
    const result = await (listDirtyBatch as any)._handler(ctx, { account_slugs: ["leo"] });
    expect(result.groups[0].reservations.map((row: any) => row._id)).toEqual(["reservations-1"]);
    expect(result.groups[0].markers.map((marker: any) => marker.missingReservation)).toEqual([false, true]);
  });

  it("rate-limits broad repair per account and can force repair for queue backlog", async () => {
    const { ctx, state } = mutableContext();
    expect(await (tryClaimFullReconciliation as any)._handler(ctx, { accounts: ["leo", "leo"], now: 1_000_000 })).toEqual(["leo"]);
    expect(await (tryClaimFullReconciliation as any)._handler(ctx, { accounts: ["leo"], now: 1_001_000 })).toEqual([]);
    expect(await (tryClaimFullReconciliation as any)._handler(ctx, { accounts: ["leo"], forceAccounts: ["leo"], now: 1_002_000 })).toEqual(["leo"]);
    expect(await (tryClaimFullReconciliation as any)._handler(ctx, { accounts: ["leo"], now: 1_003_000 })).toEqual([]);
    const nextRepair = 1_002_000 + 6 * 60 * 60 * 1000;
    expect(await (tryClaimFullReconciliation as any)._handler(ctx, { accounts: ["leo"], now: nextRepair })).toEqual(["leo"]);
    const account = [...state.values()].find((row) => row._table === "account_state");
    expect(account.lastFullReconciliationAttemptAt).toBe(nextRepair);
  });
});
