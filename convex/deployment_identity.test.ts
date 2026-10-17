import { afterEach, describe, expect, it, vi } from "vitest";
import { acquire, renew, release } from "./deployment_identity";

const commit = "a".repeat(40);
function fixture() {
  let row: any = null, inserts = 0;
  const ctx: any = { db: {
    query(table: string) {
      expect(table).toBe("deployment_leases");
      return { withIndex(index: string, range: any) {
        expect(index).toBe("by_resource");
        range({ eq: (key: string, value: string) => { expect(key).toBe("resource"); expect(value).toBe("rental-production"); } });
        return { unique: async () => row };
      } };
    },
    insert: async (_table: string, value: any) => { row = { _id: "lease", ...value }; inserts++; },
    patch: async (id: string, value: any) => { expect(id).toBe("lease"); Object.assign(row, value); },
  } };
  return { ctx, state: () => row, inserts: () => inserts };
}
const call = async (fn: any, ctx: any, owner: string, sourceCommit = commit) => fn._handler(ctx, { owner, sourceCommit });
afterEach(() => vi.useRealTimers());

describe("one bounded backend publication lease", () => {
  it("refuses another publisher until release and reuses the same row", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const f = fixture();
    expect((await call(acquire, f.ctx, "github:first")).acquired).toBe(true);
    expect((await call(acquire, f.ctx, "vercel:second")).acquired).toBe(false);
    expect(await call(release, f.ctx, "github:first")).toEqual({ released: true });
    expect((await call(acquire, f.ctx, "vercel:second")).acquired).toBe(true);
    expect(f.inserts()).toBe(1);
  });
  it("renews only the live owner and commit", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const f = fixture();
    const original = await call(acquire, f.ctx, "first"); vi.setSystemTime(20_000);
    expect((await call(renew, f.ctx, "first")).expiresAt).toBeGreaterThan(original.expiresAt);
    expect(await call(renew, f.ctx, "first", "b".repeat(40))).toEqual({ renewed: false });
    expect(await call(renew, f.ctx, "second")).toEqual({ renewed: false });
  });
  it("recovers after expiry and fences a stale owner's renewal/release", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000); const f = fixture();
    const first = await call(acquire, f.ctx, "first"); vi.setSystemTime(first.expiresAt);
    expect(await call(renew, f.ctx, "first")).toEqual({ renewed: false });
    expect((await call(acquire, f.ctx, "second")).acquired).toBe(true);
    expect(await call(release, f.ctx, "first")).toEqual({ released: false });
    expect(f.state().owner).toBe("second"); expect(f.inserts()).toBe(1);
  });
  it("rejects malformed metadata before database access", async () => {
    const f = fixture(); await expect(call(acquire, f.ctx, "bad/owner")).rejects.toThrow("Invalid deployment identity");
    await expect(call(acquire, f.ctx, "first", "not-a-commit")).rejects.toThrow("Invalid deployment identity"); expect(f.state()).toBeNull();
  });
});
