import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn(async () => null) } }));
import { getLifetimeByMonth } from "./revenue";
import { realisedMonthRevenue } from "./lib/reservations/monthRevenue";
const row = (id: string, account: string, date: string, amount: number, extra = {}) => ({ _id: id, _creationTime: 1, account_slug: account, hygglo_order_id: id, status: "confirmed", order_step: "BOOKED_AFTER_VERIFIED", start_date: date, end_date: date, net_to_owner_gbp: amount, gross_paid_gbp: amount, ...extra });
const reservations = [row("db-old", "dbcinema", "2026-09-01", 100), row("web-old", "dbcinema_web", "2026-09-01", 40), row("leo-old", "leo", "2026-09-01", 70), row("db-now", "dbcinema", "2026-10-01", 250), row("web-now", "dbcinema_web", "2026-10-01", 80), row("web-copy", "dbcinema_web", "2026-10-01", 60, { hygglo_order_id: "web-now" }), row("leo-now", "leo", "2026-10-01", 120), row("web-cancelled", "dbcinema_web", "2026-10-01", 999, { status: "cancelled" }), row("web-pending", "dbcinema_web", "2026-10-01", 999, { status: "pending", order_step: "VERIFIED" }), row("web-future", "dbcinema_web", "2026-11-01", 15)];
function context(cache?: any, history: any[] = [], extraReservations: any[] = [], baseReservations = reservations) {
  const source: Record<string, any[]> = { reservations: [...baseReservations, ...extraReservations], mv_lifetime_revenue: cache ? [{ payload: cache }] : [], historical_revenue: history };
  return { db: { query: (table: string) => { let rows = source[table] ?? []; const q: any = { collect: async () => rows, first: async () => rows[0] ?? null, withIndex: (_: any, fn: any) => { fn({eq: () => ({eq: () => {}})}); return q; } }; return q; } } };
}
const compute = (scope: string | null, ctx = context()) => (getLifetimeByMonth as any)._handler(ctx, { accountSlug: scope });
beforeEach(() => { vi.stubEnv("OWNER_AUTH_REQUIRED", "false"); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-07T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("website lifetime revenue", () => {
  it("separates historical and current website revenue while preserving the overall total and deduplication", async () => {
    const result = await compute(null); const current = result.months.find((r: any) => r.month === "2026-10"); const past = result.months.find((r: any) => r.month === "2026-09");
    expect(current.dbcinemaOrganic).toBe(250); expect(current.dbcinemaWebOrganic).toBe(80); expect(current.byAccount.dbcinema_web).toBe(80); expect(current.revenue).toBe(450);
    expect(past.dbcinemaOrganic).toBe(100); expect(past.dbcinemaWebOrganic).toBe(40); expect(past.revenue).toBe(210);
    expect(result.totalRevenue).toBe(660); expect(current.cumulative).toBe(660); expect(result.accountBreakdownVersion).toBe(4);
  });
  it("isolates website and Hygglo DB filters and keeps future payments outside realised totals", async () => {
    const web = await compute("dbcinema_web"); const db = await compute("dbcinema");
    expect(web.totalRevenue).toBe(120); expect(db.totalRevenue).toBe(350);
    expect(web.months.find((r: any) => r.month === "2026-10").dbcinemaOrganic).toBe(0);
    expect(db.months.every((r: any) => r.dbcinemaWebOrganic === 0)).toBe(true);
    expect(web.months.find((r: any) => r.month === "2026-11").bookedNext).toBe(15);
  });
  it("never loads an old combined cache, but reuses a versioned separated snapshot", async () => {
    expect((await compute(null, context({ months: [], totalRevenue: 999 }))).totalRevenue).toBe(660);
    const snapshot = { accountBreakdownVersion: 2, months: [], totalRevenue: 999 };
    expect((await compute(null, context(snapshot))).totalRevenue).toBe(660);
    const currentSnapshot = { accountBreakdownVersion: 4, months: [], totalRevenue: 12 };
    expect(await compute(null, context(currentSnapshot))).toEqual(currentSnapshot);
  });
  it("attributes verified-pending direct-site rentals to their payment month, independent of hire month", async () => {
    vi.setSystemTime(new Date("2026-11-25T12:00:00Z"));
    const paidSiteRow = row("paid-site", "dbcinema_web", "2026-12-12", 925.96, {
      status: "pending_review", order_step: "VERIFIED", booking_status: "confirmed", revenue_date: "2026-11-19",
    });
    const fixture = await compute("dbcinema_web", context(undefined, [], [paidSiteRow], []));
    expect(realisedMonthRevenue([paidSiteRow], "2026-11", "dbcinema_web").netGbp).toBe(925.96);
    expect(realisedMonthRevenue([paidSiteRow], "2026-12", "dbcinema_web").netGbp).toBe(0);
    expect(fixture.months.find((m: any) => m.month === "2026-11").dbcinemaWebOrganic).toBe(925.96);
    expect(fixture.months.find((m: any) => m.month === "2026-12").dbcinemaWebOrganic).toBe(0);
    expect(fixture.totalRevenue).toBe(925.96);
  });
  it("does not attribute Hygglo historical imports to website revenue", async () => {
    const result = await compute("dbcinema_web", context(undefined, [{ month: "2024-01", total_revenue_gbp: 1000, damage_costs_gbp: 0, dbcinema_revenue_gbp: 1000 }]));
    expect(result.months.find((r: any) => r.month === "2024-01").dbcinemaWebOrganic).toBe(0); expect(result.totalRevenue).toBe(120);
  });
});
