import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

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
 * Structured contents preserve declared units independently of stock. Known
 * marketing items remain in the mapping so a bundle cannot borrow ownership
 * from its body. Partial or unstructured repairs are reported for review.
 */

import { resolveBundleMapping } from "./lib/bundle_mapping";

export const propose = internalQuery({
  args: { include_mapped: v.optional(v.boolean()), account_slug: v.optional(v.string()), product_ids: v.optional(v.array(v.number())) },
  handler: async (ctx, args) => {
    const RE = /blackmagic|bmpcc|bmpc\b|pocket cinema/i;
    const allItems = await ctx.db.query("items").collect();

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
      if (args.account_slug && l.account_slug !== args.account_slug) continue;
      if (args.product_ids && !args.product_ids.includes(l.product_id)) continue;
      if (mapped.has(key) && !args.include_mapped) continue;
      const desc = l.description ?? "";
      if (!desc) continue;

      const { components: resolved, unmatched, structured: usedBullets } = resolveBundleMapping(desc, allItems);

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

      // Unstructured proposals remain visible for diagnosis but cannot be
      // applied as a verified full-kit mapping.
      const useFull = usedBullets;
      const chosen = useFull
        ? resolved
        : [{ item_id: body.item_id, name: body.name, qty: 1 }];
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
        components: chosen.map((r) => `${r.qty}x ${r.name}`),
        component_ids: chosen,
        source: useFull ? "bulleted-description" : "body-only-fallback",
        accessories_seen_but_not_mapped: notMapped,
        dropped: unmatched,
        requires_review: !usedBullets || unmatched.length > 0,
        previous_components: overrides.find(row => row.account_slug === l.account_slug && row.product_id === l.product_id)?.components ?? null,
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
  args: { confirm: v.boolean(), include_mapped: v.optional(v.boolean()), account_slug: v.optional(v.string()), product_ids: v.optional(v.array(v.number())),
    expected: v.optional(v.array(v.object({product_id:v.number(),before:v.union(v.null(),v.array(v.object({item_id:v.string(),qty:v.number()}))),after:v.array(v.object({item_id:v.string(),qty:v.number()}))}))) },
  handler: async (ctx, { confirm, expected, ...scope }) => {
    if (!confirm) return ["not confirmed"];
    if (scope.include_mapped && (!scope.account_slug || !scope.product_ids?.length || scope.product_ids.length > 50))
      throw new Error("Existing mapping repairs require an explicit account and 1–50 reviewed product IDs");
    const res = (await ctx.runQuery(internal.propose_bundle_mapping.propose, scope)) as unknown as {
      proposals?: Array<{
        account_slug: string;
        product_id: number;
        source: string;
        requires_review: boolean;
        component_ids: Array<{ item_id: string; name: string; qty: number }>;
      }>;
    };
    const fingerprint = (components: Array<{item_id:unknown;qty:number}> | null) => components === null ? "absent"
      : JSON.stringify(components.map(c => ({item_id:String(c.item_id),qty:c.qty})).sort((a,b)=>a.item_id.localeCompare(b.item_id)||a.qty-b.qty));
    if (scope.include_mapped) {
      for (const product_id of scope.product_ids!) {
        const reviewed = expected?.find(row=>row.product_id===product_id);
        const proposal = res.proposals?.find(row=>row.product_id===product_id);
        if (!reviewed || !proposal || proposal.requires_review || fingerprint(reviewed.after)!==fingerprint(proposal.component_ids))
          throw new Error(`Mapping proposal changed or needs review: ${scope.account_slug}#${product_id}`);
      }
    }
    const log: string[] = [];
    let changed = 0;
    for (const p of res.proposals ?? []) {
      if (p.requires_review) { log.push(`${p.account_slug}#${p.product_id}: withheld — contents need review`); continue; }
      const existing = await ctx.db
        .query("listing_resolution_override")
        .withIndex("by_account_product", (q) =>
          q.eq("account_slug", p.account_slug).eq("product_id", p.product_id),
        )
        .first();
      if (existing && !scope.include_mapped) continue;
      const reviewed = expected?.find(row=>row.product_id===p.product_id);
      if (scope.include_mapped && fingerprint(existing?.components ?? null)!==fingerprint(reviewed!.before))
        throw new Error(`Mapping changed after review: ${p.account_slug}#${p.product_id}`);
      if (existing && fingerprint(existing.components) === fingerprint(p.component_ids)) {
        log.push(`${p.account_slug}#${p.product_id}: unchanged`); continue;
      }
      const patch = {
        account_slug: p.account_slug,
        product_id: p.product_id,
        components: p.component_ids.map((c) => ({
          item_id: c.item_id as unknown as never,
          qty: c.qty,
        })),
        note: `${existing?.note ? `${existing.note}\n` : ""}fix:2026-10-02 verified structured listing description [${p.source}]: ${p.component_ids
          .map((c) => `${c.qty}x ${c.name}`)
          .join(", ")}`,
        source: "manual_audit",
        updated_at: Date.now(),
      };
      if (existing) await ctx.db.patch(existing._id, patch);
      else await ctx.db.insert("listing_resolution_override", patch);
      changed++;
      log.push(`${p.account_slug}#${p.product_id} -> ${p.component_ids.length} components`);
    }
    if (changed) {
      const settings = await ctx.db.query("settings").first();
      if (settings) await ctx.db.patch(settings._id, {draft_epoch:(settings.draft_epoch ?? 0)+1});
    }
    return log;
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.propose_bundle_mapping.propose, {}),
});
