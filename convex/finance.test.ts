import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { freeze, overview, saveEntry } from "./finance";
import { list, retry, ingest, claim, finish } from "./invoices";
function database(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = structuredClone(seed);
  let counter = 0;
  const ctx: any = {
    auth: { getUserIdentity: async () => ({ subject: "owner" }) },
    storage: {
      delete: vi.fn(),
      getUrl: vi.fn(async (id) => `https://storage.example/${id}`),
    },
    scheduler: { runAfter: vi.fn() },
    db: {
      query: (table: string) => {
        let rows = [...(tables[table] ?? [])];
        const chain: any = {
          withIndex: (_name: string, fn?: any) => {
            const q: any = {
              eq: (key: string, value: any) => {
                rows = rows.filter((r) => r[key] === value);
                return q;
              },
              gte: (key: string, value: any) => {
                rows = rows.filter((r) => r[key] >= value);
                return q;
              },
              lt: (key: string, value: any) => {
                rows = rows.filter((r) => r[key] < value);
                return q;
              },
              lte: (key: string, value: any) => {
                rows = rows.filter((r) => r[key] <= value);
                return q;
              },
            };
            fn?.(q);
            return chain;
          },
          order: (direction: string) => {
            if (direction === "desc") rows.reverse();
            return chain;
          },
          collect: async () => rows,
          take: async (n: number) => rows.slice(0, n),
          unique: async () => rows[0] ?? null,
        };
        return chain;
      },
      get: async (id: string) =>
        Object.values(tables)
          .flat()
          .find((r) => r._id === id) ?? null,
      insert: async (table: string, value: any) => {
        const id = `${table}-${++counter}`;
        (tables[table] ??= []).push({
          ...value,
          _id: id,
          _creationTime: Date.now(),
        });
        return id;
      },
      patch: async (id: string, value: any) => {
        const row = Object.values(tables)
          .flat()
          .find((r) => r._id === id);
        if (!row) throw Error("Missing row");
        for (const [k, v] of Object.entries(value))
          if (v === undefined) delete row[k];
          else row[k] = v;
      },
    },
  };
  return { ctx, tables };
}
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function rental(id: string, net: number, extra: any = {}) {
  return {
    _id: id,
    status: "confirmed",
    start_date: "2026-10-01",
    end_date: "2026-10-02",
    net_to_owner_gbp: net,
    account_slug: "leo",
    ...extra,
  };
}
describe("real finance registrations", () => {
  it("blocks anonymous access before database access", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "true");
    vi.stubEnv("CONVEX_SITE_URL", "https://owner.convex.site");
    for (const fn of [freeze, overview, saveEntry, list, retry])
      await expect(
        invoke(fn, { auth: { getUserIdentity: async () => null } }, {}),
      ).rejects.toThrow("OWNER_AUTH_REQUIRED");
  });
  it("uses canonical revenue plus claims and refreezes without double counting", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    const { ctx, tables } = database({
      reservations: [
        rental("a", 1000),
        rental("b", 1000, { account_slug: "dbcinema" }),
        rental("c", 500, { status: "cancelled" }),
        rental("d", 20, {
          start_date: "2026-09-30",
          pickup_date: "2026-10-01",
        }),
      ],
      insurance_claims: [
        { credited_to_month: "2026-10", payout_amount_gbp: 80 },
      ],
      finance_entries: [
        {
          _id: "insurance",
          kind: "expense",
          month: "2026-09",
          recurring: true,
          amount: 10000,
          voided: false,
        },
      ],
    });
    await invoke(freeze, ctx, {
      month: "2026-10",
      danielBps: 5000,
      note: "Initial",
      expectedRevision: 0,
    });
    const first = tables.finance_snapshots[0];
    expect(first.source_revenue).toBe(210000);
    expect(first.profit).toBe(200000);
    await invoke(saveEntry, ctx, {
      kind: "withdrawal",
      month: "2026-10",
      person: "Leo",
      amountGbp: 1800,
      label: "Leo withdrawal",
      recurring: false,
      voided: false,
      reason: "Bank transfer",
    });
    await invoke(freeze, ctx, {
      month: "2026-10",
      danielBps: 5000,
      note: "Revised",
      expectedRevision: 1,
    });
    const data = await invoke(overview, ctx, { month: "2026-10" });
    expect(data.months).toHaveLength(1);
    expect(data.revisions).toHaveLength(2);
    expect(data.totals.Daniel.owed).toBe(80000);
    expect(data.totals.cash).toBe(20000);
    await expect(
      invoke(freeze, ctx, {
        month: "2026-10",
        danielBps: 5000,
        note: "Stale",
        expectedRevision: 1,
      }),
    ).rejects.toThrow("Snapshot changed");
  });
  it("keeps correction audit and excludes voided withdrawals", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    const { ctx, tables } = database({
      finance_snapshots: [
        { month: "2026-10", revision: 1, daniel: 100000, leo: 100000 },
      ],
      finance_entries: [],
    });
    const args = {
      kind: "withdrawal",
      person: "Leo",
      month: "2026-10",
      amountGbp: 1800,
      label: "Transfer",
      recurring: false,
      voided: false,
      reason: "Added",
    };
    const id = await invoke(saveEntry, ctx, args);
    const row = tables.finance_entries[0];
    await expect(
      invoke(saveEntry, ctx, { ...args, id, expectedUpdatedAt: 0 }),
    ).rejects.toThrow("Entry changed");
    await invoke(saveEntry, ctx, {
      ...args,
      id,
      expectedUpdatedAt: row.updated_at,
      voided: true,
      reason: "Duplicate transfer",
    });
    expect(
      (await invoke(overview, ctx, { month: "2026-10" })).totals.Daniel.owed,
    ).toBe(0);
    expect(tables.finance_audit).toHaveLength(2);
    expect(tables.finance_audit[1].before.amount).toBe(180000);
  });
});
describe("invoice durability", () => {
  it("is idempotent per account", async () => {
    const { ctx, tables } = database();
    const args = {
      account: "leo",
      rows: [
        { id: "order", title: "Camera", date: "2026-10-01", price: "£48" },
      ],
    };
    expect(await invoke(ingest, ctx, args)).toBe(1);
    expect(await invoke(ingest, ctx, args)).toBe(0);
    expect(await invoke(ingest, ctx, { ...args, account: "dbcinema" })).toBe(1);
    expect(tables.invoice_archive).toHaveLength(2);
  });
  it("leases only three downloads and rejects stale completion", async () => {
    const { ctx, tables } = database({
      invoice_archive: Array.from({ length: 4 }, (_, i) => ({
        _id: `invoice-${i}`,
        status: "queued",
        next_retry: 0,
        attempts: 0,
        lease_until: 0,
      })),
    });
    const rows = await invoke(claim, ctx, {});
    expect(rows).toHaveLength(3);
    expect(await invoke(claim, ctx, {})).toHaveLength(1);
    await invoke(finish, ctx, {
      id: rows[0]._id,
      lease: 0,
      pdf: "pdf-stale",
      text: "text-stale",
      sha: "abc",
      verified: true,
      amounts: { currency: "GBP" },
    });
    expect(ctx.storage.delete).toHaveBeenCalledWith("pdf-stale");
    expect(tables.invoice_archive[0].status).toBe("downloading");
    await invoke(finish, ctx, {
      id: rows[0]._id,
      lease: rows[0].lease_until,
      pdf: "pdf-real",
      text: "text-real",
      sha: "abc",
      verified: false,
      error: "Needs review",
      amounts: { currency: "GBP" },
    });
    expect(tables.invoice_archive[0]).toMatchObject({
      status: "review",
      pdf_id: "pdf-real",
      error: "Needs review",
    });
  });
});
