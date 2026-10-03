import { describe, expect, it, vi } from "vitest";
import { authorizeOwner, ownerEnforcementRequired, OWNER_SERVICE_ISSUER, OWNER_SERVICE_SUBJECT } from "./owner_authorization";

describe("backend owner authorization", () => {
  const issuer = "https://example.convex.site";
  const binding = async () => ({ auth_user_id: "owner-id" });
  const validSession = async () => ({ _id: "owner-id" });
  it("denies anonymous callers, wrong issuers and non-owner users", async () => {
    for (const identity of [null, { issuer: "untrusted", subject: "owner-id" }, { issuer, subject: "stranger" }]) {
      await expect(authorizeOwner(identity, issuer, binding, validSession)).rejects.toThrow(/OWNER_/);
    }
  });
  it("requires a current server-side session even for the owner's valid JWT", async () => {
    const identity = { issuer, subject: "owner-id" };
    await expect(authorizeOwner(identity, issuer, binding, async () => undefined)).rejects.toThrow("OWNER_SESSION_EXPIRED");
    await expect(authorizeOwner(identity, issuer, binding, async () => ({ _id: "stranger" }))).rejects.toThrow("OWNER_SESSION_EXPIRED");
    await expect(authorizeOwner(identity, issuer, async () => null, validSession)).rejects.toThrow("OWNER_ACCESS_DENIED");
    await expect(authorizeOwner(identity, undefined, binding, validSession)).rejects.toThrow("OWNER_AUTH_REQUIRED");
    expect(await authorizeOwner(identity, issuer, binding, validSession)).toBe("owner");
  });
  it("reserves the service principal for the exact deployment transport identity", async () => {
    const owner = vi.fn(binding), session = vi.fn(validSession);
    expect(await authorizeOwner({ issuer: OWNER_SERVICE_ISSUER, subject: OWNER_SERVICE_SUBJECT }, issuer, owner, session)).toBe("service");
    expect(owner).not.toHaveBeenCalled(); expect(session).not.toHaveBeenCalled();
    await expect(authorizeOwner({ issuer, subject: OWNER_SERVICE_SUBJECT }, issuer, binding, validSession)).rejects.toThrow("OWNER_ACCESS_DENIED");
    await expect(authorizeOwner({ issuer: OWNER_SERVICE_ISSUER, subject: "stranger" }, issuer, binding, validSession)).rejects.toThrow("OWNER_AUTH_REQUIRED");
  });
  it("fails closed on malformed rollout configuration", () => {
    expect(ownerEnforcementRequired(undefined)).toBe(false);
    expect(ownerEnforcementRequired("false")).toBe(false);
    expect(ownerEnforcementRequired("true")).toBe(true);
    for (const value of ["", "TRUE", "1", "enabled"]) expect(() => ownerEnforcementRequired(value)).toThrow("Invalid");
  });
});
