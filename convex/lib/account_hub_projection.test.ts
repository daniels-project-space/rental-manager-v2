import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { jsonToConvex } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import { cacheValueDigest } from "./lossless_cache_codec";
import { sourceHubRows, projectHubRows, loadHubRows, prepareHubProjection, patchAccountProfile, insertAccountProfile, deleteAccountProfile, replaceAccountProfile, withPreparedHubRows, withSourceHubRows } from "./account_hub_projection";
import * as admin from "../account_hub_projection_admin";
import { loadHubBook } from "../replyInbox";

function fixture(profiles?: any[]) {
  const tables: Record<string, any[]> = { account_profiles: structuredClone(profiles ?? [
    { _id: "p1", _creationTime: 1, account_id: "a1", hub_lat: 51.500000000001, hub_lng: -0, persona_prompt: "large unrelated text" },
    { _id: "p2", _creationTime: 2, account_id: "a2" },
    { _id: "p3", _creationTime: 3, account_id: "a1", hub_lat: 0.30000000000000004, hub_lng: -1.5 },
  ]), accounts: [{ _id: "a1", slug: "leo" }, { _id: "a2", slug: "dbcinema" }], settings: [{ _id: "settings", hub_heavy_max_km: 2, hub_max_km: 5, draft_epoch: 8 }], account_hub_projection: [] };
  const reads: string[] = [], writes: string[] = []; let serial = 100, failWrite = false, failRebuild = false;
  const db = {
    query(table: string) {
      let key = "", value: unknown;
      const q = {
        withIndex(_name: string, build: (q: any) => unknown) { build({ eq(k: string, v: unknown) { key = k; value = v; } }); return q; },
        async collect() { reads.push(table); if (failRebuild && table === "account_profiles") throw Error("source read failed"); return structuredClone(tables[table].filter(row => !key || row[key] === value)); },
        async take(n: number) { return (await q.collect()).slice(0, n); },
        async unique() { const rows = await q.collect(); if (rows.length > 1) throw Error("duplicate key"); return rows[0] ?? null; },
        async first() { return (await q.collect())[0] ?? null; },
      }; return q;
    },
    async get(id: string) { reads.push("get:" + id); return structuredClone(Object.values(tables).flat().find(row => row._id === id) ?? null); },
    async insert(table: string, data: any) { const id = `${table}:${++serial}`; tables[table].push({ ...structuredClone(data), _id: id, _creationTime: serial }); writes.push(table); return id; },
    async patch(id: string, patch: any) { if (failWrite && id.startsWith("p")) throw Error("source write failed"); const table = Object.keys(tables).find(key => tables[key].some(row => row._id === id))!; const row = tables[table].find(row => row._id === id); for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete row[key]; else row[key] = structuredClone(value); } writes.push(table); },
    async replace(id: string, data: any) { const row = Object.values(tables).flat().find(row => row._id === id); for (const key of Object.keys(row)) if (!key.startsWith("_")) delete row[key]; Object.assign(row, structuredClone(data)); },
    async delete(id: string) { for (const rows of Object.values(tables)) { const at = rows.findIndex(row => row._id === id); if (at >= 0) rows.splice(at, 1); } },
  };
  const context = () => ({ db }) as unknown as MutationCtx;
  return { tables, db, context, reads, writes, failWrite: () => { failWrite = true; }, failRebuild: (value: boolean) => { failRebuild = value; } };
}
async function ready(f: ReturnType<typeof fixture>) {
  const prepared = await prepareHubProjection(f.context());
  await (admin.enable as any)._handler(f.context(), { revision: prepared.revision!, sha256: prepared.sha256! });
}
const bookValue = (book: Awaited<ReturnType<typeof loadHubBook>>) => ({ ...book, bySlug: [...book.bySlug] });

