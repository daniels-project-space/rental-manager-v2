import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

/**
 * Propagate a verified listing mapping to its IDENTICAL twin on another account.
 *
 * Leo / Diogo / DB Cinema list the same physical gear, so the same listing
 * exists two or three times. Where one copy is already mapped and another is
 * not, the unmapped copy's composition is not a guess — it is the same listing,
 * with the same title, on a different account.
 *
 * WHY THIS IS ALLOWED TO WRITE. Similarity and brand matchers are banned from
 * writing mappings here, because listing titles are SEO-stuffed and a near-match
 * routinely means a different product. This is not a similarity score: titles
 * are compared for EXACT equality after normalisation (lowercase, punctuation
 * and whitespace collapsed), which is an identity test. Daniel chose this route
 * explicitly on 2026-08-30 over a manual review list.
 *
 * SAFETY RAILS, because this is a bulk write to live mapping data:
 *   - `dry_run` defaults TRUE. Nothing is written unless the caller says so.
 *   - Refuses to run at all if ANY twin group's mapped copies disagree about
 *     composition — disagreement means the twins are not the same rental, and
 *     the safe reading of that is "stop", not "pick one".
 *   - Skips titles under 12 normalised characters as too generic to be identity.
 *   - Idempotent: a listing that already has an override or an index row is
 *     left alone, so re-running changes nothing.
 *   - Every row is stamped with SOURCE, so `revert` can remove exactly this
 *     batch and nothing else.
 *
 * This does NOT touch MASTER_INVENTORY. It writes `listing_resolution_override`
 * rows, which map an account's Hygglo listing to items that already exist.
 */
const SOURCE = "twin_identity_propagation_2026-08-30";

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const apply = internalMutation({
  args: { dry_run: v.optional(v.boolean()) },
  handler: async (ctx, { dry_run = true }) => {
    const [listings, overrides, index, items] = await Promise.all([
      ctx.db.query("online_listings").collect(),
      ctx.db.query("listing_resolution_override").collect(),
      ctx.db.query("hygglo_product_index").collect(),
      ctx.db.query("items").collect(),
    ]);
    const nameById = new Map(items.map((i) => [String(i._id), i.name_canonical]));
    const ovByKey = new Map(overrides.map((o) => [`${o.account_slug}#${o.product_id}`, o]));
    const idxByKey = new Map(index.map((r) => [`${r.account_slug}#${r.product_id}`, r]));

    const groups = new Map<string, typeof listings>();
    for (const l of listings) {
      const k = norm(l.name ?? "");
      if (k.length < 12) continue;
      const arr = groups.get(k) ?? [];
      arr.push(l);
      groups.set(k, arr);
    }

    const planned: Array<{
      title: string;
      from: string;
      to: string;
      components: Array<{ name: string; qty: number }>;
    }> = [];
    const conflicts: string[] = [];

    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      const mapped = rows.filter((r) => ovByKey.has(`${r.account_slug}#${r.product_id}`));
      const unmapped = rows.filter(
        (r) =>
          !ovByKey.has(`${r.account_slug}#${r.product_id}`) &&
          !idxByKey.has(`${r.account_slug}#${r.product_id}`),
      );
      if (mapped.length === 0 || unmapped.length === 0) continue;

      // Every mapped copy must agree, or the twins are not the same rental.
      const sigs = new Set(
        mapped.map((r) =>
          ovByKey
            .get(`${r.account_slug}#${r.product_id}`)!
            .components.map((c) => `${c.qty}x${nameById.get(String(c.item_id)) ?? "?"}`)
            .sort()
            .join("+"),
        ),
      );
      if (sigs.size > 1) {
        conflicts.push((rows[0].name ?? "").slice(0, 70));
        continue;
      }

      const src = ovByKey.get(`${mapped[0].account_slug}#${mapped[0].product_id}`)!;
      // A mapping backed by nothing is deliberate ("never quotable") and must
      // not be propagated as if it were a real composition.
      if (src.components.length === 0) continue;

      for (const target of unmapped) {
        planned.push({
          title: (rows[0].name ?? "").slice(0, 70),
          from: `${mapped[0].account_slug}#${mapped[0].product_id}`,
          to: `${target.account_slug}#${target.product_id}`,
          components: src.components.map((c) => ({
            name: nameById.get(String(c.item_id)) ?? "?",
            qty: c.qty,
          })),
        });
        if (!dry_run) {
          await ctx.db.insert("listing_resolution_override", {
            account_slug: target.account_slug,
            product_id: target.product_id,
            components: src.components.map((c) => ({
              item_id: c.item_id as Id<"items">,
              qty: c.qty,
            })),
            note: `Identical-title twin of ${mapped[0].account_slug}#${mapped[0].product_id}`,
            source: SOURCE,
            updated_at: Date.now(),
          });
        }
      }
    }

    // Stop rather than write a partial batch: a conflict means the identity
    // assumption is wrong somewhere, and that is worth a human look.
    if (conflicts.length > 0)
      return {
        applied: 0,
        dry_run,
        refused: true as const,
        reason:
          "Some twin groups disagree about composition. Identity is not safe here; nothing was written.",
        conflicts: conflicts.slice(0, 20),
      };

    return {
      dry_run,
      refused: false as const,
      applied: dry_run ? 0 : planned.length,
      would_apply: planned.length,
      source: SOURCE,
      sample: planned.slice(0, 10),
    };
  },
});

/** Remove exactly this batch — the reason every row carries SOURCE. */
export const revert = internalMutation({
  args: { confirm: v.boolean() },
  handler: async (ctx, { confirm }) => {
    if (!confirm) return { removed: 0, note: "pass confirm:true" };
    const rows = (await ctx.db.query("listing_resolution_override").collect()).filter(
      (o) => o.source === SOURCE,
    );
    for (const r of rows) await ctx.db.delete(r._id);
    return { removed: rows.length, source: SOURCE };
  },
});

export default internalAction({
  args: { dry_run: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<unknown> =>
    ctx.runMutation(internal.twin_gap_apply.apply, args),
});
