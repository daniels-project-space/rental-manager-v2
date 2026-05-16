/**
 * HydrationLayer unit tests (Wave 1).
 *
 * Covers:
 *   - T1 module cache: dedupes, expires, invalidates.
 *   - T2 DataLoader: coalesces concurrent getByIds calls into one batch.
 *   - T2 memoize: returns shared promise for identical fnRef + args.
 *   - T3 fallback: R2 throw → MV → live; envelope caveats reflect chain.
 *   - Lineage envelope: source/tier/fetchedAt populated per tier.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createHydrationLayer,
  type HydrationConvexClient,
  type R2IndexLoader,
  __resetT1CacheForTests,
} from "./hydration";

function makeConvex(callMap: Record<string, unknown>) {
  let calls = 0;
  const fnCalls: Record<string, number> = {};
  const client: HydrationConvexClient = {
    async query(fnRef: unknown, _args?: Record<string, unknown>) {
      calls++;
      // Extract identifier from fnRef ({ functionPath } or sentinel string)
      let key = "";
      if (fnRef && typeof fnRef === "object") {
        const obj = fnRef as Record<string, unknown>;
        key =
          (typeof obj.functionPath === "string" && obj.functionPath) ||
          (typeof obj._tag === "string" && obj._tag) ||
          "";
      }
      if (typeof fnRef === "string") key = fnRef;
      fnCalls[key] = (fnCalls[key] ?? 0) + 1;
      return callMap[key] ?? null;
    },
  };
  return {
    client,
    get calls() {
      return calls;
    },
    callsFor(key: string) {
      return fnCalls[key] ?? 0;
    },
  };
}

beforeEach(() => {
  __resetT1CacheForTests();
});

describe("hydration T1 static cache", () => {
  it("dedupes 10x getAll() within one instance to a single convex call", async () => {
    const itemsFetcher = { functionPath: "items.listActive" };
    const fakeRows = [{ _id: "i1" }, { _id: "i2" }];
    const cx = makeConvex({ "items.listActive": fakeRows });
    const hydrate = createHydrationLayer({
      convex: cx.client,
      staticFetchers: {
        items: itemsFetcher,
        pricing_catalog: { functionPath: "pricing_catalog.list" },
        bundles: { functionPath: "bundles.list" },
        bundle_items: { functionPath: "bundle_items.list" },
      },
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => hydrate.items.getAll()),
    );
    expect(results).toHaveLength(10);
    expect(cx.callsFor("items.listActive")).toBe(1);
    for (const r of results) {
      expect(r.data).toEqual(fakeRows);
      expect(r.meta.source.tier).toBe(1);
      expect(r.meta.source.label).toBe("t1.static");
      expect(r.meta.source.table).toBe("items");
      expect(typeof r.meta.source.fetchedAt).toBe("number");
    }
    // First call is uncached; subsequent reads hit cache.
    expect(results[0].meta.source.cached).toBe(false);
    expect(results[9].meta.source.cached).toBe(true);
  });

  it("re-fetches after T1 TTL expiry (5 min)", async () => {
    let clock = 1_000_000;
    const cx = makeConvex({ "items.listActive": [{ _id: "a" }] });
    const hydrate = createHydrationLayer({
      convex: cx.client,
      now: () => clock,
      staticFetchers: {
        items: { functionPath: "items.listActive" },
        pricing_catalog: { functionPath: "pricing_catalog.list" },
        bundles: { functionPath: "bundles.list" },
        bundle_items: { functionPath: "bundle_items.list" },
      },
    });
    await hydrate.items.getAll();
    await hydrate.items.getAll();
    expect(cx.callsFor("items.listActive")).toBe(1);
    // Advance past TTL (5 min + 1 ms).
    clock += 5 * 60_000 + 1;
    await hydrate.items.getAll();
    expect(cx.callsFor("items.listActive")).toBe(2);
  });

  it("invalidate('items') busts the cache", async () => {
    const cx = makeConvex({ "items.listActive": [] });
    const hydrate = createHydrationLayer({
      convex: cx.client,
      staticFetchers: {
        items: { functionPath: "items.listActive" },
        pricing_catalog: { functionPath: "pricing_catalog.list" },
        bundles: { functionPath: "bundles.list" },
        bundle_items: { functionPath: "bundle_items.list" },
      },
    });
    await hydrate.items.getAll();
    await hydrate.items.getAll();
    expect(cx.callsFor("items.listActive")).toBe(1);
    hydrate.invalidate("items");
    await hydrate.items.getAll();
    expect(cx.callsFor("items.listActive")).toBe(2);
  });
});

describe("hydration T2 DataLoader batching", () => {
  it("coalesces concurrent getByIds calls into a single batched fetch", async () => {
    const fetchCalls: string[][] = [];
    const fetcher = async (ids: string[]) => {
      fetchCalls.push([...ids]);
      return ids.map((id) => ({ _id: id, name: `renter-${id}` }));
    };
    const cx = makeConvex({});
    const hydrate = createHydrationLayer({
      convex: cx.client,
      entityFetchers: { renters: fetcher },
    });
    const [ab, bc] = await Promise.all([
      hydrate.renters.getByIds(["a", "b"]),
      hydrate.renters.getByIds(["b", "c"]),
    ]);
    // Exactly one underlying batch, deduped to {a,b,c}.
    expect(fetchCalls).toHaveLength(1);
    expect(new Set(fetchCalls[0])).toEqual(new Set(["a", "b", "c"]));
    // Each caller gets correct subset, in requested order.
    expect(ab.data.map((r) => r._id)).toEqual(["a", "b"]);
    expect(bc.data.map((r) => r._id)).toEqual(["b", "c"]);
    expect(ab.meta.source.tier).toBe(2);
    expect(ab.meta.source.label).toBe("t2.batch");
  });

  it("respects batchLimit by chunking", async () => {
    const fetchCalls: number[] = [];
    const fetcher = async (ids: string[]) => {
      fetchCalls.push(ids.length);
      return ids.map((id) => ({ _id: id }));
    };
    const cx = makeConvex({});
    const hydrate = createHydrationLayer({
      convex: cx.client,
      batchLimit: 2,
      entityFetchers: { renters: fetcher },
    });
    const ids = ["a", "b", "c", "d", "e"];
    const res = await hydrate.renters.getByIds(ids);
    expect(res.data).toHaveLength(5);
    expect(fetchCalls).toEqual([2, 2, 1]);
  });
});

describe("hydration T2 memoize", () => {
  it("returns a shared promise for identical fnRef + args", async () => {
    let runCount = 0;
    const runner = async () => {
      runCount++;
      return { foo: "bar" };
    };
    const cx = makeConvex({});
    const hydrate = createHydrationLayer({ convex: cx.client });
    const fn = { functionPath: "demo.query" };
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        hydrate.memoQuery(fn, { a: 1 }, runner),
      ),
    );
    expect(runCount).toBe(1);
    for (const r of results) {
      expect(r.data).toEqual({ foo: "bar" });
      expect(r.meta.source.tier).toBe(2);
    }
    // Different args → not memoized.
    await hydrate.memoQuery(fn, { a: 2 }, runner);
    expect(runCount).toBe(2);
  });
});

describe("hydration T3 fallback chain", () => {
  it("falls through R2→MV→live when R2 throws, surfaces r2_unavailable caveat", async () => {
    const r2Loader: R2IndexLoader = vi.fn(async () => {
      throw new Error("simulated r2 outage");
    });
    const mvLoader = vi.fn(async () => null);
    const liveLoader = vi.fn(async () => ({ rows: ["live-data"] }));
    const cx = makeConvex({});
    const hydrate = createHydrationLayer({
      convex: cx.client,
      r2Loader,
      mvLoader,
      liveLoader,
    });
    const res = await hydrate.loadSnapshot("by_item");
    expect(r2Loader).toHaveBeenCalledTimes(1);
    expect(mvLoader).toHaveBeenCalledTimes(1);
    expect(liveLoader).toHaveBeenCalledTimes(1);
    expect(res.data).toEqual({ rows: ["live-data"] });
    expect(res.meta.source.tier).toBe(3);
    expect(res.meta.source.label).toBe("convex.live");
    expect(res.meta.caveats).toContain("r2_unavailable");
    expect(res.meta.fallbackChain).toEqual([
      "t3.r2-snapshot",
      "t3.r2-then-mv",
      "convex.live",
    ]);
  });

  it("returns R2 data directly when snapshot available (no fallback)", async () => {
    const snapshot = { totals: { revenue: 12345 } };
    const r2Loader: R2IndexLoader = vi.fn(async () => snapshot);
    const mvLoader = vi.fn(async () => null);
    const liveLoader = vi.fn(async () => null);
    const cx = makeConvex({});
    const hydrate = createHydrationLayer({
      convex: cx.client,
      r2Loader,
      mvLoader,
      liveLoader,
    });
    const res = await hydrate.loadSnapshot("totals");
    expect(r2Loader).toHaveBeenCalledTimes(1);
    expect(mvLoader).not.toHaveBeenCalled();
    expect(liveLoader).not.toHaveBeenCalled();
    expect(res.data).toEqual(snapshot);
    expect(res.meta.source.tier).toBe(3);
    expect(res.meta.source.label).toBe("t3.r2-snapshot");
    expect(res.meta.caveats).not.toContain("r2_unavailable");
  });
});

describe("hydration lineage envelope", () => {
  it("populates _source / meta on all three tiers", async () => {
    const cx = makeConvex({ "items.listActive": [{ _id: "x" }] });
    const r2Loader: R2IndexLoader = async () => ({ ok: true });
    const hydrate = createHydrationLayer({
      convex: cx.client,
      r2Loader,
      staticFetchers: {
        items: { functionPath: "items.listActive" },
        pricing_catalog: { functionPath: "pricing_catalog.list" },
        bundles: { functionPath: "bundles.list" },
        bundle_items: { functionPath: "bundle_items.list" },
      },
      entityFetchers: {
        renters: async (ids) => ids.map((id) => ({ _id: id })),
      },
    });
    const t1 = await hydrate.items.getAll();
    const t2 = await hydrate.renters.getByIds(["r1"]);
    const t3 = await hydrate.loadSnapshot("by_item");
    expect(t1.meta.source.tier).toBe(1);
    expect(t1.meta.source.fetchedAt).toBeGreaterThan(0);
    expect(t2.meta.source.tier).toBe(2);
    expect(t2.meta.source.fetchedAt).toBeGreaterThan(0);
    expect(t3.meta.source.tier).toBe(3);
    expect(t3.meta.source.fetchedAt).toBeGreaterThan(0);
  });
});
