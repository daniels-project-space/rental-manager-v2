import { v } from "convex/values";
import { mutation, query } from "./owner_functions";
import type { Doc } from "./_generated/dataModel";
import { DEAD_ORDER_STEPS } from "./order_step_semantics";

function project(row: Doc<"reservations">) {
  return {
    _id: row._id, hygglo_order_id: row.hygglo_order_id, account_slug: row.account_slug,
    start_date: row.start_date, end_date: row.end_date, pickup_date: row.pickup_date, return_date: row.return_date,
    order_step: row.order_step, status: row.status, is_obsolete: row.is_obsolete,
    items: row.items, resolved_items: row.resolved_items, expanded_items: row.expanded_items, renter_name: row.renter_name,
  };
}

/** Periodic full repair snapshot, retaining actual hold cleanup. */
export const listBatch = query({
  args: { account_slugs: v.array(v.string()) },
  handler: async (ctx, { account_slugs }) => {
    const accounts = [...new Set(account_slugs)];
    if (accounts.length > 8) throw new Error("Reconciliation supports up to eight accounts per batch");
    if (!accounts.length) return { strategy: "reservation-index" as const, groups: [] };
    const today = new Date();
    const lookback = new Date(today); lookback.setUTCDate(lookback.getUTCDate() - 400);
    const cutoff = lookback.toISOString().slice(0, 10);
    const past = new Date(today); past.setUTCDate(past.getUTCDate() - 30);
    const pastCutoff = past.toISOString().slice(0, 10);
    // Candidate bookings are derived from reservation date indexes below.
    // Scanning calendar_holds to find reservation IDs made this refresh grow
    // with every item/day row, then fell back to collecting 400 days of fat
    // reservation documents once either threshold was crossed. The indexed
    // candidate set already covers the 30-day past window and all later end or
    // return dates; terminal rows are loaded directly from bounded indexes.
    const groups = [];
    for (const account_slug of accounts) {
      const candidates: Doc<"reservations">[] = [];
      const obsolete = await ctx.db.query("reservations").withIndex("by_account_obsolete_start", q =>
        q.eq("account_slug", account_slug).eq("is_obsolete", true).gte("start_date", cutoff)).collect();
      candidates.push(...obsolete);
      for (const step of DEAD_ORDER_STEPS) {
        const dead = await ctx.db.query("reservations").withIndex("by_account_order_step_start", q =>
          q.eq("account_slug", account_slug).eq("order_step", step).gte("start_date", cutoff)).collect();
        candidates.push(...dead);
      }
      // Exclude obsolete history from the active date indexes before reading
      // documents. Legacy missing flags remain eligible exactly like false.
      for (const obsolete of [false, undefined] as const) {
        const [ending, extended] = await Promise.all([
          ctx.db.query("reservations").withIndex("by_account_obsolete_end", q =>
            q.eq("account_slug", account_slug).eq("is_obsolete", obsolete).gte("end_date", pastCutoff)).collect(),
          ctx.db.query("reservations").withIndex("by_account_obsolete_return", q =>
            q.eq("account_slug", account_slug).eq("is_obsolete", obsolete).gte("return_date", pastCutoff)).collect(),
        ]);
        candidates.push(...ending, ...extended);
      }
      const rows = [...new Map(candidates.filter(row => typeof row.start_date === "string" && row.start_date >= cutoff)
        .map(row => [row._id, row])).values()]
        .sort((a, b) => (a.start_date ?? "").localeCompare(b.start_date ?? "") || a._creationTime - b._creationTime);
      groups.push({ account_slug, reservations: rows.map(project) });
    }
    return { strategy: "reservation-index" as const, groups };
  },
});

/** Read the compact dirty queue and the matching reservation rows. */
export const listDirtyBatch = query({
  args: {
    account_slugs: v.array(v.string()),
  },
  handler: async (ctx, { account_slugs }) => {
    const accounts = [...new Set(account_slugs)];
    if (accounts.length > 8) throw new Error("Reconciliation supports up to eight accounts per batch");
    const groups = [];
    for (const account_slug of accounts) {
      const markers = await ctx.db
        .query("reservation_reconcile_dirty")
        .withIndex("by_account_version", (q) => q.eq("account_slug", account_slug).gt("version", 0))
        .take(500);
      const rows = await Promise.all(markers.map((marker) => ctx.db.get(marker.reservation_id)));
      groups.push({
        account_slug,
        reservations: rows
          .filter((row): row is Doc<"reservations"> => row !== null && row.account_slug === account_slug)
          .map(project),
        markers: markers.map((marker) => ({
          id: marker._id,
          reservation_id: marker.reservation_id,
          version: marker.version,
          missingReservation: !rows.some((row) => row?._id === marker.reservation_id),
        })),
      });
    }
    return { groups };
  },
});

/** Acknowledge only queue versions that were actually processed. */
export const ackDirty = mutation({
  args: {
    markers: v.array(v.object({ id: v.id("reservation_reconcile_dirty"), version: v.number() })),
  },
  handler: async (ctx, { markers }) => {
    let deleted = 0;
    for (const marker of markers) {
      const current = await ctx.db.get(marker.id);
      if (!current || current.version !== marker.version) continue;
      await ctx.db.delete(marker.id);
      deleted += 1;
    }
    return { deleted };
  },
});
