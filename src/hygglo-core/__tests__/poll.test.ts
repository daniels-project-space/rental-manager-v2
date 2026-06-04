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
import { corePoll } from "../poll";
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
