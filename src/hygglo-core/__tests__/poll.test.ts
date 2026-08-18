/**
 * corePoll assembler tests — drive the pure poll loop with an injected mock
 * HyggloCore (no live fetch). Covers the Phase-2 cleanup fixes:
 *
 *   B2 — `detail_payload` is ALWAYS populated (full order blob) so the listing
 *        resolver's `hygglo_detail_payload` is non-empty on the non-denial hot
 *        path (where `order` is intentionally stripped).
 *   B3 — `order_step_extracted` is ALWAYS defined on rows whose order carries a
 *        recognised active step (never silently dropped to undefined).
 *   B4 — per-filter `listOrders` and per-order `getOrder` failures are counted
 *        and surfaced in `meta` instead of being swallowed by a bare catch.
 *
 * The mock satisfies only the methods corePoll touches (`account`, `listOrders`,
 * `getOrder`); the rest of HyggloCore is cast away.
 */
import { describe, it, expect, vi } from "vitest";
import {
  activityStampUnchanged,
  corePoll,
  parseLatestActivityMs,
  selectOperationalMessages,
  selectOperationalOrders,
  type StoredActivityEntry,
} from "../poll";
import type { HyggloCore } from "../index";
import type {
  HyggloOrderDetail,
  HyggloOrderFilter,
  OrderWithFilter,
} from "../types";

/** A minimal confirmed order detail with a recognised active step (DELIVERED). */
function makeOrderDetail(
  id: number,
  activeStep = "DELIVERED",
): HyggloOrderDetail {
  return {
    id,
    rentalPeriod: {
      startDateUTC: "2026-05-30T00:00:00Z",
      endDateUTC: "2026-06-01T00:00:00Z",
    },
    users: { otherPart: { id: 999, name: "Test Renter" } },
    price: {
      currency: "GBP",
      breakdown: {
        totalPrice: { amount: 100 },
        lenderEarnings: { amount: 64 },
      },
    },
    items: [{ name: "Widget", type: "PRODUCT", productId: 42 }],
    steps: [
      { key: "REQUEST", active: false, completed: true },
      { key: activeStep, active: true },
    ],
    activities: [],
  };
}

/**
 * Build a mock HyggloCore.
 * @param ordersByFilter map of filter → list items returned by listOrders
 * @param details        map of order id → detail (or an Error to throw)
 * @param listThrows     set of filters whose listOrders should throw
 */
function makeMockCore(opts: {
  ordersByFilter: Partial<Record<HyggloOrderFilter, OrderWithFilter[]>>;
  details: Record<number, HyggloOrderDetail | Error>;
  listThrows?: Set<HyggloOrderFilter>;
}): HyggloCore {
  const { ordersByFilter, details, listThrows } = opts;
  const mock = {
    account: { slug: "test-account", country: "GB" },
    listOrders: vi.fn(async (filter: HyggloOrderFilter) => {
      if (listThrows?.has(filter)) throw new Error(`list boom: ${filter}`);
      return ordersByFilter[filter] ?? [];
    }),
    getOrder: vi.fn(async (id: number | string) => {
      const d = details[Number(id)];
      if (d instanceof Error) throw d;
      if (!d) throw new Error(`no detail for ${id}`);
      return d;
    }),
  };
  return mock as unknown as HyggloCore;
}

describe("corePoll — B3: order_step_extracted always defined on active-step rows", () => {
  it("sets order_step_extracted for every recognised active step", async () => {
    const core = makeMockCore({
      ordersByFilter: {
        current: [{ id: 1, sourceFilter: "current" }],
      },
      details: { 1: makeOrderDetail(1, "DELIVERED") },
    });

    const result = await corePoll("test-account", { core, fetchedAt: 1 });

    expect(result.reservations).toHaveLength(1);
    const row = result.reservations[0];
    // The active step IS recognised → the field must be defined, never dropped.
    expect(row.order_step_extracted).toBeDefined();
    expect(row.order_step_extracted).toBe("DELIVERED");
  });

  it("covers all 10 recognised step keys (each yields a defined step)", async () => {
    const keys = [
      "REQUEST",
      "APPROVED",
      "FUNDS_RESERVED",
      "VERIFIED",
      "BOOKED_AFTER_VERIFIED",
      "DELIVERED",
      "RETURNED",
      "REVIEWED",
      "CANCELED",
      "VERIFICATION_FAILED",
    ];
    for (const key of keys) {
      const core = makeMockCore({
        ordersByFilter: { current: [{ id: 1, sourceFilter: "current" }] },
        details: { 1: makeOrderDetail(1, key) },
      });
      const result = await corePoll("test-account", { core, fetchedAt: 1 });
      expect(result.reservations[0].order_step_extracted).toBe(key);
    }
  });
});

