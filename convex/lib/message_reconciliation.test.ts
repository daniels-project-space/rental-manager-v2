import { describe, expect, it } from "vitest";
import { isMatchingOptimisticOwnerMessage } from "./message_reconciliation";

describe("manual-send reconciliation", () => {
  const row = {
    raw: "manual_send_optimistic",
    body_text: "See you at 7pm",
    hygglo_sent_at: 1_000_000,
    fetched_at: 1_000_000,
  };

  it("matches Hygglo's authoritative copy despite surrounding whitespace", () => {
    expect(isMatchingOptimisticOwnerMessage(row, " See you at 7pm ", 1_001_000)).toBe(true);
  });

  it("does not collapse different or much later messages", () => {
    expect(isMatchingOptimisticOwnerMessage(row, "See you at 8pm", 1_001_000)).toBe(false);
    expect(isMatchingOptimisticOwnerMessage(row, row.body_text, 3_000_001)).toBe(false);
  });
});
