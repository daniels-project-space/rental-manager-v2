import { describe, expect, it } from "vitest";
import { rankKnowledge, type ScorerInputMemory, type ScorerInputRule } from "./knowledge_search";

describe("rankKnowledge — relevance-first ordering", () => {
  it("ranks a highly-relevant low-priority FAQ above a barely-relevant high-priority rule", () => {
    // Reproduces the live 2026-08-17 bug: "FAQ: Reservation Hold" (priority 6)
    // scored the top relevance of 83 candidates for a renter's hold-timing
    // question, but ranked 74th because priority sorted first. The bot's
    // search_knowledge tool call (limit 3-5) never saw it and escalated a
    // fully FAQ-answerable question.
    const rules: ScorerInputRule[] = [
      {
        _id: "r1",
        rule_kind: "DANIEL RULE 11 — Cancellation Requests",
        rule_body:
          "NEVER auto-accept. Ask renter for reason, tell them request sent to department head, inform Daniel and ask his call.",
        category: "daniel-rule cancellation escalation",
        priority: 10,
        enabled: true,
      },
    ];
    const memories: ScorerInputMemory[] = [
      {
        _id: "m1",
        scope: "faq",
        title: "FAQ: Reservation Hold",
        content:
          "Hygglo holds the slot once the request is sent. Daniel reviews and accepts within working hours. Pre-acceptance no payment captured.",
        tags: ["faq", "hold", "platform"],
        priority: 6,
      },
    ];
    const hits = rankKnowledge(
      "ive sent the request, how long before you accept it, is my slot held in the meantime",
      rules,
      memories,
    );
    expect(hits[0].title).toBe("FAQ: Reservation Hold");
  });

  it("still uses priority as a tiebreaker when relevance is equal", () => {
    const rules: ScorerInputRule[] = [
      {
        _id: "r1",
        rule_kind: "Low Priority Rule",
        rule_body: "delivery pickup schedule",
        category: null,
        priority: 5,
        enabled: true,
      },
      {
        _id: "r2",
        rule_kind: "High Priority Rule",
        rule_body: "delivery pickup schedule",
        category: null,
        priority: 9,
        enabled: true,
      },
    ];
    const hits = rankKnowledge("delivery pickup schedule", rules, []);
    expect(hits[0].relevance).toBe(hits[1].relevance);
    expect(hits[0].title).toBe("High Priority Rule");
  });

  it("never surfaces a zero-relevance hit regardless of priority", () => {
    const rules: ScorerInputRule[] = [
      {
        _id: "r1",
        rule_kind: "Unrelated Rule",
        rule_body: "camera lens compatibility mounts",
        category: null,
        priority: 10,
        enabled: true,
      },
    ];
    const hits = rankKnowledge("what is your cancellation policy", rules, []);
    expect(hits).toHaveLength(0);
  });
});
