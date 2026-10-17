import { describe, expect, it } from "vitest";
import fs from "node:fs";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { CATALOGUE_KEY, catalogueProduct, catalogueProductsEqual, catalogueDigest, packedCatalogueDigest, packCatalogue, unpackCatalogue,
  loadCatalogueProducts, invalidateCatalogue, cataloguePatchChanges } from "./catalogue_read_cache";
import { patchProduct, insertProduct, deleteProduct } from "./product_context";
import { publish, reset, failed, enable } from "../catalogue_cache_admin";
import { __service_catalogueForStorefront } from "../hygglo_products";

const source = (id = "p1", extra: Record<string, unknown> = {}) => ({ _id: id, _creationTime: 1, accountSlug: "dbcinema",
  productId: 1, name: "Camera", lastSyncedAt: 1, isMarketingOnly: false, isPublished: true,
  description: "Exact seller wording", images: [{ fullSizeUrl: "/original", thumbnailUrl: "/thumb" }],
  prices: [{ days: 1, amount: 12.25 }], unavailableDates: [], listings: [], ...extra }) as unknown as Doc<"hygglo_products">;

function fixture(products = [source()]) {
  const tables: Record<string, any[]> = { stock_input_cache_state: [], product_read_gate: [], hygglo_products: structuredClone(products), hygglo_product_context: [], catalogue_cache_state: [], catalogue_cache_blobs: [] };
  const reads: string[] = [], writes: string[] = [], scheduled: unknown[] = [];
  let serial = 0;
  const db = {
    query(table: string) {
      const filters: [string, unknown][] = [];
      return { withIndex(_index: string, callback: (q: any) => unknown) {
        const q = { eq(key: string, value: unknown) { filters.push([key, value]); return q; } }; callback(q); return this;
      }, async collect() { reads.push(table); return structuredClone(tables[table].filter((r) => filters.every(([k, v]) => Object.is(r[k], v)))); },
      async first() { return (await this.collect())[0] ?? null; },
      async unique() { const rows = await this.collect(); if (rows.length > 1) throw Error("Duplicate"); return rows[0] ?? null; },
      async take(count: number) { return (await this.collect()).slice(0, count); } };
    },
    async get(id: string) { return structuredClone(Object.values(tables).flat().find((r) => r._id === id) ?? null); },
    async insert(table: string, data: any) { const id = `${table}:${++serial}`; tables[table].push({ ...structuredClone(data), _id: id, _creationTime: serial }); writes.push(table); return id; },
    async patch(id: string, data: any) { const table = Object.keys(tables).find((key) => tables[key].some((r) => r._id === id))!;
      const row = tables[table].find((r) => r._id === id); for (const [k, v] of Object.entries(data)) if (v === undefined) delete row[k]; else row[k] = structuredClone(v); writes.push(table); },
    async replace(id: string, data: any) { const row = Object.values(tables).flat().find((r) => r._id === id); for (const k of Object.keys(row)) if (!k.startsWith("_")) delete row[k]; Object.assign(row, structuredClone(data)); },
    async delete(id: string) { for (const rows of Object.values(tables)) { const i = rows.findIndex((r) => r._id === id); if (i >= 0) rows.splice(i, 1); } },
  };
  const ctx = { db, scheduler: { async runAfter(...args: unknown[]) { scheduled.push(args); return "job"; } } } as unknown as MutationCtx;
  return { ctx, tables, reads, writes, scheduled };
}
const handler = (definition: unknown) => (definition as { _handler: (ctx: MutationCtx, args: any) => Promise<any> })._handler;
async function ready(f: ReturnType<typeof fixture>) {
  const rows = f.tables.hygglo_products.map(catalogueProduct);
  const data = packCatalogue(rows);
  f.tables.catalogue_cache_state.push({ _id: "state", _creationTime: 1, key: CATALOGUE_KEY, revision: 1, ready_revision: 1, enabled: true, queued: false, job_token: 0, attempts: 0 });
  f.tables.catalogue_cache_blobs.push({ _id: "blob", _creationTime: 1, key: CATALOGUE_KEY, version: 1, revision: 1,
    data, count: rows.length, sha256: await catalogueDigest(rows), packed_sha256: await packedCatalogueDigest(data) });
}

