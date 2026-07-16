/**
 * Phase 4 — gate-airtightness tests for the Hygglo REST write chokepoint.
 *
 * GOAL: prove that NO operator order-edit PATCH can leave the process unless
 * the deliberate-action gate is explicitly allowed, and that when it is allowed the wire shape (method /
 * path / body) exactly matches the verified Hygglo dispatcher schema.
 *
 * Strategy:
 *   - `./hygglo-auth` is mocked so the credential/token resolution never hits
 *     the vault or the network (deterministic Bearer "TEST_TOKEN").
 *   - `global.fetch` is a vi.fn(). The CORE assertion in every "gated OFF" case
 *     is `expect(fetch).not.toHaveBeenCalled()` — i.e. the gate short-circuits
 *     BEFORE a request object is ever constructed.
 *   - Action verbs are pinned to the values read out of the 422 union-probe
 *     (`/home/ubuntu/hygglo-probe/out/disp_real_*.json`):
 *       accepted-order date edit → action "changeDates"
 *       changePrice → action "changePrice"
 *       removeItem  → action "removeItem", data.itemId is a NUMBER.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the auth layer so no vault / network call happens ──────────────────
vi.mock("./hygglo-auth", () => ({
  HYGGLO_API_BASE: "https://api.hygglo.com/api",
  getAccountCredentials: vi.fn(async () => ({ email: "x@y.z", password: "p" })),
  getHyggloAccessToken: vi.fn(async () => "TEST_TOKEN"),
  hyggloAuthHeaders: (token: string) => ({
    Authorization: `Bearer ${token}`,
    Country: "GB",
    "User-Client": "Hygglo-web",
  }),
}));

import {
  manualApproveOrder,
  manualDeclineOrder,
  changeOrderDates,
  changeOrderPrice,
  removeOrderItem,
  sendMessage,
} from "./hygglo-write";

const ACCT = "leo";
const ORDER = "3980371";
const EXPECTED_PATH =
  "https://api.hygglo.com/api/v4/my/orders/3980371?timezone=Europe%2FLondon";

/** A fetch mock that returns an OK JSON response. */
function okFetch() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => "{}",
  })) as unknown as typeof fetch;
}

/** Parse the body the writer handed to fetch (call N, defaults to first). */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const init = fetchMock.mock.calls[call][1] as RequestInit;
  return JSON.parse(init.body as string);
}

const ORIGINAL_RO = process.env.READ_ONLY_MODE;
const ORIGINAL_MANUAL_ACTIONS = process.env.ALLOW_MANUAL_ORDER_ACTIONS;
const ORIGINAL_AUTO_SEND = process.env.ALLOW_HYGGLO_SEND;

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => {
  if (ORIGINAL_RO === undefined) delete process.env.READ_ONLY_MODE;
  else process.env.READ_ONLY_MODE = ORIGINAL_RO;
  if (ORIGINAL_MANUAL_ACTIONS === undefined) delete process.env.ALLOW_MANUAL_ORDER_ACTIONS;
  else process.env.ALLOW_MANUAL_ORDER_ACTIONS = ORIGINAL_MANUAL_ACTIONS;
  if (ORIGINAL_AUTO_SEND === undefined) delete process.env.ALLOW_HYGGLO_SEND;
  else process.env.ALLOW_HYGGLO_SEND = ORIGINAL_AUTO_SEND;
});