describe("corePoll — B2: detail_payload always carries the full order blob", () => {
  it("populates detail_payload even on the non-denial hot path (order stripped)", async () => {
    const detail = makeOrderDetail(2, "DELIVERED"); // 'approved'/none signal → non-denial
    const core = makeMockCore({
      ordersByFilter: { current: [{ id: 2, sourceFilter: "current" }] },
      details: { 2: detail },
    });

    const result = await corePoll("test-account", { core, fetchedAt: 1 });
    const row = result.reservations[0];

    // detail_payload is the FULL order, regardless of the bandwidth-stripped `order`.
    expect(row.detail_payload).toBeDefined();
    expect(row.detail_payload?.id).toBe(2);
    // On a non-denial row, `order` is omitted (bandwidth) — so detail_payload is
    // the ONLY carrier of the blob for the listing resolver.
    expect(row.order).toBeUndefined();
  });
});

describe("corePoll — B4: fetch failures are counted, not swallowed", () => {
  it("counts a thrown listOrders(filter) in meta.list_filter_errors", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const core = makeMockCore({
      ordersByFilter: { current: [{ id: 1, sourceFilter: "current" }] },
      details: { 1: makeOrderDetail(1) },
      listThrows: new Set<HyggloOrderFilter>(["obsolete"]),
    });

    const result = await corePoll("test-account", { core, fetchedAt: 1 });

    expect(result.meta.list_filter_errors).toBe(1);
    expect(errSpy).toHaveBeenCalled(); // logged, not silent
    errSpy.mockRestore();
  });

  it("counts a thrown getOrder(id) in meta.detail_fetch_errors and skips that row", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const core = makeMockCore({
      ordersByFilter: {
        current: [
          { id: 1, sourceFilter: "current" },
          { id: 2, sourceFilter: "current" },
        ],
      },
      details: {
        1: makeOrderDetail(1),
        2: new Error("detail boom"),
      },
    });

    const result = await corePoll("test-account", { core, fetchedAt: 1 });

    expect(result.meta.detail_fetch_errors).toBe(1);
    expect(result.reservations).toHaveLength(1); // the bad order is skipped
    expect(result.reservations[0].hygglo_order_id).toBe("1");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("reports zero errors on a clean cycle", async () => {
    const core = makeMockCore({
      ordersByFilter: { current: [{ id: 1, sourceFilter: "current" }] },
      details: { 1: makeOrderDetail(1) },
    });
    const result = await corePoll("test-account", { core, fetchedAt: 1 });
    expect(result.meta.list_filter_errors).toBe(0);
    expect(result.meta.detail_fetch_errors).toBe(0);
  });
});

