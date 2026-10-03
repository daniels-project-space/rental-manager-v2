import { describe, expect, it } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { createRequestConvexClient, withConvexClientFactory } from "./convex-request-context";

describe("request Convex identity propagation", () => {
  it("fails closed outside a server request", () => {
    expect(() => createRequestConvexClient()).toThrow("Missing server request Convex identity");
  });

  it("keeps concurrent and nested identities separate across asynchronous tools", async () => {
    const url = "https://hearty-oyster-600.convex.cloud";
    const first = new ConvexHttpClient(url), second = new ConvexHttpClient(url);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const one = withConvexClientFactory(() => first, async () => {
      await barrier;
      expect(createRequestConvexClient()).toBe(first);
      await withConvexClientFactory(() => second, async () => {
        await Promise.resolve();
        expect(createRequestConvexClient()).toBe(second);
      });
      expect(createRequestConvexClient()).toBe(first);
    });
    const two = withConvexClientFactory(() => second, async () => {
      expect(createRequestConvexClient()).toBe(second);
      release();
      await one;
      expect(createRequestConvexClient()).toBe(second);
    });
    await Promise.all([one, two]);
    expect(() => createRequestConvexClient()).toThrow();
  });
});
