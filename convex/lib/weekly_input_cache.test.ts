import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { getFunctionName } from "convex/server";
import type { MutationCtx } from "../_generated/server";
import { WEEKLY_INPUT_KEY, captureWeeklyInputs, sourceWeeklyRows, loadWeeklyMetricRows, loadWeeklyInputSnapshot, withPreparedWeeklyInputs, withSourceWeeklyInputs, patchWeeklyMetric, insertWeeklyMetric, deleteWeeklyMetric } from "./weekly_input_cache";
import { cacheByteDigest, cacheValueDigest, packCacheValue } from "./lossless_cache_codec";
import * as admin from "../weekly_input_cache_admin";
import { getDashboardInsightBundle, getWeeklyRevenueSparkline } from "../dashboard_insights";

const now = Date.parse("2026-10-16T12:00:00Z");
function fixture(rows?: any[], items?: any[]) {
  const tables: Record<string, any[]> = { weekly_metrics: structuredClone(rows ?? [
    { _id: "metric", _creationTime: 1, week_start: "2026-10-12", week_end: "2026-10-18", account_slug: "leo", granularity: "item", item_id: "item", item_name_canonical: "Camera", utilization_rate: 0.25, voluntary_denied_count: 2, voluntary_denied_estimated_gbp: 40 },
    { _id: "global", _creationTime: 2, week_start: "2026-10-12", week_end: "2026-10-18", account_slug: "leo", granularity: "global", revenue_gross_gbp: 100, below_minimum_threshold_denied_count: 1 },
  ]), items: structuredClone(items ?? [{ _id: "item", _creationTime: 1, name_canonical: "Camera", replacement_cost_gbp: 1000 }]), weekly_input_cache_state: [], weekly_input_cache_blobs: [] };
  const reads: string[] = [], writes: string[] = [], scheduled: any[] = []; let serial = 0;
  const db = {
    query(table: string) {
      const filters: ((row: any) => boolean)[] = []; let index = "";
      const query = {
        withIndex(name: string, build: (q: any) => unknown) { index = name; const range = {
          eq(key: string, value: unknown) { filters.push(row => row[key] === value); return range; },
          gte(key: string, value: any) { filters.push(row => row[key] >= value); return range; },
        }; build(range); return query; },
        async collect() { reads.push(table); return structuredClone(tables[table].filter(row => filters.every(filter => filter(row))).sort((a, b) => {
          for (const key of index === "by_week_account_granularity" ? ["week_start", "account_slug", "granularity", "_creationTime"] : ["_creationTime"]) {
            if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
          } return 0;
        })); },
        async take(n: number) { return (await query.collect()).slice(0, n); },
        async unique() { const rows = await query.collect(); if (rows.length > 1) throw Error("Duplicate fixture key"); return rows[0] ?? null; },
      }; return query;
    },
    async get(id: string) { reads.push("get:" + id); return structuredClone(Object.values(tables).flat().find(row => row._id === id) ?? null); },
    async insert(table: string, data: any) { const id = `${table}:${++serial}`; tables[table].push({ ...structuredClone(data), _id: id, _creationTime: serial }); writes.push(table); return id; },
    async patch(id: string, patch: any) { const table = Object.keys(tables).find(key => tables[key].some(row => row._id === id))!; const row = tables[table].find(row => row._id === id); for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete row[key]; else row[key] = structuredClone(value); } writes.push(table); },
    async replace(id: string, data: any) { const row = Object.values(tables).flat().find(row => row._id === id); for (const key of Object.keys(row)) if (!key.startsWith("_")) delete row[key]; Object.assign(row, structuredClone(data)); },
    async delete(id: string) { for (const [table, rows] of Object.entries(tables)) { const at = rows.findIndex(row => row._id === id); if (at >= 0) { rows.splice(at, 1); writes.push(table); } } },
  };
  const context = () => ({ db, scheduler: { async runAfter(...args: unknown[]) { scheduled.push(args); return "job"; } } }) as unknown as MutationCtx;
  return { tables, db, context, reads, writes, scheduled };
}
async function ready(f: ReturnType<typeof fixture>, enabled = true) {
  const input = await captureWeeklyInputs(f.context()), data = packCacheValue(input);
  f.tables.weekly_input_cache_state.push({ _id: "state", _creationTime: 1, key: WEEKLY_INPUT_KEY, revision: 1, ready_revision: 1, covered_from: input.covered_from, enabled, queued: false, job_token: 0, attempts: 0, updated_at: now });
  f.tables.weekly_input_cache_blobs.push({ _id: "blob", _creationTime: 1, key: WEEKLY_INPUT_KEY, version: 1, revision: 1, covered_from: input.covered_from, data, sha256: await cacheValueDigest(input), packed_sha256: await cacheByteDigest(data) });
  return input;
}
afterEach(() => vi.restoreAllMocks());

