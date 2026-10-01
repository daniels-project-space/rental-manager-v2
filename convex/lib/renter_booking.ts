import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export const LAB_THREAD_PREFIX = "__probe__";
export type BotBooking = Doc<"reservations"> | Doc<"renter_bot_lab_bookings">;

/** A simulation can supply booking facts, but can never occupy real inventory. */
export async function getBotBooking(ctx: QueryCtx, threadId: string): Promise<BotBooking | null> {
  if (threadId.startsWith(LAB_THREAD_PREFIX)) {
    return ctx.db.query("renter_bot_lab_bookings")
      .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", threadId)).first();
  }
  return ctx.db.query("reservations")
    .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", threadId)).first();
}

/** Current editable test basket; never consult it for a real renter thread. */
export async function getLabOrder(ctx: QueryCtx, threadId: string) {
  if (!threadId.startsWith(LAB_THREAD_PREFIX)) return null;
  return ctx.db.query("renter_bot_lab_orders")
    .withIndex("by_thread", (q) => q.eq("thread_id", threadId)).first();
}
