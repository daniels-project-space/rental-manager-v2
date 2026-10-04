import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export const LAB_THREAD_PREFIX = "__probe__";
export type BotBooking = Doc<"reservations"> | Doc<"renter_bot_lab_bookings">;

/** Authoritative basket precedence shared by context and owner-task validation. */
export function requestedListingContext(booking:BotBooking|null,order:Doc<"renter_bot_lab_orders">|null,
 inquiry:Array<{name?:string;qty?:number;product_id?:number}>|undefined) {
 const lines=order ? order.items.map(i=>({name:i.name,qty:i.qty,product_id:i.product_id??null}))
  : booking?.hygglo_items?.length ? booking.hygglo_items.map(i=>({name:i.name,qty:i.qty??1,product_id:i.product_id??null}))
  : inquiry?.length ? inquiry.map(i=>({name:i.name??"",qty:i.qty??1,product_id:i.product_id??null}))
  : (booking?.items??[]).map(i=>({name:i.item_name,qty:i.qty??1,product_id:null}));
 return {lines,start_date:order?.start_date??booking?.start_date??null,end_date:order?.end_date??booking?.end_date??null};
}

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
