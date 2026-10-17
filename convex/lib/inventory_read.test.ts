import { listingDisplayCatalog } from "./listing_display_catalog";
import { listForReconcile } from "../items";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { INVENTORY_READ_KEY, readFullInventory, setInventoryReadMode } from "./inventory_read";
import { audit, enable, prepare, rebuild } from "../inventory_read_admin";
import { patchStockInput, insertStockInput, deleteStockInput } from "./stock_input_writes";
import { canonicalCacheJson, cacheValueDigest } from "./lossless_cache_codec";

const run = (fn: unknown) => (fn as { _handler: (ctx: MutationCtx, args: any) => Promise<any> })._handler;
function fixture(items?: any[]) {
  const tables: Record<string, any[]> = { items: items ?? [
    { _id: "item:a", _creationTime: 2, name_canonical: "Camera", qty: 2, image_url: "full image", notes: "retain all fields" },
    { _id: "item:b", _creationTime: 1, name_canonical: "Lens", qty: 1.25 },
  ], inventory_read_gate: [], inventory_read_blob: [], stock_input_cache_state: [], insurance_claims: [] };
  const reads: string[] = [], jobs: unknown[][] = [], writes: string[] = []; let serial = 10;
  const db = {
    query(table: string) {
      const filters: ((r: any) => boolean)[] = [];
      const q = { withIndex(_name: string, cb?: (r: any) => unknown) { const range = { eq(key: string, value: unknown) { filters.push(r => r[key] === value); return range; } }; cb?.(range); return q; },
        async collect() { reads.push(table); return structuredClone((tables[table] ?? []).filter(r => filters.every(f => f(r))).sort((a,b) => a._creationTime-b._creationTime)); },
        async take(n: number) { return (await q.collect()).slice(0,n); }, async first() { return (await q.collect())[0] ?? null; }, async unique() { const rows = await q.collect(); if (rows.length > 1) throw Error("Duplicate key"); return rows[0] ?? null; } }; return q;
    },
    normalizeId(table: string, id: string) { return table === "items" && id.startsWith("item:") ? id : null; },
    async get(id: string) { reads.push("get"); return structuredClone(Object.values(tables).flat().find(r => r._id === id) ?? null); },
    async insert(table: string, row: any) { const id = `${table === "items" ? "item" : table}:${++serial}`; (tables[table] ??= []).push({ ...structuredClone(row), _id:id, _creationTime:serial }); writes.push(table); return id; },
    async patch(id: string, patch: any) { const [table, row] = Object.entries(tables).flatMap(([t,rows]) => rows.filter(r => r._id === id).map(r => [t,r] as const))[0]; for (const [key,value] of Object.entries(patch)) if (value === undefined) delete row[key]; else row[key] = structuredClone(value); writes.push(table); },
    async replace(id: string, value: any) { const [table,row] = Object.entries(tables).flatMap(([t,rows]) => rows.filter(r => r._id === id).map(r => [t,r] as const))[0]; for (const key of Object.keys(row)) if (!key.startsWith("_")) delete row[key]; Object.assign(row,structuredClone(value)); writes.push(table); },
    async delete(id: string) { for (const [table,rows] of Object.entries(tables)) { const n = rows.findIndex(r => r._id === id); if (n >= 0) { rows.splice(n,1); writes.push(table); } } },
  };
  const mutation = () => ({ db, scheduler: { async runAfter(...args: unknown[]) { jobs.push(args); return "job"; } } }) as unknown as MutationCtx;
  const query = () => ({ db: { query:db.query, get:db.get, normalizeId:db.normalizeId } }) as unknown as QueryCtx;
  return { tables, reads, jobs, writes, mutation, query };
}
async function prepared(f: ReturnType<typeof fixture>, enabled = false) {
  await run(prepare)(f.mutation(), {}); await run(rebuild)(f.mutation(), {});
  if (enabled) { const a = await run(audit)(f.query() as MutationCtx, {}); await run(enable)(f.mutation(), { revision:a.revision,source_sha256:a.source_sha256 }); }
  f.reads.length=0; f.writes.length=0; f.jobs.length=0;
}

