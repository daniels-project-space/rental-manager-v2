import { describe, expect, it, vi } from "vitest";

vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));

import { getStatsDrawerData, getRentalHeadlineStats } from "./dashboard";
import * as headlineOrder from "./lib/confirmed_headline_order";
import { confirmedForDemandWindow } from "./lib/missed_revenue";

type FilterSet = Record<string, Array<{ op: string; value: unknown }>>;

function makeEmptyContext(reservationRows: any[] = []) {
  const reservationReads: Array<{ index: string; filters: FilterSet }> = [];
  const collectedReads: Array<{ table: string; index: string; filters: FilterSet }> = [];
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
          collectedReads.push({ table, index, filters: structuredClone(filters) });
          if (table === "reservations") reservationReads.push({ index, filters: structuredClone(filters) });
          if (table !== "reservations") return [];
          const matches = reservationRows.filter((row) => Object.entries(filters).every(([field, entries]) =>
            entries.every(({ op, value }) => op === "eq" ? row[field] === value
              : op === "gte" ? row[field] >= (value as any)
              : op === "lte" ? row[field] <= (value as any)
              : op === "gt" ? row[field] > (value as any) : row[field] < (value as any)),
          ));
          const dates = index.includes("pickup_date") ? ["pickup_date", "start_date"]
            : index.includes("return_date") ? ["return_date"]
            : index.includes("end_date") ? ["end_date"] : ["start_date"];
          return matches.sort((a, b) => {
            for (const field of dates) {
              if (a[field] === b[field]) continue;
              if (a[field] === undefined) return -1;
              if (b[field] === undefined) return 1;
              return a[field] < b[field] ? -1 : 1;
            }
            return a._creationTime - b._creationTime;
          });
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
  return { ctx: { db } as any, reservationReads, collectedReads };
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

  it("uses blacklist indexes and avoids scanning the audit history", async () => {
    const { ctx, collectedReads } = makeEmptyContext();

    await (getStatsDrawerData as any)._handler(ctx, {
      accountSlug: null,
      _bypassMv: true,
    });

    const renterIndexes = collectedReads
      .filter(({ table }) => table === "renters")
      .map(({ index }) => index)
      .sort();
    expect(renterIndexes).toEqual(["by_blacklist", "by_blacklisted"]);

    // No reservation in the four-month attribution window has a decision in
    // this fixture, so no historical audit rows should be read at all.
    expect(collectedReads.filter(({ table }) => table === "ai_decision_audit")).toEqual([]);
  });
});

function reservation(
  id: string,
  dates: { start_date: string; pickup_date?: string; end_date: string; return_date?: string },
) {
  return { _id: id, status: "confirmed", ...dates } as any;
}

describe("missed-revenue capacity reservation reads", () => {
  it("uses negotiated dates first and reads source-date fallbacks only when absent", async () => {
    const negotiatedDates = reservation("pickup-return", {
      start_date: "2026-09-10",
      pickup_date: "2026-09-12",
      end_date: "2026-10-10",
      return_date: "2026-10-12",
    });
    const sourceDates = reservation("start-end", {
      start_date: "2026-09-18",
      end_date: "2026-10-04",
    });
    const returnOnly = reservation("return-only", {
      start_date: "2026-08-12",
      pickup_date: "2026-08-14",
      end_date: "2026-10-01",
      return_date: "2026-10-03",
    });
    const endOnly = reservation("end-only", {
      start_date: "2026-08-15",
      end_date: "2026-10-05",
    });

    const reads: Array<{ index: string; filters: FilterSet }> = [];
    const ctx = {
      db: {
        query() {
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
          };
          const query = {
            withIndex(name: string, range?: (q: typeof builder) => unknown) {
              index = name;
              range?.(builder);
              return query;
            },
            async collect() {
              reads.push({ index, filters: structuredClone(filters) });
              if (index === "by_status_pickup_date") {
                return filters.pickup_date?.some(({ op, value }) => op === "eq" && value === undefined)
                  ? [sourceDates]
                  : [negotiatedDates];
              }
              if (index === "by_status_return_date") return [negotiatedDates, returnOnly];
              if (index === "by_status_return_end_date") return [sourceDates, endOnly];
              throw new Error(`Unexpected reservation index: ${index}`);
            },
          };
          return query;
        },
      },
    } as any;

    const rows = await confirmedForDemandWindow(ctx, "2026-09-01", "2026-09-30");

    expect(rows.map((row) => String(row._id)).sort()).toEqual([
      "end-only",
      "pickup-return",
      "return-only",
      "start-end",
    ]);
    expect(reads).toHaveLength(4);
    expect(reads.filter(({ index }) => index === "by_status_pickup_date")).toHaveLength(2);
    expect(reads.find(({ index, filters }) =>
      index === "by_status_pickup_date" &&
      filters.pickup_date?.some(({ op, value }) => op === "eq" && value === undefined),
    )?.filters.start_date).toEqual([
      { op: "gte", value: "2026-09-01" },
      { op: "lte", value: "2026-09-30" },
    ]);
    expect(reads.find(({ index }) => index === "by_status_return_end_date")?.filters)
      .toEqual({
        status: [{ op: "eq", value: "confirmed" }],
        return_date: [{ op: "eq", value: undefined }],
        end_date: [{ op: "gte", value: "2026-09-01" }],
      });
  });
});


