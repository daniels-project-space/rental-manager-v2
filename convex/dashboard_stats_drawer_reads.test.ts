import { describe, expect, it, vi } from "vitest";

vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));

import { getStatsDrawerData } from "./dashboard";

type FilterSet = Record<string, Array<{ op: string; value: unknown }>>;

function makeEmptyContext() {
  const reservationReads: Array<{ index: string; filters: FilterSet }> = [];
  const db = {
    query(table: string) {
      let index = "table_scan";
      const filters: FilterSet = {};
      const builder = {
        eq(field: string, value: unknown) {
          (filters[field] ??= []).push({ op: "eq", value });
          return builder;
        },
        gte(field: string, value: unknown) {
          (filters[field] ??= []).push({ op: "gte", value });
          return builder;
        },
        lte(field: string, value: unknown) {
          (filters[field] ??= []).push({ op: "lte", value });
          return builder;
        },
        lt(field: string, value: unknown) {
          (filters[field] ??= []).push({ op: "lt", value });
          return builder;
        },
        gt(field: string, value: unknown) {
          (filters[field] ??= []).push({ op: "gt", value });
          return builder;
        },
      };
      const query = {
        withIndex(name: string, range?: (q: typeof builder) => unknown) {
          index = name;
          range?.(builder);
          return query;
        },
        withSearchIndex(name: string, range?: (q: typeof builder) => unknown) {
          index = name;
          range?.(builder);
          return query;
        },
        filter() { return query; },
        order() { return query; },
        async collect() {
          if (table === "reservations") reservationReads.push({ index, filters: structuredClone(filters) });
          return [];
        },
        async first() { return null; },
        async unique() { return null; },
        async take() { return []; },
        async paginate() { return { page: [], isDone: true, continueCursor: "" }; },
      };
      return query;
    },
    async get() { return null; },
  };
  return { ctx: { db } as any, reservationReads };
}

describe("getStatsDrawerData reservation read sharing", () => {
  it("uses the monthly confirmed start/pickup reads for active candidates too", async () => {
    const { ctx, reservationReads } = makeEmptyContext();

    await (getStatsDrawerData as any)._handler(ctx, {
      accountSlug: null,
      _bypassMv: true,
    });

    const confirmedStartReads = reservationReads.filter(({ index, filters }) =>
      index === "by_status_start_date" && filters.status?.some((entry) => entry.value === "confirmed"),
    );
    const confirmedPickupReads = reservationReads.filter(({ index, filters }) =>
      index === "by_status_pickup_date" && filters.status?.some((entry) => entry.value === "confirmed"),
    );
    const projectionStart = new Date();
    projectionStart.setDate(1);
    projectionStart.setMonth(projectionStart.getMonth() - 3);
    const projectionStartIso = projectionStart.toISOString().slice(0, 10);
    const confirmedStartProjectionReads = confirmedStartReads.filter(({ filters }) =>
      filters.start_date?.some((entry) => entry.op === "gte" && entry.value === projectionStartIso),
    );
    const confirmedPickupProjectionReads = confirmedPickupReads.filter(({ filters }) =>
      filters.pickup_date?.some((entry) => entry.op === "gte" && entry.value === projectionStartIso),
    );

    expect(confirmedStartProjectionReads).toHaveLength(1);
    expect(confirmedPickupProjectionReads).toHaveLength(1);
    expect(confirmedStartProjectionReads[0].filters.start_date).not.toContainEqual(
      expect.objectContaining({ op: "lte" }),
    );
    expect(confirmedPickupProjectionReads[0].filters.pickup_date).not.toContainEqual(
      expect.objectContaining({ op: "lte" }),
    );
  });
});