describe("complete packed physical inventory", () => {
  it("defaults to exact source rows and creation order", async () => {
    const f=fixture(); expect((await readFullInventory(f.query())).map(r=>r._id)).toEqual(["item:b","item:a"]); expect(f.reads).toEqual(["inventory_read_gate","items"]);
  });
  it("prepares disabled and publishes only derived rows", async () => {
    const f=fixture(); const before=canonicalCacheJson(f.tables.items as never); await prepared(f); expect(f.tables.inventory_read_gate[0].enabled).toBe(false); expect(canonicalCacheJson(f.tables.items as never)).toBe(before);
    await readFullInventory(f.query()); expect(f.reads).not.toContain("inventory_read_blob"); const q=f.query(); setInventoryReadMode(q,"prepared"); expect((await readFullInventory(q)).length).toBe(2);
  });
  it("fully audits before activation and returns all metadata", async () => {
    const f=fixture(); await prepared(f,true); const source=await f.query().db.query("items").collect(); f.reads.length=0; expect(canonicalCacheJson(await readFullInventory(f.query()))).toBe(canonicalCacheJson(source)); expect(f.reads).toEqual(["inventory_read_gate","inventory_read_blob"]);
  });
  it("memoizes query I/O but returns independent documents and arrays", async () => {
    const f=fixture(); await prepared(f,true); const q=f.query(); const a=await readFullInventory(q); (a[0] as any).qty=99; a.reverse(); const b=await readFullInventory(q); expect(b[0].qty).toBe(1.25); expect(b.map(x=>x._id)).toEqual(["item:b","item:a"]); expect(f.reads).toEqual(["inventory_read_gate","inventory_read_blob"]);
  });
  it("source qualification bypasses all projection reads", async () => {
    const f=fixture(); await prepared(f,true); const q=f.query(); setInventoryReadMode(q,"source"); await readFullInventory(q); expect(f.reads).toEqual(["items"]);
  });
  it("preserves IEEE floats, bytes, int64 and original nested values", async () => {
    const f=fixture([{_id:"item:a",_creationTime:1,qty:-0,name_canonical:"All",extra:{array:[NaN,Infinity,-Infinity,1.0000000000000002,5n,new Uint8Array([0,255]).buffer]}}]); await prepared(f,true); expect(canonicalCacheJson(await readFullInventory(f.query()))).toBe(canonicalCacheJson(f.tables.items as never)); expect(Object.is((await readFullInventory(f.query()))[0].qty,-0)).toBe(true);
  });
  it("preserves opaque tie order by storing the ordered complete array", async () => {
    const f=fixture([{_id:"item:z",_creationTime:1,name_canonical:"first"},{_id:"item:a",_creationTime:1,name_canonical:"second"}]); await prepared(f,true); expect((await readFullInventory(f.query())).map(r=>r._id)).toEqual(["item:z","item:a"]);
  });
  it("coalesces concurrent item edits to one revision and job", async () => {
    const f=fixture(); await prepared(f,true); const ctx=f.mutation(); await Promise.all([patchStockInput(ctx,"item:a" as never,{qty:3}),patchStockInput(ctx,"item:b" as never,{qty:4})]); expect(f.tables.inventory_read_gate[0].revision).toBe(1); expect(f.jobs).toHaveLength(1); expect(f.writes[0]).toBe("inventory_read_gate");
    expect((await readFullInventory(f.query())).map(r=>r.qty)).toEqual([4,3]); await run(rebuild)(f.mutation(),{}); expect(f.tables.inventory_read_gate[0].ready_revision).toBe(1); expect((await readFullInventory(f.query())).map(r=>r.qty)).toEqual([4,3]);
  });
  it("does not invalidate unchanged inventory fields", async () => {
    const f=fixture(); await prepared(f,true); await patchStockInput(f.mutation(),"item:a" as never,{qty:2}); expect(f.tables.inventory_read_gate[0].revision).toBe(0); expect(f.jobs).toHaveLength(0);
  });
  it("unrelated stock writes leave inventory dependencies alone", async () => {
    const f=fixture(); await prepared(f,true); await insertStockInput(f.mutation(),"insurance_claims",{status:"open"} as never); expect(f.tables.inventory_read_gate[0].revision).toBe(0); expect(f.reads).not.toContain("inventory_read_gate"); expect(f.jobs).toHaveLength(0);
  });
  it("rebuilds insertions and deletions with complete membership", async () => {
    const f=fixture(); await prepared(f,true); const id=await insertStockInput(f.mutation(),"items",{name_canonical:"new",qty:5} as never); expect((await readFullInventory(f.query())).length).toBe(3); await run(rebuild)(f.mutation(),{}); expect(f.tables.inventory_read_gate[0].count).toBe(3);
    await deleteStockInput(f.mutation(),id); await run(rebuild)(f.mutation(),{}); expect((await readFullInventory(f.query())).length).toBe(2); expect(f.tables.inventory_read_gate[0].count).toBe(2);
  });
  it("never memoizes across mutation-context writes", async () => {
    const f=fixture(); await prepared(f,true); const ctx=f.mutation(); expect((await readFullInventory(ctx))[1].qty).toBe(2); await patchStockInput(ctx,"item:a" as never,{qty:10}); expect((await readFullInventory(ctx))[1].qty).toBe(10);
  });
  for (const fault of ["missing","corrupt","revision","count","version"] as const) it(`retains complete source on ${fault} artifacts; strict preparation fails`,async()=>{
    const f=fixture(); await prepared(f,true); if(fault==="missing")f.tables.inventory_read_blob=[]; else if(fault==="corrupt")f.tables.inventory_read_blob[0].data=new Uint8Array([1,2]).buffer; else if(fault==="revision")f.tables.inventory_read_blob[0].revision=99; else if(fault==="count")f.tables.inventory_read_gate[0].count=99; else f.tables.inventory_read_blob[0].version=2;
    expect((await readFullInventory(f.query())).length).toBe(2); const q=f.query();setInventoryReadMode(q,"prepared");await expect(readFullInventory(q)).rejects.toThrow();
  });
  it("rejects stale activation arguments and rechecks complete source",async()=>{
    const f=fixture();await prepared(f);const a=await run(audit)(f.query() as MutationCtx,{});await expect(run(enable)(f.mutation(),{revision:99,source_sha256:a.source_sha256})).rejects.toThrow();f.tables.items[0].notes="changed beyond gate";await expect(run(enable)(f.mutation(),{revision:a.revision,source_sha256:a.source_sha256})).rejects.toThrow();expect(f.tables.inventory_read_gate[0].enabled).toBe(false);
  });
  it("stops oversized preparation without clipping the original read contract",async()=>{
    const f=fixture(Array.from({length:2001},(_,i)=>({_id:`item:${i}`,_creationTime:i,name_canonical:"item"})));await run(prepare)(f.mutation(),{});const r=await run(rebuild)(f.mutation(),{});expect(r.rebuilt).toBe(false);expect(r.error).toContain("permanent:");expect(f.tables.inventory_read_gate[0].queued).toBe(false);expect(f.jobs).toHaveLength(1);expect((await readFullInventory(f.query())).length).toBe(2001);
  });
  it("recovers an explicitly requested derived artifact without source writes",async()=>{
    const f=fixture();await prepared(f,true);f.tables.inventory_read_blob=[];await run(prepare)(f.mutation(),{});await run(prepare)(f.mutation(),{});expect(f.jobs).toHaveLength(1);await run(rebuild)(f.mutation(),{});expect((await readFullInventory(f.query())).length).toBe(2);expect(f.tables.inventory_read_gate[0].enabled).toBe(true);
  });
  it("recovers a failed queued job only on an explicit recovery request",async()=>{const f=fixture();await prepared(f,true);f.tables.inventory_read_gate[0].queued=true;f.tables.inventory_read_gate[0].ready_revision=undefined;await run(prepare)(f.mutation(),{});expect(f.jobs).toHaveLength(0);await run(prepare)(f.mutation(),{recoverQueued:true});expect(f.jobs).toHaveLength(1);await run(rebuild)(f.mutation(),{});expect((await readFullInventory(f.query())).length).toBe(2);});
  it("has no producer work for an unqueued rebuild",async()=>{const f=fixture();await prepared(f,true);expect(await run(rebuild)(f.mutation(),{})).toEqual({rebuilt:false});expect(f.reads).not.toContain("items");});
  it.runIf(!!process.env.RM_INVENTORY_READ_FIXTURE)("matches every field of the real private inventory snapshot",async()=>{
    const d=JSON.parse(fs.readFileSync(process.env.RM_INVENTORY_READ_FIXTURE!,"utf8"));const f=fixture(d.items);await prepared(f,true);const a=await readFullInventory(f.query());expect(await cacheValueDigest(a)).toBe(await cacheValueDigest(await f.query().db.query("items").collect()));expect(f.tables.inventory_read_blob[0].data.byteLength).toBeLessThan(30000);
  });
});


