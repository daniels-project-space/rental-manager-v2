import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Which listings SAY they include a given item, and does their mapping agree?
 *
 * The renter bot only knows a kit's contents through the resolved mapping. If
 * a listing's description lists a lens but the mapping omits it, the bot will
 * offer that lens as a paid extra on a listing that already includes it.
 */
export const find = internalQuery({
  args: { pattern: v.string() },
  handler: async (ctx, { pattern }) => {
    const re = new RegExp(pattern, "i");
    const [listings, overrides, items] = await Promise.all([
      ctx.db.query("online_listings").collect(),
      ctx.db.query("listing_resolution_override").collect(),
      ctx.db.query("items").collect(),
    ]);
    const nameById = new Map(items.map((i) => [String(i._id), i.name_canonical]));
    const ovByKey = new Map(
      overrides.map((o) => [`${o.account_slug}#${o.product_id}`, o]),
    );

    const out: Array<Record<string, unknown>> = [];
    for (const l of listings) {
      const desc = (l.description ?? "").replace(/[^\x20-\x7E]/g, " ");
      const title = l.name ?? "";
      if (!re.test(desc) && !re.test(title)) continue;
      const key = `${l.account_slug}#${l.product_id}`;
      const ov = ovByKey.get(key);
      out.push({
        key,
        price: l.daily_price ?? null,
        title: title.slice(0, 62),
        mapped: ov
          ? ov.components
              .map((c) => `${c.qty}x ${nameById.get(String(c.item_id)) ?? "?"}`)
              .join(", ")
          : "(UNMAPPED)",
        says: (desc.match(new RegExp(`[^.*\\-]{0,44}${pattern}[^.*\\-]{0,22}`, "i")) ??
          [""])[0].trim(),
      });
    }
    return { count: out.length, rows: out.slice(0, 25) };
  },
});

export default internalAction({
  args: { pattern: v.string() },
  handler: async (ctx, a): Promise<unknown> =>
    ctx.runQuery(internal.diag_kit_contents.find, a),
});
