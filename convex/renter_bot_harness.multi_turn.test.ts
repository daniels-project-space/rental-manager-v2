import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { getFunctionName } from "convex/server";
import { api, internal } from "./_generated/api";
import { runBatch, runFixture, runMultiTurnScenario } from "./renter_bot_harness";

const functionName = (reference: unknown) => getFunctionName(reference as never);
const labSecret = "test-lab-secret";
const authMarker = "lab-auth-v1:" + createHash("sha256").update(labSecret).digest("hex");
type TestContext = {
  runQuery: (reference: unknown, args: Record<string, unknown>) => Promise<unknown>;
  runMutation: (reference: unknown, args: Record<string, unknown>) => Promise<unknown>;
  runAction: (reference: unknown, args: Record<string, unknown>) => Promise<unknown>;
};
type ScenarioResult = {
  threadId: string;
  order_before: unknown;
  order_after: unknown;
  turnResults: Array<{
    draft: string;
    runId?: string;
    order_after: unknown;
    escalated: boolean;
    turn_status: "ok" | "skipped" | "running";
    failure_reason?: string;
    generation_error?: unknown;
  }>;
};
const runScenario = (ctx: TestContext, args: typeof scenario) =>
  (runMultiTurnScenario as unknown as {
    _handler: (context: TestContext, input: typeof scenario) => Promise<ScenarioResult>;
  })._handler(ctx, args);

function harnessContext(generate: (args: Record<string, unknown>) => unknown) {
  const mutations: Array<{ reference: unknown; args: Record<string, unknown> }> = [];
  const actions: Array<{ reference: unknown; args: Record<string, unknown> }> = [];
  let orderRevision = 0;
  const ctx: TestContext = {
    runQuery: vi.fn(async (reference: unknown) => {
      if (functionName(reference) !== functionName(internal.renter_bot_lab_order.__service_get)) {
        throw new Error(`Unexpected query ${functionName(reference)}`);
      }
      return { revision: orderRevision++ };
    }),
    runMutation: vi.fn(async (reference: unknown, args: Record<string, unknown>) => {
      mutations.push({ reference, args });
      if (functionName(reference) === functionName(internal.renter_bot_lab_actions.appendRenterMessage)) {
        return `${args.thread_id}-turn-${args.turn_id}`;
      }
      return true;
    }),
    runAction: vi.fn(async (reference: unknown, args: Record<string, unknown>) => {
      actions.push({ reference, args });
      if (functionName(reference) === functionName(internal.renter_bot_lab_actions.__service_startLiveSession)) {
        return { threadId: "__probe__lab-started" };
      }
      return generate(args);
    }),
  };
  return { ctx, mutations, actions };
}

const scenario = {
  auth_marker: authMarker,
  scenarioId: "diogo-sony-fx3-kit",
  turns: ["Is the pickup area correct?", "Can I change the dates?"],
};