describe("lossless catalogue input cache", () => {
  it("preserves every selected field, exact floats, image pairs and duplicate order", () => {
    const rows = [catalogueProduct(source("a", { valuation: -0 })), catalogueProduct(source("b", { valuation: NaN })),
      catalogueProduct(source("c", { valuation: Infinity }))];
    const copy = unpackCatalogue(packCatalogue(rows));
    expect(catalogueProductsEqual(rows, copy)).toBe(true);
    expect(Object.is(copy[0].valuation, -0)).toBe(true);
    expect(copy[1].valuation).toBeNaN();
    expect(copy[2].valuation).toBe(Infinity);
    expect(copy.map((r) => r.productId)).toEqual([1, 1, 1]);
  });
  it.runIf(!!process.env.RM_CATALOGUE_SOURCE_SNAPSHOT)("roundtrips the complete private production catalogue without changing fields or order", () => {
    const rows = JSON.parse(fs.readFileSync(process.env.RM_CATALOGUE_SOURCE_SNAPSHOT!, "utf8")).rows.map(catalogueProduct);
    expect(catalogueProductsEqual(rows, unpackCatalogue(packCatalogue(rows)))).toBe(true);
    expect(packCatalogue(rows).byteLength).toBeLessThan(JSON.stringify(rows).length / 5);
  });
  it.runIf(!!process.env.RM_CATALOGUE_FUNCTION_SNAPSHOT)("preserves all actual public catalogue and stock-kit outputs for the complete production snapshot", async () => {
    const input = JSON.parse(fs.readFileSync(process.env.RM_CATALOGUE_FUNCTION_SNAPSHOT!, "utf8"));
    const f = fixture(input.products);
    f.tables.items = input.inventory;
    f.tables.listing_resolution_override = input.overrides;
    f.tables.online_listings = input.listings;
    await ready(f);
    f.reads.length = 0;
    const started = performance.now();
    const actual = await handler(__service_catalogueForStorefront)(f.ctx, { accountSlug: "dbcinema" });
    console.log("Complete catalogue replay ms", performance.now() - started);
    expect(JSON.parse(JSON.stringify(actual))).toEqual(input.expected);
    expect(f.reads).not.toContain("hygglo_products");
    expect(f.reads).toContain("catalogue_cache_blobs");
  });
  it("uses only the cache for a verified ready revision", async () => {
    const f = fixture(); await ready(f);
    expect(await loadCatalogueProducts(f.ctx)).toEqual(f.tables.hygglo_products.map(catalogueProduct));
    expect(f.reads).not.toContain("hygglo_products");
  });
  it("falls back to the actual source while missing, dirty or damaged", async () => {
    const f = fixture(); expect(await loadCatalogueProducts(f.ctx)).toHaveLength(1); await ready(f);
    f.tables.catalogue_cache_state[0].revision++;
    f.tables.hygglo_products[0].name = "Fresh";
    expect((await loadCatalogueProducts(f.ctx))[0].name).toBe("Fresh");
    f.tables.catalogue_cache_state[0].ready_revision++;
    f.tables.catalogue_cache_blobs[0].revision++;
    f.tables.catalogue_cache_blobs[0].data = new Uint8Array([1, 2, 3]).buffer;
    expect((await loadCatalogueProducts(f.ctx))[0].name).toBe("Fresh");
  });
  it("invalidates before a real product patch and enqueues one job for a concurrent batch", async () => {
    const f = fixture(); await ready(f);
    await patchProduct(f.ctx, "p1" as never, { name: "Changed" });
    expect(f.writes[0]).toBe("catalogue_cache_state");
    expect((await loadCatalogueProducts(f.ctx))[0].name).toBe("Changed");
    await Promise.all([invalidateCatalogue(f.ctx, ["dbcinema"]), invalidateCatalogue(f.ctx, ["dbcinema"])]);
    expect(f.scheduled).toHaveLength(1);
    expect(f.tables.catalogue_cache_state).toHaveLength(1);
  });
  it("does not invalidate on unchanged catalogue fields, polling stamps or another account", async () => {
    const f = fixture(); await ready(f);
    await patchProduct(f.ctx, "p1" as never, { name: "Camera", lastSyncedAt: 999 });
    expect(f.tables.catalogue_cache_state[0].revision).toBe(1);
    expect(f.scheduled).toHaveLength(0);
    expect(cataloguePatchChanges(source("other", { accountSlug: "leo" }), { name: "Different" })).toBe(false);
  });
  it("invalidates account moves, inserts and deletes without changing original values", async () => {
    const f = fixture(); await ready(f);
    await patchProduct(f.ctx, "p1" as never, { accountSlug: "leo" });
    expect(await loadCatalogueProducts(f.ctx)).toEqual([]);
    const { _id, _creationTime, ...value } = source("new", { productId: 2 });
    const id = await insertProduct(f.ctx, value);
    expect((await loadCatalogueProducts(f.ctx))[0].productId).toBe(2);
    await deleteProduct(f.ctx, id);
    expect(await loadCatalogueProducts(f.ctx)).toEqual([]);
  });
  it("does not publish a snapshot after an intervening source change", async () => {
    const f = fixture(); await ready(f); await invalidateCatalogue(f.ctx, ["dbcinema"]);
    const old = f.tables.catalogue_cache_blobs[0];
    expect(await handler(publish)(f.ctx, { token: 1, revision: 1, data: old.data, count: old.count, sha256: old.sha256, packed_sha256: old.packed_sha256 })).toBe(false);
    expect(f.tables.catalogue_cache_state[0].ready_revision).toBe(1);
    expect(f.tables.catalogue_cache_state[0].revision).toBe(2);
  });
  it("stops permanent retries and resets readiness before a legacy backend rollback", async () => {
    const f = fixture(); await ready(f); await invalidateCatalogue(f.ctx, ["dbcinema"]);
    const jobs = f.scheduled.length;
    await handler(failed)(f.ctx, { token: 1, error: "permanent: capacity" });
    expect(f.scheduled).toHaveLength(jobs);
    expect(f.tables.catalogue_cache_state[0].queued).toBe(false);
    await handler(reset)(f.ctx, {});
    expect(f.tables.catalogue_cache_state[0].ready_revision).toBeUndefined();
    expect(await loadCatalogueProducts(f.ctx)).toHaveLength(1);
  });
  it("ignores a stale worker failure after its successor was queued", async () => {
    const f = fixture(); await ready(f); await invalidateCatalogue(f.ctx, ["dbcinema"]);
    await handler(failed)(f.ctx, { token: 1, error: "temporary network loss" });
    expect(f.tables.catalogue_cache_state[0].job_token).toBe(2);
    const state = structuredClone(f.tables.catalogue_cache_state[0]), jobs = f.scheduled.length;
    await handler(failed)(f.ctx, { token: 1, error: "old worker" });
    expect(f.tables.catalogue_cache_state[0]).toEqual(state);
    expect(f.scheduled).toHaveLength(jobs);
  });
  it("rejects an oversized decompression header before allocating the output", () => {
    const data = packCatalogue([catalogueProduct(source())]);
    new DataView(data).setUint32(data.byteLength - 4, 9 * 1024 * 1024, true);
    expect(() => unpackCatalogue(data)).toThrow("Invalid cache size");
  });
  it("keeps the catalogue available if derived metadata has duplicate keys", async () => {
    const f = fixture(); await ready(f);
    f.tables.catalogue_cache_state.push({ ...f.tables.catalogue_cache_state[0], _id: "duplicate" });
    expect(await loadCatalogueProducts(f.ctx)).toEqual(f.tables.hygglo_products.map(catalogueProduct));
  });
  it("keeps a prepared cache disabled for public reads and stops automatic warming until enabled", async () => {
    const f = fixture(); await ready(f); f.tables.catalogue_cache_state[0].enabled = false;
    f.reads.length = 0;
    await loadCatalogueProducts(f.ctx);
    expect(f.reads).toContain("hygglo_products");
    f.reads.length = 0;
    await loadCatalogueProducts(f.ctx, true);
    expect(f.reads).not.toContain("hygglo_products");
    await patchProduct(f.ctx, "p1" as never, { name: "Changed while disabled" });
    expect(f.scheduled).toHaveLength(0);
    await expect(loadCatalogueProducts(f.ctx, true)).rejects.toThrow("not current");
  });
  it("enables only the qualified revision and rejects an intervening product change", async () => {
    const f = fixture(); await ready(f); f.tables.catalogue_cache_state[0].enabled = false;
    const sha256 = f.tables.catalogue_cache_blobs[0].sha256;
    expect(await handler(enable)(f.ctx, { revision: 1, sha256 })).toEqual({ enabled: true, revision: 1 });
    await handler(reset)(f.ctx, {});
    await expect(handler(enable)(f.ctx, { revision: 1, sha256 })).rejects.toThrow("changed");
    expect(f.tables.catalogue_cache_state[0].enabled).toBe(false);
    expect(f.tables.hygglo_products[0].name).toBe("Camera");
  });
  it("keeps readiness invalidated when a later patch reuses an earlier same-transaction source read", async () => {
    const f = fixture(); await ready(f);
    const earlier = await f.ctx.db.get("p1" as never) as Doc<"hygglo_products">;
    await patchProduct(f.ctx, "p1" as never, { name: "Temporary" }, earlier);
    await patchProduct(f.ctx, "p1" as never, { name: "Camera" }, earlier);
    expect(f.tables.catalogue_cache_state[0].ready_revision).not.toBe(f.tables.catalogue_cache_state[0].revision);
    expect((await loadCatalogueProducts(f.ctx))[0].name).toBe("Camera");
    expect(f.scheduled).toHaveLength(1);
  });
});
