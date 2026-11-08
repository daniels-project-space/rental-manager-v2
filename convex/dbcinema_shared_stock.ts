import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { repairHeldUnits } from "./lib/availability";
import { loadStockSources, stockOccupancyForItem, stockWindowPeak } from "./lib/renter_stock";

const HOUR_MS = 60 * 60 * 1000;
const MAX_LINES = 512;

type WireRequest = { version: 1; operation: string; args: Record<string, any> };
type StockLine = { itemId: string; start: number; returnAt: number; quantity: number };

function fail(message: string): never { throw new Error(message); }
function capacityConflict(message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = "DBCINEMA_SHARED_STOCK_CAPACITY_CONFLICT";
  throw error;
}
function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, any>, keys: string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function evidenceMatches(stored: unknown, evidence: unknown) {
  if (typeof stored !== "string") return false;
  try { return stable(JSON.parse(stored)) === stable(evidence); } catch { return false; }
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 255) fail(`Invalid ${label}.`);
  return value;
}
function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`Invalid ${label}.`);
  return value as number;
}
function epoch(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`Invalid ${label}.`);
  return value as number;
}
function parseLine(value: unknown): StockLine {
  if (!record(value) || !exactKeys(value, ["itemId", "start", "returnAt", "quantity"])) fail("Invalid stock line.");
  const itemId = identifier(value.itemId, "item id");
  const start = epoch(value.start, "stock start");
  const returnAt = epoch(value.returnAt, "stock return");
  const quantity = positiveInteger(value.quantity, "stock quantity");
  if (returnAt < start || returnAt + HOUR_MS <= start || !Number.isSafeInteger(returnAt + HOUR_MS)) fail("Invalid stock window.");
  return { itemId, start, returnAt, quantity };
}
function parseLines(value: unknown, label: string, allowEmpty = false): StockLine[] {
  if (!Array.isArray(value) || value.length > MAX_LINES || (!allowEmpty && !value.length)) fail(`Invalid ${label}.`);
  return value.map(parseLine);
}
function parseEvidence(value: unknown): Record<string, any> {
  if (!record(value)) fail("Invalid stock evidence.");
  return value;
}
function parseWireRequest(value: unknown): WireRequest {
  if (!record(value) || !exactKeys(value, ["version", "operation", "args"]) || value.version !== 1 || !record(value.args)) fail("Invalid shared stock request.");
  const args = value.args;
  switch (value.operation) {
    case "acquire":
      if (!exactKeys(args, Object.prototype.hasOwnProperty.call(args, "bookingId") ? ["requestId", "bookingId", "items"] : ["requestId", "items"])) fail("Invalid acquire request.");
      identifier(args.requestId, "stock request id");
      if (args.bookingId !== undefined) identifier(args.bookingId, "booking id");
      parseLines(args.items, "stock items"); break;
    case "acquireZero":
      if (!exactKeys(args, ["requestId", "bookingId", "oldItems", "newItems"])) fail("Invalid zero-delta request.");
      identifier(args.requestId, "stock request id"); identifier(args.bookingId, "booking id");
      parseLines(args.oldItems, "old stock items"); parseLines(args.newItems, "new stock items"); break;
    case "beginExecution": case "checkExecution":
      if (!exactKeys(args, ["id", "fingerprint", "executionKey"])) fail("Invalid stock execution request.");
      identifier(args.id, "stock request id"); identifier(args.fingerprint, "stock fingerprint"); identifier(args.executionKey, "execution key"); break;
    case "checkConversion":
      if (!exactKeys(args, ["id", "fingerprint", "executionKey", "receipt"])) fail("Invalid conversion check.");
      identifier(args.id, "stock request id"); identifier(args.fingerprint, "stock fingerprint"); identifier(args.executionKey, "execution key"); parseEvidence(args.receipt); break;
    case "releasePrepared":
      if (!exactKeys(args, ["id", "fingerprint", "reason"]) || !["withdrawn_before_execution", "abandoned_before_execution"].includes(args.reason)) fail("Invalid prepared-stock release.");
      identifier(args.id, "stock request id"); identifier(args.fingerprint, "stock fingerprint"); break;
    case "releaseCompensated": case "checkCompensatedRelease":
      if (!exactKeys(args, ["id", "fingerprint", "executionKey", "evidence"])) fail("Invalid compensation release.");
      identifier(args.id, "stock request id"); identifier(args.fingerprint, "stock fingerprint"); identifier(args.executionKey, "execution key"); parseEvidence(args.evidence); break;
    default: fail("Unsupported shared stock operation.");
  }
  return value as WireRequest;
}

