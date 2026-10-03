import { describe, expect, it } from "vitest";
import { validOwnerSetupInvite } from "./owner_setup";

describe("private owner setup invitation", () => {
  const token = "fixture-invitation-only-for-tests-1234567890";
  async function hash(value: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  }
  it("requires the exact private invitation and fails closed without server configuration", async () => {
    const expected = await hash(token);
    expect(await validOwnerSetupInvite(token, expected)).toBe(true);
    expect(await validOwnerSetupInvite(`${token}x`, expected)).toBe(false);
    expect(await validOwnerSetupInvite(null, expected)).toBe(false);
    expect(await validOwnerSetupInvite("short", expected)).toBe(false);
    expect(await validOwnerSetupInvite(token, undefined)).toBe(false);
    expect(await validOwnerSetupInvite(token, "malformed")).toBe(false);
    expect(await validOwnerSetupInvite("x".repeat(513), expected)).toBe(false);
  });
});
