import { action, query, internalQuery, requireOwner } from "./owner_functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const args = { reservationId: v.id("reservations") };
export const context = query({ args, handler: async (ctx, { reservationId }) => {
  await requireOwner(ctx, true);
  const row = await ctx.db.get(reservationId);
  if (!row || row.account_slug !== "dbcinema_web" || !row.hygglo_order_id) throw Error("Select a DB Cinema website rental");
  return { bookingId: row.hygglo_order_id, bookingStatus: row.booking_status ?? null, verification: row.site_verification ?? null,
    sourceRevision: row.site_revision ?? 0, syncedAt: row.last_polled_at ?? null,
    websiteUrl: `https://dbcinemarentals.com/admin?rental=${encodeURIComponent(row.hygglo_order_id)}#messages` };
} });
export const binding = internalQuery({ args, handler: async (ctx, { reservationId }) => {
  const row = await ctx.db.get(reservationId);
  if (!row || row.account_slug !== "dbcinema_web" || !row.hygglo_order_id) throw Error("Select a DB Cinema website rental");
  return { bookingId: row.hygglo_order_id };
} });
/** Owner-only bounded refresh of one rental. Approval remains authoritative on the website. */
export const refresh = action({ args, handler: async (ctx, { reservationId }): Promise<{ ok: boolean }> => {
  await requireOwner(ctx, true);
  const { bookingId } = await ctx.runQuery(internal.websiteVerification.binding, { reservationId });
  const url = process.env.DBCINEMA_CONVEX_URL, token = process.env.DBCINEMA_ADMIN_TOKEN;
  if (!url || !token) throw Error("Website verification connection is not configured");
  const response = await fetch(`${url.replace(/\/$/, "")}/api/query`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "rmv2_sync:forRmv2SyncBooking", args: { token, bookingId }, format: "json" }), signal: AbortSignal.timeout(12000) });
  let result: { status?: string; value?: { id?: string } };
  try { result = await response.json(); } catch { throw Error("Website verification could not be refreshed. Try again."); }
  if (!response.ok || result.status !== "success" || result.value?.id !== bookingId) throw Error("Website verification could not be refreshed. Try again.");
  const receipt = await ctx.runMutation(internal.sync_dbcinema_web.upsertSiteBookingsBatch, { bookings: [result.value], reconcile: false });
  if (receipt.receipts?.some((r: { outcome: string }) => r.outcome === "stale" || r.outcome === "ignored")) throw Error("Website verification has not supplied a current paid rental. Check the website.");
  return { ok: true };
} });
