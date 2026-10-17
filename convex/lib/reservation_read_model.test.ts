import fs from "node:fs";
import { jsonToConvex } from "convex/values";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { reservationReadIndexes } from "./reservation_read_indexes";
import { syncReservationReadRecord, decodeReservationRead, reservationReadRecordMatches } from "./reservation_read_model";
import { useReservationReadModel, sourceReservationReadContext, preparedReservationReadContext, hasReservationByOrder } from "./reservation_read_queries";
import { patchRevenueReservation, insertRevenueReservation, deleteRevenueReservation } from "./reservation_revenue";
import * as admin from "../reservation_read_admin";
import * as activityAdmin from "../reservation_activity_admin";
import { readLatestReservationActivity, setReservationActivityMode } from "./reservation_activity_queries";

class Range {
  #operations: any[];
  constructor(operations: any[] = []) { this.#operations = operations; }
  eq(k: string, v: any) { return new Range([...this.#operations, ["eq", k, v]]); }
  gt(k: string, v: any) { return new Range([...this.#operations, ["gt", k, v]]); }
  gte(k: string, v: any) { return new Range([...this.#operations, ["gte", k, v]]); }
  lt(k: string, v: any) { return new Range([...this.#operations, ["lt", k, v]]); }
  lte(k: string, v: any) { return new Range([...this.#operations, ["lte", k, v]]); }
  export() { return this.#operations; }
}
function fixture(rows?: any[]) {
  const tables: Record<string, any[]> = { reservations: structuredClone(rows ?? [
    { _id: "r1", _creationTime: 10, status: "confirmed", created_at: 1, v1_updated_at: 1, account_slug: "leo", hygglo_order_id: "order1", start_date: "2026-10-15", end_date: "2026-10-18", notes: "all original fields retained", net_to_owner_gbp: 0.30000000000000004 },
    { _id: "r2", _creationTime: 20, status: "ongoing", created_at: 2, v1_updated_at: 2, account_slug: "dbcinema", hygglo_order_id: "order2", start_date: "2026-10-16", end_date: "2026-10-19" },
    { _id: "r3", _creationTime: 30, status: "cancelled", created_at: 3, v1_updated_at: 3, account_slug: "leo", hygglo_order_id: "order1", start_date: "2026-10-17" },
  ]), reservation_read_records: [], reservation_order_presence: [], reservation_read_gate: [], reservation_read_progress: [], reservation_revenue_ready: [], reservation_revenue_facts: [], stock_input_cache_state: [], renter_bot_lab_bookings: [{ _id: "lab1", _creationTime: 1, status: "confirmed", created_at: 0, v1_updated_at: 0 }] };
  const sourceIds = new Set(tables.reservations.map(r => r._id)), reads: string[] = [], writes: string[] = []; let serial = 100, modelFailure = false, sourceFailure = false;
  function query(table: string, index = "by_creation_time", operations: any[] = [], direction = "asc", filter?: (row: any) => boolean): any {
    const fields = index === "by_key" ? ["key"] : index === "by_source" ? ["source_id"] : index === "by_order" ? ["hygglo_order_id"] : index === "by_source_creation_time" ? ["source_creation_time"] : index === "by_creation_time" ? [] : index === "by_renter" ? ["renter_id"] : [...(reservationReadIndexes[index as keyof typeof reservationReadIndexes] ?? []), ...(table === "reservation_read_records" ? ["source_creation_time"] : [])];
    function values() {
      const compare = (a: any, b: any) => a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;
      return tables[table].filter(row => operations.every(([op, key, value]) => op === "eq" ? row[key] === value : op === "gte" ? compare(row[key], value) >= 0 : op === "lte" ? compare(row[key], value) <= 0 : op === "gt" ? compare(row[key], value) > 0 : compare(row[key], value) < 0)).filter(row => !filter || filter(row)).slice().sort((a, b) => {
        for (const field of [...fields, "_creationTime", "_id"]) { const n = compare(a[field], b[field]); if (n) return direction === "asc" ? n : -n; } return 0;
      });
    }
    const q = {
      withIndex(name: string, build?: (range: Range) => Range) { return query(table, name, build ? build(new Range()).export() : [], direction, filter); },
      order(value: string) { return query(table, index, operations, value, filter); },
      filter(fn: (row: any) => boolean) { return query(table, index, operations, direction, fn); },
      async collect() { reads.push(table + ":" + index); return structuredClone(values()); },
      async take(n: number) { reads.push(table + ":" + index); if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid take count"); return structuredClone(values().slice(0, n)); },
      async first() { return (await q.take(1))[0] ?? null; },
      async unique() { const result = await q.take(2); if (result.length > 1) throw Error("Original unique violation"); return result[0] ?? null; },
      async paginate({ cursor, numItems }: any) { reads.push(table + ":paginate"); const after = cursor ? JSON.parse(cursor) : null; const all = values().filter(r => !after || r._creationTime > after[0] || r._creationTime === after[0] && r._id > after[1]); const page = all.slice(0, numItems), last = page.at(-1); return { page: structuredClone(page), isDone: page.length === all.length, continueCursor: last ? JSON.stringify([last._creationTime, last._id]) : cursor }; },
      async *[Symbol.asyncIterator]() { for (const row of await q.collect()) yield row; },
    }; return q;
  }
  const db = {
    query,
    normalizeId(table: string, id: string) { return table === "reservations" && sourceIds.has(id) ? id : null; },
    async get(id: string) { reads.push("get:" + id); return structuredClone(Object.values(tables).flat().find(row => row._id === id) ?? null); },
    async insert(table: string, value: any) { if (table === "reservation_read_records" && modelFailure) throw Error("model write failed"); const id = table === "reservations" ? "r" + (++serial) : table + ":" + (++serial); if (table === "reservations") sourceIds.add(id); tables[table].push({ ...structuredClone(value), _id: id, _creationTime: serial }); writes.push(table); return id; },
    async patch(id: string, value: any) { const table = Object.keys(tables).find(key => tables[key].some(row => row._id === id))!; if (table === "reservations" && sourceFailure) throw Error("source write failed"); const row = tables[table].find(row => row._id === id); for (const [key, v] of Object.entries(value)) if (v === undefined) delete row[key]; else row[key] = structuredClone(v); writes.push(table); },
    async replace(id: string, value: any) { const table = Object.keys(tables).find(key => tables[key].some(row => row._id === id))!; if (table === "reservation_read_records" && modelFailure) throw Error("model write failed"); const row = tables[table].find(row => row._id === id); for (const key of Object.keys(row)) if (!key.startsWith("_")) delete row[key]; Object.assign(row, structuredClone(value)); writes.push(table); },
    async delete(id: string) { for (const [table, rows] of Object.entries(tables)) { const i = rows.findIndex(row => row._id === id); if (i >= 0) { if (table === "reservation_read_records" && modelFailure) throw Error("model write failed"); rows.splice(i, 1); writes.push(table); } } },
  };
  const context = () => ({ db, scheduler: { async runAfter() { return "job"; } } }) as unknown as MutationCtx;
  return { tables, db, reads, writes, context, modelFailure: (v: boolean) => { modelFailure = v; }, sourceFailure: (v: boolean) => { sourceFailure = v; } };
}
async function prepare(f: ReturnType<typeof fixture>, enabled = true) {
  await (admin.start as any)._handler(f.context(), {});
  for (let n = 0; n < 20 && f.tables.reservation_read_progress[0].stage !== "prepared"; n++) await (admin.step as any)._handler(f.context(), {});
  expect(f.tables.reservation_read_gate[0].ready).toBe(true);
  if (enabled) await (admin.enable as any)._handler(f.context(), { revision: f.tables.reservation_read_progress[0].revision, count: f.tables.reservation_read_progress[0].audited_count });
}
async function prepareActivity(f: ReturnType<typeof fixture>, enable = true) {
  await (activityAdmin.start as any)._handler(f.context(), {});
  for (let n = 0; n < 20 && f.tables.reservation_read_progress[0].activity_stage !== "prepared"; n++) await (activityAdmin.step as any)._handler(f.context(), {});
  const audit = await (activityAdmin.audit as any)._handler(f.context(), {});
  if (enable) await (activityAdmin.enable as any)._handler(f.context(), audit);
  return audit;
}

describe("exact poller activity metadata", () => {
  it.each(Array.from({ length: 8 }, (_, bits) => bits))("preserves every populated-field combination %s", async bits => {
    const f = fixture([{ _id: "r1", _creationTime: 1, status: "confirmed", created_at: 1, v1_updated_at: 1, hygglo_order_id: "one", latest_activity: 1,
      ...(bits & 1 ? { order_step: "REQUEST" } : {}), ...(bits & 2 ? { paid: false } : {}), ...(bits & 4 ? { platform_booking_confirmed: false } : {}) }]);
    await prepare(f); await prepareActivity(f);
    expect(await readLatestReservationActivity(f.context(), ["one"])).toEqual({ one: { latest_activity: 1, has_order_step: bits === 7 } });
  });
  it.each([-0, NaN, Infinity, -Infinity, 0.30000000000000004])("retains the exact numeric activity value %s", async latest_activity => {
    const f = fixture([{ _id: "r1", _creationTime: 1, status: "confirmed", created_at: 1, v1_updated_at: 1, hygglo_order_id: "one", latest_activity }]);
    await prepare(f); await prepareActivity(f);
    const value = await readLatestReservationActivity(f.context(), ["one"]);
    expect(Object.is(value.one.latest_activity, latest_activity)).toBe(true);
  });
  it("preserves populated false flags, missing fields, strings, floats and duplicate order semantics", async () => {
    const f = fixture([
      { _id: "r1", _creationTime: 1, status: "confirmed", created_at: 1, v1_updated_at: 1, hygglo_order_id: "zero", latest_activity: 0, order_step: "REQUEST", paid: false, platform_booking_confirmed: false },
      { _id: "r2", _creationTime: 2, status: "ongoing", created_at: 2, v1_updated_at: 2, hygglo_order_id: "stamp", latest_activity: "2026-10-17T00:00:00.123Z", order_step: "REQUEST", paid: true },
      { _id: "r3", _creationTime: 3, status: "cancelled", created_at: 3, v1_updated_at: 3, hygglo_order_id: "duplicate" },
      { _id: "r4", _creationTime: 4, status: "confirmed", created_at: 4, v1_updated_at: 4, hygglo_order_id: "duplicate", latest_activity: 99, order_step: "REQUEST", paid: true, platform_booking_confirmed: true },
      { _id: "r5", _creationTime: 5, status: "confirmed", created_at: 5, v1_updated_at: 5, hygglo_order_id: "float", latest_activity: 0.30000000000000004, order_step: "REQUEST", paid: true, platform_booking_confirmed: true },
    ]);
    const ids = ["stamp", "zero", "duplicate", "absent", "float", "zero"];
    const before = await readLatestReservationActivity(f.context(), ids);
    expect(before).toEqual({ stamp: { latest_activity: "2026-10-17T00:00:00.123Z", has_order_step: false }, zero: { latest_activity: 0, has_order_step: true }, float: { latest_activity: 0.30000000000000004, has_order_step: true } });
    await prepare(f); await prepareActivity(f); f.reads.length = 0;
    expect(await readLatestReservationActivity(f.context(), ids)).toEqual(before);
    expect(f.reads.filter(r => r.startsWith("reservations:"))).toEqual(["reservations:by_hygglo_order_id"]);
    expect(await (activityAdmin.read as any)._handler(f.context(), { mode: "prepared", hygglo_order_ids: ids })).toEqual(before);
  });
  it("prepares and prunes derived rows without changing source documents or compressed records", async () => {
    const f = fixture(); await prepare(f); const before = structuredClone(f.tables.reservations); f.writes.length = 0;
    f.tables.reservation_order_presence.push({ _id: "orphan", _creationTime: 999, source_id: "ghost", hygglo_order_id: "ghost", activity_version: 1, latest_activity: 1, order_step: "REQUEST", paid: true, platform_booking_confirmed: true });
    const result = await prepareActivity(f, false);
    expect(result.count).toBe(before.length); expect(f.tables.reservations).toEqual(before);
    expect(f.writes).not.toContain("reservations"); expect(f.writes).not.toContain("reservation_read_records");
    expect(f.tables.reservation_read_gate[0].activity_enabled).not.toBe(true);
    expect(f.tables.reservation_order_presence.some(r => r.source_id === "ghost")).toBe(false);
  });
  it("maintains activity through actual source edits, order moves, insertions and deletion", async () => {
    const f = fixture(); await prepare(f); await prepareActivity(f);
    await patchRevenueReservation(f.context(), "r2" as any, { latest_activity: 5, order_step: "REQUEST", paid: false, platform_booking_confirmed: false });
    expect(await readLatestReservationActivity(f.context(), ["order2"])).toEqual({ order2: { latest_activity: 5, has_order_step: true } });
    await patchRevenueReservation(f.context(), "r2" as any, { latest_activity: "updated", paid: undefined, hygglo_order_id: "moved" });
    expect(await readLatestReservationActivity(f.context(), ["order2", "moved"])).toEqual({ moved: { latest_activity: "updated", has_order_step: false } });
    const id = await insertRevenueReservation(f.context(), { status: "confirmed", created_at: 40, v1_updated_at: 40, hygglo_order_id: "new", latest_activity: 7 });
    expect(await readLatestReservationActivity(f.context(), ["new"])).toEqual({ new: { latest_activity: 7, has_order_step: false } });
    await deleteRevenueReservation(f.context(), id);
    expect(await readLatestReservationActivity(f.context(), ["new"])).toEqual({});
  });
  it("avoids metadata writes for source changes unrelated to poller skip decisions", async () => {
    const f = fixture(); await prepare(f); await prepareActivity(f); f.writes.length = 0;
    await patchRevenueReservation(f.context(), "r2" as any, { notes: "unchanged activity", last_polled_at: 100 });
    expect(f.writes).not.toContain("reservation_order_presence");
  });
  it("falls back for legacy metadata and disabled or dirty gates; prepared mode fails closed", async () => {
    const f = fixture(); await prepare(f); await prepareActivity(f);
    await patchRevenueReservation(f.context(), "r2" as any, { latest_activity: 12 });
    const expected = { order2: { latest_activity: 12, has_order_step: false } };
    delete f.tables.reservation_order_presence.find(r => r.source_id === "r2").activity_version;
    expect(await readLatestReservationActivity(f.context(), ["order2"])).toEqual(expected);
    const strict = f.context(); setReservationActivityMode(strict, "prepared");
    await expect(readLatestReservationActivity(strict, ["order2"])).rejects.toThrow("unavailable");
    for (const field of ["ready", "enabled", "activity_enabled"]) {
      const gate = f.tables.reservation_read_gate[0], old = gate[field]; gate[field] = false; f.reads.length = 0;
      expect(await readLatestReservationActivity(f.context(), ["order2"])).toEqual(expected);
      expect(f.reads).toContain("reservations:by_hygglo_order_id"); gate[field] = old;
    }
  });
  it("rejects stale activation and a forged activity index value", async () => {
    const f = fixture(); await prepare(f); const audit = await prepareActivity(f, false);
    await patchRevenueReservation(f.context(), "r2" as any, { latest_activity: 44 });
    await expect((activityAdmin.enable as any)._handler(f.context(), audit)).rejects.toThrow("changed");
    f.tables.reservation_order_presence.find(r => r.source_id === "r2").latest_activity = 999;
    await expect((activityAdmin.audit as any)._handler(f.context(), {})).rejects.toThrow("mismatch");
    expect(f.tables.reservation_read_gate[0].activity_enabled).not.toBe(true);
  });
  it("keeps source mode independent and qualification bounded without clipping runtime results", async () => {
    const f = fixture(); await prepare(f); await prepareActivity(f);
    const ctx = f.context(); setReservationActivityMode(ctx, "source"); f.reads.length = 0;
    expect(await readLatestReservationActivity(ctx, ["order1", "absent"])).toEqual({});
    expect(f.reads).toEqual(["reservations:by_hygglo_order_id", "reservations:by_hygglo_order_id"]);
    f.tables.reservations = Array.from({ length: 6001 }, (_, i) => ({ ...f.tables.reservations[0], _id: "r" + i }));
    await expect((activityAdmin.audit as any)._handler(f.context(), {})).rejects.toThrow("bound");
  });
});

describe("full lossless reservation read model", () => {
  it("uses the installed Convex SDK range builder without replaying clock callbacks", () => {
    const require = createRequire(import.meta.url);
    const { QueryInitializerImpl } = require(path.join(path.dirname(require.resolve("convex/server")), "impl/query_impl.js"));
    const f = fixture(); const ctx = { ...f.context(), db: { ...f.db, query(table: string) { return table === "reservations" ? new QueryInitializerImpl(table) : f.db.query(table); } } } as unknown as QueryCtx;
    let calls = 0;
    expect(() => useReservationReadModel(ctx).db.query("reservations").withIndex("by_creation_time", q => { calls++; return q.gte("_creationTime", calls * 15); })).not.toThrow();
    expect(calls).toBe(1);
  });
  it("falls back for an incompressible large source value without losing bytes", async () => {
    const bytes = new Uint8Array(900_000); for (let at = 0; at < bytes.length; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(at + 65536, bytes.length)));
    const f = fixture([{ _id: "r1", _creationTime: 1, status: "confirmed", created_at: 1, v1_updated_at: 1, completeOriginalBytes: bytes.buffer }]);
    await prepare(f); expect(f.tables.reservation_read_records[0].valid).toBe(false); expect(f.tables.reservation_read_progress[0].audited_fallback_count).toBe(1);
    expect(await useReservationReadModel(f.context()).db.query("reservations").collect()).toEqual(f.tables.reservations);
  });
  it("keeps source fallback active after a caught source-write failure", async () => {
    const f = fixture(); await prepare(f); f.sourceFailure(true);
    await expect(patchRevenueReservation(f.context(), "r1" as any, { v1_updated_at: 9 })).rejects.toThrow("source write failed");
    expect(f.tables.reservation_read_gate[0].ready).toBe(false);
    expect(await useReservationReadModel(f.context()).db.query("reservations").collect()).toEqual(f.tables.reservations);
  });
  it("preserves complete documents, source creation order and duplicate order IDs", async () => {
    const f = fixture(); await prepare(f); f.tables.reservation_read_records.reverse(); f.reads.length = 0;
    const ctx = useReservationReadModel(f.context());
    expect(await ctx.db.query("reservations").collect()).toEqual(f.tables.reservations);
    expect(await ctx.db.query("reservations").withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", "order1")).first()).toEqual(f.tables.reservations[0]);
    expect(f.reads.some(x => x.startsWith("reservations:"))).toBe(false);
  });
  it("round trips IEEE values, bytes, integer values and nested fields without truncation", async () => {
    const f = fixture([{ _id: "r1", _creationTime: 1, status: "confirmed", created_at: 1, v1_updated_at: 1, nested: { numbers: [-0, NaN, Infinity, -Infinity, 0.30000000000000004], integer: 8n, bytes: new Uint8Array([0, 1, 255]).buffer } }]); await prepare(f);
    expect(await decodeReservationRead(f.tables.reservation_read_records[0])).toEqual(f.tables.reservations[0]);
  });
  it("uses complete source records when absent, disabled, dirty or corrupted", async () => {
    for (const mode of ["absent", "disabled", "dirty", "corrupt"]) {
      const f = fixture(); if (mode !== "absent") await prepare(f);
      if (mode === "disabled") f.tables.reservation_read_gate[0].enabled = false;
      if (mode === "dirty") f.tables.reservation_read_gate[0].ready = false;
      if (mode === "corrupt") f.tables.reservation_read_records[0].data = new Uint8Array([1, 2, 3]).buffer;
      expect(await useReservationReadModel(f.context()).db.query("reservations").collect()).toEqual(f.tables.reservations);
    }
  });
  it("uses all five range operations with original order, limit and optional-field semantics", async () => {
    const f = fixture(); await prepare(f);
    for (const order of ["asc", "desc"] as const) for (const limit of [0, 1, 2, 10]) {
      const raw = f.db.query("reservations").withIndex("by_account_start", (q: any) => q.eq("account_slug", "leo").gte("start_date", "2026-10-15").lte("start_date", "2026-10-17")).order(order);
      const cached = useReservationReadModel(f.context()).db.query("reservations").withIndex("by_account_start", q => q.eq("account_slug", "leo").gte("start_date", "2026-10-15").lte("start_date", "2026-10-17")).order(order);
      expect(await cached.take(limit)).toEqual(await raw.take(limit));
    }
    const ctx = useReservationReadModel(f.context()); expect(await ctx.db.query("reservations").withIndex("by_status_start_date", q => q.eq("status", "confirmed").gt("start_date", "2026-10-14").lt("start_date", "2026-10-16")).collect()).toEqual([f.tables.reservations[0]]);
  });
  it("evaluates a range callback once, preserving exact moving-clock boundaries", async () => {
    const f = fixture(); await prepare(f); let calls = 0;
    const rows = await useReservationReadModel(f.context()).db.query("reservations").withIndex("by_creation_time", q => { calls++; return q.gte("_creationTime", calls * 15); }).collect();
    expect(calls).toBe(1); expect(rows.map(r => r._id)).toEqual(["r2", "r3"]);
  });
  it("retains raw filters, pagination cursors, iterators and unsupported indexes", async () => {
    const f = fixture(); await prepare(f); const ctx = useReservationReadModel(f.context());
    expect(await (ctx.db.query("reservations") as any).filter((row: any) => row.status === "ongoing").collect()).toEqual([f.tables.reservations[1]]);
    expect(await ctx.db.query("reservations").paginate({ cursor: null, numItems: 2 })).toEqual(await f.db.query("reservations").paginate({ cursor: null, numItems: 2 }));
    expect(await ctx.db.query("reservations").withIndex("by_renter", q => q.eq("renter_id", undefined)).collect()).toEqual(f.tables.reservations);
    const iterated = []; for await (const row of ctx.db.query("reservations")) iterated.push(row); expect(iterated).toEqual(f.tables.reservations);
  });
  it("falls back on source creation-time ties, including a take boundary", async () => {
    const f = fixture(); f.tables.reservations[1]._creationTime = 10; await prepare(f); f.reads.length = 0;
    expect(await useReservationReadModel(f.context()).db.query("reservations").take(1)).toEqual(await f.db.query("reservations").take(1)); expect(f.reads).toContain("reservations:by_creation_time");
  });
  it("preserves unique violations, empty results and point IDs", async () => {
    const f = fixture(); await prepare(f); const ctx = useReservationReadModel(f.context());
    await expect(ctx.db.query("reservations").withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", "order1")).unique()).rejects.toThrow("Original unique violation");
    expect(await ctx.db.query("reservations").withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", "none")).first()).toBeNull();
    expect(await ctx.db.get("r2" as any)).toEqual(f.tables.reservations[1]);
    await f.db.delete("r2"); await syncReservationReadRecord(f.context(), "r2" as any); expect(await useReservationReadModel(f.context()).db.get("r2" as any)).toBeNull();
  });
  it("reuses complete cohort rows only after proving a unique order identity", async () => {
    const f = fixture(); await prepare(f); const ctx = useReservationReadModel(f.context());
    const cohort = await ctx.db.query("reservations").withIndex("by_status", q => q.eq("status", "ongoing")).collect();
    cohort[0].notes = "caller mutation"; f.reads.length = 0;
    const first = await ctx.db.query("reservations").withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", "order2")).first();
    expect(first).toEqual(f.tables.reservations[1]);
    expect(f.reads).toEqual(["reservation_order_presence:by_order"]);
    first!.notes = "another caller mutation"; f.reads.length = 0;
    expect(await ctx.db.get("r2" as any)).toEqual(f.tables.reservations[1]);
    expect(await ctx.db.query("reservations").withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", "order2")).first()).toEqual(f.tables.reservations[1]);
    expect(f.reads).toEqual([]);
  });
  it("never treats a partial cohort as proof of the first duplicate", async () => {
    const f = fixture(); await prepare(f); const ctx = useReservationReadModel(f.context());
    await ctx.db.query("reservations").withIndex("by_status", q => q.eq("status", "cancelled")).collect(); f.reads.length = 0;
    expect(await ctx.db.query("reservations").withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", "order1")).first()).toEqual(f.tables.reservations[0]);
    expect(f.reads).toEqual(["reservation_order_presence:by_order", "reservation_read_records:by_hygglo_order_id"]);
    expect(await ctx.db.query("reservations").withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", "order1")).order("desc").first()).toEqual(f.tables.reservations[2]);
  });
  it("coalesces identical first reads and keeps missing results independent of get", async () => {
    const f = fixture(); await prepare(f); const ctx = useReservationReadModel(f.context()); f.reads.length = 0;
    const get = () => ctx.db.query("reservations").withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", "order2")).first();
    const [a, b] = await Promise.all([get(), get()]); expect(a).toEqual(b); expect(a).not.toBe(b);
    expect(f.reads.filter(r => r === "reservation_read_records:by_hygglo_order_id")).toHaveLength(1);
    expect(await ctx.db.query("reservations").withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", "absent")).first()).toBeNull();
    expect(await ctx.db.get("r1" as any)).toEqual(f.tables.reservations[0]);
  });
  it("falls back if a presence key is unavailable, and isolates request snapshots", async () => {
    const f = fixture(); await prepare(f); const ctx = useReservationReadModel(f.context());
    await ctx.db.query("reservations").collect(); f.tables.reservation_order_presence.length = 0; f.reads.length = 0;
    expect(await ctx.db.query("reservations").withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", "order2")).first()).toEqual(f.tables.reservations[1]);
    expect(f.reads).toContain("reservation_read_records:by_hygglo_order_id");
    await patchRevenueReservation(f.context(), "r2" as any, { notes: "new committed snapshot" });
    const next = useReservationReadModel(f.context());
    expect(await next.db.get("r2" as any)).toEqual(f.tables.reservations[1]);
  });
  it("does not reuse rows for bounded order ranges or disabled models", async () => {
    const f = fixture(); await prepare(f); const ctx = useReservationReadModel(f.context());
    await ctx.db.query("reservations").collect(); f.reads.length = 0;
    expect(await ctx.db.query("reservations").withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", "order1").gt("_creationTime", 15)).first()).toEqual(f.tables.reservations[2]);
    expect(f.reads).not.toContain("reservation_order_presence:by_order");
    f.tables.reservation_read_gate[0].enabled = false; f.reads.length = 0;
    expect(await useReservationReadModel(f.context()).db.query("reservations").withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", "order2")).first()).toEqual(f.tables.reservations[1]);
    expect(f.reads).toContain("reservations:by_hygglo_order_id");
  });
  it("requires strict prepared reads and preserves existing context identity", async () => {
    const f = fixture(); const original = f.context(); expect(useReservationReadModel(original)).toBe(original);
    await expect(preparedReservationReadContext(f.context()).db.query("reservations").collect()).rejects.toThrow("unavailable");
    await prepare(f, false); const ctx = preparedReservationReadContext(original); expect(await ctx.db.query("reservations").collect()).toEqual(f.tables.reservations);
    const raw = sourceReservationReadContext(ctx); expect(useReservationReadModel(raw)).toBe(raw); expect(raw.db).toBe(f.db);
  });
  it("maintains every source field through real central writer helpers", async () => {
    const f = fixture(); await prepare(f);
    await patchRevenueReservation(f.context(), "r1" as any, { last_polled_at: 55 });
    expect(await reservationReadRecordMatches(f.tables.reservation_read_records.find(r => r.source_id === "r1"), f.tables.reservations[0])).toBe(true);
    const id = await insertRevenueReservation(f.context(), { status: "confirmed", created_at: 40, v1_updated_at: 40 });
    await deleteRevenueReservation(f.context(), "r2" as any);
    expect(await useReservationReadModel(f.context()).db.query("reservations").collect()).toEqual(await f.db.query("reservations").collect());
    expect(f.tables.reservation_read_records.some(r => r.source_id === id)).toBe(true);
  });
  it("keeps the runtime gate stable on normal writes and coalesces revision bumps", async () => {
    const f = fixture(); await prepare(f); const gate = structuredClone(f.tables.reservation_read_gate[0]); const ctx = f.context();
    await Promise.all([patchRevenueReservation(ctx, "r1" as any, { last_polled_at: 8 }), patchRevenueReservation(ctx, "r2" as any, { last_polled_at: 9 })]);
    expect(f.tables.reservation_read_gate[0]).toEqual(gate); expect(f.tables.reservation_read_progress[0].revision).toBe(1);
  });
  it("does not invalidate or rewrite unchanged records", async () => {
    const f = fixture(); await prepare(f); f.writes.length = 0; await patchRevenueReservation(f.context(), "r1" as any, { v1_updated_at: 1 });
    expect(f.writes).toEqual(["reservations"]); expect(f.tables.reservation_read_progress[0].revision).toBe(0);
  });
  it("disables reads and restarts preparation after a caught model-write failure", async () => {
    const f = fixture(); await prepare(f); f.modelFailure(true); await expect(patchRevenueReservation(f.context(), "r1" as any, { v1_updated_at: 9 })).rejects.toThrow("model write failed");
    expect(f.tables.reservation_read_gate[0].ready).toBe(false); expect(f.tables.reservation_read_progress[0].stage).toBe("backfill");
    expect(await useReservationReadModel(f.context()).db.query("reservations").collect()).toEqual(f.tables.reservations);
  });
  it("does not route Lab source IDs into production compressed records", async () => {
    const f = fixture(); await prepare(f); const before = structuredClone(f.tables.reservation_read_records);
    await patchRevenueReservation(f.context(), "lab1" as any, { last_polled_at: 9 }); expect(f.tables.reservation_read_records).toEqual(before);
  });
  it("prunes ghost records before auditing the whole source and keeps activation disabled", async () => {
    const f = fixture(); await prepare(f, false); const ghost = structuredClone(f.tables.reservation_read_records[0]); ghost._id = "ghost"; ghost.source_id = "missing"; f.tables.reservation_read_records.push(ghost);
    await prepare(f, false); expect(f.tables.reservation_read_records.some(r => r._id === "ghost")).toBe(false); expect(f.tables.reservation_read_gate[0].enabled).toBe(false); expect(f.tables.reservation_read_progress[0].audited_count).toBe(3);
  });
  it("keeps Lab reads on their original isolated table and IDs", async () => {
    const f = fixture(); await prepare(f); const ctx = useReservationReadModel(f.context()); f.reads.length = 0;
    expect(await ctx.db.get("lab1" as any)).toEqual(f.tables.renter_bot_lab_bookings[0]);
    expect(await ctx.db.query("renter_bot_lab_bookings").collect()).toEqual(f.tables.renter_bot_lab_bookings);
    expect(f.reads.some(x => x.startsWith("reservation_read_records:"))).toBe(false);
  });
  it("can re-audit a disabled prepared model after normal source changes", async () => {
    const f = fixture(); await prepare(f, false); await patchRevenueReservation(f.context(), "r1" as any, { last_polled_at: 99 });
    await (admin.reaudit as any)._handler(f.context(), {});
    for (let n = 0; n < 20 && f.tables.reservation_read_progress[0].stage !== "prepared"; n++) await (admin.step as any)._handler(f.context(), {});
    await (admin.enable as any)._handler(f.context(), { revision: 1, count: 3 }); expect(f.tables.reservation_read_gate[0].enabled).toBe(true);
  });
  it("does not certify an orphan left by a caught delete failure during migration", async () => {
    const f = fixture(); await prepare(f, false); f.modelFailure(true);
    await expect(deleteRevenueReservation(f.context(), "r1" as any)).rejects.toThrow("model write failed");
    expect(f.tables.reservation_read_progress[0].stage).toBe("backfill"); f.modelFailure(false);
    for (let n = 0; n < 20 && f.tables.reservation_read_progress[0].stage !== "prepared"; n++) await (admin.step as any)._handler(f.context(), {});
    expect(f.tables.reservation_read_progress[0].audited_count).toBe(2); expect(f.tables.reservation_read_records.some(r => r.source_id === "r1")).toBe(false);
  });
  it("preserves source behavior for a read-only framework context", async () => {
    const f = fixture(); await prepare(f); const ctx = Object.freeze(f.context());
    expect(useReservationReadModel(ctx)).toBe(ctx); expect(await ctx.db.query("reservations").collect()).toEqual(f.tables.reservations);
  });
  it.skipIf(!process.env.RM_RESERVATION_READ_SNAPSHOT)("round trips complete private production source records", async () => {
    const rows = jsonToConvex(JSON.parse(fs.readFileSync(process.env.RM_RESERVATION_READ_SNAPSHOT!, "utf8"))) as any[];
    const f = fixture(rows); await prepare(f); expect(await useReservationReadModel(f.context()).db.query("reservations").collect()).toEqual(rows);
    expect(f.tables.reservation_read_progress[0].audited_count).toBe(rows.length);
  });
  it("checks booking existence without full documents or compressed bodies", async () => {
    const f = fixture(); await prepare(f); f.reads.length = 0; const ctx = useReservationReadModel(f.context());
    expect(await hasReservationByOrder(ctx, "order1")).toBe(true); expect(await hasReservationByOrder(ctx, "absent")).toBe(false);
    expect(f.reads.some(x => x.startsWith("reservations:") || x.startsWith("reservation_read_records:"))).toBe(false);
    expect(f.reads.filter(x => x.startsWith("reservation_read_gate:"))).toHaveLength(1);
  });
  it("updates existence keys and preserves other duplicate source orders on deletion", async () => {
    const f = fixture(); await prepare(f); await patchRevenueReservation(f.context(), "r1" as any, { hygglo_order_id: "changed" });
    expect(await hasReservationByOrder(useReservationReadModel(f.context()), "order1")).toBe(true);
    await deleteRevenueReservation(f.context(), "r3" as any); expect(await hasReservationByOrder(useReservationReadModel(f.context()), "order1")).toBe(false);
    expect(await hasReservationByOrder(useReservationReadModel(f.context()), "changed")).toBe(true);
  });
  it("retains raw existence queries when disabled and during source-only qualification", async () => {
    const f = fixture(); await prepare(f, false); expect(await hasReservationByOrder(f.context(), "order1")).toBe(true);
    expect(await hasReservationByOrder(preparedReservationReadContext(f.context()), "order2")).toBe(true);
    f.reads.length = 0; expect(await hasReservationByOrder(sourceReservationReadContext(f.context()), "order1")).toBe(true); expect(f.reads).toContain("reservations:by_hygglo_order_id");
  });
  it("does not rewrite existence rows for unrelated polling metadata", async () => {
    const f = fixture(); await prepare(f); f.writes.length = 0; await patchRevenueReservation(f.context(), "r1" as any, { last_polled_at: 99 });
    expect(f.writes).not.toContain("reservation_order_presence");
  });
  it("rejects stale activation and audit tampering", async () => {
    const f = fixture(); await prepare(f, false); await patchRevenueReservation(f.context(), "r1" as any, { v1_updated_at: 9 });
    await expect((admin.enable as any)._handler(f.context(), { revision: 0, count: 3 })).rejects.toThrow("qualify again");
    f.tables.reservation_read_records[0].source_sha256 = "tampered"; await (admin.start as any)._handler(f.context(), {});
    // Direct audit catches a bad payload; normal source backfill repairs it.
    f.tables.reservation_read_progress[0].stage = "audit"; f.tables.reservation_read_progress[0].audited_revision = f.tables.reservation_read_progress[0].revision;
    await expect((admin.step as any)._handler(f.context(), {})).rejects.toThrow("audit failed");
  });
});
