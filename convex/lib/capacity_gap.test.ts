/**
 * Unit tests for capacity_gap.ts.
 *
 * Convex unit-test pattern: pure-helper tests with hand-crafted Doc-like
 * objects. We never spin up the in-memory Convex server here — the helpers
 * we test are pure or accept a stub ctx.
 */

import { describe, it, expect } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import {
  buildCommitmentMap,
  diagnoseDenialCapacity,
  isCompletedCommitting,
  type CommitmentMap,
} from "./capacity_gap";

const itemA = "items:a" as Id<"items">;
const itemB = "items:b" as Id<"items">;
const itemMarketing = "items:m" as Id<"items">;

function res(
  o: Partial<Omit<Doc<"reservations">, "_id">> & { _id?: string },
): Doc<"reservations"> {
  const { _id, ...rest } = o;
  return {
    _id: (_id ?? "reservations:test") as unknown as Id<"reservations">,
    _creationTime: 1700000000000,
    status: rest.status ?? "confirmed",
    created_at: 1700000000000,
    ...rest,
  } as Doc<"reservations">;
}

function stubCtxWith(items: Record<string, Partial<Doc<"items">>>) {
  return {
    db: {
      get: async (id: Id<"items">) => {
        const it = items[String(id)];
        if (!it) return null;
        return {
          _id: id,
          _creationTime: 0,
          name_canonical: it.name_canonical ?? "Unknown",
          name_input: "",
          slug: "x",
          kind: "camera",
          qty: it.qty ?? 1,
          unit_kind: "unit",
          is_marketing_only: it.is_marketing_only ?? false,
          status: "active",
          created_at: 0,
          updated_at: 0,
        };
      },
    },
  } as any;
}

describe("buildCommitmentMap", () => {
  it("tallies qty per item per date for completed rentals", () => {
    const completed = [
      res({
        _id: "reservations:r1",
        start_date: "2026-05-10",
        end_date: "2026-05-12",
        expanded_items: [
          { item_id: itemA, item_name_canonical: "A", qty: 1 },
          { item_id: itemB, item_name_canonical: "B", qty: 2 },
        ],
      }),
    ];
    const map = buildCommitmentMap(completed);
    expect(map.get(`${itemA}|2026-05-10`)).toBe(1);
    expect(map.get(`${itemA}|2026-05-12`)).toBe(1);
    expect(map.get(`${itemB}|2026-05-11`)).toBe(2);
  });

  it("falls back to resolved_items when expanded_items missing", () => {
    const completed = [
      res({
        _id: "reservations:r2",
        start_date: "2026-05-10",
        end_date: "2026-05-10",
        resolved_items: [
          { item_id: itemA, item_name_canonical: "A", confidence: 1, qty: 1 },
        ],
      }),
    ];
    const map = buildCommitmentMap(completed);
    expect(map.get(`${itemA}|2026-05-10`)).toBe(1);
  });
});

