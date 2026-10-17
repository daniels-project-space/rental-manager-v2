import type { QueryCtx } from "../_generated/server";
import { reservationReadGate } from "./reservation_read_model";

const modes = new WeakMap<object, "source" | "prepared">();
export function setReservationActivityMode(ctx: QueryCtx, mode: "source" | "prepared") { modes.set(ctx, mode); }

/** Exact poller skip-fetch inputs. False paid/confirmation flags are populated
 * values; missing activity is omitted, and duplicate orders retain .first(). */
export async function readLatestReservationActivity(ctx: QueryCtx, ids: string[]) {
  const out: Record<string, { latest_activity: number | string; has_order_step: boolean }> = {};
  const mode = modes.get(ctx);
  let useMetadata = false;
  if (mode !== "source") {
    try {
      const gate = await reservationReadGate(ctx);
      useMetadata = !!gate?.ready && gate.version === 1 && gate.enabled && (gate.activity_enabled === true || mode === "prepared");
      if (mode === "prepared" && !useMetadata) throw Error("Prepared reservation activity is unavailable");
    } catch (error) { if (mode === "prepared") throw error; }
  }
  for (const id of ids) {
    if (useMetadata) {
      try {
        const rows = await ctx.db.query("reservation_order_presence")
          .withIndex("by_order", q => q.eq("hygglo_order_id", id)).take(2);
        if (!rows.length) continue;
        if (rows.length === 1) {
          const row = rows[0];
          if (row.activity_version !== 1) throw Error("Prepared reservation activity row is unavailable");
          if (row.latest_activity !== undefined) out[id] = { latest_activity: row.latest_activity,
            has_order_step: row.order_step !== undefined && row.paid !== undefined && row.platform_booking_confirmed !== undefined };
          continue;
        }
      } catch (error) { if (mode === "prepared") throw error; }
    }
    const row = await ctx.db.query("reservations")
      .withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", id)).first();
    if (row?.latest_activity !== undefined) out[id] = { latest_activity: row.latest_activity,
      has_order_step: row.order_step !== undefined && row.paid !== undefined && row.platform_booking_confirmed !== undefined };
  }
  return out;
}
