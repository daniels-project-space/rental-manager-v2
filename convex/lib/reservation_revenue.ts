import { disableReservationReadModel, syncReservationReadRecord } from "./reservation_read_model";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { effectiveDate } from "./reservations/predicates";
import { beforeReservationStockPatch, beforeReservationStockDelete, invalidateStockWhen, stockReservationStatuses } from "./stock_input_cache";

export type RevenueFactData = WithoutSystemFields<Doc<"reservation_revenue_facts">>;
type CompleteMapping = RevenueFactData & Record<keyof RevenueFactData, unknown>;

/** Only the completed-history fields consumed by canonical month revenue. */
export function projectReservationRevenue(row: Doc<"reservations">): CompleteMapping | null {
  const date = effectiveDate(row);
  if (row.status !== "completed" || row.is_obsolete || !row.start_date || !row.end_date || !date) return null;
  return {
    source_id: row._id,
    source_creation_time: row._creationTime,
    effective_month: date.slice(0, 7),
    status: "completed",
    start_date: row.start_date,
    end_date: row.end_date,
    pickup_date: row.pickup_date,
    account_slug: row.account_slug,
    renter_id: row.renter_id,
    renter_name: row.renter_name,
    hygglo_order_id: row.hygglo_order_id,
    v1_rental_id: row.v1_rental_id,
    is_obsolete: row.is_obsolete,
    order_step: row.order_step,
    net_to_owner_gbp: row.net_to_owner_gbp,
  };
}

export function revenueFactMatches(actual: Doc<"reservation_revenue_facts"> | null, expected: RevenueFactData | null) {
  if (!expected) return actual === null;
  return actual !== null && Object.entries(expected).every(([key, value]) =>
    Object.is(actual[key as keyof RevenueFactData], value));
}

const revenueFields = new Set([
  "status", "start_date", "end_date", "pickup_date", "account_slug", "renter_id", "renter_name",
  "hygglo_order_id", "v1_rental_id", "is_obsolete", "order_step", "net_to_owner_gbp",
]);
// Some real callers expose isolated Lab bookings through a reservation-shaped
// type. Runtime ID validation keeps those out of production revenue facts.
type ReservationId = Id<"reservations"> | Id<"renter_bot_lab_bookings">;
function isProductionReservation(ctx: MutationCtx, id: ReservationId): id is Id<"reservations"> {
  return ctx.db.normalizeId("reservations", id) !== null;
}

const queues = new WeakMap<object, Map<string, Promise<unknown>>>();
function serialize<T>(ctx: MutationCtx, id: string, work: () => Promise<T>): Promise<T> {
  let queue = queues.get(ctx);
  if (!queue) { queue = new Map(); queues.set(ctx, queue); }
  const previous = queue.get(id) ?? Promise.resolve();
  const current = previous.then(work);
  queue.set(id, current);
  const clean = () => { if (queue!.get(id) === current) queue!.delete(id); };
  void current.then(clean, clean);
  return current;
}

async function maintain<T>(ctx: MutationCtx, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    await disableReservationReadModel(ctx);
    // A caller may catch a per-record sync error. It must not leave readers
    // using an old projection after the successful source write.
    const ready = await ctx.db.query("reservation_revenue_ready").withIndex("by_key", (q) => q.eq("key", "v1")).unique();
    if (ready?.ready) await ctx.db.patch(ready._id, { ready: false, updated_at: Date.now() });
    throw error;
  }
}

async function refresh(ctx: MutationCtx, id: ReservationId) {
  if (!isProductionReservation(ctx, id)) return;
  const [source, existing] = await Promise.all([
    ctx.db.get(id),
    ctx.db.query("reservation_revenue_facts").withIndex("by_source", (q) => q.eq("source_id", id)).unique(),
  ]);
  const next = source ? projectReservationRevenue(source) : null;
  if (!next) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }
  if (!existing) { await ctx.db.insert("reservation_revenue_facts", next); return; }
  if (revenueFactMatches(existing, next)) return;
  await ctx.db.patch(existing._id, next);
}

export async function refreshReservationRevenue(ctx: MutationCtx, id: Id<"reservations">) {
  return maintain(ctx, () => refresh(ctx, id));
}

async function remove(ctx: MutationCtx, id: ReservationId) {
  if (!isProductionReservation(ctx, id)) return;
  const old = await ctx.db.query("reservation_revenue_facts").withIndex("by_source", (q) => q.eq("source_id", id)).unique();
  if (old) await ctx.db.delete(old._id);
}

export async function patchRevenueReservation(
  ctx: MutationCtx, id: ReservationId, patch: Partial<WithoutSystemFields<Doc<"reservations">>>,
) {
  await beforeReservationStockPatch(ctx, id, patch);
  if (!isProductionReservation(ctx, id)) { await ctx.db.patch(id, patch); return; }
  return serialize(ctx, id, () => maintain(ctx, async () => {
    await ctx.db.patch(id, patch);
    if (Object.keys(patch).some(key => revenueFields.has(key))) {
      if (patch.status !== undefined && patch.status !== "completed") await remove(ctx, id);
      else await refresh(ctx, id);
    }
    await syncReservationReadRecord(ctx, id);
  }));
}

export async function insertRevenueReservation(ctx: MutationCtx, row: WithoutSystemFields<Doc<"reservations">>) {
  const affectsStock = stockReservationStatuses.some(status => status === row.status);
  if (affectsStock) await invalidateStockWhen(ctx, () => false);
  const id = await ctx.db.insert("reservations", row);
  if (isProductionReservation(ctx, id)) await serialize(ctx, id, () => maintain(ctx, async () => {
    if (affectsStock) await invalidateStockWhen(ctx, () => true);
    if (row.status === "completed") await refresh(ctx, id);
    await syncReservationReadRecord(ctx, id);
  }));
  return id;
}

export async function deleteRevenueReservation(ctx: MutationCtx, id: ReservationId) {
  return serialize(ctx, id, async () => {
    await beforeReservationStockDelete(ctx, id);
    if (!isProductionReservation(ctx, id)) { await ctx.db.delete(id); return; }
    return maintain(ctx, async () => {
      await ctx.db.delete(id);
      await remove(ctx, id);
      await syncReservationReadRecord(ctx, id);
    });
  });
}
