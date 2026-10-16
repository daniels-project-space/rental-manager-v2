import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { readReplyQueueRow, storeReplyQueueTiles } from "./reply_queue_storage";
import { currentQuickReplyCache } from "./quick_reply_cache";
import * as codec from "./lossless_cache_codec";
import { write, get, repack } from "../mv/reply_queue";

const tile = { thread_id: "thread", request_created_at: null, items: [], requested_items: [], availability: { stock_rules_version: 7, items: [], checked_at: 1234 }, exact: { negativeZero: -0, nan: NaN, infinity: Infinity, integer: 9007199254740993n, bytes: new Uint8Array([1, 2, 255]).buffer } };
const row = (tiles: any = [tile]) => ({ _id: "cache", _creationTime: 1, account: "all", generatedAt: 1234, tiles });
afterEach(() => vi.restoreAllMocks());

function fixture(initial: any = null) {
  let record = structuredClone(initial); const patches: any[] = [];
  const ctx = { db: {
    query: () => ({ withIndex: (_index: string, range: (q: any) => unknown) => { const q = { eq: () => q }; range(q); return { first: async () => structuredClone(record) }; } }),
    patch: async (_id: string, fields: any) => { patches.push(fields); for (const [key, value] of Object.entries(fields)) { if (value === undefined) delete record[key]; else record[key] = structuredClone(value); } },
    insert: async (_table: string, fields: any) => { record = { ...structuredClone(fields), _id: "cache", _creationTime: 1 }; patches.push(fields); return "cache"; },
  } };
  return { ctx, patches, record: () => record };
}

describe("lossless reply queue storage", () => {
  it("roundtrips complete tiles and their metadata with exact Convex values", async () => {
    const original = row(), packed = await storeReplyQueueTiles(original.account, original.generatedAt, original.tiles);
    expect(packed.tiles).toBeNull(); expect(currentQuickReplyCache(packed.tiles)).toBe(false);
    const decoded = await readReplyQueueRow({ ...original, ...packed } as any);
    expect(decoded).toEqual(original); expect(currentQuickReplyCache(decoded!.tiles)).toBe(true);
    expect(Object.keys(decoded!)).toEqual(Object.keys(original));
    expect(Object.is(decoded!.tiles[0].exact.negativeZero, -0)).toBe(true);
  });
  it("keeps legacy arrays authoritative after an older writer overwrites a packed row", async () => {
    const old = row(), packed = await storeReplyQueueTiles("all", old.generatedAt, old.tiles), newer = [{ ...tile, thread_id: "new" }];
    expect(await readReplyQueueRow({ ...old, ...packed, tiles: newer, generatedAt: 2000 } as any)).toEqual({ ...old, tiles: newer, generatedAt: 2000 });
  });
  it("returns a cache miss for corrupt, unsupported or incorrectly bound artifacts", async () => {
    for (const mode of ["bytes", "digest", "version", "account", "time"]) {
      const original = row(), packed: any = await storeReplyQueueTiles("all", original.generatedAt, original.tiles), stored: any = { ...original, ...packed };
      if (mode === "bytes") new Uint8Array(stored.tiles_gzip)[10] ^= 1;
      if (mode === "digest") stored.tiles_sha256 = "wrong";
      if (mode === "version") stored.tiles_codec_version = 2;
      if (mode === "account") stored.account = "other";
      if (mode === "time") stored.generatedAt++;
      expect(await readReplyQueueRow(stored)).toBeNull();
    }
  });
  it("preserves legacy values and uses the full original payload on encoding failure", async () => {
    expect(await readReplyQueueRow(row(null) as any)).toEqual(row(null));
    const original = row(); vi.spyOn(codec, "packCacheValue").mockImplementationOnce(() => { throw Error("permanent: cache row exceeds bound"); });
    const stored = await storeReplyQueueTiles("all", original.generatedAt, original.tiles);
    expect(stored.tiles).toEqual(original.tiles); expect(stored.tiles_gzip).toBeUndefined();
    expect(await readReplyQueueRow({ ...original, ...stored } as any)).toEqual(original);
  });
  it("writes new and changed producer results through the real mutation", async () => {
    const f = fixture(); await (write as any)._handler(f.ctx, { account: "all", generatedAt: 1234, tiles: [tile] });
    expect(f.record().tiles).toBeNull(); expect(await readReplyQueueRow(f.record())).toEqual(row());
    const newer = [{ ...tile, availability: { ...tile.availability, checked_at: 5678 } }];
    await (write as any)._handler(f.ctx, { account: "all", generatedAt: 5678, tiles: newer });
    expect(await readReplyQueueRow(f.record())).toEqual({ ...row(newer), generatedAt: 5678 });
  });
  it("migrates unchanged legacy content without advancing its original clock", async () => {
    const original = row(), f = fixture(original);
    expect(await (write as any)._handler(f.ctx, { account: "all", generatedAt: 9999, tiles: original.tiles })).toMatchObject({ skipped: true });
    expect(f.record().tiles).toBeNull(); expect(await readReplyQueueRow(f.record())).toEqual(original);
    expect(f.record().generatedAt).toBe(1234);
  });
  it("retains content skips for packed rows and returns the complete original public row", async () => {
    const original = row(), packed = await storeReplyQueueTiles("all", original.generatedAt, original.tiles), f = fixture({ ...original, ...packed });
    expect(await (write as any)._handler(f.ctx, { account: "all", generatedAt: 9999, tiles: original.tiles })).toMatchObject({ skipped: true });
    expect(f.patches).toHaveLength(0); expect(await (get as any)._handler(f.ctx, {})).toEqual(original);
  });
  it("repackages atomically with equal complete-row hashes and unchanged generation time", async () => {
    const original = row(), f = fixture(original), result = await (repack as any)._handler(f.ctx, { account: "all" });
    expect(result.packed).toBe(true); expect(result.before_sha256).toBe(result.after_sha256);
    expect(await readReplyQueueRow(f.record())).toEqual(original); expect(f.record().generatedAt).toBe(original.generatedAt);
  });
  it("does not invent an empty valid queue when the stored artifact is damaged", async () => {
    const original = row(), packed = await storeReplyQueueTiles("all", original.generatedAt, original.tiles), f = fixture({ ...original, ...packed, tiles_sha256: "wrong" });
    expect(await (get as any)._handler(f.ctx, {})).toBeNull();
    expect(await (repack as any)._handler(f.ctx, { account: "all" })).toMatchObject({ packed: false });
    expect(f.patches).toHaveLength(0);
  });
  it.skipIf(!process.env.RM_QUEUE_FUNCTION_SNAPSHOT)("preserves every actual production tile, image, price, date and grouping", async () => {
    const captured = JSON.parse(fs.readFileSync(process.env.RM_QUEUE_FUNCTION_SNAPSHOT!, "utf8"));
    const tiles = captured.executions.find((x: any) => x.request.path === "replyInbox:getReplyQueue").value.result;
    const original = row(tiles), packed = await storeReplyQueueTiles("all", original.generatedAt, tiles);
    expect(currentQuickReplyCache(tiles)).toBe(true); expect(packed.tiles_gzip).toBeInstanceOf(ArrayBuffer);
    expect(await readReplyQueueRow({ ...original, ...packed } as any)).toEqual(original);
  });
});
