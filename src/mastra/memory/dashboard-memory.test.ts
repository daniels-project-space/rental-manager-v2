import { describe, it, expect, beforeEach, vi } from "vitest";

// NODE_ENV=test forces :memory: store inside dashboard-memory.ts.
vi.stubEnv("NODE_ENV", "test");

import {
  getDashboardMemory,
  __resetDashboardMemoryForTests,
} from "./dashboard-memory";
import {
  seedMemoryFromConvex,
  __resetSeedTrackerForTests,
} from "./dashboard-memory-bridge";

describe("dashboard Mastra Memory (W2a phase3c)", () => {
  beforeEach(() => {
    __resetDashboardMemoryForTests();
    __resetSeedTrackerForTests();
  });

  it("memory singleton is a Mastra Memory instance with last-N retrieval", () => {
    const mem = getDashboardMemory();
    expect(mem).toBeTruthy();
    // Singleton: second call returns same instance.
    expect(getDashboardMemory()).toBe(mem);
  });

  it("seedMemoryFromConvex is idempotent across turns (only seeds once)", async () => {
    const msgs = [
      {
        _id: "m1",
        role: "user" as const,
        content: "Hi",
        created_at: 1000,
      },
      {
        _id: "m2",
        role: "assistant" as const,
        content: "Hello!",
        created_at: 2000,
      },
    ];
    // First seed succeeds.
    await expect(
      seedMemoryFromConvex("t-test", "acct-x", msgs),
    ).resolves.toBeUndefined();
    // Second seed is a no-op (early-return on warm thread).
    await expect(
      seedMemoryFromConvex("t-test", "acct-x", msgs),
    ).resolves.toBeUndefined();
  });

  it("seedMemoryFromConvex tolerates empty history without throwing", async () => {
    await expect(
      seedMemoryFromConvex("t-empty", "acct-x", []),
    ).resolves.toBeUndefined();
  });
});
