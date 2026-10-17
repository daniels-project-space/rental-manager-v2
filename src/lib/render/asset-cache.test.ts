import { describe, expect, it } from "vitest";
import { AssetCache } from "./asset-cache";

describe("bounded render asset cache", () => {
  const limits = { maxBytes: 6, maxEntries: 2, ttlMs: 100 };
  it("coalesces concurrent loads and preserves every byte", async () => {
    const cache = new AssetCache(limits); let calls = 0;
    const value = Buffer.from([0, 255, 1, 17]);
    const loader = async () => { calls++; return value; };
    const results = await Promise.all([cache.load("asset", loader), cache.load("asset", loader)]);
    expect(calls).toBe(1); expect(results).toEqual([value, value]);
    expect(await cache.load("asset", loader)).toBe(value); expect(calls).toBe(1);
    expect(cache.retained).toEqual({ entries: 1, bytes: 4, pending: 0 });
  });
  it("evicts least recently used buffers by bytes without mutating active callers", async () => {
    const cache = new AssetCache(limits);
    const first = await cache.load("a", async () => Buffer.from("aaaa"));
    await cache.load("b", async () => Buffer.from("bb"));
    await cache.load("a", async () => { throw Error("Unexpected reload"); });
    await cache.load("c", async () => Buffer.from("cc"));
    expect(first.toString()).toBe("aaaa"); expect(cache.retained).toEqual({ entries: 2, bytes: 6, pending: 0 });
    let reloaded = false; await cache.load("b", async () => { reloaded = true; return Buffer.from("bb"); }); expect(reloaded).toBe(true);
  });
  it("returns oversized assets in full without retaining them", async () => {
    const cache = new AssetCache(limits); const data = Buffer.alloc(7, 123);
    expect(await cache.load("large", async () => data)).toEqual(data);
    expect(cache.retained).toEqual({ entries: 0, bytes: 0, pending: 0 });
  });
  it("expires lazily and does not retain failed loads", async () => {
    let now = 0, calls = 0; const cache = new AssetCache(limits, () => now);
    const loader = async () => { calls++; return Buffer.from("x"); };
    await cache.load("x", loader); now = 100; await cache.load("x", loader); expect(calls).toBe(2);
    await expect(cache.load("bad", async () => { throw Error("source unavailable"); })).rejects.toThrow("source unavailable");
    expect(cache.retained.pending).toBe(0); expect(await cache.load("bad", loader)).toEqual(Buffer.from("x"));
  });
  it("enforces entry count even for zero-length assets", async () => {
    const cache = new AssetCache(limits); for (let i = 0; i < 10; i++) await cache.load(String(i), async () => Buffer.alloc(0));
    expect(cache.retained).toEqual({ entries: 2, bytes: 0, pending: 0 });
  });
  it("counts a replaced key once when pending-key tracking is full", async () => {
    const cache = new AssetCache(limits);
    const release: Array<(value: Buffer) => void> = [];
    const held = ["held-a", "held-b"].map(key => cache.load(key, () => new Promise<Buffer>(resolve => release.push(resolve))));
    try {
      const values = await Promise.all([cache.load("overflow", async () => Buffer.from("xx")), cache.load("overflow", async () => Buffer.from("xx"))]);
      expect(values).toEqual([Buffer.from("xx"), Buffer.from("xx")]);
      expect(cache.retained).toEqual({ entries: 1, bytes: 2, pending: 2 });
    } finally {
      release.forEach(resolve => resolve(Buffer.alloc(0)));
      await Promise.all(held);
    }
    expect(cache.retained).toEqual({ entries: 2, bytes: 0, pending: 0 });
  });
});
