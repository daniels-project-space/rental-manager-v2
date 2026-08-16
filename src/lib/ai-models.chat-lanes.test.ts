/**
 * Guards the WallE / assistant model-lane configuration.
 *
 * Context: on 2026-08-16 the shared OpenRouter account ran out of credit and
 * every chat surface returned an empty 200 — no user-visible error, no log.
 * The fix has two halves: (1) a cheaper primary lane, (2) a DISTINCT fallback
 * lane so one provider outage can't mute the bot. A fallback pointing at the
 * same model as the primary is a no-op and would silently undo half the fix,
 * so that is asserted here rather than left to review.
 */
import { describe, it, expect } from "vitest";
import {
  CHAT_MODEL,
  CHAT_MODEL_SMART,
  CHAT_MODEL_FALLBACK,
  CHAT_MODEL_SMART_FALLBACK,
} from "./ai-models";

describe("chat model lanes", () => {
  it("routes the primary lanes to Gemini 3.7 Flash", () => {
    expect(CHAT_MODEL).toBe("google/gemini-3.7-flash");
    expect(CHAT_MODEL_SMART).toBe("google/gemini-3.7-flash");
  });

  it("keeps the Claude pair as the fallback lane", () => {
    expect(CHAT_MODEL_FALLBACK).toBe("anthropic/claude-haiku-4.5");
    expect(CHAT_MODEL_SMART_FALLBACK).toBe("anthropic/claude-sonnet-4.6");
  });

  it("never lets a fallback equal its primary — that would be a no-op", () => {
    expect(CHAT_MODEL_FALLBACK).not.toBe(CHAT_MODEL);
    expect(CHAT_MODEL_SMART_FALLBACK).not.toBe(CHAT_MODEL_SMART);
  });

  it("keeps primary and fallback on different providers", () => {
    const provider = (id: string) => id.split("/")[0];
    expect(provider(CHAT_MODEL_FALLBACK)).not.toBe(provider(CHAT_MODEL));
    expect(provider(CHAT_MODEL_SMART_FALLBACK)).not.toBe(
      provider(CHAT_MODEL_SMART),
    );
  });

  it("uses fully-qualified OpenRouter slugs (provider/model)", () => {
    for (const id of [
      CHAT_MODEL,
      CHAT_MODEL_SMART,
      CHAT_MODEL_FALLBACK,
      CHAT_MODEL_SMART_FALLBACK,
    ]) {
      expect(id).toMatch(/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/);
    }
  });
});
