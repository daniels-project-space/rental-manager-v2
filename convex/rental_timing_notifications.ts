import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { queueNotificationEvents } from "./notifications";
import { pickupReminderEvent } from "./lib/rental_timing_notifications";
import { syncPickupReminder } from "./lib/rental_timing_notifications";

/** One clock, only due projected rows. No recurring rental/history scan. */
export const checkPickups = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db.query("rental_pickup_reminders").withIndex("by_active_due", q => q.eq("active", true).lte("due_at", now)).take(100);
    let inserted = 0;
    for (const entry of due) {
      const rental = await ctx.db.get(entry.reservation_id);
      const event = rental ? pickupReminderEvent(rental, now) : null;
      if (event) inserted += await queueNotificationEvents(ctx, [event]);
      await ctx.db.patch(entry._id, { active: false });
    }
    if (due.length === 100) await ctx.scheduler.runAfter(0, internal.rental_timing_notifications.checkPickups, {});
    return { checked: due.length, inserted };
  },
});

/** One-time release/recovery projection. Does not edit a rental or send a test alert. */
export const seedUpcoming = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("reservations").withIndex("by_status", q => q.eq("status", "confirmed")).paginate({ cursor: args.cursor ?? null, numItems: 100 });
    for (const row of page.page) await syncPickupReminder(ctx, row);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.rental_timing_notifications.seedUpcoming, { cursor: page.continueCursor });
    return { checked: page.page.length, done: page.isDone };
  },
});
