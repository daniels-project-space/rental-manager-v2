import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { bestMatch } from "./lib/item_name_match";

/**
 * Map Blackmagic BUNDLE listings from their real "Included in this rental"
 * descriptions.
 *
 * Evidence, not titles. Titles are SEO keyword-stuffed and demonstrably lie
 * (one Full Frame listing's title says "EF Mount" while its own description
 * says "L Mount"). The descriptions carry an explicit component list with
 * quantities and, crucially, the MOUNT — which is the only reliable way to
 * tell the two Blackmagic bodies apart:
 *     BMPCC 6K Pro        -> Canon EF mount, Super 35
 *     BMPCC 6K Full Frame -> Leica L mount, full frame
 *
 * Safety rules, all deliberate:
 *  - every component is resolved with the confidence-gated matcher; anything
 *    that is not a confident match is DROPPED and reported, never guessed
 *  - a bundle is only proposed if its CAMERA BODY resolved. Without the body
 *    we do not know what the listing fundamentally is, and a partial mapping
 *    would hold the accessories while leaving the camera free to double-book
 *  - gear we do not own (BMPCC 4K, Great Joy anamorphics, GVM panels) simply
 *    fails to match and is dropped — DANIEL RULE 18 by construction
 *  - a component qty is never allowed to exceed what master inventory holds
 */

/** Consumables/packaging that are not separately-tracked inventory. */
const NOISE_RE =
  /^(various|needed|cables?|carrying|carry|bag|bags|case|cases|packaged|all items|charger|chargers|cable)\b/i;

/** Pull the component list out of an "Included in this rental" style block. */
export function extractComponents(desc: string): Array<{ qty: number; name: string }> {
  const clean = desc.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ");
  const m = clean.match(/included in th(?:is|e)[^:]*:?(.*)$/i);
  let body = m ? m[1] : clean;
  // Everything after "About this ..." is marketing prose, not contents.
  body = body.split(/\bAbout th(?:is|e)\b/i)[0];
  // Section labels ("Camera:", "Lenses (Anamorphic):", "Media:") are headings.
  body = body.replace(/\b(camera|lenses?|media|audio|support|accessories|lighting|power)\s*\([^)]*\)\s*:/gi, " ");
  body = body.replace(/\b(camera|lenses?|media|audio|support|accessories|lighting|power)\s*:/gi, " ");

  // Common misspellings in the real listings — normalise BEFORE matching, so a
  // genuinely-owned component isn't dropped for a typo. Live: "1x 24-105mm f4
  // cannon lens" failed the confidence gate against "Canon EF 24-105mm f4"
  // purely because of "cannon".
  body = body
    .replace(/\bcannon\b/gi, "Canon")
    .replace(/\bannamorphic\b/gi, "anamorphic")
    .replace(/\bsenheiser\b/gi, "Sennheiser")
    .replace(/\blaveliers?\b/gi, "lavalier");

  // Split ONLY on an explicit "Nx" quantity marker.
  //
  // Allowing a bare "N " split inside names: "1x 1 TB SSD" broke at "1 TB",
  // and "1.8x T2.9" broke at the decimal, producing garbage components like
  // "1, 8x T2.9" and merged ones like "4x batteries 1x 1TB SSD". A wrong
  // quantity is worse than no mapping — the live parse produced "2x DJI RS3
  // Pro gimbal" from a description that says "1x", by inheriting the "2x"
  // from the DJI Mics before it. The negative lookbehind rejects decimals.
  // Accept both "1x NAME" and "1 NAME" — the listings mix both formats, and
  // requiring the "x" lost every body written as "1 Blackmagic Pocket Cinema
  // Camera 6K Full Frame (L-Mount)". The unit lookahead is what makes the
  // bare-number form safe: without it "1x 1 TB SSD" split at "1 TB".
  const parts = body.split(
    /(?=(?<![\d.])\b\d{1,2}\s*x?\s+(?!(?:tb|gb|mb|mm|k)\b)[A-Za-z])/i,
  );
  const out: Array<{ qty: number; name: string }> = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const q = p.match(/^(\d{1,2})\s*x?\s+(.*)$/);
    if (!q) continue;
    const qty = Math.max(1, Math.min(10, parseInt(q[1], 10)));
    let name = q[2].trim().replace(/[.,;]+$/, "");
    // A component name never runs to the end of a long block; anything past a
    // second quantity marker belongs to the next item.
    name = name.split(/\b\d{1,2}\s*x\s+/)[0].trim();
    if (!name || NOISE_RE.test(name)) continue;
    out.push({ qty, name: name.slice(0, 60) });
  }
  return out;
}

