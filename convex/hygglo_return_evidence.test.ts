import { describe, expect, it, vi } from "vitest";

vi.mock("./lib/reservation_revenue", () => ({
  patchRevenueReservation: async (ctx: any, id: string, patch: any) => ctx.db.patch(id, patch),
  insertRevenueReservation: async (ctx: any, row: any) => ctx.db.insert("reservations", row),
}));
vi.mock("./mv/earnings_by_period", async (original) => ({
  ...await original<any>(), applyReservationEarningsChanges: async () => {},
}));
vi.mock("./lib/rental_timing_notifications", async (original) => ({
  ...await original<any>(), syncRentalReminders: async () => {},
}));

import { upsertOrdersAsReservationsBatch } from "./hygglo";

function fixture() {
  const row: any = { _id: "r1", account_slug: "fixture", hygglo_order_id: "1", status: "confirmed", order_step: "RETURNED", start_date: "2027-01-01", end_date: "2027-01-02", items: [] };
  const db: any = {
    query: (table: string) => {
      const query: any = { withIndex: (_index: string, selector: any) => { const range: any = { eq: () => range }; selector(range); return query; }, first: async () => table === "reservations" ? { ...row } : null, collect: async () => [], take: async () => [] };
      return query;
    },
    patch: async (_id: string, patch: any) => Object.assign(row, patch),
    get: async () => ({ ...row }),
  };
  const ctx: any = { db, scheduler: { runAfter: async () => {} }, runMutation: async () => {}, auth: { getUserIdentity: async () => null } };
  const run = (order: any) => (upsertOrdersAsReservationsBatch as any)._handler(ctx, { orders: [{ account_slug: "fixture", hygglo_order_id: "1", start_date: "2027-01-01", end_date: "2027-01-02", sourceFilter: "current", items: [], ...order }] });
  return { row, run };
}

describe("return evidence at the reservation mutation", () => {
  it.each([
    undefined,
    { steps: [{ key: "RETURNED", completed: true, failure: null }] },
    { steps: [{ key: "RETURNED", completed: true }, { key: "RETURNED", completed: false }] },
  ])("does not accept a pre-extracted REVIEWED without valid proof", async (order) => {
    const state = fixture();
    await state.run({ order_step_extracted: "REVIEWED", order });
    expect(state.row).toMatchObject({ status: "confirmed", order_step: "RETURNED" });
  });

  it("accepts matching completed provider return evidence", async () => {
    const state = fixture();
    await state.run({ order_step_extracted: "REVIEWED", order: { steps: [{ key: "RETURNED", completed: true, failure: false }] } });
    expect(state.row).toMatchObject({ status: "completed", order_step: "REVIEWED" });
    await state.run({ order_step_extracted: "RETURNED", order: { steps: [{ key: "RETURNED", active: true, completed: false }] } });
    expect(state.row).toMatchObject({ status: "completed", order_step: "REVIEWED" });
  });

  it("applies the same strict rule to the legacy raw-order entry path", async () => {
    const state = fixture();
    await state.run({ order: { steps: [{ key: "RETURNED", completed: true, failure: "invalid" }] } });
    expect(state.row).toMatchObject({ status: "confirmed", order_step: "RETURNED" });
    await state.run({ order: { detail: { steps: [{ key: "RETURNED", completed: true }] } } });
    expect(state.row).toMatchObject({ status: "completed", order_step: "REVIEWED" });
  });
});
