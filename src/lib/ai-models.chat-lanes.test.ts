/**
 * Guards the WallE / assistant model-lane configuration.
 *
 * Context: on 2026-08-16 the shared OpenRouter account ran out of credit and
 * every chat surface returned an empty 200 — no user-visible error, no log.
 * The original fix had two halves: (1) a cheaper primary lane, (2) a DISTINCT
 * fallback lane so one provider outage couldn't mute the bot.
 *
 * The fallback half is now gone, in two steps:
 *   2026-08-17 (Daniel) — plain lane's Claude Haiku 4.5 fallback removed.
 *   2026-08-21 (Daniel) — smart lane's Claude Sonnet 4.6 fallback removed too.
 *
 * There is no Anthropic model referenced anywhere in this codebase now, on any
 * lane, primary or fallback. A provider failure surfaces as a real, visible
 * error rather than a silent cross-provider switch — the 2026-08-16 outage
 * scenario is now handled by failing loudly instead of by paying for a second
 * provider. These tests assert the removal stayed complete rather than leaving
 * it to review.
 */
import { describe, it, expect } from "vitest";
import { CHAT_MODEL, CHAT_MODEL_SMART } from "./ai-models";

describe("chat model lanes", () => {
  it("routes the primary lanes to Gemini 3.7 Flash", () => {
    expect(CHAT_MODEL).toBe("google/gemini-3.7-flash");
    expect(CHAT_MODEL_SMART).toBe("google/gemini-3.7-flash");
  });

  it("uses fully-qualified OpenRouter slugs (provider/model)", () => {
    for (const id of [CHAT_MODEL, CHAT_MODEL_SMART]) {
      expect(id).toMatch(/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/);
    }
  });

  it("exports NO fallback lane of any kind", async () => {
    const mod = (await import("./ai-models")) as Record<string, unknown>;
    expect(mod.CHAT_MODEL_FALLBACK).toBeUndefined();
    expect(mod.CHAT_MODEL_SMART_FALLBACK).toBeUndefined();
  });

  it("references no Anthropic model on any exported lane", async () => {
    const mod = (await import("./ai-models")) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "string") continue;
      expect(
        value.toLowerCase(),
        `${name} must not point at an Anthropic model`,
      ).not.toContain("anthropic");
      expect(
        value.toLowerCase(),
        `${name} must not point at a Claude model`,
      ).not.toContain("claude");
    }
  });
});