describe("corePoll — bounded operational refresh", () => {
  const now = Date.parse("2026-08-05T12:00:00Z");

  it("normalises real Hygglo activity formats", () => {
    expect(parseLatestActivityMs(now)).toBe(now);
    expect(parseLatestActivityMs(now / 1000)).toBe(now);
    expect(parseLatestActivityMs("2026-08-05T11:58:00Z")).toBe(Date.parse("2026-08-05T11:58:00Z"));
    expect(parseLatestActivityMs("not-a-date")).toBeNull();
  });

  it("keeps fresh replies, excludes old rows, and bounds missing-timestamp fallbacks", () => {
    const selected = selectOperationalOrders([
      { id: 1, sourceFilter: "pending", latest_activity: "2026-08-05T11:59:00Z" },
      { id: 2, sourceFilter: "current", latest_activity: now / 1000 },
      { id: 3, sourceFilter: "future", latest_activity: "2026-07-20T00:00:00Z" },
      { id: 4, sourceFilter: "obsolete" },
      { id: 5, sourceFilter: "obsolete", latest_activity: "unknown" },
      { id: 6, sourceFilter: "obsolete" },
    ], now);
    expect(selected.map((order) => order.id)).toEqual([1, 2, 4, 5]);
  });

  it("does not let one busy order bucket starve replies in another bucket", () => {
    const recent = "2026-08-05T11:59:00Z";
    const pending = Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      sourceFilter: "pending",
      latest_activity: recent,
    }));
    const selected = selectOperationalOrders([
      ...pending,
      { id: 101, sourceFilter: "current", latest_activity: recent },
      { id: 102, sourceFilter: "future", latest_activity: recent },
      { id: 103, sourceFilter: "obsolete", latest_activity: recent },
    ], now, undefined, 8);
    expect(selected.map((order) => order.id)).toEqual([1, 101, 102, 103, 2, 3, 4, 5]);
  });

  it("uploads only the newest messages per hot order to bound Convex reads", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      thread_id: "4116374",
      message_id: String(index),
      sender: index % 2 ? "owner" : "renter",
      body_text: `message ${index}`,
      hygglo_sent_at: index,
      fetched_at: now,
    }));
    const selected = selectOperationalMessages(messages);
    expect(selected).toHaveLength(8);
    expect(selected.map((message) => message.message_id)).toEqual([
      "19", "18", "17", "16", "15", "14", "13", "12",
    ]);
  });

  it("fetches only selected order details while preserving all four list reads", async () => {
    const recent = "2026-08-05T11:59:00Z";
    const core = makeMockCore({
      ordersByFilter: {
        pending: [
          { id: 1, sourceFilter: "pending", latest_activity: recent },
          { id: 2, sourceFilter: "pending", latest_activity: "2026-07-01T00:00:00Z" },
        ],
        current: [{ id: 3, sourceFilter: "current", latest_activity: recent }],
      },
      details: {
        1: makeOrderDetail(1, "REQUEST"),
        2: makeOrderDetail(2),
        3: makeOrderDetail(3, "BOOKED_AFTER_VERIFIED"),
      },
    });

    const result = await corePoll("test-account", {
      core,
      fetchedAt: now,
      mode: "operational",
    });

    expect(core.listOrders).toHaveBeenCalledTimes(4);
    expect(core.getOrder).toHaveBeenCalledTimes(2);
    expect(core.getOrder).toHaveBeenCalledWith(1);
    expect(core.getOrder).toHaveBeenCalledWith(3);
    expect(result.meta).toMatchObject({ mode: "operational", orders_listed: 3, orders_selected: 2 });
    expect(result.reservations.map((row) => row.hygglo_order_id)).toEqual(["1", "3"]);
  });
});

describe("activityStampUnchanged — Phase 18.2 skip-fetch guard", () => {
  it("treats equivalent timestamps in different formats as unchanged", () => {
    const ms = Date.parse("2026-08-05T12:00:00Z");
    expect(activityStampUnchanged(ms, ms)).toBe(true);
    expect(activityStampUnchanged(ms, ms / 1000)).toBe(true);
    expect(activityStampUnchanged(ms, "2026-08-05T12:00:00Z")).toBe(true);
    expect(activityStampUnchanged("2026-08-05T12:00:00Z", ms / 1000)).toBe(true);
  });

  it("detects a real change regardless of format", () => {
    const t1 = Date.parse("2026-08-05T12:00:00Z");
    const t2 = Date.parse("2026-08-05T12:05:00Z");
    expect(activityStampUnchanged(t1, t2)).toBe(false);
    expect(activityStampUnchanged(t1, "2026-08-05T12:05:00Z")).toBe(false);
  });

  it("never skips when either side is missing", () => {
    expect(activityStampUnchanged(undefined, 123)).toBe(false);
    expect(activityStampUnchanged(123, undefined)).toBe(false);
    expect(activityStampUnchanged(undefined, undefined)).toBe(false);
  });

  it("falls back to exact raw equality when a value doesn't parse as a timestamp", () => {
    // Neither "opaque-token" nor "" is a Date.parse-able string; only an exact
    // raw match counts as unchanged — anything else must fetch.
    expect(activityStampUnchanged("opaque-token", "opaque-token")).toBe(true);
    expect(activityStampUnchanged("opaque-token", "different-token")).toBe(false);
  });
});

