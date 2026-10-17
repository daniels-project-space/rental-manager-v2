import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import type { MutationCtx } from "../_generated/server";
import { sharedStockImplementation } from "./shared_stock_version";
import { STOCK_INPUT_KEY, stockStaticTables, captureStockInputs, loadStockInputCache, withSourceStockInputs, withPreparedStockInputs, type StockInputSnapshot } from "./stock_input_cache";
import { cacheByteDigest, cacheValueDigest, canonicalCacheJson, packCacheValue } from "./lossless_cache_codec";
import { loadReservationsForStockWindow, loadStockSources } from "./renter_stock";
import { patchStockInput, insertStockInput, deleteStockInput } from "./stock_input_writes";
import { patchRevenueReservation, insertRevenueReservation } from "./reservation_revenue";
import { publish, failed, enable, reset } from "../stock_input_cache_admin";

function fixture(input?: StockInputSnapshot) {
  const tables: Record<string, any[]> = Object.fromEntries([...stockStaticTables, "reservations", "renter_bot_lab_bookings", "stock_input_cache_state", "stock_input_cache_blobs", "reservation_revenue_facts", "reservation_revenue_ready", "hygglo_product_context", "hygglo_products", "online_listings", "storefront_checkout_stock"].map((key) => [key, []]));
  if (input) for (const [key, rows] of Object.entries(input)) tables[key] = structuredClone(rows);
  else {
    tables.items = [{ _id: "item", _creationTime: 1, name_canonical: "Camera", status: "active", is_marketing_only: false, qty: 2 }];
    tables.reservations = [{ _id: "booking", _creationTime: 1, status: "confirmed", start_date: "2026-10-15", end_date: "2026-10-17", account_slug: "leo", resolved_items: [{ item_id: "item", qty: 1 }] }];
  }
  const reads: string[] = [], writes: { table: string; patch?: any }[] = [], scheduled: unknown[] = [];
  let serial = 0, redirect = false;
  const indexes: Record<string, string[]> = { by_status: ["status"], by_status_end_date: ["status", "end_date"], by_status_return_date: ["status", "return_date"], by_account_status: ["account_slug", "status"], by_active_start: ["is_active", "start_date"], by_account_product: ["account_slug", "product_id"] };
  const compareValue = (a: any, b: any) => a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;
  const db = {
    query(table: string) {
      const filters: ((row: any) => boolean)[] = []; let index = "";
      const q = { withIndex(name: string, callback?: (range: any) => unknown) {
        index = name; const range = { eq(key: string, v: unknown) { filters.push((r) => r[key] === v); return range; }, gte(key: string, v: any) { filters.push((r) => r[key] >= v); return range; }, lte(key: string, v: any) { filters.push((r) => r[key] <= v); return range; } }; callback?.(range); return q;
      }, async collect() { reads.push(table); return structuredClone((tables[table] ?? []).filter((r) => filters.every((f) => f(r))).sort((a, b) => {
        for (const key of [...(indexes[index] ?? []), "_creationTime"]) { const order = compareValue(a[key], b[key]); if (order) return order; } return 0;
      })); }, async take(n: number) { return (await q.collect()).slice(0, n); }, async first() { return (await q.collect())[0] ?? null; }, async unique() { const rows = await q.collect(); if (rows.length > 1) throw Error("Duplicate fixture key"); return rows[0] ?? null; } }; return q;
    },
    normalizeId(table: string, id: string) { return tables[table]?.some((r) => r._id === id) ? id : null; },
    async get(id: string) { reads.push("get:" + id); return structuredClone(Object.values(tables).flat().find((r) => r._id === id) ?? null); },
    async insert(table: string, data: any) { if (redirect && table === "reservations") table = "renter_bot_lab_bookings"; const id = `${table}:${++serial}`; tables[table].push({ ...structuredClone(data), _id: id, _creationTime: serial }); writes.push({ table }); return id; },
    async patch(id: string, patch: any) { const table = Object.keys(tables).find((key) => tables[key].some((r) => r._id === id))!; const row = tables[table].find((r) => r._id === id); for (const [key, value] of Object.entries(patch)) if (value === undefined) delete row[key]; else row[key] = structuredClone(value); writes.push({ table, patch }); },
    async delete(id: string) { for (const table of Object.keys(tables)) { const i = tables[table].findIndex((r) => r._id === id); if (i >= 0) { tables[table].splice(i, 1); writes.push({ table }); } } },
    async replace(id: string, data: any) { const row = Object.values(tables).flat().find((r) => r._id === id); for (const key of Object.keys(row)) if (!key.startsWith("_")) delete row[key]; Object.assign(row, structuredClone(data)); },
  };
  const context = () => ({ db, scheduler: { async runAfter(...args: unknown[]) { scheduled.push(args); return "job"; } } }) as unknown as MutationCtx;
  return { tables, db, ctx: context(), context, reads, writes, scheduled, redirectInserts() { redirect = true; } };
}
async function ready(f: ReturnType<typeof fixture>, enabled = true) {
  const inputs = await captureStockInputs(f.context()), data = packCacheValue(inputs);
  f.tables.stock_input_cache_state.push({ _id: "state", _creationTime: 1, key: STOCK_INPUT_KEY, implementation: await sharedStockImplementation(), revision: 1, ready_revision: 1, enabled, queued: false, job_token: 0, attempts: 0, updated_at: 1 });
  f.tables.stock_input_cache_blobs.push({ _id: "blob", _creationTime: 1, key: STOCK_INPUT_KEY, version: 1, revision: 1, data, sha256: await cacheValueDigest(inputs), packed_sha256: await cacheByteDigest(data) });
  return inputs;
}
const handler = (definition: unknown) => (definition as { _handler: (ctx: MutationCtx, args: any) => Promise<any> })._handler;
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("atomic stock input cache", () => {
  it("reads the exact snapshot once per query and returns independent mutable records", async () => {
    const f = fixture(); await ready(f); f.reads.length = 0;
    const first = await loadReservationsForStockWindow(f.ctx, "confirmed"); first[0].status = "changed locally";
    const next = await loadReservationsForStockWindow(f.ctx, "confirmed"); expect(next[0].status).toBe("confirmed");
    expect(f.reads).toEqual(["stock_input_cache_state", "stock_input_cache_blobs"]);
  });
  it("coalesces a concurrent mutation, invalidates before source writes and clears read memo", async () => {
    const f = fixture(); await ready(f); expect(await loadStockInputCache(f.ctx)).not.toBeNull();
    await Promise.all([patchStockInput(f.ctx, "item" as never, { qty: 3 }), insertStockInput(f.ctx, "insurance_claims", { status: "open" } as never)]);
    expect(f.writes[0].table).toBe("stock_input_cache_state");
    expect(f.tables.stock_input_cache_state[0].revision).toBe(2); expect(f.scheduled).toHaveLength(1);
    expect(await loadStockInputCache(f.ctx)).toBeNull(); expect(f.tables.items[0].qty).toBe(3);
    await deleteStockInput(f.ctx, "item" as never); expect(f.scheduled).toHaveLength(1);
  });
  it("does not rebuild unchanged input values", async () => {
    const f = fixture(); await ready(f); await patchStockInput(f.ctx, "item" as never, { qty: 2 });
    expect(f.tables.stock_input_cache_state[0].revision).toBe(1); expect(f.scheduled).toHaveLength(0);
  });
  it("tracks active reservation clocks without mixing Lab namespaces", async () => {
    const f = fixture(); await ready(f); await patchRevenueReservation(f.ctx, "booking" as never, { last_polled_at: 123 });
    expect(f.tables.stock_input_cache_state[0].revision).toBe(2);
    const lab = fixture(); await ready(lab); lab.redirectInserts();
    const { _id, _creationTime, ...row } = lab.tables.reservations[0];
    await insertRevenueReservation(lab.ctx, row); expect(lab.tables.renter_bot_lab_bookings).toHaveLength(1);
    expect(lab.tables.stock_input_cache_state[0].revision).toBe(1); expect(lab.scheduled).toHaveLength(0);
  });
  it("keeps disabled preparation and stale source generations off the public path", async () => {
    const f = fixture(); await ready(f, false); expect(await loadStockInputCache(f.ctx)).toBeNull();
    const p = f.context(); expect(await withPreparedStockInputs(p, () => loadStockInputCache(p))).not.toBeNull();
    await patchStockInput(f.context(), "item" as never, { qty: 4 });
    await expect(withPreparedStockInputs(f.context(), async () => null)).rejects.toThrow("not current");
    expect(f.scheduled).toHaveLength(0);
    const blob = f.tables.stock_input_cache_blobs[0];
    await expect(handler(enable)(f.context(), { revision: 1, sha256: blob.sha256 })).rejects.toThrow("changed");
  });
  it("rejects stale workers and stops permanent retries", async () => {
    const f = fixture(); await ready(f); await patchStockInput(f.ctx, "item" as never, { qty: 3 }); const blob = f.tables.stock_input_cache_blobs[0];
    expect(await handler(publish)(f.context(), { token: 1, revision: 1, data: blob.data, sha256: blob.sha256, packed_sha256: blob.packed_sha256 })).toBe(false);
    const token = f.tables.stock_input_cache_state[0].job_token, jobs = f.scheduled.length;
    await handler(failed)(f.context(), { token: 1, error: "old worker" }); expect(f.scheduled).toHaveLength(jobs);
    await handler(failed)(f.context(), { token, error: "permanent: capacity" }); expect(f.tables.stock_input_cache_state[0].enabled).toBe(false);
    await handler(reset)(f.context(), {}); expect(f.tables.stock_input_cache_state[0].ready_revision).toBeUndefined();
  });
  it("keeps website hold expiry and heartbeat checks live", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const f = fixture(); await ready(f);
    f.tables.storefront_checkout_stock = [{ _id: "checkout", key: "website", receivedAt: 1000, rows: [{ bookingId: "hold", expiresAt: 2000 }] }];
    expect((await loadStockSources(f.context())).checkoutHolds).toHaveLength(1);
    vi.setSystemTime(2001); expect((await loadStockSources(f.context())).checkoutHolds).toHaveLength(0);
    vi.stubEnv("REQUIRE_WEBSITE_STOCK_HOLDS_SYNC", "true"); vi.setSystemTime(182000);
    await expect(loadStockSources(f.context())).rejects.toThrow("needs refresh");
  });
  it("preserves negotiated return and absolute website window index unions", async () => {
    const f = fixture(); f.tables.reservations.push({ _id: "site", _creationTime: 2, status: "confirmed", account_slug: "dbcinema_web", start_date: "2020-01-01", end_date: "2020-01-02", site_item_windows: [{ item_id: "item", qty: 1, start: Date.parse("2026-10-16"), end: Date.parse("2026-10-18") }] });
    f.tables.reservations[0].return_date = "2026-10-22"; await ready(f);
    for (const includeWebsite of [true, false]) {
      const raw = f.context(), cached = f.context(), window = { start_date: "2026-10-16", end_date: "2026-10-20" };
      const expected = await withSourceStockInputs(raw, () => loadReservationsForStockWindow(raw, "confirmed", window, includeWebsite));
      expect(await loadReservationsForStockWindow(cached, "confirmed", window, includeWebsite)).toEqual(expected);
    }
  });
  it("uses original indexes for fully tied keys and malformed legacy dates", async () => {
    for (const extra of [{ _id: "tie", _creationTime: 1, end_date: "2026-10-17" }, { _id: "legacy", _creationTime: 2, end_date: "October 17, 2026" }]) {
      const f = fixture(); f.tables.reservations.push({ ...f.tables.reservations[0], ...extra }); await ready(f); f.reads.length = 0;
      await loadReservationsForStockWindow(f.context(), "confirmed", { start_date: "2026-10-16", end_date: "2026-10-20" });
      expect(f.reads).toContain("reservations");
    }
  });
  it.runIf(!!process.env.RM_STOCK_INPUT_SNAPSHOT)("matches all original date partitions and full records over the private production snapshot", async () => {
    const input = JSON.parse(fs.readFileSync(process.env.RM_STOCK_INPUT_SNAPSHOT!, "utf8")).inputs;
    const f = fixture(input); const captured = await ready(f);
    expect(canonicalCacheJson(captured)).toBe(canonicalCacheJson(input));
    for (const status of ["confirmed", "ongoing", "pending_review"]) for (const window of [undefined, { start_date: "2026-10-01", end_date: "2026-10-31" }, { start_date: "2026-10-16", end_date: "2026-10-20" }, { start_date: "2026-11-01", end_date: "2026-11-30" }]) for (const website of [true, false]) {
      const raw = f.context(), cached = f.context();
      const expected = await withSourceStockInputs(raw, () => loadReservationsForStockWindow(raw, status, window, website));
      expect(await loadReservationsForStockWindow(cached, status, window, website)).toEqual(expected);
    }
  });
});
