import { describe, it, expect } from "vitest";
import {
  classifyIntent,
  modelForIntent,
  type IntentHistoryEntry,
} from "./classify-intent";

describe("classifyIntent", () => {
  it("flags mutations from action verbs", () => {
    expect(classifyIntent("accept order 1234")).toBe("mutation");
    expect(classifyIntent("decline that rental")).toBe("mutation");
    expect(classifyIntent("approve abc123")).toBe("mutation");
    expect(classifyIntent("apply a 10% discount")).toBe("mutation");
    expect(classifyIntent("delete this rule")).toBe("mutation");
    expect(classifyIntent("mark as paid")).toBe("mutation");
    expect(classifyIntent("set the price to 200")).toBe("mutation");
  });

  it("flags complex reasoning prompts", () => {
    expect(classifyIntent("Why did revenue drop last week?")).toBe("complex");
    expect(classifyIntent("Compare this month vs last month")).toBe("complex");
    expect(classifyIntent("Should I accept the cheap booking?")).toBe(
      "mutation",
    ); // contains "accept"
    expect(classifyIntent("Explain why R5 has lower revenue")).toBe("complex");
    expect(classifyIntent("Recommend an action for pending orders")).toBe(
      "complex",
    );
  });

  it("flags simple-read questions", () => {
    expect(classifyIntent("what's today's revenue?")).toBe("simple_read");
    expect(classifyIntent("show me pending decisions")).toBe("simple_read");
    expect(classifyIntent("list overdue items")).toBe("simple_read");
    expect(classifyIntent("how much did we earn this week?")).toBe(
      "simple_read",
    );
    expect(classifyIntent("today's briefing")).toBe("simple_read");
  });

  it("defaults to unknown on ambiguity / empty / no keyword hit", () => {
    expect(classifyIntent("")).toBe("unknown");
    expect(classifyIntent("   ")).toBe("unknown");
    expect(classifyIntent("hi")).toBe("unknown");
    expect(classifyIntent("foo bar baz")).toBe("unknown");
  });

  it("bumps very long messages to complex", () => {
    const long = "x".repeat(260);
    expect(classifyIntent(long)).toBe("complex");
  });

  it("bumps multi-sentence prompts to complex", () => {
    expect(
      classifyIntent("First. Second. Third."),
    ).toBe("complex");
  });

  it("biases to complex when the last assistant turn ran a mutate tool", () => {
    const history: IntentHistoryEntry[] = [
      { role: "user", content: "accept 1234" },
      {
        role: "assistant",
        content: "Done.",
        metadata: JSON.stringify({ tool: "mutate", op: "accept" }),
      },
    ];
    // "ok" alone would normally be `unknown`; mutate context lifts it.
    expect(classifyIntent("ok", history)).toBe("complex");
  });

  it("mutation keyword wins over simple_read keyword", () => {
    // contains both "show" and "delete"
    expect(classifyIntent("show me what you'd delete")).toBe("mutation");
  });

  it("complex keyword wins over simple_read keyword", () => {
    // contains both "show" and "why"
    expect(classifyIntent("show me why revenue dipped")).toBe("complex");
  });
});

describe("modelForIntent", () => {
  it("maps simple_read to grok-4-fast", () => {
    expect(modelForIntent("simple_read", "grok-4.3")).toBe("grok-4-fast");
  });

  it("maps other intents to the configured default", () => {
    expect(modelForIntent("mutation", "grok-4.3")).toBe("grok-4.3");
    expect(modelForIntent("complex", "grok-4.3")).toBe("grok-4.3");
    expect(modelForIntent("unknown", "grok-4.3")).toBe("grok-4.3");
  });
});
