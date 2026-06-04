/**
 * Phase 4 (CLI-takeover) — gate + dry-run airtightness tests for the GATED
 * core order-write route (`src/hygglo-core/order-writes.ts`).
 *
 * GOAL: prove that
 *   1. The feature gate (`USE_CORE_ORDER_WRITES`) defaults OFF.
 *   2. Dry-run is the DEFAULT, and a dry-run returns the intended action payload
 *      while making ZERO network calls (orders.* → hygglo-write.ts is never
 *      reached, so `global.fetch` is never called).
 *   3. A real write happens ONLY when dryRun is EXPLICITLY false — and even then
 *      the network is mocked here; no live Hygglo endpoint is touched.
 *   4. Unmapped actions return null (caller falls through to the legacy route).
 *
 * Strategy mirrors hygglo-write.test.ts: the auth layer is mocked (no vault /
 * network), and `global.fetch` is a vi.fn whose NON-invocation is the core
 * assertion for every dry-run / gated-off case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the auth layer so the (live-only) path can never hit the vault/network.
vi.mock("../lib/hygglo-auth", () => ({
  HYGGLO_API_BASE: "https://api.hygglo.com/api",
  getAccountCredentials: vi.fn(async () => ({ email: "x@y.z", password: "p" })),
  getHyggloAccessToken: vi.fn(async () => "TEST_TOKEN"),
  hyggloAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
}));

import {
  coreOrderWrite,
  planCoreOrderWrite,
  useCoreOrderWrites,
  coreOrderWritesDryRun,
  isCoreRoutableAction,
} from "./order-writes";

const ACCT = "leo";
const ORDER = "3980371";

const ENV_KEYS = ["USE_CORE_ORDER_WRITES", "CORE_ORDER_WRITES_DRY_RUN", "READ_ONLY_MODE"] as const;
const SAVED: Record<string, string | undefined> = {};

function okFetch() {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => "{}" })) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe("env gates — default-safe posture", () => {
  it("useCoreOrderWrites() defaults OFF when unset", () => {
    expect(useCoreOrderWrites()).toBe(false);
  });
  it("useCoreOrderWrites() OFF unless literal 'true'", () => {
    process.env.USE_CORE_ORDER_WRITES = "1";
    expect(useCoreOrderWrites()).toBe(false);
    process.env.USE_CORE_ORDER_WRITES = "true";
    expect(useCoreOrderWrites()).toBe(true);
  });
  it("coreOrderWritesDryRun() defaults ON (true) when unset", () => {
    expect(coreOrderWritesDryRun()).toBe(true);
  });
  it("coreOrderWritesDryRun() stays ON unless literal 'false'", () => {
    process.env.CORE_ORDER_WRITES_DRY_RUN = "true";
    expect(coreOrderWritesDryRun()).toBe(true);
    process.env.CORE_ORDER_WRITES_DRY_RUN = "off"; // anything-but-"false" ⇒ ON
    expect(coreOrderWritesDryRun()).toBe(true);
    process.env.CORE_ORDER_WRITES_DRY_RUN = "false";
    expect(coreOrderWritesDryRun()).toBe(false);
  });
});

describe("isCoreRoutableAction", () => {
  it("recognises the six order actions; rejects chat/unknown", () => {
    for (const a of ["accept", "decline", "change_dates", "apply_discount", "change_owner_earnings", "remove_item"]) {
      expect(isCoreRoutableAction(a)).toBe(true);
    }
    expect(isCoreRoutableAction("send_message")).toBe(false);
    expect(isCoreRoutableAction("mark_picked_up")).toBe(false);
  });
});

describe("planCoreOrderWrite — pure intended-payload resolution", () => {
  it("maps each action to its verified wire verb + data", () => {
    expect(planCoreOrderWrite({ accountSlug: ACCT, action: "accept", orderId: ORDER, actionArgs: {} }))
      .toMatchObject({ wireVerb: "approve", data: {} });
    expect(planCoreOrderWrite({ accountSlug: ACCT, action: "decline", orderId: ORDER, actionArgs: { reason: "too far" } }))
      .toMatchObject({ wireVerb: "decline", data: { reason: "too far" } });
    expect(planCoreOrderWrite({ accountSlug: ACCT, action: "change_dates", orderId: ORDER, actionArgs: { startDate: "2026-07-01", endDate: "2026-07-03" } }))
      .toMatchObject({ wireVerb: "selectDates", data: { rentalStartDate: "2026-07-01", rentalEndDate: "2026-07-03" } });
    expect(planCoreOrderWrite({ accountSlug: ACCT, action: "apply_discount", orderId: ORDER, actionArgs: { amount: 100 } }))
      .toMatchObject({ wireVerb: "changePrice", data: { price: 100 } });
    expect(planCoreOrderWrite({ accountSlug: ACCT, action: "remove_item", orderId: ORDER, actionArgs: { itemId: 42 } }))
      .toMatchObject({ wireVerb: "removeItem", data: { itemId: 42 } });
  });
  it("returns null for unmapped actions", () => {
    expect(planCoreOrderWrite({ accountSlug: ACCT, action: "send_message", orderId: ORDER, actionArgs: {} })).toBeNull();
  });
  it("throws on missing orderId so dry-run surfaces the shape bug", () => {
    expect(() => planCoreOrderWrite({ accountSlug: ACCT, action: "accept", actionArgs: {} })).toThrow(/missing orderId/);
  });
});

describe("coreOrderWrite — DRY-RUN is default and makes NO network call", () => {
  it("returns the intended payload and never calls fetch (env default)", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock;
    const outcome = await coreOrderWrite({ accountSlug: ACCT, action: "accept", orderId: ORDER, actionArgs: {} });
    expect(outcome).not.toBeNull();
    expect(outcome!.mode).toBe("dry_run");
    expect(outcome!.executed).toBe(false);
    expect(outcome!.plan).toMatchObject({ wireVerb: "approve", accountSlug: ACCT, hyggloOrderId: ORDER, data: {} });
    expect(fetchMock).not.toHaveBeenCalled(); // CORE assertion: zero network
  });

  it("explicit dryRun:true ⇒ payload + no fetch", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock;
    const outcome = await coreOrderWrite({ accountSlug: ACCT, action: "decline", orderId: ORDER, actionArgs: { reason: "busy" }, dryRun: true });
    expect(outcome!.mode).toBe("dry_run");
    expect(outcome!.plan.data).toEqual({ reason: "busy" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gate OFF but unmapped action ⇒ null (caller uses legacy route)", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock;
    const outcome = await coreOrderWrite({ accountSlug: ACCT, action: "send_message", orderId: ORDER, actionArgs: {} });
    expect(outcome).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("coreOrderWrite — LIVE path only when dryRun EXPLICITLY false (network mocked)", () => {
  it("dryRun:false reaches orders.* → hygglo-write.ts and PATCHes (mocked fetch)", async () => {
    // READ_ONLY_MODE unset ⇒ hygglo-write.ts writesAllowed() is true. The
    // network is the mocked fetch — no live Hygglo endpoint is touched.
    const fetchMock = okFetch();
    global.fetch = fetchMock;
    const outcome = await coreOrderWrite({ accountSlug: ACCT, action: "accept", orderId: ORDER, actionArgs: {}, dryRun: false });
    expect(outcome!.mode).toBe("live");
    expect(outcome!.executed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain(`/v4/my/orders/${ORDER}`);
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ action: "approve", data: {} });
  });

  it("dryRun:false BUT READ_ONLY_MODE='true' ⇒ hygglo-write skips, still NO fetch", async () => {
    const fetchMock = okFetch();
    global.fetch = fetchMock;
    process.env.READ_ONLY_MODE = "true";
    const outcome = await coreOrderWrite({ accountSlug: ACCT, action: "accept", orderId: ORDER, actionArgs: {}, dryRun: false });
    expect(outcome!.mode).toBe("live"); // executor ran, but chokepoint skipped
    expect(outcome!.executed).toBe(true);
    expect((outcome as { result: { status: string } }).result.status).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled(); // READ_ONLY_MODE rail held
  });
});
