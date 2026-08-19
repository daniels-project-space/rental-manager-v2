import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Full audit of listing_resolution_override — the audit-authoritative table
 * that WINS over everything else. A wrong row here is a silent wrong answer
 * everywhere, so it deserves stronger checks than "does it conflict with the
 * index" (which only ever looked at the subset that HAS an index row).
 *
 * Two mechanical, non-heuristic defect tests:
 *   A. IMPOSSIBLE DEMAND — the override asks for more units of an item than
 *      the master inventory has. Cannot be right under any interpretation.
 *   B. ZERO TOKEN OVERLAP — no component's canonical name shares a meaningful
 *      word with the listing title. Not proof of error, but the exact
 *      signature of the two confirmed bad rows, so worth surfacing.
 */
const STOP = new Set([
  "the", "and", "for", "with", "plus", "set", "kit", "bundle", "combo", "like",
  "pro", "2x", "3x", "4x", "x2", "x3", "x4", "professional", "full", "mm", "new",
]);

const toks = (s: string): Set<string> =>
  new Set(
    (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
      (t) => t.length > 2 && !STOP.has(t),
    ),
  );

export const audit = internalQuery({
  args: {},
  handler: async (ctx) => {
    const items = await ctx.db.query("items").collect();
    const byId = new Map(items.map((i) => [String(i._id), i]));
    const overrides = await ctx.db.query("listing_resolution_override").collect();

    const bySource: Record<string, number> = {};
    const impossible: string[] = [];
    const zeroOverlap: string[] = [];

    for (const o of overrides) {
      const src = o.note?.startsWith("auto:") ? `note:${o.note.split(" ")[0]}` : (o.source ?? "none");
      bySource[src] = (bySource[src] ?? 0) + 1;

      const prod = await ctx.db
        .query("hygglo_products")
        .withIndex("by_account_product", (q) =>
          q.eq("accountSlug", o.account_slug).eq("productId", o.product_id),
        )
        .first();
      const title = prod?.name ?? "";
      const key = `${o.account_slug}#${o.product_id}`;

      // A. impossible demand
      for (const c of o.components) {
        const it = byId.get(String(c.item_id));
        if (!it) continue;
        const have = it.qty ?? 0;
        if (c.qty > have) {
          impossible.push(
            `${key} "${title.slice(0, 60)}" → wants ${c.qty}x ${it.name_canonical} but qty=${have} [${o.note ?? ""}]`,
          );
        }
      }

      // B. zero token overlap with the listing title
      if (title && o.components.length > 0) {
        const t = toks(title);
        const anyHit = o.components.some((c) => {
          const n = byId.get(String(c.item_id))?.name_canonical ?? "";
          for (const w of toks(n)) if (t.has(w)) return true;
          return false;
        });
        if (!anyHit) {
          zeroOverlap.push(
            `${key} "${title.slice(0, 60)}" → [${o.components
              .map((c) => `${c.qty}x ${byId.get(String(c.item_id))?.name_canonical ?? "?"}`)
              .join(", ")}] [${o.note ?? ""}]`,
          );
        }
      }
    }

    return {
      totalOverrides: overrides.length,
      bySource,
      impossibleCount: impossible.length,
      impossible,
      zeroOverlapCount: zeroOverlap.length,
      zeroOverlap: zeroOverlap.slice(0, 40),
    };
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.investigate_overrides.audit, {}),
});