function acquireFingerprint(items: StockLine[]) {
  const rows = items.map(line => ({ itemId: line.itemId, start: line.start, end: line.returnAt + HOUR_MS, quantity: line.quantity }))
    .sort((a, b) => a.itemId.localeCompare(b.itemId) || a.start - b.start || a.end - b.end || a.quantity - b.quantity);
  return JSON.stringify(rows.map(line => [line.itemId, line.start, line.end, line.quantity]));
}
function zeroFingerprint(bookingId: string, oldItems: StockLine[], newItems: StockLine[]) {
  const rows = (items: StockLine[]) => items.map(line => [line.itemId, line.start, line.returnAt, line.quantity]);
  return JSON.stringify(["zero-capacity-v1", bookingId, rows(oldItems), rows(newItems)]);
}
function mergeLines(lines: StockLine[]) {
  const merged = new Map<string, StockLine>();
  for (const line of lines) {
    const key = JSON.stringify([line.itemId, line.start, line.returnAt]);
    const current = merged.get(key);
    const quantity = (current?.quantity ?? 0) + line.quantity;
    if (!Number.isSafeInteger(quantity)) fail("Stock quantity exceeds the supported range.");
    merged.set(key, { ...line, quantity });
  }
  return [...merged.values()].sort((a, b) => a.itemId.localeCompare(b.itemId) || a.start - b.start || a.returnAt - b.returnAt);
}
function assertZeroDelta(oldItems: StockLine[], newItems: StockLine[]) {
  const key = (line: StockLine) => JSON.stringify([line.itemId, line.start, line.returnAt]);
  const old = new Map(mergeLines(oldItems).map(line => [key(line), line.quantity]));
  for (const line of mergeLines(newItems)) {
    if (line.quantity > (old.get(key(line)) ?? 0)) fail("A zero-capacity equipment change cannot add stock.");
  }
}
function isoMinute(value: number) { return new Date(value).toISOString().slice(0, 16); }
function addDay(day: string) { return new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10); }
function overlapsDates(block: any, start: string, end: string) {
  if (typeof block?.start_date !== "string" || typeof block?.end_date !== "string") return false;
  return `${block.start_date}T00:00` < end && `${addDay(block.end_date)}T00:00` > start;
}
function rowsFromSite(windows: any[]): string | null {
  if (!Array.isArray(windows)) return null;
  const totals = new Map<string, number>();
  for (const row of windows) {
    if (!row || typeof row.item_id !== "string" || !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || !Number.isSafeInteger(row.qty) || row.qty < 1) return null;
    const key = JSON.stringify([row.item_id, row.start, row.end]);
    const qty = (totals.get(key) ?? 0) + row.qty;
    if (!Number.isSafeInteger(qty)) return null;
    totals.set(key, qty);
  }
  return JSON.stringify([...totals].map(([key, qty]) => [JSON.parse(key)[0], JSON.parse(key)[1], JSON.parse(key)[2], qty]).sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2]));
}
function siteCoversClaim(windows: any[], claimed: any[]): boolean {
  if (!Array.isArray(windows) || windows.length > MAX_LINES || !Array.isArray(claimed) || claimed.length > MAX_LINES) return false;
  const totals = new Map<string, number>();
  for (const row of windows) {
    if (!row || typeof row.item_id !== "string" || !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || !Number.isSafeInteger(row.qty) || row.qty < 1) return false;
    const key = JSON.stringify([row.item_id, row.start, row.end]);
    const qty = (totals.get(key) ?? 0) + row.qty;
    if (!Number.isSafeInteger(qty)) return false;
    totals.set(key, qty);
  }
  for (const row of claimed) {
    if (!row || typeof row.item_id !== "string" || !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || row.end <= HOUR_MS || !Number.isSafeInteger(row.qty) || row.qty < 1) return false;
    // A standard website window records the renter's return time, while a
    // manager-imported physical receipt can already include the one-hour buffer.
    const actualReturn = totals.get(JSON.stringify([row.item_id, row.start, row.end - HOUR_MS])) ?? 0;
    const bufferedEnd = totals.get(JSON.stringify([row.item_id, row.start, row.end])) ?? 0;
    if (Math.max(actualReturn, bufferedEnd) < row.qty) return false;
  }
  return true;
}
function rowsFromRequest(lines: StockLine[]): string {
  const totals = new Map<string, number>();
  for (const line of lines) {
    const key = JSON.stringify([line.itemId, line.start, line.returnAt]);
    totals.set(key, (totals.get(key) ?? 0) + line.quantity);
  }
  return JSON.stringify([...totals].map(([key, qty]) => [JSON.parse(key)[0], JSON.parse(key)[1], JSON.parse(key)[2], qty]).sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2]));
}
function rowsFromConversionEvidence(windows: any[]): string | null {
  if (!Array.isArray(windows) || windows.length > MAX_LINES) return null;
  const totals = new Map<string, number>();
  for (const row of windows) {
    if (!row || typeof row.managerItemId !== "string" || !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || !Number.isSafeInteger(row.quantity) || row.quantity < 1) return null;
    const key = JSON.stringify([row.managerItemId, row.start, row.end]);
    const qty = (totals.get(key) ?? 0) + row.quantity;
    if (!Number.isSafeInteger(qty)) return null;
    totals.set(key, qty);
  }
  return JSON.stringify([...totals].map(([key, qty]) => [JSON.parse(key)[0], JSON.parse(key)[1], JSON.parse(key)[2], qty]).sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2]));
}
function rowsFromCompensationEvidence(windows: any[]): string | null {
  if (!Array.isArray(windows) || windows.length > MAX_LINES) return null;
  const totals = new Map<string, number>();
  for (const row of windows) {
    if (!row || typeof row.itemId !== "string" || !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || !Number.isSafeInteger(row.quantity) || row.quantity < 1) return null;
    const key = JSON.stringify([row.itemId, row.start, row.end]);
    const qty = (totals.get(key) ?? 0) + row.quantity;
    if (!Number.isSafeInteger(qty)) return null;
    totals.set(key, qty);
  }
  return JSON.stringify([...totals].map(([key, qty]) => [JSON.parse(key)[0], JSON.parse(key)[1], JSON.parse(key)[2], qty]).sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2]));
}

