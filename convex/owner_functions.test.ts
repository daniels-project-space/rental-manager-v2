import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { authComponent } from "./auth";
import { query, mutation, action, internalQuery, internalQueryOf, internalMutationOf, internalActionOf } from "./owner_functions";
import { internalQuery as originalInternalQuery } from "./_generated/server";
import { v } from "convex/values";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("actual registered owner handlers", () => {
  it.each([[query, internalQueryOf], [mutation, internalMutationOf], [action, internalActionOf]] as const)("preserves validators and behavior for privileged internal callers while denying the public call", async (builder, counterpart) => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "true");
    const handler = vi.fn((_ctx, args) => args.value * 2);
    const publicFunction = (builder as typeof query)({ args: { value: v.number() }, returns: v.number(), handler });
    const internalFunction = (counterpart as typeof internalQueryOf)(publicFunction);
    expect(internalFunction.isInternal).toBe(true);
    expect((internalFunction as any).exportArgs()).toBe((publicFunction as any).exportArgs());
    expect((internalFunction as any).exportReturns()).toBe((publicFunction as any).exportReturns());
    const ctx = { auth: { getUserIdentity: async () => null } };
    await expect((publicFunction as any)._handler(ctx, { value: 7 })).rejects.toThrow("OWNER_AUTH_REQUIRED");
    expect(handler).not.toHaveBeenCalled();
    expect(await (internalFunction as any)._handler(ctx, { value: 7 })).toBe(14);
    expect(handler).toHaveBeenCalledOnce();
  });
  it("refuses unknown functions and mismatched counterpart types", () => {
    expect(() => internalQueryOf({} as any)).toThrow("matching owner-protected");
    expect(() => internalMutationOf(query({ handler: async () => null }) as any)).toThrow("matching owner-protected");
  });
  it.each([["query", query], ["mutation", mutation], ["action", action]] as const)("denies an anonymous %s before its handler can read or write data", async (_kind, builder) => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "true");
    vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
    const handler = vi.fn(() => "protected data");
    const registered = builder({ args: {}, handler });
    await expect((registered as any)._handler({ auth: { getUserIdentity: async () => null } }, {})).rejects.toThrow("OWNER_AUTH_REQUIRED");
    expect(handler).not.toHaveBeenCalled();
    expect(authComponent.safeGetAuthUser).not.toHaveBeenCalled();
  });
  it("checks the owner's live session and preserves the caller's result and arguments", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "true");
    vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
    const handler = vi.fn((_ctx, args) => args);
    const registered = mutation({ handler });
    const ctx = {
      auth: { getUserIdentity: async () => ({ issuer: "https://example.convex.site", subject: "owner-id" }) },
      db: { query: () => ({ first: async () => ({ auth_user_id: "owner-id" }) }) },
    };
    vi.mocked(authComponent.safeGetAuthUser).mockResolvedValue(undefined);
    await expect((registered as any)._handler(ctx, { value: 7 })).rejects.toThrow("OWNER_SESSION_EXPIRED");
    expect(handler).not.toHaveBeenCalled();
    vi.mocked(authComponent.safeGetAuthUser).mockResolvedValue({ _id: "owner-id" } as any);
    expect(await (registered as any)._handler(ctx, { value: 7 })).toEqual({ value: 7 });
    expect(handler).toHaveBeenCalledOnce();
  });
  it("keeps internal registrations on Convex's internal-only builder", () => {
    expect(internalQuery).toBe(originalInternalQuery);
  });
  it("rejects malformed enforcement configuration rather than falling back to anonymous access", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "TRUE");
    const handler = vi.fn();
    await expect((query({ handler }) as any)._handler({}, {})).rejects.toThrow("Invalid");
    expect(handler).not.toHaveBeenCalled();
  });
});