describe("existing packed inventory in display and reconciliation readers", () => {
  it("preserves the complete display catalogue, image stripping and item-map values", async () => {
    const f=fixture(); await prepared(f,true); const source=f.query();setInventoryReadMode(source,"source");
    const a=await listingDisplayCatalog(source);f.reads.length=0;const b=await listingDisplayCatalog(f.query());
    expect(b.items).toEqual(a.items);expect(b.imageItems).toEqual(a.imageItems);expect(b.itemMap).toEqual(a.itemMap);expect(b.mappingMap).toEqual(a.mappingMap);
    expect(f.reads).not.toContain("items");expect(f.reads).toContain("inventory_read_blob");
  });
  it("preserves the real complete reconciliation response", async () => {
    const f=fixture();await prepared(f,true);const source=f.query();setInventoryReadMode(source,"source");
    const a=await run(listForReconcile)(source as MutationCtx,{});f.reads.length=0;
    expect(await run(listForReconcile)(f.query() as MutationCtx,{})).toEqual(a);expect(f.reads).not.toContain("items");
  });
  it("retains preloaded inventory without extra artifact reads", async () => {
    const f=fixture();await prepared(f,true);const rows=structuredClone(f.tables.items);const result=await listingDisplayCatalog(f.query(),undefined,{items:rows});
    expect(result.items).toBe(rows);expect(f.reads).not.toContain("items");expect(f.reads).not.toContain("inventory_read_gate");
  });
  it.each(["disabled","stale"])("retains exact live source rows when %s",async(reason)=>{
    const f=fixture();await prepared(f,true);if(reason==="disabled")f.tables.inventory_read_gate[0].enabled=false;else f.tables.inventory_read_gate[0].revision++;
    f.tables.items[0].qty=7;const a=await listingDisplayCatalog(f.query());const b=await run(listForReconcile)(f.query() as MutationCtx,{});
    expect(a.items.find(r=>String(r._id)==="item:a")?.qty).toBe(7);expect(b.find((r:any)=>r._id==="item:a").qty).toBe(7);expect(f.reads).toContain("items");
  });
  it("shares one validated query snapshot while isolating caller values", async()=>{
    const f=fixture();await prepared(f,true);const q=f.query();const display=await listingDisplayCatalog(q);display.items[0].qty=99;
    const result=await run(listForReconcile)(q as MutationCtx,{});expect(result[0].qty).toBe(1.25);expect(f.reads.filter(t=>t==="inventory_read_gate")).toHaveLength(1);expect(f.reads.filter(t=>t==="inventory_read_blob")).toHaveLength(1);
  });
  it("keeps the full private real-inventory reconciliation and display values", async()=>{
    if(!process.env.RM_INVENTORY_READ_FIXTURE)return;
    const items=JSON.parse(fs.readFileSync(process.env.RM_INVENTORY_READ_FIXTURE,"utf8"));const rows=Array.isArray(items)?items:items.items;
    expect(Array.isArray(rows)).toBe(true);expect(rows.length).toBeGreaterThan(0);const f=fixture(rows);await prepared(f,true);const source=f.query();setInventoryReadMode(source,"source");
    const a=await listingDisplayCatalog(source), b=await listingDisplayCatalog(f.query());expect(b.items).toEqual(a.items);expect(b.imageItems).toEqual(a.imageItems);expect(b.itemMap).toEqual(a.itemMap);
    const q=f.query();setInventoryReadMode(q,"source");expect(await run(listForReconcile)(f.query() as MutationCtx,{})).toEqual(await run(listForReconcile)(q as MutationCtx,{}));
  });
});