describe("multi-turn Lab harness contract", () => {
  beforeEach(() => {
    vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "local");
    vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "false");
    vi.stubEnv("RENTER_BOT_LAB_API_SECRET", labSecret);
    vi.stubEnv("RENTER_BOT_LAB_AUTH_CONFIG_VERSION", authMarker);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("routes every turn through the shared atomic message-and-claim finalizer", async () => {
    const { ctx, mutations, actions } = harnessContext((args) => ({
      status: "ok",
      draft: `Reply to ${String(args.text)}`,
      overall_status: "pass",
      rubric_results: [],
      productionGuardFlags: [],
      runId: `run-${String(args.turnId)}`,
    }));

    const result = await runScenario(ctx, scenario);

    const start = actions.find((call) => functionName(call.reference) === functionName(internal.renter_bot_lab_actions.__service_startLiveSession));
    const turns = actions.filter((call) => functionName(call.reference) === functionName(api.renter_bot_lab_actions.runTestTurn));
    expect(start?.args).toMatchObject({ accountSlug: "diogo", scenarioId: "diogo-sony-fx3-kit", lifecycle: "awaiting_owner_approval" });
    expect(start?.args.items).toEqual([expect.any(String)]);
    expect(start?.args.startDate).toEqual(expect.any(String));
    expect(start?.args.endDate).toEqual(expect.any(String));
    expect(turns).toHaveLength(2);
    expect(turns.every((call) => call.args.requestMessageId === undefined)).toBe(true);
    expect(turns.every((call) => call.args.triggeredBy === "harness_batch")).toBe(true);
    expect(turns.every((call) => call.args.auth_marker === authMarker)).toBe(true);
    expect(mutations.some((call) => functionName(call.reference) === functionName(internal.renter_bot_lab_actions.appendRenterMessage))).toBe(false);
    expect(mutations.some((call) => functionName(call.reference) === functionName(internal.renter_bot_lab_actions.__service_claimTestTurn))).toBe(false);
    expect(mutations.some((call) => functionName(call.reference) === functionName(internal.renter_bot_lab_actions.__service_finishTestTurn))).toBe(false);
    expect(result.turnResults.map((turn: { draft: string }) => turn.draft)).toEqual([
      "Reply to Is the pickup area correct?",
      "Reply to Can I change the dates?",
    ]);
    expect(result.order_before).toEqual({ revision: 0 });
    expect(result.turnResults.map((turn) => turn.order_after)).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect(result.order_after).toEqual({ revision: 3 });
    expect(mutations.some((call) => functionName(call.reference) === functionName(internal.renter_bot_probe.__service_cleanup))).toBe(false);
  });

  it("preserves failed generation evidence and stops before fabricating later turns", async () => {
    const { ctx, mutations, actions } = harnessContext(() => ({
      status: "skipped", reason: "canonical_generation_upstream_unavailable", draft: "",
      overall_status: "flag", rubric_results: [], productionGuardFlags: [],
      generation_error: { error_code: "upstream_unavailable", http_status: 503 },
      runId: "failed-run-1",
    }));

    const result = await runScenario(ctx, { ...scenario, turns: ["hello", "Can I change the dates?"] });

    expect(result.turnResults).toHaveLength(1);
    expect(result.turnResults[0]).toMatchObject({
      escalated: false,
      turn_status: "skipped",
      failure_reason: "canonical_generation_upstream_unavailable",
      generation_error: { error_code: "upstream_unavailable", http_status: 503 },
    });
    expect(result.turnResults[0].runId).toBe("failed-run-1");
    expect(actions.filter((call) => functionName(call.reference) === functionName(api.renter_bot_lab_actions.runTestTurn))).toHaveLength(1);
    expect(mutations.some((call) => functionName(call.reference) === functionName(internal.renter_bot_probe.__service_cleanup))).toBe(false);
  });

  it("routes seeded fixture conversations through the same public Lab turn contract", async () => {
    const fixture = {
      _id: "fixture-1",
      account_slug: "diogo",
      seed_context: { items: ["Sony FX3"] },
      messages: [{ role: "renter", text: "Can I change the dates?" }],
      scenario_type: "rental_question",
      active: true,
    };
    const actions: Array<{ reference: unknown; args: Record<string, unknown> }> = [];
    const mutations: Array<{ reference: unknown; args: Record<string, unknown> }> = [];
    const ctx: TestContext = {
      runQuery: vi.fn(async (reference: unknown) => {
        const name = functionName(reference);
        if (name === functionName(internal.renter_bot_harness.getFixture)) return fixture;
        if (name === functionName(internal.renter_bot_lab_actions.getLatestRenterMessageForThread)) {
          return { account_slug: "diogo", message_id: "fixture-final-message", body_text: "Can I change the dates?" };
        }
        throw new Error(`Unexpected fixture query ${name}`);
      }),
      runMutation: vi.fn(async (reference: unknown, args: Record<string, unknown>) => {
        mutations.push({ reference, args });
        return null;
      }),
      runAction: vi.fn(async (reference: unknown, args: Record<string, unknown>) => {
        actions.push({ reference, args });
        if (functionName(reference) === functionName(api.renter_bot_lab_actions.startLiveSession)) {
          return { threadId: "__probe__fixture-session" };
        }
        return {
          status: "ok", runId: "run-fixture-1", overall_status: "pass", draft: "Sure, what dates do you need?",
        };
      }),
    };

    const result = await (runFixture as unknown as {
      _handler: (context: TestContext, input: Record<string, unknown>) => Promise<{ threadId: string; runId: string; overall_status: string }>;
    })._handler(ctx, { auth_marker: authMarker, fixtureId: "fixture-1" });

    expect(result).toEqual({ threadId: "__probe__fixture-session", runId: "run-fixture-1", overall_status: "pass" });
    expect(actions).toHaveLength(2);
    expect(functionName(actions[0].reference)).toBe(functionName(api.renter_bot_lab_actions.startLiveSession));
    expect(actions[0].args).toMatchObject({ accountSlug: "diogo", fixtureId: "fixture-1" });
    expect(functionName(actions[1].reference)).toBe(functionName(api.renter_bot_lab_actions.runTestTurn));
    expect(actions[1].args).toMatchObject({
      auth_marker: authMarker,
      threadId: "__probe__fixture-session",
      accountSlug: "diogo",
      text: "Can I change the dates?",
      requestMessageId: "fixture-final-message",
      fixtureId: "fixture-1",
      triggeredBy: "harness_batch",
    });
    expect(mutations.some((call) => functionName(call.reference) === functionName(internal.renter_bot_probe.seed))).toBe(false);
    expect(mutations.some((call) => functionName(call.reference) === functionName(internal.renter_bot_probe.__service_cleanup))).toBe(false);
  });

  it("returns thread and run identifiers from fixture batches so results can be reopened", async () => {
    const actions: Array<{ reference: unknown; args: Record<string, unknown> }> = [];
    const ctx: TestContext = {
      runQuery: vi.fn(async () => []),
      runMutation: vi.fn(async () => null),
      runAction: vi.fn(async (reference: unknown, args: Record<string, unknown>) => {
        actions.push({ reference, args });
        return { threadId: "__probe__fixture-session", runId: "run-fixture-1", overall_status: "flag" };
      }),
    };
    const result = await (runBatch as unknown as {
      _handler: (context: TestContext, input: Record<string, unknown>) => Promise<unknown>;
    })._handler(ctx, { auth_marker: authMarker, fixtureIds: ["fixture-1"] });

    expect(result).toMatchObject({ results: [{
      fixtureId: "fixture-1",
      threadId: "__probe__fixture-session",
      runId: "run-fixture-1",
      overall_status: "flag",
    }] });
    expect(actions[0].args).toMatchObject({ fixtureId: "fixture-1", auth_marker: authMarker });
  });
});
