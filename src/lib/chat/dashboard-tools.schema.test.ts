/**
 * Mechanical guards on the chat tool registry's WRITE surface.
 *
 * These are deliberately schema-level, not prompt-level: the whole point of the
 * 2026-08-14 hardening is that an LLM must be unable to reach a dangerous field
 * even if it ignores every word of the tool description. If someone widens a
 * schema, these fail — a prompt-text warning would not have.
 *
 * `execute` is never invoked here, so the ConvexHttpClient is a bare stub; only
 * the closure identity matters for building the registry.
 */
import { describe, expect, it } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import { buildDashboardTools } from "./dashboard-tools";

const convexStub = {} as unknown as ConvexHttpClient;
const tools = buildDashboardTools(convexStub);

/** The AI SDK stores the Zod schema on `inputSchema`. */
function schemaOf(name: string) {
  const t = tools[name] as unknown as { inputSchema?: { safeParse: (v: unknown) => { success: boolean } } };
  if (!t?.inputSchema?.safeParse) throw new Error(`tool '${name}' has no parseable inputSchema`);
  return t.inputSchema;
}

describe("change_settings is a closed allowlist", () => {
  // settings:update ALSO accepts these. None may be reachable from chat:
  // the first two are the production safety rails, minimum_rental_gbp is a
  // real-money pricing floor, and the ai_* pair drives the AI-boost revenue
  // attribution the assistant is itself credited by.
  const FORBIDDEN: Array<[string, unknown]> = [
    ["read_only_mode", false],
    ["ALLOW_HYGGLO_SEND", true],
    ["minimum_rental_gbp", 1],
    ["ai_boost_rate", 0.9],
    ["ai_active_from", "2020-01"],
    ["draft_epoch", 99],
  ];

  it.each(FORBIDDEN)("rejects %s outright", (field, value) => {
    expect(schemaOf("change_settings").safeParse({ [field]: value }).success).toBe(false);
  });

  it("still accepts the genuinely safe operational fields", () => {
    const ok = schemaOf("change_settings").safeParse({
      pickup_hours: [{ start: "10:00", end: "12:00" }],
      polling_interval_ms: 300_000,
      escalate_to_sonnet: true,
      availability_include_pending: false,
      hub_max_km: 25,
      hub_heavy_max_km: 10,
    });
    expect(ok.success).toBe(true);
  });

  it("enforces the poll-interval bounds Convex enforces (2 min - 1 hour)", () => {
    const s = schemaOf("change_settings");
    expect(s.safeParse({ polling_interval_ms: 60_000 }).success).toBe(false);
    expect(s.safeParse({ polling_interval_ms: 3_600_001 }).success).toBe(false);
    expect(s.safeParse({ polling_interval_ms: 120_000 }).success).toBe(true);
  });
});

describe("the two-phase price change is wired", () => {
  it("exposes propose and execute as separate tools", () => {
    expect(tools.propose_price_change).toBeDefined();
    expect(tools.execute_price_change).toBeDefined();
  });

  it("execute_price_change cannot be called without a token", () => {
    const s = schemaOf("execute_price_change");
    expect(s.safeParse({ account_slug: "leo", percent_change: 10 }).success).toBe(false);
    expect(s.safeParse({ confirmation_token: "", account_slug: "leo", percent_change: 10 }).success).toBe(false);
    expect(s.safeParse({ confirmation_token: "pcp_x", account_slug: "leo", percent_change: 10 }).success).toBe(true);
  });

  // ±50 / non-zero must match convex/listing_price_admin.ts (MAX_ABS_PERCENT),
  // on BOTH tools and on the read-only preview, so no surface can quote or
  // request a change the executor would refuse.
  it.each(["propose_price_change", "execute_price_change"])(
    "%s pins percent_change to the write path's bounds",
    (name) => {
      const s = schemaOf(name);
      const base = name === "execute_price_change" ? { confirmation_token: "pcp_x" } : {};
      const at = (p: number) => s.safeParse({ ...base, account_slug: "leo", percent_change: p }).success;
      expect(at(0)).toBe(false);
      expect(at(51)).toBe(false);
      expect(at(-51)).toBe(false);
      expect(at(-10)).toBe(true); // price cuts are legitimate
      expect(at(50)).toBe(true);
    },
  );

  it("rejects an account outside the Hygglo allowlist", () => {
    expect(
      schemaOf("propose_price_change").safeParse({ account_slug: "nope", percent_change: 10 }).success,
    ).toBe(false);
  });

  it("preview_listing_price_change shares the same percent bounds", () => {
    const s = schemaOf("preview_listing_price_change");
    expect(s.safeParse({ account: "leo", percent: 26 }).success).toBe(true); // >25 is now allowed
    expect(s.safeParse({ account: "leo", percent: 51 }).success).toBe(false);
    expect(s.safeParse({ account: "leo", percent: 0 }).success).toBe(false);
  });

  // The tool description IS the guard against WallE executing without a human
  // yes, so pin the load-bearing phrases against a well-meaning "tidy-up" edit.
  it("keeps the human-confirmation contract in the tool descriptions", () => {
    const propose = (tools.propose_price_change as { description?: string }).description ?? "";
    const execute = (tools.execute_price_change as { description?: string }).description ?? "";
    expect(propose).toMatch(/NOTHING CHANGES/i);
    expect(propose).toMatch(/confirm/i);
    expect(execute).toMatch(/same turn/i);
    expect(execute).toMatch(/is NOT confirmation|NOT CONFIRMATION/i);
    expect(execute).toMatch(/propose_price_change/);
  });
});