describe("lossless weekly metric inputs", () => {
  it("preserves full records, index order and independent mutable results with one artifact load", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(); await ready(f); f.reads.length = 0; const ctx = f.context();
    const expected = await sourceWeeklyRows(f.context(), "2026-07-18");
    const [a, b] = await Promise.all([loadWeeklyMetricRows(ctx, "2026-07-18"), loadWeeklyMetricRows(ctx, "2026-07-18")]);
    expect(a).toEqual(expected); a[0].week_end = "changed"; expect(b).toEqual(expected);
    expect(f.reads.filter(table => table === "weekly_input_cache_blobs")).toHaveLength(1);
  });
  it("uses current source data when absent, dirty, disabled or damaged", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    for (const mode of ["absent", "dirty", "disabled", "damaged"]) {
      const f = fixture(); if (mode !== "absent") await ready(f, mode !== "disabled");
      if (mode === "dirty") f.tables.weekly_input_cache_state[0].revision++;
      if (mode === "damaged") f.tables.weekly_input_cache_blobs[0].data = new Uint8Array([1, 2, 3]).buffer;
      expect(await loadWeeklyMetricRows(f.context(), "2026-07-18")).toEqual(await sourceWeeklyRows(f.context(), "2026-07-18"));
    }
  });
  it("retains old-history fallback and advances the cutoff without rounding or clipping rows", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(); f.tables.weekly_metrics.push({ ...f.tables.weekly_metrics[0], _id: "old", week_start: "2020-01-01" }); await ready(f);
    for (const from of ["2019-01-01", "2026-07-11", "2026-10-12", "2026-10-13", "2030-01-01"]) expect(await loadWeeklyMetricRows(f.context(), from)).toEqual(await sourceWeeklyRows(f.context(), from));
  });
  it("keeps long history widgets on their original indexed path without loading the cache", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(); await ready(f); f.reads.length = 0;
    await (getWeeklyRevenueSparkline as any)._handler(f.context(), { accountSlug: null, weeks: 30 });
    expect(f.reads).toEqual(["weekly_metrics"]);
  });
  it("coalesces concurrent source writes into one invalidation before writes and a single delayed refresh", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(); await ready(f); const ctx = f.context(); await loadWeeklyInputSnapshot(ctx); f.writes.length = 0;
    await Promise.all([patchWeeklyMetric(ctx, "metric" as any, { utilization_rate: 0.4 }), patchWeeklyMetric(ctx, "global" as any, { revenue_gross_gbp: 150 })]);
    expect(f.tables.weekly_input_cache_state[0].revision).toBe(2); expect(f.scheduled).toHaveLength(1); expect(f.scheduled[0][0]).toBe(5000);
    expect(f.writes[0]).toBe("weekly_input_cache_state"); expect(await loadWeeklyMetricRows(ctx, "2026-07-18")).toEqual(await sourceWeeklyRows(f.context(), "2026-07-18"));
  });
  it("does not rebuild for unchanged values or history outside the cached coverage", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(); await ready(f);
    await patchWeeklyMetric(f.context(), "metric" as any, { utilization_rate: 0.25 });
    const { _id, _creationTime, ...oldRow } = f.tables.weekly_metrics[0];
    await insertWeeklyMetric(f.context(), { ...oldRow, week_start: "2020-01-01" });
    expect(f.scheduled).toHaveLength(0); expect(f.tables.weekly_input_cache_state[0].revision).toBe(1);
  });
  it("invalidates moves across the coverage boundary and source deletes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    for (const mode of ["move-out", "move-in", "delete"]) {
      const f = fixture(); if (mode === "move-in") f.tables.weekly_metrics[0].week_start = "2020-01-01"; await ready(f);
      if (mode === "delete") await deleteWeeklyMetric(f.context(), "metric" as any);
      else await patchWeeklyMetric(f.context(), "metric" as any, { week_start: mode === "move-in" ? "2026-10-12" : "2020-01-01" });
      expect(f.tables.weekly_input_cache_state[0].revision).toBe(2);
    }
  });
  it("keeps disabled preparation strict and rejects enabling after source changes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(); await ready(f, false);
    const prepared = f.context(); f.reads.length = 0;
    expect(await withPreparedWeeklyInputs(prepared, () => loadWeeklyMetricRows(prepared, "2026-07-18"))).toHaveLength(2);
    expect(f.reads).not.toContain("weekly_metrics");
    const sha256 = f.tables.weekly_input_cache_blobs[0].sha256; await patchWeeklyMetric(f.context(), "metric" as any, { utilization_rate: 0.5 });
    await expect((admin.enable as any)._handler(f.context(), { revision: 1, sha256 })).rejects.toThrow("changed");
    const ctx = f.context(); await expect(withPreparedWeeklyInputs(ctx, () => loadWeeklyMetricRows(ctx, "2026-07-18"))).rejects.toThrow("not current");
  });
  it("rejects mismatched known records and oversized snapshots", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture();
    await expect(patchWeeklyMetric(f.context(), "metric" as any, {}, f.tables.weekly_metrics[1])).rejects.toThrow("does not match");
    f.tables.weekly_metrics = Array.from({ length: 2001 }, (_, i) => ({ ...f.tables.weekly_metrics[0], _id: String(i) }));
    await expect(captureWeeklyInputs(f.context())).rejects.toThrow("permanent:");
  });
  it("publishes through the real refresh action while keeping first preparation disabled", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(); await (admin.warm as any)._handler(f.context(), {});
    const ctx = { runQuery: (ref: any, args: any) => (admin as any)[getFunctionName(ref).split(":")[1]]._handler(f.context(), args), runMutation: (ref: any, args: any) => (admin as any)[getFunctionName(ref).split(":")[1]]._handler(f.context(), args) };
    expect((await (admin.refresh as any)._handler(ctx, { token: 1 })).published).toBe(true);
    expect(f.tables.weekly_input_cache_state[0]).toMatchObject({ enabled: false, revision: 0, ready_revision: 0, queued: false });
    expect(await (admin.auditPreparedInputs as any)._handler(f.context(), {})).toMatchObject({ equal: true, count: 2 });
  });
  it("discards stale workers, bounds retries and resets to source reads", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(); await ready(f); const state = f.tables.weekly_input_cache_state[0]; Object.assign(state, { queued: true, job_token: 2, revision: 2 });
    const args = { token: 1, revision: 1, covered_from: state.covered_from, ...f.tables.weekly_input_cache_blobs[0] }; args.token = 1;
    expect(await (admin.publish as any)._handler(f.context(), args)).toBe(false);
    args.token = 2; args.revision = 1; expect(await (admin.publish as any)._handler(f.context(), args)).toBe(false); expect(f.scheduled[0][0]).toBe(30000);
    await (admin.failed as any)._handler(f.context(), { token: 3, error: "permanent: invalid input" }); expect(state).toMatchObject({ enabled: false, queued: false });
    await (admin.reset as any)._handler(f.context(), {}); expect(await loadWeeklyInputSnapshot(f.context())).toBeNull();
  });
  it("preserves all real bundle calculations with the exact same records and ordering", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(); await ready(f);
    for (const accountSlug of [null, "leo", "diogo", "dbcinema", "dbcinema_web"]) {
      const raw = f.context(), cached = f.context();
      expect(await withPreparedWeeklyInputs(cached, () => (getDashboardInsightBundle as any)._handler(cached, { accountSlug }))).toEqual(await withSourceWeeklyInputs(raw, () => (getDashboardInsightBundle as any)._handler(raw, { accountSlug })));
    }
  });
  it("stops transient retries after three attempts and leaves source reads available", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now); const f = fixture(); await ready(f); const state = f.tables.weekly_input_cache_state[0];
    Object.assign(state, { queued: true, job_token: 5, ready_revision: 0 });
    for (const token of [5, 6, 7]) await (admin.failed as any)._handler(f.context(), { token, error: "temporary failure" });
    expect(f.scheduled.map(job => job[0])).toEqual([30000, 60000]); expect(state).toMatchObject({ attempts: 3, queued: false, enabled: false });
    expect(await loadWeeklyMetricRows(f.context(), "2026-07-18")).toEqual(await sourceWeeklyRows(f.context(), "2026-07-18"));
  });
  it.skipIf(!process.env.RM_WEEKLY_INPUT_SNAPSHOT || !process.env.RM_STOCK_INPUT_SNAPSHOT)("replays every private production metric and complete bundle for all account controls", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const source = JSON.parse(fs.readFileSync(process.env.RM_WEEKLY_INPUT_SNAPSHOT!, "utf8")), stock = JSON.parse(fs.readFileSync(process.env.RM_STOCK_INPUT_SNAPSHOT!, "utf8"));
    const f = fixture(source.rows, stock.items); await ready(f);
    for (const from of [source.covered_from, "2026-07-18", "2026-08-21", "2026-09-18", "2026-10-16"]) expect(await loadWeeklyMetricRows(f.context(), from)).toEqual(await sourceWeeklyRows(f.context(), from));
    for (const accountSlug of [null, "leo", "diogo", "dbcinema", "dbcinema_web"]) {
      const raw = f.context(), cached = f.context();
      expect(await withPreparedWeeklyInputs(cached, () => (getDashboardInsightBundle as any)._handler(cached, { accountSlug }))).toEqual(await withSourceWeeklyInputs(raw, () => (getDashboardInsightBundle as any)._handler(raw, { accountSlug })));
    }
  });
});