describe("automated renter replies are permanently draft-only", () => {
  it("sendMessage never reaches fetch even when every legacy write gate is open", async () => {
    delete process.env.READ_ONLY_MODE;
    process.env.ALLOW_HYGGLO_SEND = "true";
    const f = okFetch();
    global.fetch = f;
    const result = await sendMessage({
      accountSlug: ACCT,
      conversationId: ORDER,
      text: "This must remain a draft",
    });
    expect(result).toEqual({
      status: "skipped",
      reason: "AUTOMATED_MESSAGE_SEND_DISABLED",
    });
    expect(f).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
//  (a) GATED OFF  ⇒  skipped + fetch NEVER called
// ════════════════════════════════════════════════════════════════════════
describe("gate airtight: manual order actions disabled ⇒ no fetch", () => {
  beforeEach(() => {
    process.env.ALLOW_MANUAL_ORDER_ACTIONS = "false";
  });

  it("changeOrderDates is skipped and never calls fetch", async () => {
    const f = okFetch();
    global.fetch = f;
    const res = await changeOrderDates({
      accountSlug: ACCT,
      hyggloOrderId: ORDER,
      rentalStartDate: "2026-06-10",
      rentalEndDate: "2026-06-12",
    });
    expect(res).toEqual({ status: "skipped", reason: "MANUAL_ACTION_DISABLED" });
    expect(f).not.toHaveBeenCalled();
  });

  it("changeOrderPrice is skipped and never calls fetch", async () => {
    const f = okFetch();
    global.fetch = f;
    const res = await changeOrderPrice({
      accountSlug: ACCT,
      hyggloOrderId: ORDER,
      price: 99,
    });
    expect(res).toEqual({ status: "skipped", reason: "MANUAL_ACTION_DISABLED" });
    expect(f).not.toHaveBeenCalled();
  });

  it("removeOrderItem is skipped and never calls fetch", async () => {
    const f = okFetch();
    global.fetch = f;
    const res = await removeOrderItem({
      accountSlug: ACCT,
      hyggloOrderId: ORDER,
      itemId: 4054569,
    });
    expect(res).toEqual({ status: "skipped", reason: "MANUAL_ACTION_DISABLED" });
    expect(f).not.toHaveBeenCalled();
  });

  it("manual approve + decline are also skipped (no fetch)", async () => {
    const f = okFetch();
    global.fetch = f;
    const a = await manualApproveOrder({ accountSlug: ACCT, hyggloOrderId: ORDER });
    const d = await manualDeclineOrder({ accountSlug: ACCT, hyggloOrderId: ORDER });
    expect(a.status).toBe("skipped");
    expect(d.status).toBe("skipped");
    expect(f).not.toHaveBeenCalled();
  });

  it("no number of calls bypasses the dedicated operator gate", async () => {
    const f = okFetch();
    global.fetch = f;
    await changeOrderDates({ accountSlug: ACCT, hyggloOrderId: ORDER, rentalStartDate: "a", rentalEndDate: "b" });
    await changeOrderPrice({ accountSlug: ACCT, hyggloOrderId: ORDER, price: 1 });
    await removeOrderItem({ accountSlug: ACCT, hyggloOrderId: ORDER, itemId: 1 });
    expect(f).toHaveBeenCalledTimes(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
//  (b) WRITES ALLOWED  ⇒  exact method / path / body
// ════════════════════════════════════════════════════════════════════════
describe("when manual order actions are allowed ⇒ exact wire shape", () => {
  beforeEach(() => {
    process.env.ALLOW_MANUAL_ORDER_ACTIONS = "true";
  });

  it("changeOrderDates → PATCH changeDates {rentalStartDate,rentalEndDate}", async () => {
    const f = okFetch() as unknown as ReturnType<typeof vi.fn>;
    global.fetch = f as unknown as typeof fetch;
    const res = await changeOrderDates({
      accountSlug: ACCT,
      hyggloOrderId: ORDER,
      rentalStartDate: "2026-06-10",
      rentalEndDate: "2026-06-12",
    });
    expect(res.status).toBe("sent");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(EXPECTED_PATH);
    expect(init.method).toBe("PATCH");
    expect(bodyOf(f)).toEqual({
      action: "changeDates",
      data: { rentalStartDate: "2026-06-10", rentalEndDate: "2026-06-12" },
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer TEST_TOKEN");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("changeOrderPrice → PATCH changePrice {price:number}", async () => {
    const f = okFetch() as unknown as ReturnType<typeof vi.fn>;
    global.fetch = f as unknown as typeof fetch;
    const res = await changeOrderPrice({ accountSlug: ACCT, hyggloOrderId: ORDER, price: 4500 });
    expect(res.status).toBe("sent");
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(EXPECTED_PATH);
    expect(init.method).toBe("PATCH");
    expect(bodyOf(f)).toEqual({ action: "changePrice", data: { price: 4500 } });
  });

  it("removeOrderItem → PATCH removeItem {itemId:number}", async () => {
    const f = okFetch() as unknown as ReturnType<typeof vi.fn>;
    global.fetch = f as unknown as typeof fetch;
    const res = await removeOrderItem({ accountSlug: ACCT, hyggloOrderId: ORDER, itemId: 4054569 });
    expect(res.status).toBe("sent");
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(EXPECTED_PATH);
    expect(init.method).toBe("PATCH");
    const body = bodyOf(f);
    expect(body).toEqual({ action: "removeItem", data: { itemId: 4054569 } });
    // itemId MUST be a number on the wire (probe: string ⇒ 422).
    expect(typeof body.data.itemId).toBe("number");
  });

  it("non-OK response ⇒ failed result with sliced body, still one fetch", async () => {
    const f = vi.fn(async () => ({
      ok: false,
      status: 422,
      text: async () => "x".repeat(900),
    })) as unknown as ReturnType<typeof vi.fn>;
    global.fetch = f as unknown as typeof fetch;
    const res = await changeOrderPrice({ accountSlug: ACCT, hyggloOrderId: ORDER, price: 1 });
    expect(res.status).toBe("failed");
    expect(res.httpStatus).toBe(422);
    expect((res.error ?? "").length).toBeLessThanOrEqual(500);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
