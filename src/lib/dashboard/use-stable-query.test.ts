import { describe, expect, it } from "vitest";
import { stableQueryArgsKey } from "./use-stable-query";

describe("stable query argument identity", () => {
  it("distinguishes account scopes while ignoring object key order", () => {
    expect(stableQueryArgsKey([{ accountSlug: "dbcinema" }]))
      .not.toBe(stableQueryArgsKey([{ accountSlug: "dbcinema_web" }]));
    expect(stableQueryArgsKey([{ month: "2026-11", accountSlug: "dbcinema" }]))
      .toBe(stableQueryArgsKey([{ accountSlug: "dbcinema", month: "2026-11" }]));
  });

  it("keeps skipped queries separate from a loaded argument set", () => {
    expect(stableQueryArgsKey(["skip"]))
      .not.toBe(stableQueryArgsKey([{ accountSlug: "all" }]));
  });
});
