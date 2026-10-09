import { describe, expect, it } from "vitest";
import { ownerLoginHref, ownerReturnTo } from "./owner-navigation";

describe("owner login return destinations", () => {
  it("preserves local notification and chat destinations", () => {
    const target = "/renter-bot-lab?chat=chat-123&account=dbc#messages";
    expect(ownerReturnTo(target)).toBe(target);
    expect(new URL(ownerLoginHref(target), "https://rental-manager.invalid").searchParams.get("returnTo")).toBe(target);
  });
  it("rejects external, malformed and login-loop destinations", () => {
    for (const target of [undefined, null, "", "https://evil.invalid", "//evil.invalid", "/\\evil.invalid", "/\n/evil.invalid", "/login?returnTo=https://evil.invalid", "/login/", "javascript:alert(1)"])
      expect(ownerReturnTo(target)).toBe("/");
  });
});
