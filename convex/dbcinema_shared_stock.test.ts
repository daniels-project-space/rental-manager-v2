import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { registerRoutes: vi.fn(), safeGetAuthUser: vi.fn() }, createAuth: vi.fn() }));
import { process, reconcileMirroredBookingClaim } from "./dbcinema_shared_stock";
import { dbcinemaSharedStockWrite } from "./http";

function fixture() {
  const tables: Record<string, any[]> = {
    items: [{ _id: "lens", name_canonical: "Sony 24–70mm", status: "active", is_marketing_only: false, qty: 1 }],
    reservations: [], hygglo_product_index: [], listing_resolution_override: [], insurance_claims: [],
    owner_unavailability: [], vacation_periods: [], stock_approval_claims: [], dbcinema_shared_stock_claims: [],
  };
  let nextId = 0;
  const db: any = {
    query(table: string) {
      let rows = [...(tables[table] ?? [])];
      const query: any = {
        withIndex: (_name: string, filterRows: (q: any) => void) => {
          const filter: any = { eq: (key: string, value: unknown) => { rows = rows.filter(row => row[key] === value); return filter; } };
          filterRows(filter);
          return query;
        },
        collect: async () => rows,
        take: async (count: number) => rows.slice(0, count),
      };
      return query;
    },
    insert: async (table: string, value: any) => {
      const id = `row-${++nextId}`;
      tables[table].push({ ...value, _id: id });
      return id;
    },
    patch: async (id: string, value: any) => {
      const row = Object.values(tables).flat().find(item => item._id === id);
      if (!row) throw Error("missing row");
      Object.assign(row, value);
    },
  };
  return { tables, ctx: { db } as any };
}

const run = (ctx: any, request: unknown) => (process as any)._handler(ctx, { request });
const at = Date.parse("2027-01-01T10:00:00Z");
const acquire = (requestId: string) => ({ version: 1, operation: "acquire", args: { requestId, items: [{ itemId: "lens", start: at, returnAt: at + 86400000, quantity: 1 }] } });

afterEach(() => vi.unstubAllEnvs());