async function claimForRequest(ctx: any, requestId: string) {
  const rows = await ctx.db.query("dbcinema_shared_stock_claims").withIndex("by_request_id", (q: any) => q.eq("request_id", requestId)).take(2);
  if (rows.length > 1) fail("Duplicate stock request needs reconciliation.");
  return rows[0] ?? null;
}
async function siteBooking(ctx: any, bookingId: string) {
  const rows = await ctx.db.query("reservations").withIndex("by_hygglo_order_id", (q: any) => q.eq("hygglo_order_id", bookingId)).take(10);
  const candidates = rows.filter((row: any) => row.account_slug === "dbcinema_web" && !row.is_obsolete);
  if (candidates.length !== 1) return null;
  const row = candidates[0];
  if (!["confirmed", "ongoing"].includes(row.status) || ["RETURNED", "REVIEWED"].includes(row.order_step)) return null;
  return row;
}
function siteRowsMatchReservation(row: any, expected: string | null) {
  return !!row && Number.isSafeInteger(row.site_revision) && row.site_revision >= 0 && expected !== null && rowsFromSite(row.site_item_windows) === expected;
}
async function ensureNoDuplicateOrSame(ctx: any, requestId: string, payload: any) {
  const prior = await claimForRequest(ctx, requestId);
  if (prior && prior.request_hash !== stable(payload)) fail("Stock request identity changed; reconcile it before retrying.");
  return prior;
}
async function ensureAvailable(ctx: any, rawLines: StockLine[], excludeRequestId?: string, excludeBookingId?: string) {
  const loaded = await loadStockSources(ctx);
  const sources = {
    ...loaded,
    ...(excludeBookingId ? { reservations: loaded.reservations.filter((row: any) => row.hygglo_order_id !== excludeBookingId) } : {}),
    ...(excludeRequestId ? { websiteSwapClaims: ((loaded as any).websiteSwapClaims ?? []).filter((claim: any) => claim.request_id !== excludeRequestId) } : {}),
  };
  for (const line of mergeLines(rawLines)) {
    const item = sources.items.find((value: any) => String(value._id) === line.itemId);
    if (!item || item.status !== "active" || item.is_marketing_only !== false || !Number.isSafeInteger(item.qty) || item.qty < 0) fail("The requested equipment has no verified live stock mapping.");
    const start = isoMinute(line.start), end = isoMinute(line.returnAt + HOUR_MS);
    const occupancy = stockOccupancyForItem(sources as any, item, { item_name: item.name_canonical, start_date: start.slice(0, 10), end_date: end.slice(0, 10), ...(excludeBookingId ? { thread_id: excludeBookingId } : {}) } as any);
    const occupied = stockWindowPeak(occupancy, start, end);
    const repair = repairHeldUnits(sources.claims, item._id);
    const blocked = sources.vacations.some((row: any) => overlapsDates(row, start, end)) || sources.blackouts.some((row: any) => row.item_id === item._id && overlapsDates(row, start, end));
    if (!Number.isSafeInteger(occupied) || !Number.isSafeInteger(repair) || blocked || occupied + repair + line.quantity > item.qty) capacityConflict(`Not enough available equipment to change ${item.name_canonical}.`);
  }
}

