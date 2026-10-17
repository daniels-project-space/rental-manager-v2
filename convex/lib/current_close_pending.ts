import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { reservationReadGate } from "./reservation_read_model";
import { preparedReservationReadContext, isReservationReadSourceContext } from "./reservation_read_queries";
import { isInCurrentOrderPresence, isOutstandingReturnState, type ReturnPresenceRow } from "./return_presence";

const legacy = new WeakSet<object>();
const reports = new WeakMap<object, { mode: "source" | "current_orders"; orders: number; reason?: string }>();
export function useLegacyClosePending(ctx: QueryCtx) { legacy.add(ctx); }
export function closePendingReadReport(ctx: QueryCtx) { return reports.get(ctx); }

/** The existing return predicate requires an exact current-feed order ID.
 * Fetch those bounded IDs through the already-qualified compact read model,
 * retaining complete documents and every duplicate order row. */
export async function loadVisibleClosePending(ctx: QueryCtx, accountSlug: string | null, today: string, presence: ReturnPresenceRow[]): Promise<Doc<"reservations">[]> {
  const visible = (rows: Doc<"reservations">[]) => rows.filter(row =>
    (!accountSlug || row.account_slug === accountSlug) && isOutstandingReturnState(row, today) && isInCurrentOrderPresence(row, presence));
  const source = async (reason: string, orders = 0) => {
    reports.set(ctx, { mode: "source", orders, reason });
    return visible(await ctx.db.query("reservations").withIndex("by_status_close_pending", q => q.eq("status", "completed").eq("platform_close_pending", true)).collect());
  };
  if (legacy.has(ctx) || isReservationReadSourceContext(ctx)) return source("source qualification");
  if ("insert" in ctx.db) return source("mutable context");
  try {
    if (presence.some(row => !Array.isArray(row.orderIds) || row.orderIds.some(id => typeof id !== "string"))) return source("unsupported presence shape");
    const ids = [...new Set(presence.flatMap(row => row.orderIds).filter(Boolean))];
    if (!ids.length) { reports.set(ctx, { mode: "current_orders", orders: 0 }); return []; }
    if (ids.length > 64) return source("current-order bound exceeded", ids.length);
    const gate = await reservationReadGate(ctx);
    if (!gate?.ready || !gate.enabled || gate.version !== 1) return source("compact model unavailable", ids.length);
    // Strict reads never turn corrupt compressed records into a fat per-order
    // scan. Any failure returns to the original close-pending source query.
    const prepared = preparedReservationReadContext(ctx);
    const rows: Doc<"reservations">[] = [];
    for (let offset = 0; offset < ids.length; offset += 8) {
      const groups = await Promise.all(ids.slice(offset, offset + 8).map(async id => {
        const [records, witnesses] = await Promise.all([
          prepared.db.query("reservations").withIndex("by_hygglo_order_id", q => q.eq("hygglo_order_id", id)).take(9),
          ctx.db.query("reservation_order_presence").withIndex("by_order", q => q.eq("hygglo_order_id", id)).take(9),
        ]);
        const sourceIds = new Set(witnesses.map(row => String(row.source_id)));
        if (records.length >= 9 || witnesses.length >= 9 || sourceIds.size !== witnesses.length || records.length !== sourceIds.size || records.some(row => !sourceIds.has(String(row._id)))) throw Error("Incomplete or excessive order cohort");
        return records;
      }));
      rows.push(...groups.flat());
      if (rows.length > 256) return source("record bound exceeded", ids.length);
    }
    if (new Set(rows.map(row => String(row._id))).size !== rows.length) return source("duplicate source identity", ids.length);
    const pending = rows.filter(row => row.status === "completed" && row.platform_close_pending === true);
    const times = new Set<number>();
    if (pending.some(row => !Number.isFinite(row._creationTime) || times.has(row._creationTime) || !times.add(row._creationTime))) return source("opaque source creation order", ids.length);
    pending.sort((a, b) => a._creationTime - b._creationTime);
    reports.set(ctx, { mode: "current_orders", orders: ids.length });
    return visible(pending);
  } catch { return source("compact read failed"); }
}
