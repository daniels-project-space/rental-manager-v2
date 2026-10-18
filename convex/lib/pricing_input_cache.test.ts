import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { getFunctionName } from "convex/server";
import { jsonToConvex } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import { PRICING_INPUT_KEY, capturePricingInputs, sourcePricingRows, loadPricingRows, loadPricingSnapshot, withSourcePricingInputs, withPreparedPricingInputs, patchPricingInput, insertPricingInput, deletePricingInput } from "./pricing_input_cache";
import { cacheByteDigest, cacheValueDigest, packCacheValue } from "./lossless_cache_codec";
import { loadPriceIndex } from "../replyInbox";
import { upsertPricingRow, applyRecommendation } from "../pricing_catalog";
import * as admin from "../pricing_input_cache_admin";

function fixture(input?: any[]) {
  const rows = input ?? [
    { _id: "price-a", _creationTime: 1.125, item_name_canonical: "Camera body", account_id: "owner-a", daily_price_min: 20.25, daily_price_max: 35.5, is_bundle: false, created_at: 1 },
    { _id: "price-b", _creationTime: 2.5, item_name_canonical: "Camera body", account_id: "owner-b", daily_price_min: 22.75, daily_price_max: 40, is_bundle: false, created_at: 2 },
    { _id: "price-short", _creationTime: 3, item_name_canonical: "Go", daily_price_min: 1, daily_price_max: 2, is_bundle: false, created_at: 3 },
  ];
  const tables: Record<string, any[]> = { pricing_catalog: structuredClone(rows), pricing_input_cache_state: [], pricing_input_cache_blobs: [], recommendation_dismissals: [], accounts: [
    { _id: "owner-a", slug: "leo" }, { _id: "owner-b", slug: "daniel" },
  ] };
  const reads: string[] = [], writes: string[] = [], scheduled: any[] = []; let serial = 0;
  const db = {
    query(table: string) {
      const filters: ((row: any) => boolean)[] = [];
      const query = {
        withIndex(_name: string, build: (q: any) => unknown) { const q = { eq(key: string, value: unknown) { filters.push(row => row[key] === value); return q; } }; build(q); return query; },
        async collect() { reads.push(table); return structuredClone(tables[table].filter(row => filters.every(filter => filter(row))).sort((a, b) => a._creationTime - b._creationTime || a._id.localeCompare(b._id))); },
        async take(n: number) { return (await query.collect()).slice(0, n); },
        async first() { return (await query.collect())[0] ?? null; },
        async unique() { const rows = await query.collect(); if (rows.length > 1) throw Error("Duplicate fixture key"); return rows[0] ?? null; },
      }; return query;
    },
    async get(id: string) { reads.push("get:" + id); return structuredClone(Object.values(tables).flat().find(row => row._id === id) ?? null); },
    async insert(table: string, data: any) { const id = `${table}:${++serial}`; tables[table].push({ ...structuredClone(data), _id: id, _creationTime: 100 + serial }); writes.push(table); return id; },
    async patch(id: string, patch: any) { const table = Object.keys(tables).find(key => tables[key].some(row => row._id === id))!; const row = tables[table].find(row => row._id === id); for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete row[key]; else row[key] = structuredClone(value); } writes.push(table); },
    async replace(id: string, data: any) { const row = Object.values(tables).flat().find(row => row._id === id); for (const key of Object.keys(row)) if (!key.startsWith("_")) delete row[key]; Object.assign(row, structuredClone(data)); },
    async delete(id: string) { for (const [table, rows] of Object.entries(tables)) { const at = rows.findIndex(row => row._id === id); if (at >= 0) { rows.splice(at, 1); writes.push(table); } } },
  };
  const context = () => ({ db, scheduler: { async runAfter(...args: unknown[]) { scheduled.push(args); return "job"; } } }) as unknown as MutationCtx;
  return { tables, db, context, reads, writes, scheduled };
}
async function ready(f: ReturnType<typeof fixture>, enabled = true) {
  const input = await capturePricingInputs(f.context()), data = packCacheValue(input);
  f.tables.pricing_input_cache_state.push({ _id: "state", _creationTime: 1, key: PRICING_INPUT_KEY, revision: 1, ready_revision: 1, enabled, queued: false, job_token: 0, attempts: 0, updated_at: 1 });
  f.tables.pricing_input_cache_blobs.push({ _id: "blob", _creationTime: 1, key: PRICING_INPUT_KEY, version: 1, revision: 1, data, sha256: await cacheValueDigest(input), packed_sha256: await cacheByteDigest(data) });
  return input;
}
afterEach(() => vi.restoreAllMocks());

