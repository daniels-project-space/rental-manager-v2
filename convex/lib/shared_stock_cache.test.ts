import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { MutationCtx } from "../_generated/server";
import { stockStaticTables, type StockInputSnapshot, STOCK_INPUT_KEY } from "./stock_input_cache";
import { patchStockInput } from "./stock_input_writes";
import { patchProduct, refreshProductContext } from "./product_context";
import { patchOnlineListing, replaceOnlineListingRows, listingAllocationChanged } from "./stock_listing_writes";
import { sharedStockImplementation } from "./shared_stock_version";
import { readSharedStock, setSharedStockMode, SHARED_STOCK_KEY } from "./shared_stock_cache";
import { cacheByteDigest, cacheValueDigest, packCacheValue } from "./lossless_cache_codec";
import * as admin from "../stock_input_cache_admin";

function fixture(input?: StockInputSnapshot) {
  const tables: Record<string, any[]> = Object.fromEntries([...stockStaticTables, "reservations", "renter_bot_lab_bookings", "stock_input_cache_state", "stock_input_cache_blobs", "stock_shared_snapshot_cache", "product_read_gate", "reservation_revenue_facts", "reservation_revenue_ready", "hygglo_product_context", "hygglo_products", "online_listings", "storefront_checkout_stock"].map((key) => [key, []]));
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

function workerFixture() {
  const f = fixture(), calls: string[] = [];
  async function dispatch(ref: any, args: any) {
    const name = getFunctionName(ref); calls.push(name);
    const definition = (admin as any)[name.split(":").at(-1)!];
    if (!definition?._handler) throw Error("Unknown worker handler " + name);
    return definition._handler(context(), args);
  }
  function context(): any { return { ...f.context(), runQuery: dispatch, runMutation: dispatch, runAction: dispatch }; }
  async function flush() {
    for (let n = 0; f.scheduled.length && n < 12; n++) {
      const [, ref, args] = f.scheduled.shift() as any[]; await dispatch(ref, args);
    }
    if (f.scheduled.length) throw Error("Worker exceeded bounded fixture jobs");
  }
  return { ...f, context, calls, flush };
}
const handler = (definition: any) => definition._handler;
async function ready(f: ReturnType<typeof workerFixture>, enabled = true) {
  await handler(admin.warm)(f.context(), {}); await f.flush();
  const state = f.tables.stock_input_cache_state[0], blob = f.tables.stock_input_cache_blobs[0];
  await handler(admin.enable)(f.context(), { revision: state.revision, sha256: blob.sha256 });
  const shared = f.tables.stock_shared_snapshot_cache[0]; expect(shared).toBeDefined();
  if (enabled) await handler(admin.enableShared)(f.context(), { revision: state.revision, sha256: shared.sha256, implementation: shared.implementation });
}
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("qualified shared-stock cache lifecycle", () => {
  it("builds through real registered worker handlers and defaults to disabled serving", async () => {
    const f = workerFixture(); await ready(f, false);
    expect(f.tables.stock_shared_snapshot_cache[0].enabled).toBe(false);
    const ctx = f.context(); setSharedStockMode(ctx, "prepared");
    const cached = await readSharedStock(ctx), raw = f.context(); setSharedStockMode(raw, "raw");
    expect(cached.units).toEqual((await readSharedStock(raw)).units);
    expect(f.calls).not.toContain("stock_input_cache_admin:buildSharedSnapshot");
    expect(f.calls).toContain("stock_input_cache_admin:snapshot");
    expect(f.calls).not.toContain("items:__service_sharedStockForStorefront");
  });
  it("never recirculates an existing final view when building", async () => {
    const f = workerFixture(); await ready(f); const shared = f.tables.stock_shared_snapshot_cache[0];
    const wrong = {version:2,turnaroundBufferMinutes:60,checkedAt:1,units:[{masterItemId:"item",active:true,quantityOwned:999,windows:[]}]};
    shared.data = packCacheValue(wrong); shared.packed_sha256 = await cacheByteDigest(shared.data);
    const state = f.tables.stock_input_cache_state[0];
    const built = await handler(admin.buildSharedSnapshot)(f.context(), { token: state.job_token, revision: state.revision });
    expect(built.value.units[0].quantityOwned).toBe(2);
  });
  it.each(["implementation", "version", "bytes"])("falls back for invalid %s and rejects strict qualification", async kind => {
    const f = workerFixture(); await ready(f); const row = f.tables.stock_shared_snapshot_cache[0];
    if (kind === "implementation") row.implementation = "old";
    if (kind === "version") row.version = 1;
    if (kind === "bytes") row.data = new Uint8Array([1,2,3]).buffer;
    expect((await readSharedStock(f.context())).units[0].quantityOwned).toBe(2);
    const ctx = f.context(); setSharedStockMode(ctx,"prepared"); await expect(readSharedStock(ctx)).rejects.toThrow();
  });
  it("keeps checkout heartbeat expiry live on the actual cached path", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); vi.stubEnv("REQUIRE_WEBSITE_STOCK_HOLDS_SYNC","true");
    const f = workerFixture(); f.tables.storefront_checkout_stock.push({_id:"hold-source",key:"website",receivedAt:1000,rows:[]}); await ready(f);
    f.reads.length = 0; vi.setSystemTime(181001);
    await expect(readSharedStock(f.context())).rejects.toThrow("needs refresh");
    expect(f.reads).not.toContain("items"); expect(f.reads).toContain("storefront_checkout_stock");
  });
  it("rejects a late publisher after real stock changes, then refreshes to the new quantity", async () => {
    const f = workerFixture(); await ready(f); const old = structuredClone(f.tables.stock_shared_snapshot_cache[0]), state = structuredClone(f.tables.stock_input_cache_state[0]);
    await patchStockInput(f.context(), "item" as any, {qty:3});
    expect(await handler(admin.publishSharedSnapshot)(f.context(), {token:state.job_token,revision:state.revision,implementation:old.implementation,data:old.data,sha256:old.sha256,packed_sha256:old.packed_sha256,generated_at:1})).toBe(false);
    expect((await readSharedStock(f.context())).units[0].quantityOwned).toBe(3);
    await f.flush(); expect((await readSharedStock(f.context())).units[0].quantityOwned).toBe(3); expect(f.tables.stock_shared_snapshot_cache[0].enabled).toBe(true);
  });
  it("rejects activation with the wrong implementation or revision", async () => {
    const f = workerFixture(); await ready(f,false); const row=f.tables.stock_shared_snapshot_cache[0];
    await expect(handler(admin.enableShared)(f.context(), {revision:row.revision,sha256:row.sha256,implementation:"old"})).rejects.toThrow("changed");
    await patchStockInput(f.context(),"item" as any,{qty:4});
    await expect(handler(admin.enableShared)(f.context(), {revision:row.revision,sha256:row.sha256,implementation:row.implementation})).rejects.toThrow("changed");
  });
  it("rebuilds after code changes and refuses another deployment's warm request", async () => {
    const f=workerFixture();await ready(f);f.tables.stock_input_cache_state[0].implementation="old";
    expect(await handler(admin.ensureSharedSnapshot)(f.context(),{})).toEqual({queued:true});await f.flush();expect(f.tables.stock_input_cache_state[0].implementation).toBe(await sharedStockImplementation());
    vi.stubEnv("CONVEX_CLOUD_URL","https://right.convex.cloud");const jobs=f.scheduled.length;
    await expect(handler(admin.ensureSharedSnapshot)(f.context(),{expectedDeploymentUrl:"https://wrong.convex.cloud"})).rejects.toThrow("Wrong stock deployment");expect(f.scheduled).toHaveLength(jobs);
  });
  it("stops permanent projection retries and keeps the input cache healthy", async () => {
    const f=workerFixture();await ready(f);const state=f.tables.stock_input_cache_state[0];
    const ctx=f.context();ctx.runQuery=async()=>({implementation:await sharedStockImplementation(),value:null,error:"permanent: oversized"});
    expect(await handler(admin.refreshSharedSnapshot)(ctx,{token:state.job_token,revision:state.revision,attempt:0})).toMatchObject({published:false});
    expect(f.scheduled).toHaveLength(0);expect(state.enabled).toBe(true);
    expect(await handler(admin.ensureSharedSnapshot)(f.context(),{})).toHaveProperty("skipped");expect(f.scheduled).toHaveLength(0);
  });
  it("bounds transient retries and rejects an out-of-range retry counter", async () => {
    const f=workerFixture();await ready(f);const state=f.tables.stock_input_cache_state[0];
    const ctx=f.context();ctx.runQuery=async()=>({implementation:await sharedStockImplementation(),value:null,error:"temporary network"});
    for(let attempt=0;attempt<=2;attempt++)await handler(admin.refreshSharedSnapshot)(ctx,{token:state.job_token,revision:state.revision,attempt});
    expect(f.scheduled).toHaveLength(2);expect((f.scheduled as any[]).map(job=>job[2].attempt)).toEqual([1,2]);
    await expect(handler(admin.refreshSharedSnapshot)(ctx,{token:state.job_token,revision:state.revision,attempt:3})).rejects.toThrow("retry count");
  });
  it("counts the captured build as the first attempt and preserves healthy raw inputs", async () => {
    vi.stubEnv("REQUIRE_WEBSITE_STOCK_HOLDS_SYNC", "true");
    const f = workerFixture();
    f.tables.stock_input_cache_state.push({_id:"state",key:STOCK_INPUT_KEY,revision:0,enabled:true,queued:false,job_token:0,attempts:0,updated_at:1});
    await handler(admin.warm)(f.context(), {}); await f.flush();
    expect(f.calls.filter(name => name === "stock_input_cache_admin:buildSharedSnapshot")).toHaveLength(2);
    expect(f.tables.stock_input_cache_state[0].enabled).toBe(true);
    expect(f.tables.stock_input_cache_state[0].shared_error).toContain("needs refresh");
    expect(f.tables.stock_input_cache_blobs).toHaveLength(1);
    expect(f.tables.stock_shared_snapshot_cache).toHaveLength(0);
  });
  it("invalidates actual product-context allocation changes but ignores sync stamps and images", async () => {
    const f=workerFixture();f.tables.hygglo_products.push({_id:"product",_creationTime:1,accountSlug:"leo",productId:7,name:"Camera",lastSyncedAt:1,images:[]});
    await refreshProductContext(f.context(),"leo",7);await ready(f);const rev=f.tables.stock_input_cache_state[0].revision;
    await patchProduct(f.context(),"product" as any,{lastSyncedAt:2,images:[{fullSizeUrl:"/new"}]});expect(f.tables.stock_input_cache_state[0].revision).toBe(rev);
    await patchProduct(f.context(),"product" as any,{description:"Changed complete kit"});expect(f.tables.stock_input_cache_state[0].revision).toBe(rev+1);expect(f.scheduled).toHaveLength(1);
  });
  it("invalidates description changes and deletions while ignoring listing prices and equivalent rescans", async () => {
    const f=workerFixture();f.tables.online_listings.push({_id:"listing",_creationTime:1,account_slug:"leo",product_id:7,description:"Whole kit",name:"Kit",is_published:true,updated_at:1});await ready(f);
    const rev=f.tables.stock_input_cache_state[0].revision;await patchOnlineListing(f.context(),"listing" as any,{daily_price:20});expect(f.tables.stock_input_cache_state[0].revision).toBe(rev);
    await replaceOnlineListingRows(f.context(),"leo",[{product_id:7,name:"Changed title only",is_published:true,description:"Whole kit"}]);expect(f.tables.stock_input_cache_state[0].revision).toBe(rev);
    const id=f.tables.online_listings[0]._id;await patchOnlineListing(f.context(),id,{description:"New physical contents"});expect(f.tables.stock_input_cache_state[0].revision).toBe(rev+1);
    await f.flush();const next=f.tables.stock_input_cache_state[0].revision;await replaceOnlineListingRows(f.context(),"leo",[]);expect(f.tables.stock_input_cache_state[0].revision).toBe(next+1);
  });
  it("does not infer a stable first row for conflicting duplicate descriptions",()=>{
    expect(listingAllocationChanged([{product_id:1,description:"a"}],[{product_id:1,description:"a"},{product_id:1,description:"b"}])).toBe(true);
    expect(listingAllocationChanged([{product_id:1,description:"a"},{product_id:1,description:"a"}],[{product_id:1,description:"a"}])).toBe(false);
  });
});
