import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCatalogItemChunk, bootstrapLocalLab } from "./renter_bot_lab_local_setup";

afterEach(() => vi.unstubAllEnvs());

function localEnvironment() {
  vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "local");
  vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "false");
  vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING", "enabled");
}

function fakeContext() {
  const tables: Record<string, Array<Record<string, any>>> = {
    accounts: [], account_profiles: [], account_hub_projection: [],
    renter_bot_lab_catalog_snapshots: [], items: [], inventory_read_gate: [], stock_input_cache_state: [],
  };
  let nextId = 0;
  const ctx = {
    db: {
      query(table: string) {
        let field = "";
        let value: unknown;
        return {
          withIndex(_name: string, build: (q: { eq: (key: string, next: unknown) => unknown }) => unknown) {
            build({ eq: (key, next) => { field = key; value = next; return null; } });
            return {
              unique: async () => tables[table].find((row) => row[field] === value) ?? null,
            };
          },
          collect: async () => tables[table],
        };
      },
      async insert(table: string, value: Record<string, any>) {
        const row = { ...value, _id: `${table}-${++nextId}` };
        tables[table].push(row);
        return row._id;
      },
      async get(id: string) {
        return Object.values(tables).flat().find((row) => row._id === id) ?? null;
      },
      async patch(id: string, patch: Record<string, any>) {
        const row = Object.values(tables).flat().find((candidate) => candidate._id === id);
        if (row) Object.assign(row, patch);
      },
    },
  };
  return { ctx, tables };
}

describe("local Lab bootstrap", () => {
  it("refuses any deployment that is not explicitly local and probe-only", async () => {
    const { ctx } = fakeContext();
    vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "hosted");
    vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "false");
    vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING", "enabled");
    await expect((bootstrapLocalLab as any)._handler(ctx, {})).rejects.toThrow("disabled outside");
  });

  it("creates the three account-specific pickup fixtures idempotently", async () => {
    localEnvironment();
    const { ctx, tables } = fakeContext();
    expect(await (bootstrapLocalLab as any)._handler(ctx, {})).toMatchObject({ ready: ["leo", "diogo", "dbcinema"], count: 3, isolated: true });
    await (bootstrapLocalLab as any)._handler(ctx, {});
    expect(tables.accounts.map((row) => row.slug).sort()).toEqual(["dbcinema", "diogo", "leo"]);
    expect(tables.account_profiles).toHaveLength(3);
    const profileFor = (slug: string) => {
      const account = tables.accounts.find((row) => row.slug === slug);
      return tables.account_profiles.find((row) => row.account_id === account?._id);
    };
    expect(profileFor("leo")?.pickup_address).toContain("Waterstones");
    expect(profileFor("diogo")?.pickup_address).toContain("Charing Cross");
    expect(profileFor("dbcinema")?.pickup_address).toContain("Sherlock Holmes");
  });

  it("preserves owner-confirmed kit source and freshness as structured inventory provenance", async () => {
    localEnvironment();
    const { ctx, tables } = fakeContext();
    tables.renter_bot_lab_catalog_snapshots.push({ snapshot_key: "current:v1", sync_status: "syncing", sync_id: "sync-1" });
    await (applyCatalogItemChunk as any)._handler(ctx, {
      sync_id: "sync-1",
      rows: [{
        source_id: "bmpcc-pro", name: "BMPCC 6K Pro", display_name: "BMPCC 6K Pro", kind: "camera",
        qty: 1, unit_kind: "kit", status: "active", is_marketing_only: false, aliases: [],
        included_with_rental: ["5× NP-F570 batteries", "1× 2TB SSD"], contents_source: "owner-confirmed kit contents",
      }],
    });
    expect(tables.items[0]).toMatchObject({
      description_source: "owner-confirmed kit contents",
      owner_verified_kit: { source: "owner-confirmed kit contents", contents: ["5× NP-F570 batteries", "1× 2TB SSD"] },
      compatibility: { included_with_rental: ["5× NP-F570 batteries", "1× 2TB SSD"] },
    });
    expect(tables.items[0].updated_at).toEqual(expect.any(Number));
  });
});
