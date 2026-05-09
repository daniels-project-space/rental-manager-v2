import { query } from "./_generated/server";
import { v } from "convex/values";

const TODAY = () => new Date().toISOString().slice(0, 10);

/**
 * W05 Live Activity Feed — recent reservations ordered by creation time
 */
export const getRecentActivity = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    limit: v.number(),
  },
  handler: async (ctx, { accountSlug, limit }) => {
    // OPEN_INDEX_NEED: index by _creationTime DESC would avoid full scan here.
    let rows = await ctx.db.query("reservations").collect();
    if (accountSlug) {
      rows = rows.filter((r) => r.account_slug === accountSlug);
    }
    rows.sort((a, b) => b._creationTime - a._creationTime);
    rows = rows.slice(0, limit);

    return rows.map((r) => ({
      id: r._id,
      accountSlug: r.account_slug,
      itemNames: (r.items ?? []).map((i) => i.item_name),
      status: r.status,
      startDate: r.start_date,
      endDate: r.end_date,
      createdAt: r._creationTime,
    }));
  },
});

/**
 * W07 Return Hub — active reservations due today or overdue
 */
export const getDueReturns = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    const today = TODAY();
    // OPEN_INDEX_NEED: composite index (status, end_date) for efficient due/overdue scan.
    let active = await ctx.db
      .query("reservations")
      .withIndex("by_status", (q) => q.eq("status", "confirmed"))
      .collect();

    if (accountSlug) {
      active = active.filter((r) => r.account_slug === accountSlug);
    }

    const due = active.filter(
      (r) => r.end_date !== undefined && r.end_date <= today
    );

    const results = await Promise.all(
      due.map(async (r) => {
        let renterName = "Unknown";
        if (r.renter_id) {
          const renter = await ctx.db.get(r.renter_id);
          renterName = renter?.display_name ?? "Unknown";
        }
        return {
          reservationId: r._id,
          renterName,
          itemNames: (r.items ?? []).map((i) => i.item_name),
          endDate: r.end_date,
          isOverdue: r.end_date !== undefined && r.end_date < today,
          accountSlug: r.account_slug,
        };
      })
    );

    return results;
  },
});

/**
 * W09 Conversation Funnel — counts by stage derived from reservations + denials
 */
export const getConversionFunnel = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
  },
  handler: async (ctx, { accountSlug, days }) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db.query("reservations").collect();
    if (accountSlug) {
      reservations = reservations.filter(
        (r) => r.account_slug === accountSlug
      );
    }
    const recent = reservations.filter(
      (r) => r.start_date !== undefined && r.start_date >= cutoffStr
    );

    const bookings = recent.filter(
      (r) => r.status === "confirmed" || r.status === "completed"
    ).length;

    // Conversations as proxy for inquiries
    let conversations = await ctx.db.query("conversations").collect();
    if (accountSlug) {
      const accountRow = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) =>
          q.eq("slug", accountSlug as string)
        )
        .first();
      if (accountRow) {
        conversations = conversations.filter(
          (c) => c.account_id === accountRow._id
        );
      }
    }
    const inquiries = conversations.filter(
      (c) => c._creationTime >= cutoff.getTime()
    ).length;

    let denials = await ctx.db.query("denial_records").collect();
    if (accountSlug) {
      const accountRow = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) =>
          q.eq("slug", accountSlug as string)
        )
        .first();
      if (accountRow) {
        denials = denials.filter((d) => d.account_id === accountRow._id);
      }
    }
    const recentDenials = denials.filter(
      (d) => d.created_at >= cutoff.getTime()
    ).length;

    const responses = inquiries; // conversations == responses (no separate sent-count available)
    const conversionRate = inquiries > 0 ? bookings / inquiries : 0;
    const denialRate =
      inquiries > 0 ? recentDenials / inquiries : 0;

    return {
      inquiries,
      responses,
      bookings,
      conversionRate,
      denialRate,
    };
  },
});
