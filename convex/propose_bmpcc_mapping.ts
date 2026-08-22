import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Propose (and, with apply=true, write) mappings for the BODY-ONLY Blackmagic
 * listings.
 *
 * Context: 127 Blackmagic listings exist across the three accounts and only 3
 * were mapped. The earlier "BMPCC 6K Pro has no listing" conclusion was drawn
 * from the MAPPING table rather than the catalogue, so it could only ever find
 * listings that were already mapped — circular, and wrong.
 *
 * The discriminator (confirmed by Daniel, and consistent with the listing
 * descriptions):
 *   BMPCC 6K Pro        -> Canon EF mount, Super 35
 *   BMPCC 6K Full Frame -> Leica L mount, full frame
 * These are DIFFERENT cameras, not variants of one.
 *
 * DELIBERATELY CONSERVATIVE. Only listings that are unambiguously ONE body and
 * nothing else are proposed here:
 *   - must name Blackmagic/BMPCC and exactly one of the two models
 *   - listings naming BOTH ("Full Frame 6K + BMPCC 6K Pro… dual camera") are
 *     skipped: they are two-body kits and need a real component list
 *   - Pyxis is a different camera and Daniel has ruled it marketing — skipped
 *   - BMPCC 4K is not in master inventory at all — skipped
 *   - anything bundling glass/gimbal/rig is skipped; a bundle needs its
 *     components enumerated, which is a separate, evidence-led pass
 *
 * Storage/media (SSD, CFexpress, batteries) does NOT disqualify a body-only
 * listing — those ship with the camera and are not separately-tracked items.
 */

const ACCESSORY_RE =
  /\b(lens|lenses|mm\b|anamorphic|gimbal|rs\s?3|ronin|rig|tripod|follow focus|nucleus|mic|microphone|monitor|transmitter|speedbooster|operator|zeiss|vespid|samyang|sirui|great joy|blazar|dzo)\b/i;

/**
 * Extras that make a listing MORE than a bare body, caught by price review:
 * the proposal initially included a £150 "Explorer Set", a £140 "CINEMA Kit
 * Combo", a £70 "+ v mount run and gun setup" and a £50 "Set + VND Filter".
 * Genuine body-only Blackmagic listings sit at £30-47, so anything carrying
 * these words is a bundle and needs its components enumerated, not a
 * single-item mapping.
 *
 * "body set" / "body kit" are explicitly allowed — those ARE the bare body.
 */
const EXTRAS_RE =
  /\+|\bexplorer\b|\bcombo\b|run\s*(&|and)\s*gun|\bv[-\s]?mount\b|\bvnd\b|\bfilter\b|\bultimate\b|\bproduction\b|\bpackage\b/i;
const BODY_ONLY_RE = /\bbody\s*(set|kit)\b/i;

function classify(title: string): "pro" | "ff" | null {
  const t = title.toLowerCase();
  if (!/blackmagic|bmpcc|bmpc\b|pocket cinema/.test(t)) return null;
  if (/pyxis/.test(t)) return null; // different camera, ruled marketing
  if (/\b4k\b/.test(t) && !/6k/.test(t)) return null; // BMPCC 4K not owned
  const saysPro = /6k\s*pro|pro\b/.test(t) && /6k/.test(t);
  const saysFF = /full\s*frame|6k\s*ff\b/.test(t);
  if (saysPro && saysFF) return null; // dual-camera kit — needs components
  if (saysFF) return "ff";
  if (saysPro) return "pro";
  return null;
}

export const propose = internalQuery({
  args: {},
  handler: async (ctx) => {
    const items = await ctx.db.query("items").collect();
    const pro = items.find((i) => i.name_canonical === "BMPCC 6K Pro");
    const ff = items.find((i) => i.name_canonical === "BMPCC 6K Full Frame");
    if (!pro || !ff) return { error: "BMPCC items not found in master inventory" };

    const [listings, index, overrides] = await Promise.all([
      ctx.db.query("online_listings").collect(),
      ctx.db.query("hygglo_product_index").collect(),
      ctx.db.query("listing_resolution_override").collect(),
    ]);
    const mapped = new Set([
      ...index.map((r) => `${r.account_slug}#${r.product_id}`),
      ...overrides.map((r) => `${r.account_slug}#${r.product_id}`),
    ]);

    const propose: Array<Record<string, unknown>> = [];
    const skippedBundles: string[] = [];
    for (const l of listings) {
      const title = (l.name ?? "").replace(/[^\x20-\x7E]/g, "");
      const cls = classify(title);
      if (!cls) continue;
      const key = `${l.account_slug}#${l.product_id}`;
      if (mapped.has(key)) continue; // already resolved — leave alone
      // A bare body may say "body set/kit"; anything else carrying extras is
      // a bundle. Price sanity-checks this: bodies are £30-47.
      const isBodyOnly = BODY_ONLY_RE.test(title);
      if (!isBodyOnly && (ACCESSORY_RE.test(title) || EXTRAS_RE.test(title))) {
        skippedBundles.push(`${key} £${l.daily_price ?? "?"} ${title.slice(0, 80)}`);
        continue;
      }
      propose.push({
        account_slug: l.account_slug,
        product_id: l.product_id,
        price: l.daily_price ?? null,
        title: title.slice(0, 90),
        item: cls === "pro" ? "BMPCC 6K Pro" : "BMPCC 6K Full Frame",
      });
    }
    return {
      propose_count: propose.length,
      propose,
      skipped_bundle_count: skippedBundles.length,
      skipped_bundles: skippedBundles.slice(0, 25),
    };
  },
});

export const apply = internalMutation({
  args: { confirm: v.boolean() },
  handler: async (ctx, { confirm }) => {
    if (!confirm) return ["not confirmed — no writes"];
    const items = await ctx.db.query("items").collect();
    const byName = new Map(items.map((i) => [i.name_canonical, i]));
    const proposed = (await ctx.runQuery(internal.propose_bmpcc_mapping.propose, {})) as {
      propose?: Array<{ account_slug: string; product_id: number; item: string; title: string }>;
    };
    const log: string[] = [];
    for (const p of proposed.propose ?? []) {
      const it = byName.get(p.item);
      if (!it) {
        log.push(`SKIP ${p.account_slug}#${p.product_id}: no item "${p.item}"`);
        continue;
      }
      const existing = await ctx.db
        .query("listing_resolution_override")
        .withIndex("by_account_product", (q) =>
          q.eq("account_slug", p.account_slug).eq("product_id", p.product_id),
        )
        .first();
      if (existing) {
        log.push(`SKIP ${p.account_slug}#${p.product_id}: override already exists`);
        continue;
      }
      await ctx.db.insert("listing_resolution_override", {
        account_slug: p.account_slug,
        product_id: p.product_id,
        components: [{ item_id: it._id, qty: 1 }],
        note: `fix:2026-08-22 body-only Blackmagic mapped by model+mount (Pro=EF/S35, FF=L/full-frame)`,
        source: "manual_audit",
        updated_at: Date.now(),
      });
      log.push(`${p.account_slug}#${p.product_id} -> ${p.item}`);
    }
    return log;
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.propose_bmpcc_mapping.propose, {}),
});
