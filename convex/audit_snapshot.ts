import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

// `listActiveReservations` removed by Phase 3a fixup (M2): zero in-repo callers
// after W1e pagination conversion. Re-add when wiring an audit cron.

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