describe("lossless pricing inputs", () => {
  it("retains all records, duplicate names/account scopes and exact source order with one artifact read", async () => {
    const f = fixture(); await ready(f); f.reads.length = 0; const ctx = f.context();
    const [a, b] = await Promise.all([loadPricingRows(ctx), loadPricingRows(ctx)]);
    expect(a).toEqual(await sourcePricingRows(f.context())); a[0].daily_price_min = 999; expect(b[0].daily_price_min).toBe(20.25);
    expect(f.reads.filter(table => table === "pricing_input_cache_blobs")).toHaveLength(1);
  });
  it("preserves IEEE numeric values and never rounds money inputs", async () => {
    const f = fixture(); Object.assign(f.tables.pricing_catalog[0], { daily_price_min: -0, daily_price_max: NaN }); Object.assign(f.tables.pricing_catalog[1], { daily_price_min: 0.1 + 0.2, daily_price_max: Infinity }); await ready(f);
    const rows = await loadPricingRows(f.context()); expect(Object.is(rows[0].daily_price_min, -0)).toBe(true); expect(Number.isNaN(rows[0].daily_price_max)).toBe(true); expect(rows[1].daily_price_min).toBe(0.30000000000000004); expect(rows[1].daily_price_max).toBe(Infinity);
  });
  it("takes the complete source path when the cache is absent, disabled, dirty or damaged", async () => {
    for (const mode of ["absent", "disabled", "dirty", "damaged"]) {
      const f = fixture(); if (mode !== "absent") await ready(f, mode !== "disabled");
      if (mode === "dirty") f.tables.pricing_input_cache_state[0].revision++;
      if (mode === "damaged") f.tables.pricing_input_cache_blobs[0].packed_sha256 = "wrong";
      expect(await loadPricingRows(f.context())).toEqual(await sourcePricingRows(f.context()));
    }
  });
  it("coalesces concurrent writes, invalidates before source changes and clears a prior read memo", async () => {
    const f = fixture(); await ready(f); const ctx = f.context(); await loadPricingSnapshot(ctx); f.writes.length = 0;
    await Promise.all([patchPricingInput(ctx, "price-a" as any, { daily_price_min: 25 }), patchPricingInput(ctx, "price-b" as any, { daily_price_max: 45 })]);
    expect(f.tables.pricing_input_cache_state[0].revision).toBe(2); expect(f.writes[0]).toBe("pricing_input_cache_state"); expect(f.scheduled).toHaveLength(1); expect(f.scheduled[0][0]).toBe(5000);
    expect(await loadPricingRows(ctx)).toEqual(await sourcePricingRows(f.context()));
  });
  it("skips invalidation for identical values and rejects mismatched known records", async () => {
    const f = fixture(); await ready(f); await patchPricingInput(f.context(), "price-a" as any, { daily_price_min: 20.25 }, f.tables.pricing_catalog[0]); expect(f.scheduled).toHaveLength(0);
    await expect(patchPricingInput(f.context(), "price-a" as any, {}, f.tables.pricing_catalog[1])).rejects.toThrow("does not match");
  });
  it("invalidates inserts and deletes without changing source values or accounts", async () => {
    for (const mode of ["insert", "delete"]) {
      const f = fixture(); await ready(f);
      if (mode === "insert") await insertPricingInput(f.context(), { item_name_canonical: "Lens", daily_price_min: 12.5, daily_price_max: 25, is_bundle: false, created_at: 1 });
      else await deletePricingInput(f.context(), "price-a" as any, f.tables.pricing_catalog[0]);
      expect(f.tables.pricing_input_cache_state[0].revision).toBe(2); expect(f.scheduled).toHaveLength(1);
      expect(await loadPricingRows(f.context())).toEqual(await sourcePricingRows(f.context()));
    }
  });
  it("retains the real upsert and recommendation behavior while maintaining cache revisions", async () => {
    const f = fixture(); await ready(f);
    await (upsertPricingRow as any)._handler(f.context(), { item_name_canonical: "Camera body", daily_price_min: 30, daily_price_max: 40 });
    expect(f.tables.pricing_catalog[0].daily_price_min).toBe(30); expect(f.tables.pricing_catalog[1].daily_price_min).toBe(22.75);
    expect(await (applyRecommendation as any)._handler(f.context(), { pricingRowId: "price-a", accountSlug: "leo", itemNameCanonical: "Camera body", newDailyRate: 50, demandSignature: "r1,r2,r3" })).toMatchObject({ updated: 1, newDailyRate: 50 });
    expect(f.tables.pricing_catalog.slice(0, 2).map(row => [row.daily_price_min, row.daily_price_max])).toEqual([[50, 50], [22.75, 40]]);
    expect(f.tables.recommendation_dismissals).toMatchObject([{ pricing_row_id: "price-a", account_slug: "leo", demand_signature: "r1,r2,r3", dismissed_by: "applied" }]);
    expect(f.tables.pricing_input_cache_state[0].revision).toBe(3); expect(f.scheduled).toHaveLength(1);
    await expect((applyRecommendation as any)._handler(f.context(), { pricingRowId: "price-a", accountSlug: "daniel", itemNameCanonical: "Camera body", newDailyRate: 60, demandSignature: "r1,r2,r3" })).rejects.toThrow("different account");
  });
  it("keeps preparation strict and refuses enabling a source revision that changed", async () => {
    const f = fixture(); await ready(f, false); const ctx = f.context(); f.reads.length = 0;
    expect(await withPreparedPricingInputs(ctx, () => loadPricingRows(ctx))).toHaveLength(3); expect(f.reads).not.toContain("pricing_catalog");
    const sha256 = f.tables.pricing_input_cache_blobs[0].sha256; await patchPricingInput(f.context(), "price-a" as any, { daily_price_min: 10 });
    await expect((admin.enable as any)._handler(f.context(), { revision: 1, sha256 })).rejects.toThrow("changed");
    const dirty = f.context(); await expect(withPreparedPricingInputs(dirty, () => loadPricingRows(dirty))).rejects.toThrow("not current");
  });
  it("bounds preparation without truncating the source fallback", async () => {
    const f = fixture(); f.tables.pricing_catalog = Array.from({ length: 2001 }, (_, i) => ({ ...f.tables.pricing_catalog[0], _id: String(i) }));
    await expect(capturePricingInputs(f.context())).rejects.toThrow("permanent:"); expect(await loadPricingRows(f.context())).toHaveLength(2001);
  });
  it("executes the actual refresh, source audit and real price-index calculation while disabled", async () => {
    const f = fixture(); await (admin.warm as any)._handler(f.context(), {});
    const ctx = { runQuery: (ref: any, args: any) => (admin as any)[getFunctionName(ref).split(":")[1]]._handler(f.context(), args), runMutation: (ref: any, args: any) => (admin as any)[getFunctionName(ref).split(":")[1]]._handler(f.context(), args) };
    expect((await (admin.refresh as any)._handler(ctx, { token: 1 })).published).toBe(true);
    expect(f.tables.pricing_input_cache_state[0]).toMatchObject({ enabled: false, revision: 0, ready_revision: 0, queued: false });
    expect(await (admin.auditPreparedInputs as any)._handler(f.context(), {})).toMatchObject({ equal: true, count: 3 });
    expect(await (admin.auditPriceIndex as any)._handler(f.context(), {})).toMatchObject({ equal: true, entries: 2 });
  });
  it("rejects stale workers and stops bounded transient/permanent retries", async () => {
    const f = fixture(); await ready(f); const state = f.tables.pricing_input_cache_state[0]; Object.assign(state, { queued: true, job_token: 5, ready_revision: 0 });
    expect(await (admin.publish as any)._handler(f.context(), { token: 4 })).toBe(false);
    for (const token of [5, 6, 7]) await (admin.failed as any)._handler(f.context(), { token, error: "temporary failure" });
    expect(f.scheduled.map(job => job[0])).toEqual([30000, 60000]); expect(state).toMatchObject({ enabled: false, queued: false, attempts: 3 });
    Object.assign(state, { enabled: true, queued: true, job_token: 9, attempts: 0 }); const before = f.scheduled.length;
    await (admin.failed as any)._handler(f.context(), { token: 9, error: "permanent: capacity" }); expect(f.scheduled).toHaveLength(before); expect(state.enabled).toBe(false);
    await (admin.reset as any)._handler(f.context(), {}); expect(await loadPricingSnapshot(f.context())).toBeNull();
  });
  it("preserves the real price-index keys and duplicate precedence exactly", async () => {
    const f = fixture(); await ready(f); const raw = f.context(), cached = f.context();
    expect(await withPreparedPricingInputs(cached, () => loadPriceIndex(cached))).toEqual(await withSourcePricingInputs(raw, () => loadPriceIndex(raw)));
  });
  it.skipIf(!process.env.RM_PRICING_INPUT_SNAPSHOT)("replays every private production record and the complete real price index", async () => {
    const rows = jsonToConvex(JSON.parse(fs.readFileSync(process.env.RM_PRICING_INPUT_SNAPSHOT!, "utf8"))) as any[], f = fixture(rows); await ready(f, false); const raw = f.context(), cached = f.context();
    expect(await withPreparedPricingInputs(cached, () => loadPricingRows(cached))).toEqual(await sourcePricingRows(raw));
    const rawIndex = f.context(), cachedIndex = f.context(); expect(await withPreparedPricingInputs(cachedIndex, () => loadPriceIndex(cachedIndex))).toEqual(await withSourcePricingInputs(rawIndex, () => loadPriceIndex(rawIndex)));
  });
});