describe("DB Cinema shared stock bridge", () => {
  it("claims only net-new units in common availability and releases them idempotently", async () => {
    const f = fixture();
    const first = await run(f.ctx, acquire("swap-one"));
    expect(first.result.state).toBe("prepared");
    expect(first.result.fingerprint).toBe(JSON.stringify([["lens", at, at + 86400000 + 3600000, 1]]));
    expect(await run(f.ctx, acquire("swap-two"))).toEqual({ sharedStockError: "capacity_conflict" });

    const release = { version: 1, operation: "releasePrepared", args: { id: "swap-one", fingerprint: first.result.fingerprint, reason: "withdrawn_before_execution" } };
    expect((await run(f.ctx, release)).result.state).toBe("released");
    expect((await run(f.ctx, release)).result.replayed).toBe(true);
    expect((await run(f.ctx, acquire("swap-two"))).result.state).toBe("prepared");
  });

  it("rechecks stock before execution while excluding only its own prepared claim", async () => {
    const f = fixture();
    const acquired = await run(f.ctx, acquire("swap-recheck"));
    const external = { _id: "external-reservation", account_slug: "other", hygglo_order_id: "external-order", status: "confirmed", start_date: "2027-01-01", end_date: "2027-01-02", resolved_items: [{ item_id: "lens", item_name_canonical: "Sony 24–70mm", confidence: 1, qty: 1 }] };
    f.tables.reservations.push(external);
    const begin = { version: 1, operation: "beginExecution", args: { id: "swap-recheck", fingerprint: acquired.result.fingerprint, executionKey: "swap-execution-recheck" } };
    expect(await run(f.ctx, begin)).toEqual({ sharedStockError: "capacity_conflict" });
    expect(f.tables.dbcinema_shared_stock_claims[0].status).toBe("prepared");

    f.tables.reservations.splice(f.tables.reservations.indexOf(external), 1);
    expect((await run(f.ctx, begin)).result.state).toBe("execution_started");
  });

  it("keeps the existing booking's physical occupancy when checking a positive swap delta", async () => {
    const f = fixture();
    f.tables.reservations.push({ _id: "booking-reservation", account_slug: "dbcinema_web", hygglo_order_id: "booking-1", status: "confirmed", order_step: "APPROVED", site_revision: 2, start_date: "2027-01-01", end_date: "2027-01-02", resolved_items: [{ item_id: "lens", item_name_canonical: "Sony 24–70mm", confidence: 1, qty: 1 }] });
    const request = { version: 1, operation: "acquire", args: { requestId: "swap-same-item-delta", bookingId: "booking-1", items: [{ itemId: "lens", start: at, returnAt: at + 86400000, quantity: 1 }] } };
    expect(await run(f.ctx, request)).toEqual({ sharedStockError: "capacity_conflict" });
    expect(f.tables.dbcinema_shared_stock_claims).toHaveLength(0);
  });

  it("rechecks positive deltas against the original booking at settlement", async () => {
    const f = fixture();
    f.tables.items[0].qty = 3;
    f.tables.reservations.push({ _id: "booking-reservation", account_slug: "dbcinema_web", hygglo_order_id: "booking-1", status: "confirmed", order_step: "APPROVED", site_revision: 2, start_date: "2027-01-01", end_date: "2027-01-02", resolved_items: [{ item_id: "lens", item_name_canonical: "Sony 24–70mm", confidence: 1, qty: 1 }] });
    const request = { version: 1, operation: "acquire", args: { requestId: "swap-race-delta", bookingId: "booking-1", items: [{ itemId: "lens", start: at, returnAt: at + 86400000, quantity: 1 }] } };
    const acquired = await run(f.ctx, request);
    expect(acquired.result.state).toBe("prepared");
    const begin = { version: 1, operation: "beginExecution", args: { id: "swap-race-delta", fingerprint: acquired.result.fingerprint, executionKey: "swap-race-execution" } };
    expect((await run(f.ctx, begin)).result.state).toBe("execution_started");

    f.tables.reservations.push({ _id: "external-reservation", account_slug: "other", hygglo_order_id: "external-order", status: "confirmed", start_date: "2027-01-01", end_date: "2027-01-02", resolved_items: [{ item_id: "lens", item_name_canonical: "Sony 24–70mm", confidence: 1, qty: 2 }] });
    const check = { version: 1, operation: "checkExecution", args: { id: "swap-race-delta", fingerprint: acquired.result.fingerprint, executionKey: "swap-race-execution" } };
    expect(await run(f.ctx, check)).toEqual({ sharedStockError: "capacity_conflict" });
    expect(f.tables.dbcinema_shared_stock_claims[0].status).toBe("execution_started");
  });

  it("rejects a zero-capacity claim that adds a physical stock unit", async () => {
    const f = fixture();
    const oldLine = { itemId: "lens", start: at, returnAt: at + 86400000, quantity: 1 };
    const newLine = { itemId: "lens", start: at, returnAt: at + 86400000, quantity: 2 };
    const request = { version: 1, operation: "acquireZero", args: { requestId: "swap-zero-unsafe", bookingId: "booking-unsafe", oldItems: [oldLine], newItems: [newLine] } };
    await expect(run(f.ctx, request)).rejects.toThrow(/cannot add stock/);
    expect(f.tables.dbcinema_shared_stock_claims).toHaveLength(0);
  });

  it("does not start execution until an exact zero-delta booking is present", async () => {
    const f = fixture();
    const window = { item_id: "lens", qty: 1, start: at, end: at + 86400000 };
    f.tables.reservations.push({ _id: "reservation-1", account_slug: "dbcinema_web", hygglo_order_id: "booking-1", status: "confirmed", order_step: "APPROVED", site_revision: 7, site_item_windows: [window] });
    const line = { itemId: "lens", start: at, returnAt: at + 86400000, quantity: 1 };
    const request = { version: 1, operation: "acquireZero", args: { requestId: "swap-zero", bookingId: "booking-1", oldItems: [line], newItems: [line] } };
    const acquired = await run(f.ctx, request);
    const begin = { version: 1, operation: "beginExecution", args: { id: "swap-zero", fingerprint: acquired.result.fingerprint, executionKey: "swap_execution_zero" } };
    expect((await run(f.ctx, begin)).result.state).toBe("execution_started");

    const receipt = { swapId: "swap-zero", bookingId: "booking-1", bookingRevision: 7, managerRequestId: "swap-zero", fingerprint: acquired.result.fingerprint, executionKey: "swap_execution_zero", appliedAt: at, windows: [{ managerItemId: "lens", start: at, end: at + 86400000, quantity: 1 }] };
    const checked = await run(f.ctx, { version: 1, operation: "checkConversion", args: { id: "swap-zero", fingerprint: acquired.result.fingerprint, executionKey: "swap_execution_zero", receipt } });
    expect(checked.result).toMatchObject({ state: "converted", stockRisk: false });
  });

  it("keeps an acquired claim when the site booking has not reached the recorded revision", async () => {
    const f = fixture();
    f.tables.items[0].qty = 2;
    const window = { item_id: "lens", qty: 1, start: at, end: at + 86400000 };
    const reservation = { _id: "reservation-1", account_slug: "dbcinema_web", hygglo_order_id: "booking-1", status: "confirmed", order_step: "APPROVED", site_revision: 6, site_item_windows: [window] };
    f.tables.reservations.push(reservation);
    const line = { itemId: "lens", start: at, returnAt: at + 86400000, quantity: 1 };
    const acquired = await run(f.ctx, acquire("swap-claim"));
    const begin = { version: 1, operation: "beginExecution", args: { id: "swap-claim", fingerprint: acquired.result.fingerprint, executionKey: "exec-claim" } };
    await run(f.ctx, begin);
    const receipt = { swapId: "swap-claim", bookingId: "booking-1", bookingRevision: 7, managerRequestId: "swap-claim", fingerprint: acquired.result.fingerprint, executionKey: "exec-claim", appliedAt: at, windows: [{ managerItemId: "lens", start: at, end: at + 86400000, quantity: 2 }] };
    const checked = await run(f.ctx, { version: 1, operation: "checkConversion", args: { id: "swap-claim", fingerprint: acquired.result.fingerprint, executionKey: "exec-claim", receipt } });
    expect(checked.result).toMatchObject({ state: "converted", stockRisk: true });
    expect(f.tables.dbcinema_shared_stock_claims[0].holds_stock).toBe(true);
    expect(f.tables.dbcinema_shared_stock_claims[0].booking_id).toBe("booking-1");

    reservation.site_revision = 7;
    reservation.site_item_windows = [{ ...window, qty: 2 }];
    const retried = await run(f.ctx, { version: 1, operation: "checkConversion", args: { id: "swap-claim", fingerprint: acquired.result.fingerprint, executionKey: "exec-claim", receipt } });
    expect(retried.result).toMatchObject({ state: "converted", stockRisk: false, replayed: true });
    expect(f.tables.dbcinema_shared_stock_claims[0].holds_stock).toBe(false);
    await expect(run(f.ctx, { version: 1, operation: "checkConversion", args: { id: "swap-claim", fingerprint: acquired.result.fingerprint, executionKey: "exec-claim", receipt: { ...receipt, appliedAt: at + 1 } } })).rejects.toThrow(/evidence changed/);
  });

  it("does not replay a compensated release with different refund evidence", async () => {
    const f = fixture();
    f.tables.items.push({ _id: "camera", name_canonical: "Synthetic camera", status: "active", is_marketing_only: false, qty: 1 });
    f.tables.reservations.push({ _id: "booking-reservation", account_slug: "dbcinema_web", hygglo_order_id: "booking-1", status: "confirmed", order_step: "APPROVED", site_revision: 2, start_date: "2027-01-01", end_date: "2027-01-02", site_item_windows: [{ item_id: "lens", qty: 1, start: at, end: at + 86400000 }] });
    const acquired = await run(f.ctx, { version: 1, operation: "acquire", args: { requestId: "swap-compensated", bookingId: "booking-1", items: [{ itemId: "camera", start: at, returnAt: at + 86400000, quantity: 1 }] } });
    const begin = { version: 1, operation: "beginExecution", args: { id: "swap-compensated", fingerprint: acquired.result.fingerprint, executionKey: "execution-compensated" } };
    await run(f.ctx, begin);
    const evidence = { swapId: "swap-compensated", bookingId: "booking-1", bookingRevision: 2, paymentIntentId: "pi-original", refundId: "re-original", refundStatus: "succeeded", amountPence: 500, refundAttemptedAt: at, windows: [{ itemId: "lens", start: at, end: at + 86400000, quantity: 1 }] };
    const release = { version: 1, operation: "releaseCompensated", args: { id: "swap-compensated", fingerprint: acquired.result.fingerprint, executionKey: "execution-compensated", evidence } };
    expect((await run(f.ctx, release)).result.state).toBe("compensated_released");
    expect((await run(f.ctx, release)).result.replayed).toBe(true);
    await expect(run(f.ctx, { ...release, args: { ...release.args, evidence: { ...evidence, refundId: "replaced-refund" } } })).rejects.toThrow(/evidence changed/);
  });

  it("authenticates the private route and returns the strict receipt shape", async () => {
    const f = fixture();
    const secret = "a-secure-shared-stock-secret-with-32-bytes";
    const request = (token?: string) => new Request("https://manager.convex.site/dbcinema/shared-stock", {
      method: "POST",
      headers: { ...(token ? { "x-shared-stock-token": token } : {}), "content-type": "application/json" },
      body: JSON.stringify(acquire("swap-http")),
    });
    const context = { runMutation: async (_ref: any, args: any) => run(f.ctx, args.request) };
    expect((await (dbcinemaSharedStockWrite as any)._handler(context, request(secret))).status).toBe(503);
    vi.stubEnv("DBCINEMA_SHARED_STOCK_SECRET", secret);
    expect((await (dbcinemaSharedStockWrite as any)._handler(context, request("wrong-token"))).status).toBe(401);
    const response = await (dbcinemaSharedStockWrite as any)._handler(context, request(secret));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: 1,
      operation: "acquire",
      request: { requestId: "swap-http", source: "website" },
      result: { state: "prepared", replayed: false },
    });
  });

  it("returns the site's exact typed capacity-conflict response", async () => {
    const f = fixture();
    const secret = "a-secure-shared-stock-secret-with-32-bytes";
    vi.stubEnv("DBCINEMA_SHARED_STOCK_SECRET", secret);
    await run(f.ctx, acquire("swap-occupies-only-unit"));
    const conflictRequest = acquire("swap-competing-for-only-unit");
    const request = new Request("https://manager.convex.site/dbcinema/shared-stock", {
      method: "POST",
      headers: { "x-shared-stock-token": secret, "content-type": "application/json" },
      body: JSON.stringify(conflictRequest),
    });
    const context = { runMutation: async (_ref: any, args: any) => run(f.ctx, args.request) };
    const response = await (dbcinemaSharedStockWrite as any)._handler(context, request);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ version: 1, operation: "acquire", error: "capacity_conflict" });
  });

  it("releases a paid booking claim only after the authoritative site windows match", async () => {
    const f = fixture();
    const acquired = await run(f.ctx, acquire("booking_booking-1"));
    await run(f.ctx, { version: 1, operation: "beginExecution", args: { id: "booking_booking-1", fingerprint: acquired.result.fingerprint, executionKey: "booking-execution" } });
    const booking = {
      _id: "reservation-1", account_slug: "dbcinema_web", hygglo_order_id: "booking-1",
      status: "confirmed", site_revision: 3,
      site_item_windows: [{ item_id: "lens", qty: 1, start: at, end: at + 86400000 }],
    };
    expect(f.tables.dbcinema_shared_stock_claims[0].booking_id).toBe("booking-1");
    expect(await reconcileMirroredBookingClaim(f.ctx, { ...booking, site_item_windows: [{ ...booking.site_item_windows[0], item_id: "another-lens" }] })).toBe(0);
    expect(f.tables.dbcinema_shared_stock_claims[0].holds_stock).toBe(true);
    expect(await reconcileMirroredBookingClaim(f.ctx, booking)).toBe(1);
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({ status: "converted", holds_stock: false, reservation_id: "reservation-1" });
  });

  it("releases a swap claim when its new item is present alongside unchanged booking items", async () => {
    const f = fixture();
    f.tables.items.push({ _id: "camera", name_canonical: "Synthetic camera", status: "active", is_marketing_only: false, qty: 1 });
    const lensWindow = { item_id: "lens", qty: 1, start: at, end: at + 86400000 };
    const reservation = { _id: "reservation-multi", account_slug: "dbcinema_web", hygglo_order_id: "booking-multi", status: "confirmed", order_step: "BOOKED_AFTER_VERIFIED", site_revision: 4, site_item_windows: [lensWindow] };
    f.tables.reservations.push(reservation);
    const acquired = await run(f.ctx, { version: 1, operation: "acquire", args: { requestId: "swap_multi", bookingId: "booking-multi", items: [{ itemId: "camera", start: at, returnAt: at + 86400000, quantity: 1 }] } });
    await run(f.ctx, { version: 1, operation: "beginExecution", args: { id: "swap_multi", fingerprint: acquired.result.fingerprint, executionKey: "swap-execution-multi" } });

    expect(await reconcileMirroredBookingClaim(f.ctx, reservation)).toBe(0);
    expect(f.tables.dbcinema_shared_stock_claims[0].holds_stock).toBe(true);
    const converted = { ...reservation, site_item_windows: [...reservation.site_item_windows, { item_id: "camera", qty: 1, start: at, end: at + 86400000 }] };
    expect(await reconcileMirroredBookingClaim(f.ctx, converted)).toBe(1);
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({ status: "converted", holds_stock: false, reservation_id: "reservation-multi" });
  });

  it("returns the exact stock acknowledgement for a converted booking receipt and safely replays it", async () => {
    const f = fixture();
    f.tables.items[0].qty = 2;
    f.tables.items.push({ _id: "camera", name_canonical: "Synthetic camera", status: "active", is_marketing_only: false, qty: 1 });
    f.tables.reservations.push({ _id: "reservation-ack", account_slug: "dbcinema_web", hygglo_order_id: "booking-ack", status: "confirmed", order_step: "BOOKED_AFTER_VERIFIED", site_revision: 4, site_item_windows: [{ item_id: "camera", qty: 1, start: at, end: at + 86400000 }] });
    const acquired = await run(f.ctx, { version: 1, operation: "acquire", args: { requestId: "swap_ack", bookingId: "booking-ack", items: [{ itemId: "lens", start: at, returnAt: at + 86400000, quantity: 1 }] } });
    await run(f.ctx, { version: 1, operation: "beginExecution", args: { id: "swap_ack", fingerprint: acquired.result.fingerprint, executionKey: "swap_execution_ack" } });
    const receipt = { swapId: "ack", bookingId: "booking-ack", bookingRevision: 5, managerRequestId: "swap_ack", fingerprint: acquired.result.fingerprint, executionKey: "swap_execution_ack", appliedAt: at, windows: [{ managerItemId: "lens", start: at, end: at + 86400000, quantity: 1 }] };
    const booking = { _id: "reservation-ack", account_slug: "dbcinema_web", hygglo_order_id: "booking-ack", status: "confirmed", site_revision: 6, site_item_windows: [{ item_id: "lens", qty: 1, start: at, end: at + 86400000 }] };
    const acknowledgement = { swapId: "ack", managerRequestId: "swap_ack", fingerprint: acquired.result.fingerprint, executionKey: "swap_execution_ack", bookingRevision: 5 };
    Object.assign(f.tables.reservations.find(row => row._id === "reservation-ack"), booking);
    expect(await reconcileMirroredBookingClaim(f.ctx, booking, receipt)).toEqual(acknowledgement);
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({ status: "converted", holds_stock: false, reservation_id: "reservation-ack" });
    expect(await reconcileMirroredBookingClaim(f.ctx, booking, receipt)).toEqual(acknowledgement);
    await expect(reconcileMirroredBookingClaim(f.ctx, booking, { ...receipt, fingerprint: "changed" })).rejects.toThrow(/does not match/);

    const check = { version: 1, operation: "checkConversion", args: { id: "swap_ack", fingerprint: acquired.result.fingerprint, executionKey: "swap_execution_ack", receipt } };
    const external = { _id: "external-overlap", account_slug: "other", hygglo_order_id: "external-overlap", status: "confirmed", start_date: "2027-01-01", end_date: "2027-01-01", resolved_items: [{ item_id: "lens", item_name_canonical: "Sony 24–70mm", confidence: 1, qty: 2 }] };
    f.tables.reservations.push(external);
    expect((await run(f.ctx, check)).result).toMatchObject({ state: "converted", stockRisk: true });
    f.tables.reservations.splice(f.tables.reservations.indexOf(external), 1);
    expect((await run(f.ctx, check)).result).toMatchObject({ state: "converted", stockRisk: false, replayed: true });
  });
});
