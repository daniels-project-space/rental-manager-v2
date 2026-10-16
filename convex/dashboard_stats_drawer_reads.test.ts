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
  it.each([null, "dbcinema"] as const)("reads each %s reservation once by its effective date", async (accountSlug) => {
    const { ctx, reservationReads } = makeEmptyContext();

    await (getStatsDrawerData as any)._handler(ctx, {
      accountSlug,
      _bypassMv: true,
    });

    const effectiveDateIndex = accountSlug ? "by_account_status_pickup_date" : "by_status_pickup_date";
    const statusReads = (status: string) => reservationReads.filter(({ index, filters }) =>
      index === effectiveDateIndex && filters.status?.some((entry) => entry.value === status),
    );
    const projectionStart = new Date();
    projectionStart.setDate(1);
    projectionStart.setMonth(projectionStart.getMonth() - 3);
    const projectionStartIso = projectionStart.toISOString().slice(0, 10);
    const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0)
      .toISOString().slice(0, 10);
    const confirmedReads = statusReads("confirmed");
    const completedReads = statusReads("completed");
    const confirmedPickupWindow = confirmedReads.filter(({ filters }) =>
      filters.pickup_date?.some((entry) => entry.op === "gte" && entry.value === projectionStartIso),
    );
    const confirmedStartFallback = confirmedReads.filter(({ filters }) =>
      filters.pickup_date?.some((entry) => entry.op === "eq" && entry.value === undefined) &&
      filters.start_date?.some((entry) => entry.op === "gte" && entry.value === projectionStartIso),
    );
    const completedPickupWindow = completedReads.filter(({ filters }) =>
      filters.pickup_date?.some((entry) => entry.op === "gte" && entry.value === projectionStartIso),
    );
    const completedStartFallback = completedReads.filter(({ filters }) =>
      filters.pickup_date?.some((entry) => entry.op === "eq" && entry.value === undefined) &&
      filters.start_date?.some((entry) => entry.op === "gte" && entry.value === projectionStartIso),
    );

    expect(confirmedPickupWindow).toHaveLength(1);
    expect(confirmedStartFallback).toHaveLength(1);
    expect(confirmedPickupWindow[0].filters.pickup_date).not.toContainEqual(
      expect.objectContaining({ op: "lte" }),
    );
    expect(confirmedStartFallback[0].filters.start_date).not.toContainEqual(
      expect.objectContaining({ op: "lte" }),
    );
    expect(completedPickupWindow).toHaveLength(1);
    expect(completedStartFallback).toHaveLength(1);
    expect(completedPickupWindow[0].filters.pickup_date).toContainEqual({ op: "lte", value: monthEnd });
    expect(completedStartFallback[0].filters.start_date).toContainEqual({ op: "lte", value: monthEnd });
  });
});
