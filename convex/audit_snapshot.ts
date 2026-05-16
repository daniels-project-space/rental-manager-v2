import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

/**
 * Phase 3 audit: list reservations whose [start_date, end_date] overlaps
 * the window [today, today+30d]. Returns full row plus the resolved/expanded items.
 *
 * Note: image_hints field does not exist yet on reservations (added by phase 6).
 */
export const listActiveReservations = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const horizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const horizonIso = horizon.toISOString().slice(0, 10);

    const page = await ctx.db.query("reservations").paginate(paginationOpts);
    const inWindow = page.page.filter((r) => {
      const sd = r.start_date ?? null;
      const ed = r.end_date ?? null;
      if (!sd || !ed) return false;
      // overlap: end >= today AND start <= horizon
      return ed >= todayIso && sd <= horizonIso;
    });

    return {
      snapshot_taken_at: now.toISOString(),
      window_start: todayIso,
      window_end: horizonIso,
      total_in_window: inWindow.length,
      reservations: inWindow.map((r) => ({
        _id: r._id,
        hygglo_order_id: r.hygglo_order_id ?? null,
        account_slug: r.account_slug ?? null,
        status: r.status,
        booking_status: r.booking_status ?? null,
        order_step: r.order_step ?? null,
        start_date: r.start_date ?? null,
        end_date: r.end_date ?? null,
        items: r.items ?? [],
        resolved_items: r.resolved_items ?? null,
        expanded_items: r.expanded_items ?? null,
        photos_urls: r.photos_urls ?? null,
        image_hints: (r as any).image_hints ?? null,
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const listLinkedItems = internalQuery({
  args: { item_ids: v.array(v.id("items")) },
  handler: async (ctx, { item_ids }) => {
    const unique = Array.from(new Set(item_ids));
    const rows = await Promise.all(unique.map((id) => ctx.db.get(id)));
    return rows
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => ({
        _id: r._id,
        name: r.name_canonical,
        name_input: r.name_input,
        slug: r.slug,
        kind: r.kind,
        image_url: r.image_url ?? null,
        is_marketing_only: r.is_marketing_only,
        status: r.status,
      }));
  },
});
