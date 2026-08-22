import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Cross-account TWIN listings where one account has a verified mapping and
 * another does not.
 *
 * Leo / Diogo / DB Cinema list the same physical gear, so the same listing
 * often exists on two or three accounts. Where one copy is already mapped, the
 * other copy's composition is not a guess — it is the same listing.
 *
 * Grouping is by EXACT normalised title equality (lowercase, punctuation and
 * whitespace collapsed). Deliberately NOT a similarity score: fuzzy title
 * matching is banned from writing mappings here, because listing titles are
 * SEO-stuffed and a near-match routinely means a different product. Exact
 * equality after normalisation is identity.
 *
 * Read-only. Reports; writes nothing.
 */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const find = internalQuery({
  args: {},
  handler: async (ctx) => {
    const [listings, overrides, index, items] = await Promise.all([
      ctx.db.query("online_listings").collect(),
      ctx.db.query("listing_resolution_override").collect(),
      ctx.db.query("hygglo_product_index").collect(),
      ctx.db.query("items").collect(),
    ]);
    const nameById = new Map(items.map((i) => [String(i._id), i.name_canonical]));
    const ovByKey = new Map(
      overrides.map((o) => [`${o.account_slug}#${o.product_id}`, o]),
    );
    const idxByKey = new Map(
      index.map((r) => [`${r.account_slug}#${r.product_id}`, r]),
    );

    const groups = new Map<string, typeof listings>();
    for (const l of listings) {
      const k = norm(l.name ?? "");
      if (k.length < 12) continue; // too generic to treat as identity
      const arr = groups.get(k) ?? [];
      arr.push(l);
      groups.set(k, arr);
    }

    const gaps: Array<Record<string, unknown>> = [];
    // Twins that are BOTH mapped but to different compositions. These are
    // worse than an unmapped listing: the same rental answers differently
    // depending on which account the renter came through, and the thinner
    // side silently under-holds. Found live: leo#1172593 maps body-only while
    // its dbcinema twin maps the body plus both Canon zooms.
    const disagree: Array<Record<string, unknown>> = [];
    for (const [title, rows] of groups.entries()) {
      if (rows.length < 2) continue;
      {
        const allMapped = rows.filter((r) =>
          ovByKey.has(`${r.account_slug}#${r.product_id}`),
        );
        if (allMapped.length >= 2) {
          const byKey = allMapped.map((r) => {
            const o = ovByKey.get(`${r.account_slug}#${r.product_id}`)!;
            return {
              key: `${r.account_slug}#${r.product_id}`,
              n: o.components.length,
              comps: o.components
                .map((c) => `${c.qty}x ${nameById.get(String(c.item_id)) ?? "?"}`)
                .sort(),
            };
          });
          const sig = new Set(byKey.map((b) => b.comps.join("+")));
          if (sig.size > 1) {
            disagree.push({
              title: (rows[0].name ?? "").slice(0, 58),
              copies: byKey.map((b) => ({ key: b.key, n: b.n, comps: b.comps.join(", ") })),
            });
          }
        }
      }
      const mapped = rows.filter((r) => ovByKey.has(`${r.account_slug}#${r.product_id}`));
      const unmapped = rows.filter(
        (r) =>
          !ovByKey.has(`${r.account_slug}#${r.product_id}`) &&
          !idxByKey.has(`${r.account_slug}#${r.product_id}`),
      );
      if (mapped.length === 0 || unmapped.length === 0) continue;

      // Only propagate when every mapped copy agrees on the composition —
      // disagreement means the twins are not actually the same rental.
      const sigs = new Set(
        mapped.map((r) => {
          const o = ovByKey.get(`${r.account_slug}#${r.product_id}`)!;
          return o.components
            .map((c) => `${c.qty}x${nameById.get(String(c.item_id)) ?? "?"}`)
            .sort()
            .join("+");
        }),
      );
      const src = ovByKey.get(`${mapped[0].account_slug}#${mapped[0].product_id}`)!;
      gaps.push({
        title: (rows[0].name ?? "").slice(0, 58),
        agree: sigs.size === 1,
        from: `${mapped[0].account_slug}#${mapped[0].product_id}`,
        components: src.components.map((c) => ({
          item_id: String(c.item_id),
          name: nameById.get(String(c.item_id)) ?? "?",
          qty: c.qty,
        })),
        to: unmapped.map((r) => ({
          account_slug: r.account_slug,
          product_id: r.product_id,
          price: r.daily_price ?? null,
        })),
        void_title: title.slice(0, 0),
      });
    }
    const agreeing = gaps.filter((g) => g.agree);
    return {
      groups_with_gap: gaps.length,
      agreeing: agreeing.length,
      conflicting: gaps.length - agreeing.length,
      targets: agreeing.reduce(
        (n, g) => n + (g.to as unknown[]).length,
        0,
      ),
      disagreeing_pairs: disagree.length,
      disagree: disagree.slice(0, 25),
      rows: agreeing.slice(0, 40),
      conflicts: gaps.filter((g) => !g.agree).slice(0, 10),
    };
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.diag_twin_gaps.find, {}),
});