async function processRequest(ctx: any, untrusted: unknown) {
  const request = parseWireRequest(untrusted);
  const args = request.args;
  const payload = { operation: request.operation, args };
  const reply = (result: Record<string, any>) => ({ operation: request.operation, request: { ...args, source: "website" }, result });

  if (request.operation === "acquire" || request.operation === "acquireZero") {
    const requestId = String(args.requestId);
    const prior = await ensureNoDuplicateOrSame(ctx, requestId, payload);
    const items = request.operation === "acquire" ? parseLines(args.items, "stock items") : [];
    const oldItems = request.operation === "acquireZero" ? parseLines(args.oldItems, "old stock items") : [];
    const newItems = request.operation === "acquireZero" ? parseLines(args.newItems, "new stock items") : [];
    if (request.operation === "acquireZero") assertZeroDelta(oldItems, newItems);
    const fingerprint = request.operation === "acquire" ? acquireFingerprint(items) : zeroFingerprint(String(args.bookingId), oldItems, newItems);
    if (prior) {
      if (["released", "compensated_released"].includes(prior.status)) fail("This stock claim has already been released.");
      return reply({ state: "prepared", replayed: true, requestId, fingerprint });
    }
    let reservation: any = null;
    let holdsStock = request.operation === "acquire";
    if (request.operation === "acquire") {
      if (args.bookingId && !(await siteBooking(ctx, String(args.bookingId)))) fail("The original booking is not available for this equipment change.");
      await ensureAvailable(ctx, items);
    } else {
      reservation = await siteBooking(ctx, String(args.bookingId));
      if (!reservation || !siteRowsMatchReservation(reservation, rowsFromRequest(oldItems))) fail("The original booking stock does not match the requested equipment change.");
      holdsStock = false;
    }
    const claimItems = mergeLines(items).map(line => ({
      item_id: line.itemId as any, start: line.start, end: line.returnAt + HOUR_MS, qty: line.quantity,
    }));
    await ctx.db.insert("dbcinema_shared_stock_claims", {
      request_id: requestId, request_payload: payload, request_hash: stable(payload), fingerprint,
      status: "prepared", holds_stock: holdsStock, items: claimItems,
      ...(request.operation === "acquireZero" ? { booking_id: String(args.bookingId), reservation_id: reservation._id } : args.bookingId ? { booking_id: String(args.bookingId) } :
        requestId.startsWith("booking_") ? { booking_id: requestId.slice("booking_".length) } : {}),
      created_at: Date.now(), updated_at: Date.now(),
    });
    return reply({ state: "prepared", replayed: false, requestId, fingerprint });
  }

  const row = await claimForRequest(ctx, String(args.id));
  if (!row || row.fingerprint !== args.fingerprint) fail("The shared stock claim could not be matched.");
  if (request.operation === "beginExecution") {
    if (row.status === "execution_started" && row.execution_key === args.executionKey) return reply({ state: "execution_started", replayed: true });
    if (row.status !== "prepared" || row.execution_key) fail("The stock claim is not available for execution.");
    const stored = row.request_payload;
    if (!record(stored) || !record(stored.args)) fail("The stock claim needs reconciliation.");
    const bookingId = typeof stored.args.bookingId === "string" ? stored.args.bookingId : undefined;
    if (row.holds_stock) {
      if (!Array.isArray(row.items) || !row.items.length) fail("The stock claim needs reconciliation.");
      const lines = row.items.map((line: any) => parseLine({ itemId: String(line.item_id), start: line.start, returnAt: line.end - HOUR_MS, quantity: line.qty }));
      if (bookingId && !(await siteBooking(ctx, bookingId))) fail("The original booking is no longer available for this equipment change.");
      await ensureAvailable(ctx, lines, String(row.request_id));
    } else if (stored.operation === "acquireZero") {
      const oldItems = parseLines(stored.args.oldItems, "old stock items");
      const newItems = parseLines(stored.args.newItems, "new stock items");
      assertZeroDelta(oldItems, newItems);
      const reservation = await siteBooking(ctx, String(stored.args.bookingId));
      if (!reservation || String(reservation._id) !== String(row.reservation_id) || !siteRowsMatchReservation(reservation, rowsFromRequest(oldItems))) fail("The original booking stock changed before equipment execution.");
    } else fail("The stock claim needs reconciliation.");
    await ctx.db.patch(row._id, { status: "execution_started", execution_key: args.executionKey, updated_at: Date.now() });
    return reply({ state: "execution_started", replayed: false });
  }
  if (request.operation === "checkExecution") {
    if (row.status !== "execution_started" || row.execution_key !== args.executionKey) fail("Stock execution has not been started.");
    // An execution claim can sit between renter acceptance and settlement.
    // Recheck live occupancy at the settlement boundary so an external
    // reservation created after the original claim cannot be silently ignored.
    if (row.holds_stock) {
      const stored = row.request_payload;
      if (!record(stored) || !record(stored.args) || !Array.isArray(row.items) || !row.items.length) fail("The stock claim needs reconciliation.");
      const bookingId = typeof stored.args.bookingId === "string" ? stored.args.bookingId : undefined;
      const lines = row.items.map((line: any) => parseLine({ itemId: String(line.item_id), start: line.start, returnAt: line.end - HOUR_MS, quantity: line.qty }));
      await ensureAvailable(ctx, lines, String(row.request_id), bookingId);
    }
    return reply({ state: "execution_started", replayed: true });
  }
  if (request.operation === "releasePrepared") {
    if (row.status === "released") return reply({ state: "released", replayed: true });
    if (row.status !== "prepared" || row.execution_key) fail("The stock claim cannot be released after execution starts.");
    await ctx.db.patch(row._id, { status: "released", holds_stock: false, updated_at: Date.now() });
    return reply({ state: "released", replayed: false });
  }
  if (request.operation === "checkCompensatedRelease") {
    const state = row.status === "compensated_released" && evidenceMatches(row.evidence_hash, args.evidence) ? "compensated_released" : "unconfirmed";
    return reply({ state, replayed: true });
  }
  if (request.operation === "releaseCompensated") {
    const evidence = args.evidence;
    if (row.status === "compensated_released") {
      if (!evidenceMatches(row.evidence_hash, evidence)) fail("The compensated release evidence changed.");
      return reply({ state: "compensated_released", replayed: true });
    }
    if (!["execution_started", "converted"].includes(row.status) || row.execution_key !== args.executionKey ||
        evidence.refundStatus !== "succeeded" || !identifier(evidence.swapId, "swap id") ||
        !identifier(evidence.bookingId, "booking id") || !identifier(evidence.paymentIntentId, "payment intent") ||
        !identifier(evidence.refundId, "refund id") || !Number.isSafeInteger(evidence.amountPence) || evidence.amountPence < 1 ||
        !Number.isSafeInteger(evidence.refundAttemptedAt)) fail("The compensation evidence is incomplete.");
    const reservation = await siteBooking(ctx, evidence.bookingId);
    const current = rowsFromSite(reservation?.site_item_windows);
    const expected = rowsFromCompensationEvidence(evidence.windows);
    if (!reservation || reservation.site_revision !== evidence.bookingRevision || expected === null || current !== expected)
      return reply({ state: "unconfirmed", replayed: true });
    await ctx.db.patch(row._id, { status: "compensated_released", holds_stock: false, booking_id: evidence.bookingId, reservation_id: reservation._id, evidence_hash: stable(evidence), updated_at: Date.now() });
    return reply({ state: "compensated_released", replayed: false });
  }
  if (request.operation === "checkConversion") {
    const evidence = args.receipt;
    if (!["execution_started", "converted"].includes(row.status) || row.execution_key !== args.executionKey ||
        !identifier(evidence.swapId, "swap id") || !identifier(evidence.bookingId, "booking id") ||
        evidence.managerRequestId !== row.request_id || evidence.fingerprint !== row.fingerprint ||
        evidence.executionKey !== row.execution_key || !Number.isSafeInteger(evidence.bookingRevision) ||
        !Number.isSafeInteger(evidence.appliedAt)) fail("The conversion evidence does not match the acquired stock claim.");
    if (row.status === "converted" && !evidenceMatches(row.evidence_hash, evidence)) fail("The converted stock evidence changed.");
    const reservation = await siteBooking(ctx, evidence.bookingId);
    const actual = rowsFromSite(reservation?.site_item_windows);
    const expected = rowsFromConversionEvidence(evidence.windows);
    let exact = !!reservation && reservation.site_revision >= evidence.bookingRevision && expected !== null && actual === expected && siteCoversClaim(reservation.site_item_windows ?? [], row.items ?? []);
    if (exact) {
      try {
        const lines = evidence.windows.map((win: any) => parseLine({ itemId: win.managerItemId, start: win.start, returnAt: win.end - HOUR_MS, quantity: win.quantity }));
        await ensureAvailable(ctx, lines, row.request_id, evidence.bookingId);
      } catch { exact = false; }
    }
    await ctx.db.patch(row._id, {
      status: "converted", holds_stock: exact ? false : row.holds_stock,
      booking_id: evidence.bookingId, ...(reservation ? { reservation_id: reservation._id } : {}),
      evidence_hash: stable(evidence), updated_at: Date.now(),
    });
    return reply({ state: "converted", stockRisk: !exact, replayed: row.status === "converted" });
  }
  return fail("Unsupported shared stock operation.");
}

