/**
 * Auto-close reconciler (Hygglo-confirmed). A confirmed reservation stays
 * status:"confirmed" until someone closes it, but once Hygglo's funnel reaches
 * REVIEWED the gear is physically back (renter returned it, review stage). This
 * cron closes those automatically so the Return Hub only shows gear genuinely
 * still out.
 *
 * Conservative on purpose:
 *   - only order_step === "REVIEWED" (the unambiguous "returned" signal)
 *   - only the recent window (avoid touching ancient unreconciled rows)
 *   - never reopens; only confirmed → completed
 */
import { internalMutation, query } from "./_generated/server";

const RECENT_DAYS = 120;
const recentCutoff = () =>
  new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);

/** What WOULD be auto-closed right now — read-only, closes nothing. */
export const previewReconcile = query({
  args: {},
  handler: async (ctx) => {
    const cutoff = recentCutoff();
    const rows = (
      await ctx.db
        .query("reservations")
        .withIndex("by_status", (q) => q.eq("status", "confirmed"))
        .collect()
    ).filter(
      (r) =>
        r.order_step === "REVIEWED" &&
        !r.is_obsolete &&
        r.end_date !== undefined &&
        r.end_date >= cutoff,
    );
    return {
      count: rows.length,
      sample: rows.slice(0, 25).map((r) => ({
        order: r.hygglo_order_id ?? null,
        renter: r.renter_name ?? null,
        dates: `${r.start_date ?? "?"}→${r.end_date ?? "?"}`,
        account: r.account_slug ?? null,
      })),
    };
  },
});

/** Cron entry — closes Hygglo-confirmed returns. */
export const reconcile = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = recentCutoff();
    const rows = (
      await ctx.db
        .query("reservations")
        .withIndex("by_status", (q) => q.eq("status", "confirmed"))
        .collect()
    ).filter(
      (r) =>
        r.order_step === "REVIEWED" &&
        !r.is_obsolete &&
        r.end_date !== undefined &&
        r.end_date >= cutoff,
    );
    let closed = 0;
    for (const r of rows) {
      const base = r.notes ?? "";
      const stamp = "Auto-closed: Hygglo marked REVIEWED (returned)";
      await ctx.db.patch(r._id, {
        status: "completed",
        notes: base ? `${base} | ${stamp}` : stamp,
      });
      closed++;
    }
    return { closed };
  },
});
