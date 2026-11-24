import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { registerRoutes: vi.fn(), safeGetAuthUser: vi.fn() }, createAuth: vi.fn() }));
import { process, reconcileMirroredBookingClaim, releaseTerminalWebsiteBookingClaim } from "./dbcinema_shared_stock";
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
const paidBooking = (bookingId: string, revision = 3) => ({ version: 1, operation: "acquirePaidBooking", args: {
  requestId: `booking_${bookingId}`, bookingId, bookingRevision: revision, verificationState: "pending",
  paymentEvidence: { status: "succeeded", paymentIntentId: `pi_synthetic_${bookingId}`, paidAt: at },
  items: [{ itemId: "lens", start: at, returnAt: at + 86400000, quantity: 1 }],
} });

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

  it("releases a prepared claim when the renter declines before execution", async () => {
    const f = fixture();
    const first = await run(f.ctx, acquire("swap-renter-declined"));
    const release = {
      version: 1,
      operation: "releasePrepared",
      args: {
        id: "swap-renter-declined",
        fingerprint: first.result.fingerprint,
        reason: "renter_declined_before_execution",
      },
    };

    expect((await run(f.ctx, release)).result).toMatchObject({ state: "released", replayed: false });
    expect((await run(f.ctx, release)).result).toMatchObject({ state: "released", replayed: true });
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({ status: "released", holds_stock: false });
  });

  it("reserves stock for a paid booking while verification is pending", async () => {
    const f = fixture();
    const first = await run(f.ctx, paidBooking("pending-one"));
    expect(first).toMatchObject({ operation: "acquirePaidBooking", outcome: "execution_started", holdsStock: true, replayed: false });
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({
      request_id: "booking_pending-one", booking_id: "pending-one", status: "execution_started", holds_stock: true,
    });
    expect(await run(f.ctx, paidBooking("pending-two"))).toEqual({ sharedStockError: "capacity_conflict" });

    const replay = await run(f.ctx, paidBooking("pending-one"));
    expect(replay).toMatchObject({ outcome: "execution_started", holdsStock: true, replayed: true });
    await expect(run(f.ctx, { ...paidBooking("pending-one"), args: { ...paidBooking("pending-one").args, paymentEvidence: { status: "succeeded", paymentIntentId: "pi_changed", paidAt: at } } }))
      .rejects.toThrow(/stock changed/);
  });

  it("converts a paid pending-verification claim atomically when the matching confirmed booking imports without a swap receipt", async () => {
    const f = fixture();
    await run(f.ctx, paidBooking("verified-auto", 3));
    const booking = {
      _id: "reservation-verified-auto", account_slug: "dbcinema_web", hygglo_order_id: "verified-auto",
      status: "confirmed", site_revision: 4,
      site_item_windows: [{ item_id: "lens", qty: 1, start: at, end: at + 86400000 + 3600000 }],
    };
    f.tables.reservations.push(booking);

    expect(await reconcileMirroredBookingClaim(f.ctx, booking)).toBe(1);
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({
      booking_id: "verified-auto", reservation_id: booking._id, status: "converted", holds_stock: false,
    });
    expect(await reconcileMirroredBookingClaim(f.ctx, booking)).toBe(0);
    expect(f.tables.dbcinema_shared_stock_claims[0].status).toBe("converted");
  });

  it("keeps the paid pending claim if the confirmed import does not contain its exact claimed item window", async () => {
    const f = fixture();
    await run(f.ctx, paidBooking("verified-mismatch", 3));
    const booking = {
      _id: "reservation-verified-mismatch", account_slug: "dbcinema_web", hygglo_order_id: "verified-mismatch",
      status: "confirmed", site_revision: 4,
      site_item_windows: [{ item_id: "another-lens", qty: 1, start: at, end: at + 86400000 + 3600000 }],
    };
    f.tables.reservations.push(booking);

    expect(await reconcileMirroredBookingClaim(f.ctx, booking)).toBe(0);
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({ status: "execution_started", holds_stock: true });
  });

  it.each([
    { status: "cancelled", reason: "booking_cancelled" },
    { status: "completed", reason: "booking_returned" },
  ])("releases a pending paid claim when the website booking becomes $status", async ({ status, reason }) => {
    const f = fixture();
    await run(f.ctx, paidBooking(`terminal-${status}`, 3));
    const pending = {
      _id: `reservation-terminal-${status}`, account_slug: "dbcinema_web", hygglo_order_id: `terminal-${status}`,
      status: "pending_review", site_revision: 3,
      site_item_windows: [{ item_id: "lens", qty: 1, start: at, end: at + 86400000 + 3600000 }],
    };

    expect(await reconcileMirroredBookingClaim(f.ctx, pending)).toBe(0);
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({ status: "execution_started", holds_stock: true });

    const released = await releaseTerminalWebsiteBookingClaim(f.ctx, {
      ...pending, status, site_revision: 4,
    });
    expect(released).toMatchObject({ outcome: "released", releasedClaims: 1, idempotent: false });
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({
      status: "released", holds_stock: false, release_reason: reason,
    });
    expect(await releaseTerminalWebsiteBookingClaim(f.ctx, {
      ...pending, status, site_revision: 4,
    })).toMatchObject({ outcome: "released", releasedClaims: 0, idempotent: true });
  });

  it("hands the pending claim into verified booking execution and converts it against imported windows", async () => {
    const f = fixture();
    const pending = await run(f.ctx, paidBooking("verified-next"));
    const acquired = await run(f.ctx, { version: 1, operation: "acquire", args: { requestId: "booking_verified-next", items: [{ itemId: "lens", start: at, returnAt: at + 86400000, quantity: 1 }] } });
    expect(acquired).toMatchObject({ operation: "acquire", result: { state: "execution_started", replayed: true, fingerprint: pending.fingerprint } });
    const begun = await run(f.ctx, { version: 1, operation: "beginExecution", args: {
      id: "booking_verified-next", fingerprint: pending.fingerprint, executionKey: "booking_execution_verified-next",
    } });
    expect(begun.result).toMatchObject({ state: "execution_started", replayed: true });

    const booking = {
      _id: "reservation-verified-next", account_slug: "dbcinema_web", hygglo_order_id: "verified-next",
      status: "confirmed", site_revision: 4,
      site_item_windows: [{ item_id: "lens", qty: 1, start: at, end: at + 86400000 + 3600000 }],
    };
    f.tables.reservations.push(booking);
    const stockReceipt = {
      kind: "booking_confirmation", bookingId: "verified-next", bookingRevision: 4,
      managerRequestId: "booking_verified-next", fingerprint: pending.fingerprint,
      executionKey: "booking_execution_verified-next", appliedAt: at,
      windows: [{ managerItemId: "lens", start: at, end: at + 86400000 + 3600000, quantity: 1 }],
    };
    expect(await reconcileMirroredBookingClaim(f.ctx, booking, stockReceipt)).toMatchObject({
      kind: "booking_confirmation", managerRequestId: "booking_verified-next", executionKey: "booking_execution_verified-next",
    });
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({ status: "converted", holds_stock: false });
  });

  it("releases pending booking stock idempotently and blocks late acquisition retries", async () => {
    const f = fixture();
    await run(f.ctx, paidBooking("pending-release"));
    const release = { version: 1, operation: "releaseBooking", args: {
      bookingId: "pending-release", bookingRevision: 4,
      eventId: "booking_pending-release_4_verification_declined", reason: "verification_declined",
    } };
    expect(await run(f.ctx, release)).toMatchObject({ outcome: "released", releasedClaims: 1, idempotent: false });
    expect(await run(f.ctx, release)).toMatchObject({ outcome: "released", releasedClaims: 0, idempotent: true });
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({ status: "released", holds_stock: false, release_reason: "verification_declined" });
    await expect(run(f.ctx, paidBooking("pending-release"))).rejects.toThrow(/already released/);

    const tombstone = { version: 1, operation: "releaseBooking", args: {
      bookingId: "release-before-acquire", bookingRevision: 1,
      eventId: "booking_release-before-acquire_1_booking_cancelled", reason: "booking_cancelled",
    } };
    expect(await run(f.ctx, tombstone)).toMatchObject({ releasedClaims: 0, idempotent: true });
    await expect(run(f.ctx, paidBooking("release-before-acquire"))).rejects.toThrow(/already released/);
  });

  it("does not overwrite the first terminal release reason when later terminal syncs replay", async () => {
    const f = fixture();
    await run(f.ctx, paidBooking("release-reason"));
    const firstRelease = { version: 1, operation: "releaseBooking", args: {
      bookingId: "release-reason", bookingRevision: 4,
      eventId: "booking_release-reason_4_verification_declined", reason: "verification_declined",
    } };
    await run(f.ctx, firstRelease);

    expect(await releaseTerminalWebsiteBookingClaim(f.ctx, {
      account_slug: "dbcinema_web", hygglo_order_id: "release-reason", status: "cancelled", site_revision: 5,
    })).toMatchObject({ outcome: "released", releasedClaims: 0, idempotent: true });
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({
      status: "released", holds_stock: false, release_reason: "verification_declined", release_revision: 4,
      release_event_id: "booking_release-reason_4_verification_declined",
    });
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
    const window = { item_id: "lens", qty: 1, start: at, end: at + 86400000 + 3600000 };
    f.tables.reservations.push({ _id: "reservation-1", account_slug: "dbcinema_web", hygglo_order_id: "booking-1", status: "confirmed", order_step: "APPROVED", site_revision: 7, site_item_windows: [window] });
    const line = { itemId: "lens", start: at, returnAt: at + 86400000, quantity: 1 };
    const request = { version: 1, operation: "acquireZero", args: { requestId: "swap-zero", bookingId: "booking-1", oldItems: [line], newItems: [line] } };
    const acquired = await run(f.ctx, request);
    const begin = { version: 1, operation: "beginExecution", args: { id: "swap-zero", fingerprint: acquired.result.fingerprint, executionKey: "swap_execution_zero" } };
    expect((await run(f.ctx, begin)).result.state).toBe("execution_started");

    const receipt = { swapId: "swap-zero", bookingId: "booking-1", bookingRevision: 7, managerRequestId: "swap-zero", fingerprint: acquired.result.fingerprint, executionKey: "swap_execution_zero", appliedAt: at, windows: [{ managerItemId: "lens", start: at, end: at + 86400000 + 3600000, quantity: 1 }] };
    const checked = await run(f.ctx, { version: 1, operation: "checkConversion", args: { id: "swap-zero", fingerprint: acquired.result.fingerprint, executionKey: "swap_execution_zero", receipt } });
    expect(checked.result).toMatchObject({ state: "converted", stockRisk: false });
  });

  it("reconciles a zero-delta replacement against the full buffered booking and exact receipt", async () => {
    const f = fixture();
    f.tables.items[0].qty = 2;
    const returnAt = at + 86400000;
    const physicalEnd = returnAt + 3600000;
    const booking = {
      _id: "zero-reservation", account_slug: "dbcinema_web", hygglo_order_id: "zero-decrease",
      status: "confirmed", site_revision: 7,
      site_item_windows: [{ item_id: "lens", qty: 2, start: at, end: physicalEnd }],
    };
    f.tables.reservations.push(booking);
    const oldLine = { itemId: "lens", start: at, returnAt, quantity: 2 };
    const newLine = { ...oldLine, quantity: 1 };
    const request = { version: 1, operation: "acquireZero", args: {
      requestId: "swap_zero-decrease", bookingId: "zero-decrease", oldItems: [oldLine], newItems: [newLine],
    } };
    const acquired = await run(f.ctx, request);
    expect(acquired.result.state).toBe("prepared");
    const begun = await run(f.ctx, { version: 1, operation: "beginExecution", args: {
      id: "swap_zero-decrease", fingerprint: acquired.result.fingerprint, executionKey: "swap_execution_zero-decrease",
    } });
    expect(begun.result.state).toBe("execution_started");

    booking.site_revision = 8;
    booking.site_item_windows = [{ item_id: "lens", qty: 1, start: at, end: physicalEnd }];
    const receipt = {
      swapId: "zero-decrease", bookingId: "zero-decrease", bookingRevision: 8,
      managerRequestId: "swap_zero-decrease", fingerprint: acquired.result.fingerprint,
      executionKey: "swap_execution_zero-decrease", appliedAt: at + 1,
      windows: [{ managerItemId: "lens", start: at, end: physicalEnd, quantity: 1 }],
    };
    const acknowledged = await reconcileMirroredBookingClaim(f.ctx, booking, receipt);
    expect(acknowledged).toMatchObject({ swapId: "zero-decrease", managerRequestId: "swap_zero-decrease", executionKey: "swap_execution_zero-decrease" });
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({ status: "converted", holds_stock: false });
    expect(await reconcileMirroredBookingClaim(f.ctx, booking, receipt)).toEqual(acknowledged);
    await expect(reconcileMirroredBookingClaim(f.ctx, booking, { ...receipt, windows: [{ ...receipt.windows[0], quantity: 2 }] }))
      .rejects.toThrow(/claimed and imported physical equipment/);
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

  it("releases a prepared claim after an evidenced refund when execution never began", async () => {
    const f = fixture();
    f.tables.items.push({ _id: "camera", name_canonical: "Synthetic camera", status: "active", is_marketing_only: false, qty: 1 });
    f.tables.reservations.push({ _id: "booking-reservation", account_slug: "dbcinema_web", hygglo_order_id: "booking-1", status: "confirmed", order_step: "APPROVED", site_revision: 2, start_date: "2027-01-01", end_date: "2027-01-02", site_item_windows: [{ item_id: "lens", qty: 1, start: at, end: at + 86400000 }] });
    const acquired = await run(f.ctx, { version: 1, operation: "acquire", args: { requestId: "swap-prepared-compensation", bookingId: "booking-1", items: [{ itemId: "camera", start: at, returnAt: at + 86400000, quantity: 1 }] } });
    const evidence = { swapId: "swap-prepared-compensation", bookingId: "booking-1", bookingRevision: 2, paymentIntentId: "pi-original", refundId: "re-succeeded", refundStatus: "succeeded", amountPence: 500, refundAttemptedAt: at, windows: [{ itemId: "lens", start: at, end: at + 86400000, quantity: 1 }] };
    const release = { version: 1, operation: "releaseCompensated", args: { id: "swap-prepared-compensation", fingerprint: acquired.result.fingerprint, executionKey: "execution-not-started", evidence } };
    await expect(run(f.ctx, { ...release, args: { ...release.args, evidence: { ...evidence, bookingId: "different-booking" } } })).rejects.toThrow(/claim is bound to another booking/);
    expect((await run(f.ctx, release)).result).toMatchObject({ state: "compensated_released", replayed: false });
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({ status: "compensated_released", holds_stock: false });
    expect((await run(f.ctx, release)).result.replayed).toBe(true);
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

  it("serves paid verification holds, terminal releases, and typed conflicts through the private route", async () => {
    const f = fixture();
    const secret = "a-secure-shared-stock-secret-with-32-bytes";
    vi.stubEnv("DBCINEMA_SHARED_STOCK_SECRET", secret);
    const context = { runMutation: async (_ref: any, args: any) => run(f.ctx, args.request) };
    const request = (payload: unknown) => new Request("https://manager.convex.site/dbcinema/shared-stock", {
      method: "POST",
      headers: { "x-shared-stock-token": secret, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const pending = paidBooking("http-pending");
    const reservedResponse = await (dbcinemaSharedStockWrite as any)._handler(context, request(pending));
    expect(reservedResponse.status).toBe(200);
    expect(await reservedResponse.json()).toMatchObject({
      version: 1, operation: "acquirePaidBooking", outcome: "execution_started", bookingId: "http-pending", holdsStock: true,
    });

    const conflict = await (dbcinemaSharedStockWrite as any)._handler(context, request(paidBooking("http-conflict")));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ version: 1, operation: "acquirePaidBooking", error: "capacity_conflict" });

    const release = { version: 1, operation: "releaseBooking", args: {
      bookingId: "http-pending", bookingRevision: 4, eventId: "booking_http-pending_4_booking_cancelled", reason: "booking_cancelled",
    } };
    const releasedResponse = await (dbcinemaSharedStockWrite as any)._handler(context, request(release));
    expect(releasedResponse.status).toBe(200);
    expect(await releasedResponse.json()).toMatchObject({
      version: 1, operation: "releaseBooking", outcome: "released", bookingId: "http-pending", releasedClaims: 1, idempotent: false,
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

  it("preserves stock risk on an acquire replay after a conversion mismatch", async () => {
    const f = fixture();
    f.tables.items[0].qty = 2;
    const booking = {
      _id: "reservation-mismatch",
      account_slug: "dbcinema_web",
      hygglo_order_id: "booking-mismatch",
      status: "confirmed",
      order_step: "BOOKED_AFTER_VERIFIED",
      site_revision: 4,
      site_item_windows: [{ item_id: "camera", qty: 1, start: at, end: at + 86400000 }],
    };
    f.tables.reservations.push(booking);
    const request = { version: 1, operation: "acquire", args: {
      requestId: "swap_mismatch",
      bookingId: "booking-mismatch",
      items: [{ itemId: "lens", start: at, returnAt: at + 86400000, quantity: 1 }],
    } };
    const acquired = await run(f.ctx, request);
    const executionKey = "swap_execution_mismatch";
    await run(f.ctx, { version: 1, operation: "beginExecution", args: {
      id: "swap_mismatch", fingerprint: acquired.result.fingerprint, executionKey,
    } });
    const receipt = {
      swapId: "mismatch",
      bookingId: "booking-mismatch",
      bookingRevision: 5,
      managerRequestId: "swap_mismatch",
      fingerprint: acquired.result.fingerprint,
      executionKey,
      appliedAt: at,
      windows: [{ managerItemId: "lens", start: at, end: at + 86400000, quantity: 1 }],
    };
    const check = { version: 1, operation: "checkConversion", args: {
      id: "swap_mismatch", fingerprint: acquired.result.fingerprint, executionKey, receipt,
    } };

    expect((await run(f.ctx, check)).result).toMatchObject({ state: "converted", stockRisk: true });
    expect(f.tables.dbcinema_shared_stock_claims[0]).toMatchObject({ status: "converted", holds_stock: true });
    expect((await run(f.ctx, request)).result).toMatchObject({ state: "converted", stockRisk: true, replayed: true });
  });
});