describe("actual headline handler reuses confirmed pickup rows", () => {
  it("retains the source pickup query for tied creation times", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    try {
      const context = makeEmptyContext([
        { _id: "later-start", _creationTime: 1, status: "confirmed", account_slug: "dbcinema", start_date: "2026-10-11", end_date: "2026-10-21", pickup_date: "2026-10-12", net_to_owner_gbp: 11.123456789, items: [] },
        { _id: "earlier-start", _creationTime: 1, status: "confirmed", account_slug: "dbcinema", start_date: "2026-10-10", end_date: "2026-10-20", pickup_date: "2026-10-12", net_to_owner_gbp: 22.987654321, items: [] },
      ]);
      await (getRentalHeadlineStats as any)._handler(context.ctx, { accountSlug: "dbcinema" });
      expect(context.reservationReads.filter(({ index, filters }) => index === "by_account_status_pickup_date" &&
        filters.status?.some(({ value }) => value === "confirmed") &&
        filters.pickup_date?.some(({ op, value }) => op === "gte" && value === "2026-07-01"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([null, "dbcinema", "leo", "unknown", ""])("preserves every field for account %s", async (accountSlug) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const rows = [
      { _id: "one", _creationTime: 1, status: "confirmed", account_slug: "dbcinema", start_date: "2026-10-10", end_date: "2026-10-20", pickup_date: "2026-10-11", net_to_owner_gbp: 123.456789, items: [] },
      { _id: "two", _creationTime: 2, status: "confirmed", account_slug: "leo", start_date: "2026-07-01", end_date: "2026-07-02", pickup_date: "2026-07-01", net_to_owner_gbp: 17.123456789, items: [] },
      { _id: "three", _creationTime: 3, status: "confirmed", account_slug: "dbcinema", start_date: "2026-11-01", end_date: "2026-11-02", pickup_date: "2026-10-31", net_to_owner_gbp: 22.987654321, items: [] },
      { _id: "completed", _creationTime: 4, status: "completed", account_slug: "dbcinema", start_date: "2026-10-01", end_date: "2026-10-02", pickup_date: "2026-10-01", net_to_owner_gbp: 31.23456789, items: [] },
      { _id: "missing", _creationTime: 5, status: "confirmed", account_slug: "dbcinema", start_date: "2026-09-01", end_date: "2026-09-02", net_to_owner_gbp: 4.56789, items: [] },
    ];
    const optimized = makeEmptyContext(rows), original = makeEmptyContext(rows);
    let restore: (() => void) | undefined;
    try {
      const actual = await (getRentalHeadlineStats as any)._handler(optimized.ctx, { accountSlug });
      const spy = vi.spyOn(headlineOrder, "confirmedPickupWindow").mockReturnValue(null);
      restore = () => { spy.mockRestore(); };
      const expected = await (getRentalHeadlineStats as any)._handler(original.ctx, { accountSlug });
      expect(actual).toEqual(expected);
      const confirmedPickupReads = (context: typeof optimized) => context.reservationReads.filter(({ index, filters }) =>
        index.includes("pickup_date") && filters.status?.some(({ value }) => value === "confirmed"));
      expect(confirmedPickupReads(original)).toHaveLength(1);
      expect(confirmedPickupReads(optimized)).toHaveLength(0);
    } finally {
      restore?.();
      vi.useRealTimers();
    }
  });
});