describe("diagnoseDenialCapacity", () => {
  it("classifies a fully-booked denied rental as capacity_gap", async () => {
    const map: CommitmentMap = new Map([
      [`${itemA}|2026-06-01`, 1],
      [`${itemA}|2026-06-02`, 1],
    ]);
    const ctx = stubCtxWith({
      [String(itemA)]: { qty: 1, name_canonical: "FX3", is_marketing_only: false },
    });
    const denial = res({
      _id: "reservations:d1",
      status: "cancelled",
      start_date: "2026-06-01",
      end_date: "2026-06-02",
      duration_days: 2,
      gross_paid_gbp: 200,
      expanded_items: [{ item_id: itemA, item_name_canonical: "FX3", qty: 1 }],
    });
    const out = await diagnoseDenialCapacity(ctx, denial, map, new Map());
    expect(out.cause).toBe("capacity");
    expect(out.estimated_loss_gbp).toBe(200);
    expect(out.per_item_diagnosis[0].classification).toBe("capacity_gap");
  });

  it("classifies a denial with spare capacity as voluntary", async () => {
    const map: CommitmentMap = new Map();
    const ctx = stubCtxWith({
      [String(itemA)]: { qty: 3, name_canonical: "FX3", is_marketing_only: false },
    });
    const denial = res({
      _id: "reservations:d2",
      status: "cancelled",
      start_date: "2026-06-10",
      end_date: "2026-06-11",
      expanded_items: [{ item_id: itemA, item_name_canonical: "FX3", qty: 1 }],
    });
    const out = await diagnoseDenialCapacity(ctx, denial, map, new Map());
    expect(out.cause).toBe("voluntary");
    expect(out.per_item_diagnosis[0].classification).toBe("voluntary");
  });

  it("classifies marketing-only items as marketing_only", async () => {
    const map: CommitmentMap = new Map();
    const ctx = stubCtxWith({
      [String(itemMarketing)]: {
        qty: 0,
        name_canonical: "ARRI Alexa",
        is_marketing_only: true,
      },
    });
    const denial = res({
      _id: "reservations:d3",
      status: "cancelled",
      start_date: "2026-06-15",
      end_date: "2026-06-15",
      expanded_items: [
        { item_id: itemMarketing, item_name_canonical: "ARRI Alexa", qty: 1 },
      ],
    });
    const out = await diagnoseDenialCapacity(ctx, denial, map, new Map());
    expect(out.cause).toBe("marketing_only");
    expect(out.per_item_diagnosis[0].classification).toBe("marketing_only");
  });

  it("classifies mixed (capacity + voluntary) as mixed", async () => {
    const map: CommitmentMap = new Map([
      [`${itemA}|2026-06-20`, 1],
    ]);
    const ctx = stubCtxWith({
      [String(itemA)]: { qty: 1, name_canonical: "A", is_marketing_only: false },
      [String(itemB)]: { qty: 5, name_canonical: "B", is_marketing_only: false },
    });
    const denial = res({
      _id: "reservations:d4",
      status: "cancelled",
      start_date: "2026-06-20",
      end_date: "2026-06-20",
      expanded_items: [
        { item_id: itemA, item_name_canonical: "A", qty: 1 },
        { item_id: itemB, item_name_canonical: "B", qty: 1 },
      ],
    });
    const out = await diagnoseDenialCapacity(ctx, denial, map, new Map());
    expect(out.cause).toBe("mixed");
  });

  it("returns unknown for rentals with no dates", async () => {
    const ctx = stubCtxWith({});
    const out = await diagnoseDenialCapacity(
      ctx,
      res({ _id: "reservations:d5" }),
      new Map(),
      new Map(),
    );
    expect(out.cause).toBe("unknown");
  });

  it("falls back to pricing catalog for £ estimate", async () => {
    const ctx = stubCtxWith({
      [String(itemA)]: { qty: 1, name_canonical: "FX3", is_marketing_only: false },
    });
    const denial = res({
      _id: "reservations:d6",
      status: "cancelled",
      start_date: "2026-07-01",
      end_date: "2026-07-03",
      duration_days: 3,
      items: [{ item_name: "FX3" }],
      expanded_items: [{ item_id: itemA, item_name_canonical: "FX3", qty: 1 }],
    });
    const out = await diagnoseDenialCapacity(
      ctx,
      denial,
      new Map(),
      new Map([["FX3", 80]]),
    );
    expect(out.estimated_loss_gbp).toBe(240);
  });
});

describe("isCompletedCommitting", () => {
  it("accepts confirmed + completed, rejects cancelled and obsolete", () => {
    expect(isCompletedCommitting(res({ status: "confirmed" }))).toBe(true);
    expect(isCompletedCommitting(res({ status: "completed" }))).toBe(true);
    expect(isCompletedCommitting(res({ status: "cancelled" }))).toBe(false);
    expect(
      isCompletedCommitting(res({ status: "confirmed", is_obsolete: true })),
    ).toBe(false);
  });
});