describe("atomic account hub projection", () => {
  it("preserves original row order, duplicate accounts, null defaults and precise coordinates", async () => {
    const f = fixture(); await ready(f);
    const actual = await loadHubRows(f.context()); expect(actual).toEqual(await sourceHubRows(f.context()));
    expect(Object.is(actual[0].hub_lng, -0)).toBe(true); expect(actual[2].hub_lat).toBe(0.30000000000000004);
    expect(actual[1]).toMatchObject({ hub_lat: null, hub_lng: null });
    const source = f.context(), cached = f.context();
    expect(bookValue(await withSourceHubRows(source, () => loadHubBook(source)))).toEqual(bookValue(await loadHubBook(cached)));
    expect([...((await loadHubBook(f.context())).bySlug)]).toEqual([["leo", { lat: 0.30000000000000004, lng: -1.5 }], ["dbcinema", { lat: null, lng: null }]]);
  });
  it("keeps missing, disabled, invalid and dirty projections on the complete source path", async () => {
    for (const mode of ["missing", "disabled", "dirty", "corrupt"]) {
      const f = fixture(); if (mode !== "missing") await ready(f);
      if (mode === "disabled") f.tables.account_hub_projection[0].enabled = false;
      if (mode === "dirty") f.tables.account_hub_projection[0].ready = false;
      if (mode === "corrupt") f.tables.account_hub_projection[0].rows[0].hub_lat = 0;
      expect(await loadHubRows(f.context())).toEqual(await sourceHubRows(f.context()));
      if (mode !== "disabled") { const ctx = f.context(); if (mode !== "missing" && mode !== "dirty" && mode !== "corrupt") continue; await expect(withPreparedHubRows(ctx, () => loadHubRows(ctx))).rejects.toThrow(); }
    }
  });
  it("prepares disabled rows and audits the real hub-book implementation without source fallback", async () => {
    const f = fixture(); await prepareHubProjection(f.context());
    expect(f.tables.account_hub_projection[0].enabled).toBe(false);
    f.reads.length = 0; const ctx = f.context(); await withPreparedHubRows(ctx, () => loadHubRows(ctx)); expect(f.reads).not.toContain("account_profiles");
    expect(await (admin.audit as any)._handler(f.context(), {})).toMatchObject({ rowsEqual: true, hubBookEqual: true, count: 3 });
  });
  it("updates coordinates and reassigned accounts atomically, including deletion of optional coordinates", async () => {
    const f = fixture(); await ready(f); await patchAccountProfile(f.context(), "p1" as any, { account_id: "a2" as any, hub_lat: undefined, hub_lng: 0.25 });
    expect(await loadHubRows(f.context())).toEqual(await sourceHubRows(f.context())); expect(f.tables.account_hub_projection[0].ready).toBe(true);
  });
  it("keeps persona and communication edits out of projection reads and writes", async () => {
    const f = fixture(); await ready(f); f.reads.length = 0; f.writes.length = 0;
    await patchAccountProfile(f.context(), "p1" as any, { persona_prompt: "new persona" });
    expect(f.reads).toEqual([]); expect(f.writes).toEqual(["account_profiles"]);
  });
  it("maintains inserts, deletes and complete replacements without removing source fields", async () => {
    const f = fixture(); await ready(f);
    const id = await insertAccountProfile(f.context(), { account_id: "a1" as any, created_at: 0, updated_at: 0, hub_lat: 4, persona_prompt: "retained" });
    await deleteAccountProfile(f.context(), "p1" as any); await replaceAccountProfile(f.context(), "p2" as any, { account_id: "a1" as any, created_at: 0, updated_at: 0, hub_lng: 7 });
    expect(await loadHubRows(f.context())).toEqual(await sourceHubRows(f.context())); expect(await f.db.get(id)).toMatchObject({ persona_prompt: "retained" });
  });
  it("serializes concurrent profile writes before publishing a complete projection", async () => {
    const f = fixture(); await ready(f); const ctx = f.context();
    await Promise.all([patchAccountProfile(ctx, "p1" as any, { hub_lat: 2 }), patchAccountProfile(ctx, "p2" as any, { hub_lat: 4 }), insertAccountProfile(ctx, { account_id: "a2" as any, created_at: 0, updated_at: 0, hub_lng: 9 })]);
    expect(await loadHubRows(f.context())).toEqual(await sourceHubRows(f.context())); expect(f.tables.account_hub_projection[0].revision).toBe(3);
  });
  it("invalidates before a caught source failure", async () => {
    const f = fixture(); await ready(f); f.failWrite(); await expect(patchAccountProfile(f.context(), "p1" as any, { hub_lat: 9 })).rejects.toThrow("source write failed");
    expect(f.tables.account_hub_projection[0].ready).toBe(false); expect(await loadHubRows(f.context())).toEqual(await sourceHubRows(f.context()));
  });
  it("keeps source fallback active after a caught rebuild failure", async () => {
    const f = fixture(); await ready(f); f.failRebuild(true); await expect(patchAccountProfile(f.context(), "p1" as any, { hub_lat: 9 })).rejects.toThrow("source read failed"); f.failRebuild(false);
    expect(f.tables.account_hub_projection[0].ready).toBe(false); expect((await loadHubRows(f.context()))[0].hub_lat).toBe(9);
  });
  it("rejects stale activation after an actual coordinate update", async () => {
    const f = fixture(), prepared = await prepareHubProjection(f.context()); await patchAccountProfile(f.context(), "p1" as any, { hub_lat: 9 });
    await expect((admin.enable as any)._handler(f.context(), { revision: prepared.revision!, sha256: prepared.sha256! })).rejects.toThrow("qualify again");
  });
  it("reads account slugs and distance settings live while using cached coordinate rows", async () => {
    const f = fixture(); await ready(f); await f.db.patch("a1", { slug: "changed" }); await f.db.patch("settings", { hub_max_km: 11, draft_epoch: 99 });
    const actual = await loadHubBook(f.context()); expect(actual.maxKm).toBe(11); expect(actual.draftEpoch).toBe(99); expect(actual.bySlug.has("changed")).toBe(true); expect(actual.bySlug.has("leo")).toBe(false);
  });
  it("does not truncate source reads when artifact preparation exceeds its bound", async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => ({ _id: "p" + i, _creationTime: i, account_id: "a1", hub_lat: i })); const f = fixture(rows);
    expect((await prepareHubProjection(f.context())).ready).toBe(false); expect(await loadHubRows(f.context())).toHaveLength(2001);
  });
  it("returns independent rows without exposing projection storage to consumers", async () => {
    const f = fixture(); await ready(f); const rows = await loadHubRows(f.context()); rows[0].hub_lat = 4;
    expect(await loadHubRows(f.context())).toEqual(await sourceHubRows(f.context()));
  });
  it.skipIf(!process.env.RM_HUB_PROFILE_SNAPSHOT)("preserves the complete live profile input order and exact hub values", async () => {
    const rows = jsonToConvex(JSON.parse(fs.readFileSync(process.env.RM_HUB_PROFILE_SNAPSHOT!, "utf8"))) as any[]; const f = fixture(rows); await ready(f);
    expect(await loadHubRows(f.context())).toEqual(projectHubRows(rows)); expect(f.tables.account_hub_projection[0].sha256).toBe(await cacheValueDigest(projectHubRows(rows)));
  });
});
