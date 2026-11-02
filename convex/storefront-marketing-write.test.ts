import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth", () => ({ authComponent: { registerRoutes: vi.fn(), safeGetAuthUser: vi.fn() }, createAuth: vi.fn() }));
vi.mock("./lib/product_context", () => ({
  patchProduct: async (ctx: any, id: string, patch: object) => ctx.db.patch(id, patch),
  insertProduct: vi.fn(), refreshProductContext: vi.fn(),
}));

import http, { storefrontMarketingWrite } from "./http";
import { __saveStorefrontMarketing } from "./hygglo_products";

const secret = "fixture-secret";
const requestId = "78b1f7e0-6e74-4a2c-b463-6ec0110a76df";
const changes = Array.from({ length: 112 }, (_, index) => ({ productId: index + 1, marketingOnly: true, expectedUpdatedAt: 0 }));
const request = (body: unknown, token: string | null = secret) => new Request("https://fixture.invalid/dbcinema/storefront-marketing-write", {
  method: "POST", headers: token ? { "x-dbcinema-sync-token": token } : {}, body: typeof body === "string" ? body : JSON.stringify(body),
});
const invoke = (ctx: any, body: unknown, token?: string | null) => (storefrontMarketingWrite as any)._handler(ctx, request(body, token));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("private storefront marketing write", () => {
  it("rejects unauthorized, malformed and oversized writes before dispatch", async () => {
    expect(http.lookup("/dbcinema/storefront-marketing-write", "POST")?.[0]).toBe(storefrontMarketingWrite);
    vi.stubEnv("DBCINEMA_MARKETING_WRITE_SECRET", secret);
    const runMutation = vi.fn();
    const valid = { protocolVersion: 1, requestId, changes };
    expect((await invoke({ runMutation }, valid, null)).status).toBe(401);
    for (const invalid of [{ ...valid, changes: [] }, { ...valid, changes: [changes[0], changes[0]] }, { ...valid, changes: [{ ...changes[0], accountSlug: "other" }] }, { ...valid, requestId: "bad" }]) {
      expect((await invoke({ runMutation }, invalid)).status).toBe(400);
    }
    expect((await invoke({ runMutation }, "x".repeat(100001))).status).toBe(413);
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("passes only the bounded operation and returns its receipt", async () => {
    vi.stubEnv("DBCINEMA_MARKETING_WRITE_SECRET", secret);
    const result = [{ productId: 1, marketingOnly: true, mode: "manual", updatedAt: 17 }];
    const runMutation = vi.fn().mockResolvedValue(result);
    const response = await invoke({ runMutation }, { protocolVersion: 1, requestId, changes });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ protocolVersion: 1, status: "success", requestId, results: result });
    expect(runMutation.mock.calls[0][1]).toEqual({ requestId, changes });
  });

  it("validates the entire batch and replays the same request without writing twice", async () => {
    const products = changes.map(change => ({ _id: `product-${change.productId}`, accountSlug: "dbcinema", productId: change.productId, isMarketingOnly: false }));
    const receipts: any[] = [];
    const patches: any[] = [];
    const db = {
      query: (table: string) => {
        let rows: any[] = table === "hygglo_products" ? products : table === "storefront_marketing_requests" ? receipts : [];
        const query: any = { withIndex: (_index: string, callback: (filter: any) => void) => {
          const filter: any = { eq: (field: string, value: unknown) => { rows = rows.filter(row => row[field] === value); return filter; } };
          callback(filter); return query;
        }, first: async () => rows[0] ?? null, unique: async () => rows[0] ?? null };
        return query;
      },
      patch: async (id: string, value: object) => { patches.push(id); Object.assign(products.find(product => product._id === id)!, value); },
      insert: async (_table: string, value: object) => { receipts.push({ _id: "receipt", ...value }); return "receipt"; },
      delete: vi.fn(),
    };
    const scheduler = { runAfter: vi.fn() };
    const save = (args: unknown) => (__saveStorefrontMarketing as any)._handler({ db, scheduler }, args);
    const result = await save({ requestId, changes });
    expect(result).toHaveLength(112);
    expect(patches).toHaveLength(112);
    expect(scheduler.runAfter).toHaveBeenCalledTimes(1);
    expect(await save({ requestId, changes })).toEqual(result);
    expect(patches).toHaveLength(112);
    await expect(save({ requestId, changes: changes.slice(0, 1) })).rejects.toThrow("different changes");
    (products[0] as any).marketingOnlyUpdatedAt += 1;
    await expect(save({ requestId, changes })).rejects.toThrow("changed after this save");
    await expect(save({ requestId: "c4c5ea41-a2d6-493d-a683-4c8bc4be2e88", changes })).rejects.toThrow("changed in another session");
    expect(patches).toHaveLength(112);
  });
});
