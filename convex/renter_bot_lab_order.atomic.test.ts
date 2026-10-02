import { describe, expect, it } from "vitest";
import { applyChange } from "./renter_bot_lab_order";

function fixture() {
  const tables: Record<string, any[]> = {
    items: [{ _id: "camera", name_canonical: "Sony FX3", status: "active", is_marketing_only: false, qty: 1, kind: "camera_body", aliases: [] }],
    renter_bot_lab_orders: [{ _id: "order", thread_id: "__probe__atomic", account_slug: "leo", start_date: "2026-10-06", end_date: "2026-10-07", changes: [],
      items: [{ item_id: "camera", name: "Sony FX3", qty: 1, daily_price_gbp: 40, origin: "seed" }] }],
    renter_bot_lab_bookings: [{ _id: "booking", hygglo_order_id: "__probe__atomic", start_date: "2026-10-06", end_date: "2026-10-07", pickup_date: "2026-10-06" }],
  };
  const db = {
    query: (table: string) => {
      const filters: Array<[string, any]> = [];
      const q = { eq: (key: string, value: any) => { filters.push([key, value]); return q; } };
      const result: any = { withIndex: (_name: string, select: any) => { select(q); return result; },
        collect: async () => (tables[table] ?? []).filter(row => filters.every(([key, value]) => row[key] === value)),
        first: async () => (await result.collect())[0] ?? null, unique: async () => (await result.collect())[0] ?? null };
      return result;
    },
    patch: async (id: string, value: any) => { const row = Object.values(tables).flat().find(r => r._id === id); Object.assign(row, value); },
  };
  return { tables, ctx: { db } };
}
const extend = (ctx: any) => (applyChange as any)._handler(ctx, { thread_id: "__probe__atomic", action: "set_dates", start_date: "2026-10-06", end_date: "2026-10-08" });
describe("date amendments validate stock before writing", () => {
  it("leaves both records and physical pickup facts untouched on a blocked extra day", async () => {
    const { tables, ctx } = fixture();
    tables.owner_unavailability = [{ item_id: "camera", start_date: "2026-10-08", end_date: "2026-10-08" }];
    const before = structuredClone(tables);
    expect(await extend(ctx)).toMatchObject({ ok: false });
    expect(tables).toEqual(before);
  });
  it("commits an available date change with a real stock receipt and preserves pickup facts", async () => {
    const { tables, ctx } = fixture();
    const result = await extend(ctx);
    expect(result).toMatchObject({ ok: true, order: { days: 3, total_gbp: 120 }, stock_receipts: [{ available: true, start_date: "2026-10-06", end_date: "2026-10-08", requested_units: 1 }] });
    expect(tables.renter_bot_lab_orders[0].end_date).toBe("2026-10-08");
    expect(tables.renter_bot_lab_bookings[0]).toMatchObject({ end_date: "2026-10-08", pickup_date: "2026-10-06" });
  });
  it("aggregates shared physical components across separately rentable kit lines", async () => {
    const { tables, ctx } = fixture();
    tables.items.push({ _id: "camera2", name_canonical: "Sony A7 V", status: "active", qty: 1, kind: "camera_body" }, { _id: "lens", name_canonical: "Sony GM 24-70", status: "active", qty: 1, kind: "lens" });
    tables.renter_bot_lab_orders[0].items = [{ product_id: 1, item_id: "camera", name: "FX3 kit", qty: 1, origin: "seed" }, { product_id: 2, item_id: "camera2", name: "A7 V kit", qty: 1, origin: "seed" }];
    tables.listing_resolution_override = [1, 2].map(product_id => ({ account_slug: "leo", product_id, components: [{ item_id: product_id === 1 ? "camera" : "camera2", qty: 1 }, { item_id: "lens", qty: 1 }] }));
    const before = structuredClone(tables);
    expect(await extend(ctx)).toMatchObject({ ok: false });
    expect(tables).toEqual(before);
  });
  it("does not let a free primary body prove an unmapped listing kit", async () => {
    const { tables, ctx } = fixture();
    tables.renter_bot_lab_orders[0].items[0].product_id = 1;
    tables.hygglo_products = [{ accountSlug: "leo", productId: 1, masterItemId: "camera", name: "Unmapped kit" }];
    expect(await extend(ctx)).toMatchObject({ ok: false });
    expect(tables.renter_bot_lab_orders[0].changes).toEqual([]);
  });
  it("does not claim to validate a date change for an empty basket", async () => {
    const { tables, ctx } = fixture(); tables.renter_bot_lab_orders[0].items = [];
    expect(await extend(ctx)).toMatchObject({ ok: false });
  });
  it("does not move a collected rental's start date or edit an already returned rental", async () => {
    const { tables, ctx } = fixture();
    expect(await (applyChange as any)._handler(ctx, { thread_id: "__probe__atomic", action: "set_dates", start_date: "2026-10-07", end_date: "2026-10-08" })).toMatchObject({ ok: false });
    tables.renter_bot_lab_bookings[0].return_date = "2026-10-07";
    expect(await extend(ctx)).toMatchObject({ ok: false });
    expect(tables.renter_bot_lab_orders[0].changes).toEqual([]);
  });
});
