import { describe, it, expect, vi, afterEach } from "vitest";
import { listActiveForStorefront } from "./reservations";

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("storefront custody feed", () => {
  it("includes overdue delivered gear without leaking another account or duplicating dated rows", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    const rows = [
      { _id: "old-away", account_slug: "dbcinema", status: "confirmed", order_step: "DELIVERED", start_date: "2026-08-01", end_date: "2026-08-02", renter_email: "private@example.invalid" },
      { _id: "dated-away", account_slug: "dbcinema", status: "confirmed", order_step: "DELIVERED", start_date: "2026-10-08", end_date: "2026-10-09" },
      { _id: "future", account_slug: "dbcinema", status: "confirmed", order_step: "BOOKED_AFTER_VERIFIED", end_date: "2026-12-01" },
      { _id: "foreign", account_slug: "other", status: "confirmed", order_step: "DELIVERED", end_date: "2026-08-02" },
      { _id: "cancelled", account_slug: "dbcinema", status: "cancelled", order_step: "DELIVERED", end_date: "2026-08-02" },
      { _id: "obsolete", account_slug: "dbcinema", status: "confirmed", order_step: "DELIVERED", is_obsolete: true, end_date: "2026-08-02" },
      { _id: "returned", account_slug: "dbcinema", status: "completed", order_step: "RETURNED", end_date: "2026-08-02" },
    ];
    const indexes: string[] = [];
    const ctx: any = { auth: { getUserIdentity: async () => null }, db: { query: (table:string) => {
      let selected = table === "reservations" ? rows : [];
      const query: any = { withIndex: (index: string, select: any) => {
        indexes.push(index);
        const selector: any = { eq: (key: string, value: any) => { selected = selected.filter((r: any) => r[key] === value); return selector; }, gte: (key: string, value: any) => { selected = selected.filter((r: any) => r[key] >= value); return selector; } };
        select(selector); return query;
      }, collect: async () => selected };
      return query;
    } } };
    const result = await (listActiveForStorefront as any)._handler(ctx, { account_slug: "dbcinema" });
    expect(new Set(result.map((r: any) => r._id))).toEqual(new Set(["old-away", "dated-away", "future"]));
    expect(result).toHaveLength(3);
    expect(result.find((r: any) => r._id === "old-away")).toMatchObject({ end_date: "2026-08-02", order_step: "DELIVERED" });
    expect(result.some((r: any) => "renter_email" in r)).toBe(false);
    expect(indexes).toEqual(["by_account_end", "by_account_order_step", "by_account_product"]);
  });
});
