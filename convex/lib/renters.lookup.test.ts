import { describe, expect, it, vi } from "vitest";
import { renterForReservation, renterMapsForReservations } from "./renters";

type FixtureRenter = {
  _id: string;
  display_name: string;
  hygglo_user_id?: string;
  total_rentals_count?: number;
  [key: string]: unknown;
};

function fixture(rows: {
  byId?: Record<string, FixtureRenter>;
  byHuid?: Record<string, FixtureRenter[]>;
  byName?: Record<string, FixtureRenter[]>;
  all?: FixtureRenter[];
} = {}) {
  const idReads: string[] = [];
  const indexReads: Array<{ index: string; field: string; value: string }> = [];
  let fullCollects = 0;
  const db = {
    get: vi.fn(async (id: string) => {
      idReads.push(id);
      return rows.byId?.[id] ?? null;
    }),
    query: vi.fn((table: string) => ({
      withIndex: (index: string, build: (q: { eq: (field: string, value: string) => typeof q }) => unknown) => {
        let field = "";
        let value = "";
        const q = { eq: (nextField: string, nextValue: string) => { field = nextField; value = nextValue; return q; } };
        build(q);
        indexReads.push({ index, field, value });
        const values = index === "by_hygglo_user_id"
          ? rows.byHuid?.[value] ?? []
          : rows.byName?.[value] ?? [];
        return { collect: async () => values, first: async () => values[0] ?? null };
      },
      collect: async () => {
        fullCollects++;
        return table === "renters" ? rows.all ?? [] : [];
      },
    })),
  };
  return { ctx: { db } as any, idReads, indexReads, fullCollects: () => fullCollects };
}

const renter = (id: string, display_name: string, extras: Partial<FixtureRenter> = {}) => ({
  _id: id,
  display_name,
  ...extras,
}) as any;

describe("renterMapsForReservations", () => {
  it("uses direct renter IDs without scanning renters or redundantly reading their HUID index", async () => {
    const direct = renter("renter-doc", "Alice Example", { hygglo_user_id: "huid-1" });
    const f = fixture({ byId: { "renter-doc": direct } });
    const maps = await renterMapsForReservations(f.ctx, [
      { renter_id: "renter-doc", hygglo_user_id: "huid-1", renter_name: "Alice Example" },
    ]);

    expect(maps.byId.get("renter-doc")).toBe(direct);
    expect(maps.byName.get("alice example")).toBe(direct);
    expect(f.idReads).toEqual(["renter-doc"]);
    expect(f.indexReads).toEqual([]);
    expect(f.fullCollects()).toBe(0);
  });

  it("resolves legacy renter IDs through the indexed HUID path", async () => {
    const huidRenter = renter("renter-doc", "Bob Example", { hygglo_user_id: "legacy-huid" });
    const f = fixture({ byHuid: { "legacy-huid": [huidRenter] } });
    const reservations = [{ renter_id: "legacy-huid", renter_name: "Bob Example" }];
    const maps = await renterMapsForReservations(f.ctx, reservations);

    expect(f.indexReads).toEqual([{ index: "by_hygglo_user_id", field: "hygglo_user_id", value: "legacy-huid" }]);
    expect(await renterForReservation(f.ctx, reservations[0], maps)).toBe(huidRenter);
    expect(f.idReads).toEqual(["legacy-huid"]);
    expect(f.fullCollects()).toBe(0);
  });

  it("retains case-insensitive name fallback only for unresolved legacy rows", async () => {
    const older = renter("r1", "ALICE EXAMPLE", { total_rentals_count: 2 });
    const preferred = renter("r2", "Alice Example", { total_rentals_count: 9 });
    const f = fixture({ all: [older, preferred] });
    const maps = await renterMapsForReservations(f.ctx, [{ renter_name: "alice example" }]);

    expect(f.indexReads).toEqual([]);
    expect(maps.byName.get("alice example")).toBe(preferred);
    expect(f.fullCollects()).toBe(1);
  });
});
