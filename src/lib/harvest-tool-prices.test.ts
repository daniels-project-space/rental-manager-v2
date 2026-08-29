import { describe, it, expect } from "vitest";
import { harvestToolPrices } from "./harvest-tool-prices";

/**
 * The guard only lets the bot quote a price it can trace to a tool result, and
 * this is the function that collects them. When it silently harvested nothing,
 * replies were blocked for UNGROUNDED_PRICE on turns where lookup_pricing had
 * been called three times and returned real numbers — the renter got silence
 * because the plumbing between the tool and the guard was broken, not because
 * anything was wrong with the answer.
 *
 * The shape below is Mastra's real one, copied from a live run: the payload is
 * nested under `payload`, NOT the `toolResults` key this used to read.
 */
describe("harvestToolPrices", () => {
  it("harvests prices from Mastra's nested payload shape", () => {
    const steps = [
      {
        type: "tool-result",
        runId: "9a17afb6",
        from: "AGENT",
        payload: {
          toolCallId: "call_992402",
          toolName: "lookup_pricing",
          result: { item: "Sony A7 III", daily_price_gbp: 26, days: 1 },
        },
      },
    ];
    const out: number[] = [];
    harvestToolPrices(steps, out);
    expect(out).toContain(26);
  });

  it("still handles the older flat toolResults shape", () => {
    const out: number[] = [];
    harvestToolPrices([{ toolResults: [{ daily_price_gbp: 30 }] }], out);
    expect(out).toContain(30);
  });

  it("does NOT harvest from args — the model must not launder its own number", () => {
    // Whitelisting an argument would let the model invent £5, pass it to a
    // tool, and have the guard accept it back. That defeats the guard entirely.
    const steps = [
      {
        payload: {
          toolName: "lookup_pricing",
          args: { daily_price_gbp: 5, item_name: "Sony A7 V" },
          result: { daily_price_gbp: 30 },
        },
      },
    ];
    const out: number[] = [];
    harvestToolPrices(steps, out);
    expect(out).toContain(30);
    expect(out).not.toContain(5);
  });

  it("collects every price across multiple tool calls in one turn", () => {
    const steps = [
      { payload: { toolName: "lookup_pricing", result: { daily_price_gbp: 26 } } },
      { payload: { toolName: "lookup_pricing", result: { daily_price_gbp: 30 } } },
      { payload: { toolName: "lookup_pricing", result: { daily_price_gbp: 8 } } },
    ];
    const out: number[] = [];
    harvestToolPrices(steps, out);
    expect(out).toEqual(expect.arrayContaining([26, 30, 8]));
  });

  it("ignores non-price numbers", () => {
    const out: number[] = [];
    harvestToolPrices([{ payload: { result: { days: 3, product_id: 1114610 } } }], out);
    expect(out).toEqual([]);
  });

  it("terminates on a self-referential payload", () => {
    const inner: Record<string, unknown> = { daily_price_gbp: 42 };
    inner.self = inner;
    const out: number[] = [];
    harvestToolPrices([{ payload: { result: inner } }], out);
    expect(out).toContain(42);
  });

  it("survives empty and missing steps", () => {
    const out: number[] = [];
    harvestToolPrices(undefined, out);
    harvestToolPrices([], out);
    expect(out).toEqual([]);
  });
});
