/**
 * Guards the WallE / assistant model-lane configuration.
 *
 * Context: on 2026-08-16 the shared OpenRouter account ran out of credit and
 * every chat surface returned an empty 200 — no user-visible error, no log.
 * The original fix had two halves: (1) a cheaper primary lane, (2) a
 * DISTINCT fallback lane so one provider outage can't mute the bot.
 *
 * 2026-08-17 (Daniel): the plain lane's fallback (Claude Haiku 4.5) was
 * removed — no Haiku calls anywhere, even as a dormant safety net. The
 * plain lane is Gemini-only now; a primary failure surfaces as a real error
 * instead of a silent switch. The smart (compat/availability/inventory)
 * lane's Sonnet fallback is untouched — that decision was scoped to Haiku
 * specifically, so this lane still has a non-Gemini safety net. Asserting
 * both halves here rather than leaving them to review.
 */
import { describe, it, expect } from "vitest";
import { CHAT_MODEL, CHAT_MODEL_SMART, CHAT_MODEL_SMART_FALLBACK } from "./ai-models";

describe("chat model lanes", () => {
  it("routes the primary lanes to Gemini 3.7 Flash", () => {
    expect(CHAT_MODEL).toBe("google/gemini-3.7-flash");
    expect(CHAT_MODEL_SMART).toBe("google/gemini-3.7-flash");
  });

  it("keeps Sonnet as the smart-lane fallback only", () => {
    expect(CHAT_MODEL_SMART_FALLBACK).toBe("anthropic/claude-sonnet-4.6");
  });

  it("never lets the smart fallback equal its primary — that would be a no-op", () => {
    expect(CHAT_MODEL_SMART_FALLBACK).not.toBe(CHAT_MODEL_SMART);
  });

  it("keeps the smart primary and fallback on different providers", () => {
    const provider = (id: string) => id.split("/")[0];
    expect(provider(CHAT_MODEL_SMART_FALLBACK)).not.toBe(
      provider(CHAT_MODEL_SMART),
    );
  });

  it("uses fully-qualified OpenRouter slugs (provider/model)", () => {
    for (const id of [CHAT_MODEL, CHAT_MODEL_SMART, CHAT_MODEL_SMART_FALLBACK]) {
      expect(id).toMatch(/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/);
    }
  });

  it("no longer exports a plain-lane fallback", async () => {
    const mod = (await import("./ai-models")) as Record<string, unknown>;
    expect(mod.CHAT_MODEL_FALLBACK).toBeUndefined();
  });
});
