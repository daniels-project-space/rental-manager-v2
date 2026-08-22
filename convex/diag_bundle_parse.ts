import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { extractComponents } from "./lib/bundle_description_parse";

/**
 * Line-by-line parse audit for a single listing.
 *
 * Shows the RAW description beside every extracted line and the top candidate
 * items with their token overlap — so a wrong quantity or a wrongly-dropped
 * component can be traced to the exact line that caused it, instead of being
 * inferred from the proposal summary.
 */
export const audit = internalQuery({
  args: { account_slug: v.string(), product_id: v.number() },
  handler: async (ctx, { account_slug, product_id }) => {
    const row = await ctx.db
      .query("online_listings")
      .withIndex("by_account_product", (q) =>
        q.eq("account_slug", account_slug).eq("product_id", product_id),
      )
      .unique();
    if (!row) return { error: "no such listing" };
    const desc = (row.description ?? "")
      .replace(/[^\x20-\x7E]/g, " ")
      .replace(/\s+/g, " ");
    const { components, usedBullets } = extractComponents(desc);

    const items = (await ctx.db.query("items").collect()).filter(
      (i) => i.status === "active" && !i.is_marketing_only && (i.qty ?? 0) > 0,
    );
    const toks = (s: string) =>
      new Set(
        (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((t) =>
          t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t,
        ),
      );

    return {
      usedBullets,
      raw_len: desc.length,
      raw: desc,
      lines: components.map((c) => {
        const lt = toks(c.name);
        const scored = items
          .map((it) => {
            const item = toks(it.name_canonical);
            const hit = [...item].filter((t) => lt.has(t)).length;
            return {
              name: it.name_canonical,
              aliases: (it.aliases ?? []).slice(0, 4).join(" | "),
              qty_owned: it.qty ?? 0,
              frac: item.size ? hit / item.size : 0,
              covered: `${hit}/${item.size}`,
              missing: [...item].filter((t) => !lt.has(t)).join(","),
            };
          })
          .filter((s) => s.frac > 0)
          .sort((a, b) => b.frac - a.frac)
          .slice(0, 3);
        return { qty: c.qty, line: c.name, top: scored };
      }),
    };
  },
});

export default internalAction({
  args: { account_slug: v.string(), product_id: v.number() },
  handler: async (ctx, a): Promise<unknown> =>
    ctx.runQuery(internal.diag_bundle_parse.audit, a),
});
