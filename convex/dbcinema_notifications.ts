import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { queueNotificationEvents } from "./notifications";
import { buildConfirmedBookingNotificationCopy } from "./lib/notification_events";

export const receive = internalMutation({
  args: { event: v.object({ version: v.literal(1), eventKey: v.string(), kind: v.string(), conversationId: v.string(),
    createdAt: v.number(), title: v.string(), body: v.string(), renterName: v.string(),
    income: v.optional(v.object({ gross: v.number(), net: v.number(), currency: v.string() })) }) },
  handler: async (ctx, { event: e }) => {
    if (![e.eventKey, e.kind, e.conversationId].every(s => s.length > 0 && s.length <= 256) ||
        !Number.isSafeInteger(e.createdAt) || e.createdAt < 0 || e.createdAt > Date.now() + 60_000 ||
        e.title.length > 300 || e.body.length > 2000 || e.renterName.length > 300)
      throw Error("Invalid website notification");
    const paid = e.kind === "booking_paid";
    if (paid && (!e.income || e.income.currency !== "GBP" || ![e.income.gross, e.income.net].every(n => Number.isFinite(n) && n >= 0 && n <= 1_000_000)))
      throw Error("Website income receipt is missing");
    const copy_data = paid ? { renter_name: e.renterName, gross: e.income!.gross, net: e.income!.net, currency: "GBP" } : undefined;
    const copy = paid ? buildConfirmedBookingNotificationCopy({ ...e.income!, renterName: e.renterName, accountSlug: "dbcinema_web" })
      : { title: `DB Cinema Web · ${e.title}`, body: e.body };
    const type = paid ? "booking_confirmed" : e.kind === "human_request" ? "human_request" :
      e.kind === "renter_message" ? "renter_message" : e.kind === "booking_cancelled" ? "booking_cancelled" :
      e.kind.startsWith("email_") ? "email_notification" : "booking_update";
    const thread_id = `dbcinema:${e.conversationId}`;
    const inserted = await queueNotificationEvents(ctx, [{ type, event_key: `dbcinema:${e.eventKey}`,
      source_kind: e.kind, source_channel: e.kind.startsWith("email_") ? "email" : "website", created_at: e.createdAt,
      thread_id, account_slug: "dbcinema_web", ...copy, copy_data,
      url: `/?thread=${encodeURIComponent(thread_id)}&account=dbcinema_web` }]);
    return { ok: true, version: 1, eventKey: e.eventKey, inserted: inserted > 0 };
  },
});
