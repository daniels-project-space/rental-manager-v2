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

import { extractComponents } from "./lib/bundle_description_parse";

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

      const { components: comps, usedBullets } = extractComponents(desc);
      const resolved: Array<{
        item_id: string;
        name: string;
        qty: number;
        kind: string;
      }> = [];
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
          // Mount tokens are tolerated as missing because kit lines omit them
          // -- but ONLY when enough signal survives. "PL to EF mount" is
          // ENTIRELY mount tokens, so stripping them left the single token
          // "to", which matched the phrase "ready-to-shoot" in a marketing
          // sentence and proposed a mount adapter for a kit that has none.
          // Below 2 surviving tokens the tolerance is dropped and the full
          // item name must appear.
          const stripped = itemToks.filter((t) => !MOUNT_TOKS.has(t));
          const required = stripped.length >= 2 ? stripped : itemToks;
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
        // MAX, not SUM. Two lines resolving to the same item almost always
        // means the item was MENTIONED twice (intro prose plus the bullet),
        // not that there are two of them: diogo#1173794 lists "1x Variable ND
        // filter" once and describes it once, and summing proposed 2x. Max
        // errs toward under-holding, which is the safe direction -- an
        // over-count marks real stock as rented when it is on the shelf.
        if (seen) seen.qty = Math.min(Math.max(seen.qty, qty), cap);
        else
          resolved.push({
            item_id: String(m.match._id),
            name: m.match.name_canonical,
            qty,
            kind: m.match.kind,
          });
      }

      // The body must be an actual CAMERA, checked by inventory kind.
      // Matching /bmpcc/i on the NAME accepted "BMPCC battery pack" as the
      // body: two listings resolved to a battery pack alone, passing this gate
      // while the real camera stayed unmapped and free to double-book. Kind is
      // the fact; the name is a string that happens to share a prefix.
      const body = resolved.find((r) => r.kind === "camera");
      if (!body) {
        noBody.push(`${key} £${l.daily_price ?? "?"} ${title.slice(0, 60)}`);
        continue;
      }

      // TWO TIERS, by how trustworthy the description's structure is.
      //
      // Quantities are only believed when the description used real bullet
      // delimiters. Each bullet carries its own count, so a number cannot leak
      // across items -- the failure that turned "1x DJI RS 3 Pro Gimbal" into
      // a phantom "3x" (splitting at the "3" in "RS 3") is impossible there.
      //
      // Everything else falls back to the numeric split, which is NOT safe for
      // counts, so those listings map the CAMERA BODY ONLY at qty 1. The body
      // is the scarce, expensive item and the one that actually double-books;
      // there is exactly one per listing, so it carries no count ambiguity.
      // Their accessories stay unmapped and read as free -- today's behaviour,
      // not a regression.
      const useFull = usedBullets;
      const chosen = useFull
        ? resolved
        : [{ item_id: body.item_id, name: body.name, qty: 1 }];
      const bodyOnly = chosen;
      const notMapped = useFull
        ? []
        : resolved
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
        source: useFull ? "bulleted-description" : "body-only-fallback",
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
        source: string;
        component_ids: Array<{ item_id: string; name: string; qty: number }>;
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
        note: `fix:2026-08-22 from listing description [${p.source}]: ${p.component_ids
          .map((c) => `${c.qty}x ${c.name}`)
          .join(", ")}`,
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