export const process = internalMutation({
  args: { request: v.any() },
  handler: async (ctx, { request }) => {
    try {
      return await processRequest(ctx as any, request);
    } catch (error) {
      // Convex serializes errors between mutations and HTTP actions. Return a
      // small typed result so the HTTP adapter can preserve this conflict
      // without relying on custom Error fields crossing that boundary.
      if ((error as any)?.code === "DBCINEMA_SHARED_STOCK_CAPACITY_CONFLICT") {
        return { sharedStockError: "capacity_conflict" as const };
      }
      throw error;
    }
  },
});

/** Called in the same mutation that imports a paid website booking. */
export function reconcileMirroredBookingClaim(ctx: any, booking: any): Promise<number>;
export function reconcileMirroredBookingClaim(ctx: any, booking: any, stockReceipt: any): Promise<Record<string, any>>;
export async function reconcileMirroredBookingClaim(ctx: any, booking: any, stockReceipt?: any): Promise<number | Record<string, any>> {
  if (booking?.account_slug !== "dbcinema_web" || !booking.hygglo_order_id ||
      !["confirmed", "ongoing"].includes(booking.status) || !Array.isArray(booking.site_item_windows)) {
    if (stockReceipt !== undefined) fail("The stock receipt does not belong to an active website booking.");
    return 0;
  }
  const claims = await ctx.db.query("dbcinema_shared_stock_claims")
    .withIndex("by_booking", (q: any) => q.eq("booking_id", booking.hygglo_order_id)).take(11);
  if (claims.length > 10) fail("This booking has too many stock claims to reconcile safely.");
  const actual = rowsFromSite(booking.site_item_windows);
  if (actual === null) {
    if (stockReceipt !== undefined) fail("The stock receipt has invalid physical booking windows.");
    return 0;
  }
  if (stockReceipt !== undefined) {
    if (!stockReceipt || typeof stockReceipt.bookingId !== "string" || stockReceipt.bookingId !== booking.hygglo_order_id ||
        !Number.isSafeInteger(stockReceipt.bookingRevision) || !Number.isSafeInteger(booking.site_revision) || stockReceipt.bookingRevision > booking.site_revision ||
        typeof stockReceipt.managerRequestId !== "string" || typeof stockReceipt.fingerprint !== "string" ||
        typeof stockReceipt.executionKey !== "string" || !Number.isSafeInteger(stockReceipt.appliedAt) ||
        !Array.isArray(stockReceipt.windows)) fail("The stock receipt identity does not match the imported booking.");
    if (stockReceipt.kind === "booking_confirmation") {
      if (stockReceipt.managerRequestId !== `booking_${booking.hygglo_order_id}` || stockReceipt.executionKey !== `booking_execution_${booking.hygglo_order_id}`) fail("The booking stock receipt identity is invalid.");
    } else if (typeof stockReceipt.swapId !== "string" || stockReceipt.managerRequestId !== `swap_${stockReceipt.swapId}` || stockReceipt.executionKey !== `swap_execution_${stockReceipt.swapId}`) {
      fail("The equipment-change stock receipt identity is invalid.");
    }
    const claim = claims.find((row: any) => row.request_id === stockReceipt.managerRequestId);
    const expected = rowsFromConversionEvidence(stockReceipt.windows);
    if (!claim || !claim.holds_stock && claim.status !== "converted" ||
        claim.booking_id !== booking.hygglo_order_id || claim.request_payload?.operation !== "acquire" ||
        claim.fingerprint !== stockReceipt.fingerprint || claim.execution_key !== stockReceipt.executionKey ||
        !["execution_started", "converted"].includes(claim.status) || expected === null || actual !== expected ||
        !siteCoversClaim(booking.site_item_windows, claim.items ?? [])) fail("The stock receipt does not match the claimed and imported physical equipment.");
    if (claim.status === "converted" && !evidenceMatches(claim.evidence_hash, stockReceipt) && !evidenceMatches(claim.evidence_hash, {
      bookingId: stockReceipt.bookingId, siteRevision: stockReceipt.bookingRevision, windows: booking.site_item_windows,
    })) fail("The previously converted stock receipt changed.");
    const lines = stockReceipt.windows.map((row: any) => parseLine({ itemId: row.managerItemId, start: row.start, returnAt: row.end - HOUR_MS, quantity: row.quantity }));
    await ensureAvailable(ctx, lines, claim.request_id, booking.hygglo_order_id);
    if (claim.status === "execution_started") {
      await ctx.db.patch(claim._id, {
        status: "converted", holds_stock: false, booking_id: booking.hygglo_order_id,
        reservation_id: booking._id, evidence_hash: stable(stockReceipt), updated_at: Date.now(),
      });
    }
    return {
      ...(stockReceipt.kind === "booking_confirmation" ? { kind: "booking_confirmation" } : { swapId: stockReceipt.swapId }),
      managerRequestId: stockReceipt.managerRequestId, fingerprint: stockReceipt.fingerprint,
      executionKey: stockReceipt.executionKey, bookingRevision: stockReceipt.bookingRevision,
    };
  }
  let released = 0;
  for (const claim of claims) {
    if (!claim.holds_stock || claim.status !== "execution_started" || claim.booking_id !== booking.hygglo_order_id || claim.request_payload?.operation !== "acquire" || !Array.isArray(claim.items)) continue;
    if (!siteCoversClaim(booking.site_item_windows, claim.items)) continue;
    const lines = claim.items.map((line: any) => parseLine({ itemId: String(line.item_id), start: line.start, returnAt: line.end - HOUR_MS, quantity: line.qty }));
    await ensureAvailable(ctx, lines, claim.request_id, booking.hygglo_order_id);
    await ctx.db.patch(claim._id, {
      status: "converted", holds_stock: false, reservation_id: booking._id,
      evidence_hash: stable({ bookingId: booking.hygglo_order_id, siteRevision: booking.site_revision, windows: booking.site_item_windows }),
      updated_at: Date.now(),
    });
    released++;
  }
  return released;
}
