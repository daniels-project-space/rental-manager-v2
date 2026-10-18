import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("../auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import {
  getNextRentals,
  getRentalHeadlineCoreStats,
  getRentalHeadlineStats,
  getRentalPendingReviewStats,
} from "../dashboard";
import { loadHandoffReservations } from "./handoff_reservations";

type Row = Record<string, any>;
const today = "2026-10-16";
const cutoff = "2026-09-16";
const row = (id: string, fields: Row = {}): Row => ({
  _id: id, _creationTime: 1, status: "confirmed", account_slug: "diogo",
  start_date: today, end_date: today, items: [], ...fields,
});

function fixture(tables: Record<string, Row[]>) {
  const reads: Array<{ table: string; index: string; rows: number; equals: Record<string, any> }> = [];
  const ctx: any = { db: { query(table: string) {
    let data = [...(tables[table] ?? [])];
    let index = "";
    const q: any = {
      withIndex(name: string, select: (range: any) => any) {
        index = name;
        const equals: Record<string, any> = {};
        const range: any = {
          eq(key: string, value: any) { equals[key] = value; data = data.filter((r) => r[key] === value); return range; },
          gte(key: string, value: any) { data = data.filter((r) => r[key] !== undefined && r[key] >= value); return range; },
          lte(key: string, value: any) { data = data.filter((r) => r[key] !== undefined && r[key] <= value); return range; },
        };
        select(range);
        q.equals = equals;
        return q;
      },
      async collect() {
        reads.push({ table, index, rows: data.length, equals: { ...(q.equals ?? {}) } });
        return data;
      },
      async first() { return (await q.collect())[0] ?? null; },
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

  it("keeps negotiated current-month revenue outside the source start-date window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    try {
      const { ctx, reads } = fixture({ reservations: [
        row("old-start", { start_date: "2025-01-01", end_date: "2026-10-15", pickup_date: "2026-10-14", status: "completed", order_step: "REVIEWED", net_to_owner_gbp: 37 }),
        row("cancelled-income", { pickup_date: "2026-10-14", status: "cancelled", order_step: "REVIEWED", net_to_owner_gbp: 999 }),
      ] });
      const result = await (getRentalHeadlineStats as any)._handler(ctx, { accountSlug: null });
      expect(result.monthly.confirmed_revenue).toBe(37);
      expect(reads.some((read) => read.index === "by_pickup_date")).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("includes a past confirmed rental with no negotiated pickup in current revenue", async () => {
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    try {
      const {ctx}=fixture({reservations:[row("past-confirmed",{start_date:"2026-10-01",end_date:"2026-10-02",net_to_owner_gbp:37,order_step:"REVIEWED"})]});
      expect((await(getRentalHeadlineStats as any)._handler(ctx,{accountSlug:null})).monthly.confirmed_revenue).toBe(37);
    }finally{vi.useRealTimers();}
  });

  it("keeps confirmed and pending-review subscriptions on separate reservation status ranges", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    try {
      const data = { reservations: [
        row("confirmed", { net_to_owner_gbp: 80, order_step: "DELIVERED" }),
        row("pending", { status: "pending_review", hygglo_order_id: "pending", net_to_owner_gbp: 45, start_date: "2026-10-20", end_date: "2026-10-21" }),
      ], conversations: [
        { _id: "conversation-pending", thread_id: "pending", last_sender: "renter", last_renter_msg_at: Date.now() - 1_000 },
      ] };
      const core = fixture(data);
      const coreResult = await (getRentalHeadlineCoreStats as any)._handler(core.ctx, { accountSlug: null });
      expect(coreResult.active.total).toBe(1);
      expect(coreResult.active.pending_review_count).toBe(0);
      expect(core.reads.some((read) => read.equals.status === "pending_review")).toBe(false);

      const pending = fixture(data);
      const pendingResult = await (getRentalPendingReviewStats as any)._handler(pending.ctx, { accountSlug: null });
      expect(pendingResult).toMatchObject({ count: 1, value_gbp: 45, month_value_gbp: 45 });
      expect(pendingResult.rentals.map((r: any) => r.reservation_id)).toEqual(["pending"]);
      expect(pending.reads.filter((read) => read.table === "reservations").every((read) => read.equals.status === "pending_review")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows recent pending arrivals from other accounts without reading confirmed rentals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    try {
      const { ctx, reads } = fixture({ reservations: [
        row("own-pending", { status: "pending_review", hygglo_order_id: "thread-own", net_to_owner_gbp: 45, start_date: "2026-10-20" }),
        row("other-pending", { status: "pending_review", account_slug: "leo", _creationTime: Date.now() - 1000, start_date: "2026-10-21" }),
        row("confirmed", { account_slug: "leo" }),
      ], conversations: [
        { _id: "conversation-own", thread_id: "thread-own", last_sender: "renter", last_renter_msg_at: Date.now() - 1_000 },
      ] });
      const result = await (getRentalPendingReviewStats as any)._handler(ctx, { accountSlug: "diogo" });
      expect(result.count).toBe(1);
      expect(result.other_account_new_booking_count).toBe(1);
      expect(reads.filter((read) => read.table === "reservations").every((read) => read.equals.status === "pending_review")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps older adjacent members when grouping the span, identity and net of an active rental", async () => {
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    try {
      const shared={renter_id:"same-renter",resolved_items:[{item_id:"camera",qty:1}],order_step:"DELIVERED"};
      const {ctx}=fixture({reservations:[row("older-member",{...shared,start_date:"2026-10-01",end_date:"2026-10-09",net_to_owner_gbp:90}),row("active-member",{...shared,start_date:"2026-10-10",end_date:"2026-10-20",net_to_owner_gbp:110})]});
      const result=await(getRentalHeadlineStats as any)._handler(ctx,{accountSlug:null});
      expect(result.active.rentals).toHaveLength(1);expect(result.active.rentals[0]).toMatchObject({calendar_reservation_id:"older-member",start_date:"2026-10-01",return_date:"2026-10-20",net_gbp:200});
    }finally{vi.useRealTimers();}
  });

  it.runIf(!!process.env.RM_HEADLINE_SOURCE_SNAPSHOT)("preserves all five captured production headline outputs", async () => {
    const snapshot = JSON.parse(fs.readFileSync(process.env.RM_HEADLINE_SOURCE_SNAPSHOT!, "utf8"));
    const before = JSON.parse(fs.readFileSync(process.env.RM_HEADLINE_BEFORE_RESULTS!, "utf8"));
    vi.useFakeTimers();
    try {
      for (const [key, expected] of Object.entries(before)) {
        vi.setSystemTime(new Date((expected as any).generatedAt));
        const { ctx } = fixture(snapshot);
        expect(await (getRentalHeadlineStats as any)._handler(ctx, JSON.parse(key)), key).toEqual(expected);
      }
    } finally { vi.useRealTimers(); }
  });
});
