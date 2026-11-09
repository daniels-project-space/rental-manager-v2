import { describe, expect, it } from "vitest";
import { resolveRenterBotLabBrowserUrl } from "./convex-url";

describe("Renter Bot Lab browser backend", () => {
  it("uses the isolated hosted deployment", () => {
    expect(resolveRenterBotLabBrowserUrl({
      NODE_ENV: "production",
      NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL: "https://clean-bulldog-494.convex.cloud",
    })).toBe("https://clean-bulldog-494.convex.cloud");
  });

  it("rejects the live Rental Manager database", () => {
    expect(() => resolveRenterBotLabBrowserUrl({
      NODE_ENV: "production",
      NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL: "https://hearty-oyster-600.convex.cloud",
    })).toThrow("cannot use live rental data");
  });

  it("uses a local Convex server only during local development", () => {
    expect(resolveRenterBotLabBrowserUrl({
      NODE_ENV: "development",
      NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3212",
    })).toBe("http://127.0.0.1:3212");
    expect(() => resolveRenterBotLabBrowserUrl({
      NODE_ENV: "production",
      NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL: "http://127.0.0.1:3212",
    })).toThrow("isolated Convex cloud deployment");
  });

  it("fails closed when hosted configuration is missing or malformed", () => {
    expect(() => resolveRenterBotLabBrowserUrl({ NODE_ENV: "production" })).toThrow("not configured");
    expect(() => resolveRenterBotLabBrowserUrl({
      NODE_ENV: "production",
      NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL: "https://clean-bulldog-494.convex.cloud/?x=1",
    })).toThrow("URL is invalid");
  });
});
