import fs from "node:fs";
import { jsonToConvex } from "convex/values";
import { describe, expect, it } from "vitest";
import type { MutationCtx } from "../_generated/server";
import { decodeProductRead, syncProductReadRecord, loadProductReadRecords, setProductReadMode } from "./product_read_model";
import { patchProduct, insertProduct, deleteProduct } from "./product_context";
import * as admin from "../product_read_admin";

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
  const tables: Record<string, any[]> = { hygglo_products: structuredClone(rows ?? [
    { _id: "p1", _creationTime: 10, accountSlug: "leo", productId: 7, name: "Complete kit", lastSyncedAt: 1, prices: [{ amount: 0.30000000000000004 }], images: [{ fullSizeUrl: "/image" }], listings: [{ nested: { retained: true } }] },
    { _id: "p2", _creationTime: 20, accountSlug: "dbcinema", productId: 8, name: "Other kit", lastSyncedAt: 2 },
    { _id: "p3", _creationTime: 30, accountSlug: "leo", productId: 7, name: "Duplicate source identity", lastSyncedAt: 3 },
  ]), product_read_records: [], product_read_gate: [], product_read_progress: [], hygglo_product_context: [], catalogue_cache_state: [], catalogue_cache_blobs: [] };
  const sourceIds = new Set(tables.hygglo_products.map(r => r._id)), reads: string[] = [], writes: string[] = []; let serial = 100, modelFailure = false, sourceFailure = false;
  function query(table: string, index = "by_creation_time", operations: any[] = [], direction = "asc", filter?: (row: any) => boolean): any {
    const fields = index === "by_key" ? ["key"] : index === "by_source" ? ["source_id"] : index === "by_source_creation_time" ? ["source_creation_time"] : index === "by_account" ? ["accountSlug", ...(table === "product_read_records" ? ["source_creation_time"] : [])] : index === "by_account_product" ? table === "hygglo_product_context" ? ["account_slug", "product_id"] : ["accountSlug", "productId"] : [];

    function values() {
      const compare = (a: any, b: any) => a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;
      return (tables[table] ?? []).filter(row => operations.every(([op, key, value]) => op === "eq" ? row[key] === value : op === "gte" ? compare(row[key], value) >= 0 : op === "lte" ? compare(row[key], value) <= 0 : op === "gt" ? compare(row[key], value) > 0 : compare(row[key], value) < 0)).filter(row => !filter || filter(row)).slice().sort((a, b) => {
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
    normalizeId(table: string, id: string) { return table === "hygglo_products" && sourceIds.has(id) ? id : null; },
    async get(id: string) { reads.push("get:" + id); return structuredClone(Object.values(tables).flat().find(row => row._id === id) ?? null); },
    async insert(table: string, value: any) { if (table === "product_read_records" && modelFailure) throw Error("model write failed"); const id = table === "hygglo_products" ? "r" + (++serial) : table + ":" + (++serial); if (table === "hygglo_products") sourceIds.add(id); (tables[table] ??= []).push({ ...structuredClone(value), _id: id, _creationTime: serial }); writes.push(table); return id; },
    async patch(id: string, value: any) { const table = Object.keys(tables).find(key => tables[key].some(row => row._id === id))!; if (table === "hygglo_products" && sourceFailure) throw Error("source write failed"); const row = tables[table].find(row => row._id === id); for (const [key, v] of Object.entries(value)) if (v === undefined) delete row[key]; else row[key] = structuredClone(v); writes.push(table); },
    async replace(id: string, value: any) { const table = Object.keys(tables).find(key => tables[key].some(row => row._id === id))!; if (table === "product_read_records" && modelFailure) throw Error("model write failed"); const row = tables[table].find(row => row._id === id); for (const key of Object.keys(row)) if (!key.startsWith("_")) delete row[key]; Object.assign(row, structuredClone(value)); writes.push(table); },
    async delete(id: string) { for (const [table, rows] of Object.entries(tables)) { const i = rows.findIndex(row => row._id === id); if (i >= 0) { if (table === "product_read_records" && modelFailure) throw Error("model write failed"); rows.splice(i, 1); writes.push(table); } } },
  };
  const context = () => ({ db, scheduler: { async runAfter() { return "job"; } } }) as unknown as MutationCtx;
  return { tables, db, reads, writes, context, modelFailure: (v: boolean) => { modelFailure = v; }, sourceFailure: (v: boolean) => { sourceFailure = v; } };
}
async function prepare(f: ReturnType<typeof fixture>, enabled = true) {
  await (admin.start as any)._handler(f.context(), {});
  for (let n = 0; n < 200 && f.tables.product_read_progress[0].stage !== "prepared"; n++) await (admin.step as any)._handler(f.context(), {});
  expect(f.tables.product_read_gate[0].ready).toBe(true);
  if (enabled) await (admin.enable as any)._handler(f.context(), { revision: f.tables.product_read_progress[0].revision, count: f.tables.product_read_progress[0].audited_count });
}

describe("full product read model", () => {
  it("preserves every field and source order including duplicate product identities", async () => {
    const f = fixture(); await prepare(f); f.tables.product_read_records.reverse(); f.reads.length = 0;
    expect(await loadProductReadRecords(f.context())).toEqual(f.tables.hygglo_products);
    expect(await loadProductReadRecords(f.context(), "leo")).toEqual([f.tables.hygglo_products[0], f.tables.hygglo_products[2]]);
    expect(await loadProductReadRecords(f.context(), "")).toEqual([]);
    expect(await loadProductReadRecords(f.context(), "absent")).toEqual([]);
    expect(f.reads.some(r => r.startsWith("hygglo_products:"))).toBe(false);
  });
  it("preserves precise floats, special numbers, integer and byte values", async () => {
    const f = fixture([{ _id: "p1", _creationTime: 1, accountSlug: "leo", productId: 1, lastSyncedAt: 1, nested: { values: [-0, NaN, Infinity, -Infinity, 0.30000000000000004], integer: 123n, bytes: new Uint8Array([0, 255]).buffer } }]);
    await prepare(f); expect(await decodeProductRead(f.tables.product_read_records[0])).toEqual(f.tables.hygglo_products[0]);
  });
  it.each(["absent", "disabled", "dirty", "corrupt", "metadata"])("uses source records when %s", async mode => {
    const f = fixture(); if (mode !== "absent") await prepare(f);
    if (mode === "disabled") f.tables.product_read_gate[0].enabled = false;
    if (mode === "dirty") f.tables.product_read_gate[0].ready = false;
    if (mode === "corrupt") f.tables.product_read_records[0].data = new Uint8Array([1, 2, 3]).buffer;
    if (mode === "metadata") f.tables.product_read_records[0].accountSlug = "wrong";
    expect(await loadProductReadRecords(f.context())).toEqual(f.tables.hygglo_products);
  });
  it("never treats corrupt prepared records as qualified source fallback", async () => {
    const f = fixture(); await prepare(f, false); f.tables.product_read_records[0].packed_sha256 = "wrong";
    const ctx = f.context(); setProductReadMode(ctx, "prepared");
    await expect(loadProductReadRecords(ctx)).rejects.toThrow("Invalid product");
  });
  it.each(["missing", "extra"])("uses source when the compact set has %s records", async mode => {
    const f = fixture(); await prepare(f);
    if (mode === "missing") f.tables.product_read_records.shift();
    else f.tables.product_read_records.push({ ...f.tables.product_read_records[0], _id: "extra" });
    expect(await loadProductReadRecords(f.context())).toEqual(f.tables.hygglo_products);
    const ctx = f.context(); setProductReadMode(ctx, "prepared");
    await expect(loadProductReadRecords(ctx)).rejects.toThrow("Incomplete product");
  });
  it("retains original database ordering for equal creation times", async () => {
    const f = fixture(); f.tables.hygglo_products[2]._creationTime = 10; await prepare(f); f.reads.length = 0;
    expect(await loadProductReadRecords(f.context(), "leo")).toEqual(await f.db.query("hygglo_products").withIndex("by_account", (q: Range) => q.eq("accountSlug", "leo")).collect());
    expect(f.reads).toContain("hygglo_products:by_account");
  });
  it("maintains full non-context fields, cleared fields, account moves, insertions and deletions", async () => {
    const f = fixture(); await prepare(f);
    await patchProduct(f.context(), "p1" as any, { lastSyncedAt: 33, prices: [{ amount: 99.123456789 }] } as any);
    await patchProduct(f.context(), "p1" as any, { accountSlug: "diogo", productId: 12, images: undefined });
    const id = await insertProduct(f.context(), { accountSlug: "leo", productId: 90, lastSyncedAt: 5 } as any);
    await deleteProduct(f.context(), "p3" as any);
    expect(await loadProductReadRecords(f.context(), "leo")).toEqual(await f.db.query("hygglo_products").withIndex("by_account", (q: Range) => q.eq("accountSlug", "leo")).collect());
    expect((await loadProductReadRecords(f.context(), "diogo"))[0]).toEqual(f.tables.hygglo_products.find(r => r._id === "p1"));
    expect(f.tables.product_read_records.some(r => r.source_id === id)).toBe(true);
    expect(f.tables.product_read_records.some(r => r.source_id === "p3")).toBe(false);
  });
  it("does not rewrite unchanged records or bump a revision for no-op patches", async () => {
    const f = fixture(); await prepare(f); const before = f.tables.product_read_progress[0].revision;
    f.writes.length = 0; await patchProduct(f.context(), "p1" as any, { lastSyncedAt: 1 });
    expect(f.writes).not.toContain("product_read_records"); expect(f.tables.product_read_progress[0].revision).toBe(before);
  });
  it("coalesces revision bumps and serializes concurrent writes for the same source", async () => {
    const f = fixture(); await prepare(f); const ctx = f.context();
    await Promise.all([syncProductReadRecord(ctx, "p1" as any), syncProductReadRecord(ctx, "p1" as any)]);
    expect(f.tables.product_read_records.filter(r => r.source_id === "p1")).toHaveLength(1);
    await Promise.all([patchProduct(ctx, "p1" as any, { lastSyncedAt: 31 }), patchProduct(ctx, "p2" as any, { lastSyncedAt: 32 })]);
    expect(f.tables.product_read_progress[0].revision).toBe(1);
    expect(await decodeProductRead(f.tables.product_read_records.find(r => r.source_id === "p1"))).toEqual(f.tables.hygglo_products[0]);
  });
  it("serializes per-account counts during concurrent inserts and moves", async () => {
    const f = fixture(); await prepare(f); const ctx = f.context();
    await Promise.all([
      insertProduct(ctx, { accountSlug: "leo", productId: 91, lastSyncedAt: 1 } as any),
      insertProduct(ctx, { accountSlug: "leo", productId: 92, lastSyncedAt: 1 } as any),
      patchProduct(ctx, "p2" as any, { accountSlug: "leo" }),
    ]);
    const accounts = f.tables.product_read_gate[0].accounts;
    expect(accounts.find((row: any) => row.accountSlug === "leo").count).toBe(5);
    expect(accounts.find((row: any) => row.accountSlug === "dbcinema").count).toBe(0);
    expect(await loadProductReadRecords(f.context(), "leo")).toHaveLength(5);
  });
  it.each(["model", "source"])("disables serving after caught %s write failure", async kind => {
    const f = fixture(); await prepare(f); if (kind === "model") f.modelFailure(true); else f.sourceFailure(true);
    await expect(patchProduct(f.context(), "p1" as any, { lastSyncedAt: 9 })).rejects.toThrow("write failed");
    expect(f.tables.product_read_gate[0].ready).toBe(false); expect(f.tables.product_read_progress[0].stage).toBe("backfill");
    expect(await loadProductReadRecords(f.context())).toEqual(f.tables.hygglo_products);
  });
  it("keeps independent decoded records for successive reads", async () => {
    const f = fixture(); await prepare(f); const ctx = f.context(); const first = await loadProductReadRecords(ctx); first[0].name = "mutated";
    expect((await loadProductReadRecords(ctx))[0].name).toBe("Complete kit");
  });
  it("supports the actual list handler in source and prepared modes while disabled", async () => {
    const f = fixture(); await prepare(f, false);
    const source = await (admin.read as any)._handler(f.context(), { mode: "source", accountSlug: "leo" });
    expect(await (admin.read as any)._handler(f.context(), { mode: "prepared", accountSlug: "leo" })).toEqual(source);
  });
  it("rejects source changes after audit, then audits again without restarting source backfill", async () => {
    const f = fixture(); await prepare(f, false); const old = f.tables.product_read_progress[0].revision;
    await patchProduct(f.context(), "p1" as any, { lastSyncedAt: 22 });
    await expect((admin.enable as any)._handler(f.context(), { revision: old, count: 3 })).rejects.toThrow("changed");
    await (admin.reaudit as any)._handler(f.context(), {});
    for (let n = 0; n < 20 && f.tables.product_read_progress[0].stage !== "prepared"; n++) await (admin.step as any)._handler(f.context(), {});
    expect(f.tables.product_read_progress[0].audited_count).toBe(3); expect(f.tables.product_read_progress[0].audited_revision).toBe(1);
  });
  it("prunes orphaned model records before audit without writing source", async () => {
    const f = fixture(); await prepare(f, false); f.tables.product_read_records.push({ ...f.tables.product_read_records[0], _id: "ghost", source_id: "missing", _creationTime: 999 });
    f.writes.length = 0; await (admin.reaudit as any)._handler(f.context(), {});
    for (let n = 0; n < 20 && f.tables.product_read_progress[0].stage !== "prepared"; n++) await (admin.step as any)._handler(f.context(), {});
    expect(f.tables.product_read_records.some(r => r._id === "ghost")).toBe(false); expect(f.writes).not.toContain("hygglo_products");
  });
  it("retains large incompressible source values through explicit fallback records", async () => {
    const bytes = new Uint8Array(900_000); for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, bytes.length)));
    const f = fixture([{ _id: "p1", _creationTime: 1, accountSlug: "leo", productId: 1, lastSyncedAt: 1, originalBytes: bytes.buffer }]); await prepare(f);
    expect(f.tables.product_read_records[0].valid).toBe(false); expect(f.tables.product_read_progress[0].audited_fallback_count).toBe(1);
    expect(await loadProductReadRecords(f.context())).toEqual(f.tables.hygglo_products);
  });
  it.skipIf(!process.env.RM_PRODUCT_READ_SNAPSHOT)("qualifies every full private product record with original account ordering", async () => {
    const rows = jsonToConvex(JSON.parse(fs.readFileSync(process.env.RM_PRODUCT_READ_SNAPSHOT!, "utf8"))) as any[];
    const f = fixture(rows); await prepare(f);
    for (const account of [undefined, "leo", "dbcinema", "diogo", ""]) {
      const ctx = f.context(); setProductReadMode(ctx, "source");
      expect(await loadProductReadRecords(f.context(), account)).toEqual(await loadProductReadRecords(ctx, account));
    }
    expect(f.tables.product_read_progress[0].audited_count).toBe(rows.length);
    expect(f.tables.product_read_progress[0].audited_fallback_count).toBe(0);
  }, 30_000);
});