describe("corePoll — Phase 18.2 skip-fetch optimisation", () => {
  it("skips the detail GET for an order whose stamp is unchanged and has order_step", async () => {
    const core = makeMockCore({
      ordersByFilter: {
        current: [
          { id: 1, sourceFilter: "current", latest_activity: 1000 },
          { id: 2, sourceFilter: "current", latest_activity: 2000 },
        ],
      },
      details: {
        // Order 1 must NOT be fetched — if the mock were called for id 1 with
        // no matching detail, the test would throw "no detail for 1".
        2: makeOrderDetail(2),
      },
    });
    const storedActivity: Record<string, StoredActivityEntry> = {
      "1": { latest_activity: 1000, has_order_step: true },
      "2": { latest_activity: 9999, has_order_step: true }, // stale → must fetch
    };
    const getStoredActivity = vi.fn(async (ids: string[]) => {
      const out: Record<string, StoredActivityEntry> = {};
      for (const id of ids) if (storedActivity[id]) out[id] = storedActivity[id];
      return out;
    });

    const result = await corePoll("test-account", {
      core,
      fetchedAt: 1,
      getStoredActivity,
    });

    expect(getStoredActivity).toHaveBeenCalledWith(["1", "2"]);
    expect(core.getOrder).toHaveBeenCalledTimes(1);
    expect(core.getOrder).toHaveBeenCalledWith(2);
    expect(core.getOrder).not.toHaveBeenCalledWith(1);
    expect(result.reservations.map((r) => r.hygglo_order_id)).toEqual(["2"]);
    expect(result.meta.orders_skipped_unchanged).toBe(1);
    // Skipped order 1 is still confirmed present for hygglo_presence / Return
    // Hub, even though it produced no reservation row this cycle.
    expect(result.presentOrderIds).toEqual(
      expect.arrayContaining([
        { id: "1", sourceFilter: "current" },
        { id: "2", sourceFilter: "current" },
      ]),
    );
    expect(result.presentOrderIds).toHaveLength(2);
  });

  it("fetches (never skips) a legacy row with no order_step yet, even if the stamp matches", async () => {
    const core = makeMockCore({
      ordersByFilter: { current: [{ id: 1, sourceFilter: "current", latest_activity: 1000 }] },
      details: { 1: makeOrderDetail(1) },
    });
    const getStoredActivity = vi.fn(async () => ({
      "1": { latest_activity: 1000, has_order_step: false } as StoredActivityEntry,
    }));

    const result = await corePoll("test-account", { core, fetchedAt: 1, getStoredActivity });

    expect(core.getOrder).toHaveBeenCalledWith(1);
    expect(result.meta.orders_skipped_unchanged).toBe(0);
    expect(result.reservations).toHaveLength(1);
  });

  it("fetches (never skips) when the list-endpoint order carries no latest_activity", async () => {
    const core = makeMockCore({
      ordersByFilter: { current: [{ id: 1, sourceFilter: "current" }] }, // no latest_activity
      details: { 1: makeOrderDetail(1) },
    });
    const getStoredActivity = vi.fn(async () => ({
      "1": { latest_activity: 1000, has_order_step: true } as StoredActivityEntry,
    }));

    const result = await corePoll("test-account", { core, fetchedAt: 1, getStoredActivity });

    expect(core.getOrder).toHaveBeenCalledWith(1);
    expect(result.meta.orders_skipped_unchanged).toBe(0);
  });

  it("degrades to fetching everything when the batched lookup itself fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const core = makeMockCore({
      ordersByFilter: { current: [{ id: 1, sourceFilter: "current", latest_activity: 1000 }] },
      details: { 1: makeOrderDetail(1) },
    });
    const getStoredActivity = vi.fn(async () => {
      throw new Error("convex unavailable");
    });

    const result = await corePoll("test-account", { core, fetchedAt: 1, getStoredActivity });

    expect(core.getOrder).toHaveBeenCalledWith(1);
    expect(result.meta.orders_skipped_unchanged).toBe(0);
    expect(result.reservations).toHaveLength(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("never skips when getStoredActivity is omitted (default behaviour unchanged)", async () => {
    const core = makeMockCore({
      ordersByFilter: { current: [{ id: 1, sourceFilter: "current", latest_activity: 1000 }] },
      details: { 1: makeOrderDetail(1) },
    });

    const result = await corePoll("test-account", { core, fetchedAt: 1 });

    expect(core.getOrder).toHaveBeenCalledWith(1);
    expect(result.meta.orders_skipped_unchanged).toBe(0);
    expect(result.presentOrderIds).toEqual([{ id: "1", sourceFilter: "current" }]);
  });
});