export const propose = internalQuery({
  args: {},
  handler: async (ctx) => {
    const RE = /blackmagic|bmpcc|bmpc\b|pocket cinema/i;
    const allItems = await ctx.db.query("items").collect();
    const ownable = allItems.filter(
      (i) => i.status === "active" && !i.is_marketing_only && (i.qty ?? 0) > 0,
    );

    const [listings, index, overrides] = await Promise.all([
      ctx.db.query("online_listings").collect(),
      ctx.db.query("hygglo_product_index").collect(),
      ctx.db.query("listing_resolution_override").collect(),
    ]);
    const mapped = new Set([
      ...index.map((r) => `${r.account_slug}#${r.product_id}`),
      ...overrides.map((r) => `${r.account_slug}#${r.product_id}`),
    ]);

    const proposals: Array<Record<string, unknown>> = [];
    const noBody: string[] = [];
    for (const l of listings) {
      const title = (l.name ?? "");
      if (!RE.test(title) || /pyxis/i.test(title)) continue;
      const key = `${l.account_slug}#${l.product_id}`;
      if (mapped.has(key)) continue;
      const desc = l.description ?? "";
      if (!desc) continue;

      const comps = extractComponents(desc);
      const resolved: Array<{ item_id: string; name: string; qty: number }> = [];
      const unmatched: string[] = [];
      for (const c of comps) {
        // ASYMMETRIC MATCH: a kit line CONTAINS the item name plus extra words
        // ("Sennheiser MKE 600 shotgun mic", "Canon 24-105mm f4 Lens"), so the
        // right test is item-tokens ⊆ line-tokens, not the reverse.
        //
        // bestMatch's confidence gate requires the QUERY's tokens to be
        // covered, which is correct for "which product does the renter mean?"
        // but wrong here — it dropped genuinely-owned components over the
        // words "shotgun", "mic" and "Lens". Mount tokens (ef/l/rf/e) are
        // tolerated as missing since kit lines routinely omit them.
        const lineToks = new Set(
          (c.name.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((t) =>
            t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t,
          ),
        );
        const MOUNT_TOKS = new Set(["ef", "l", "rf", "e", "pl", "mount"]);
        let picked: (typeof ownable)[number] | null = null;
        let pickedSpecificity = 0;
        for (const it of ownable) {
          const itemToks = (it.name_canonical.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(
            (t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t),
          );
          const required = itemToks.filter((t) => !MOUNT_TOKS.has(t));
          if (required.length === 0) continue;
          if (!required.every((t) => lineToks.has(t))) continue;
          // Prefer the most specific item that fits, so "BMPCC 6K Full Frame"
          // wins over a hypothetical shorter "BMPCC" entry.
          if (required.length > pickedSpecificity) {
            picked = it;
            pickedSpecificity = required.length;
          }
        }
        // Fall back to the strict matcher for lines that are just a bare name.
        const m = picked
          ? { match: picked, confident: true }
          : bestMatch(
              c.name,
              ownable,
              (i) => i.name_canonical,
              (i) => (i.aliases ?? []) as string[],
            );
        if (!m.match || !m.confident) {
          unmatched.push(`${c.qty}x ${c.name}`);
          continue;
        }
        const cap = m.match.qty ?? 1;
        const qty = Math.min(c.qty, cap);
        const seen = resolved.find((r) => r.item_id === String(m.match!._id));
        if (seen) seen.qty = Math.min(seen.qty + qty, cap);
        else resolved.push({ item_id: String(m.match._id), name: m.match.name_canonical, qty });
      }

      const body = resolved.find((r) => /bmpcc/i.test(r.name));
      if (!body) {
        noBody.push(`${key} £${l.daily_price ?? "?"} ${title.slice(0, 60)}`);
        continue;
      }

      // BODY ONLY, QTY 1 — a deliberate, documented reduction.
      //
      // Free-text descriptions cannot be split reliably, because product names
      // contain digits: "1x DJI RS 3 Pro Gimbal" split at the "3" and produced
      // a phantom "3x", which the accessory path then wrote as 2x a qty-2 item
      // from a description that plainly says 1x. Same shape as "A7 III" and
      // "24-105". Each regex iteration fixed one split and broke another, and
      // the failure mode is a SILENTLY WRONG QUANTITY on live inventory — the
      // exact bug class this whole effort exists to remove.
      //
      // The camera body is the scarce, expensive item and the one that
      // actually double-books; it is always exactly 1 per listing, so it
      // carries no quantity ambiguity. Mapping just the body is strictly
      // better than mapping nothing (today the body is held by NOTHING when
      // one of these bundles goes out) and cannot be wrong about counts.
      //
      // Accessories stay unmapped: they read as free, which is the current
      // state, not a regression. Enumerating them needs per-listing review.
      const bodyOnly = [{ item_id: body.item_id, name: body.name, qty: 1 }];
      const notMapped = resolved
        .filter((r) => r.item_id !== body.item_id)
        .map((r) => `${r.qty}x ${r.name}`);

      proposals.push({
        key,
        account_slug: l.account_slug,
        product_id: l.product_id,
        price: l.daily_price ?? null,
        title: title.replace(/[^\x20-\x7E]/g, "").slice(0, 70),
        components: bodyOnly.map((r) => `${r.qty}x ${r.name}`),
        component_ids: bodyOnly,
        accessories_seen_but_not_mapped: notMapped,
        dropped: unmatched.slice(0, 6),
      });
    }
    return {
      proposal_count: proposals.length,
      no_body_count: noBody.length,
      no_body: noBody.slice(0, 20),
      proposals,
    };
  },
});

export const apply = internalMutation({
  args: { confirm: v.boolean() },
  handler: async (ctx, { confirm }) => {
    if (!confirm) return ["not confirmed"];
    const res = (await ctx.runQuery(internal.propose_bundle_mapping.propose, {})) as unknown as {
      proposals?: Array<{
        account_slug: string;
        product_id: number;
        component_ids: Array<{ item_id: string; qty: number }>;
      }>;
    };
    const log: string[] = [];
    for (const p of res.proposals ?? []) {
      const existing = await ctx.db
        .query("listing_resolution_override")
        .withIndex("by_account_product", (q) =>
          q.eq("account_slug", p.account_slug).eq("product_id", p.product_id),
        )
        .first();
      if (existing) continue;
      await ctx.db.insert("listing_resolution_override", {
        account_slug: p.account_slug,
        product_id: p.product_id,
        components: p.component_ids.map((c) => ({
          item_id: c.item_id as unknown as never,
          qty: c.qty,
        })),
        note: "fix:2026-08-22 bundle mapped from listing description component list",
        source: "manual_audit",
        updated_at: Date.now(),
      });
      log.push(`${p.account_slug}#${p.product_id} -> ${p.component_ids.length} components`);
    }
    return log;
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.propose_bundle_mapping.propose, {}),
});
