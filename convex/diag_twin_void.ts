import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Why the applier plans 79 writes where the diagnostic counted 110 targets.
 *
 * The hypothesis is that the missing 31 are twins whose mapped copy has ZERO
 * components. An empty override is not an unfinished mapping — it is a
 * deliberate "backed by nothing, never quotable" marker, and lookup_pricing
 * reads it that way (`if (o.components.length === 0) ownedPids.delete(...)`).
 * Propagating one would be copying a decision that the twin is NOT stock, which
 * is a very different act from copying a composition.
 *
 * Confirms the count rather than assuming it, because the difference decides
 * how many rows get written to live mapping data.
 */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const check = internalQuery({
  args: {},
  handler: async (ctx) => {
    const [listings, overrides, index] = await Promise.all([
      ctx.db.query("online_listings").collect(),
      ctx.db.query("listing_resolution_override").collect(),
      ctx.db.query("hygglo_product_index").collect(),
    ]);
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

    let targetsFromVoid = 0;
    let targetsFromReal = 0;
    const voidSamples: string[] = [];
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      const mapped = rows.filter((r) => ovByKey.has(`${r.account_slug}#${r.product_id}`));
      const unmapped = rows.filter(
        (r) =>
          !ovByKey.has(`${r.account_slug}#${r.product_id}`) &&
          !idxByKey.has(`${r.account_slug}#${r.product_id}`),
      );
      if (mapped.length === 0 || unmapped.length === 0) continue;
      const src = ovByKey.get(`${mapped[0].account_slug}#${mapped[0].product_id}`)!;
      if (src.components.length === 0) {
        targetsFromVoid += unmapped.length;
        if (voidSamples.length < 8) voidSamples.push((rows[0].name ?? "").slice(0, 66));
      } else targetsFromReal += unmapped.length;
    }

    return {
      targets_total: targetsFromVoid + targetsFromReal,
      targets_with_real_composition: targetsFromReal,
      targets_whose_twin_is_void: targetsFromVoid,
      note: "A void twin means 'deliberately backed by nothing, never quotable'. Copying it would assert the twin is NOT stock — a different claim from copying a composition, and not what this batch is for.",
      void_samples: voidSamples,
    };
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> => ctx.runQuery(internal.diag_twin_void.check, {}),
});
