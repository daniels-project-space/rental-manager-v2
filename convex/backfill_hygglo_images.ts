import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/** Phase 11.2: inspect specific item images by id. */
export const inspectItemImages = internalQuery({
  args: { itemIds: v.array(v.string()) },
  handler: async (ctx, { itemIds }) => {
    const items = await ctx.db.query("items").collect();
    const out: any[] = [];
    for (const it of items) {
      const id = it._id as string;
      if (!itemIds.includes(id)) continue;
      out.push({
        item_id: id,
        name_canonical: (it as any).name_canonical,
        image_url: (it as any).image_url ? "SET" : null,
      });
    }
    return out;
  },
});

/** Phase 11.2 inspection helper — sample reservation hygglo/expanded arrays. */
export const inspectSample = internalQuery({
  args: { hyggloOrderIds: v.array(v.string()) },
  handler: async (ctx, { hyggloOrderIds }) => {
    const rows = await ctx.db.query("reservations").collect();
    const out: any[] = [];
    for (const r of rows) {
      const hid = String((r as any).hygglo_order_id ?? "");
      if (!hyggloOrderIds.includes(hid)) continue;
      const hi = (r as any).hygglo_items ?? [];
      const ei = (r as any).expanded_items ?? [];
      const ri = (r as any).resolved_items ?? [];
      out.push({
        hygglo_order_id: hid,
        is_obsolete: (r as any).is_obsolete ?? false,
        hi_len: hi.length,
        ei_len: ei.length,
        ri_len: ri.length,
        hi_sample: hi.slice(0, 3).map((h: any) => ({
          name: (h.name ?? "").slice(0, 60),
          image_set: !!h.image_url,
          type: h.type,
        })),
        ei_sample: ei.slice(0, 3).map((x: any) => ({
          item_id: x.item_id,
          name: x.item_name_canonical,
        })),
        ri_sample: ri.slice(0, 3).map((x: any) => ({
          item_id: x.item_id,
          name: x.item_name_canonical,
        })),
      });
    }
    return out;
  },
});

/**
 * Phase 11.2 — Backfill hygglo_items[].image_url for historical rentals.
 *
 * The poller (convex/hygglo.ts) was fixed in PASS-10 (commit f09f7dc) to write
 * per-item image_url into reservations.hygglo_items[i].image_url from the
 * Hygglo detail payload. Rows written BEFORE that fix have null image_url on
 * every entry, so the Active Rentals tile shows blank thumbnails.
 *
 * Strategy:
 *   1. Build Map<items._id, items.image_url> from inventory.
 *   2. Scan non-obsolete reservations whose hygglo_items[] has any null image_url.
 *   3. For each entry, resolve item_id by position (hygglo_items[i] ↔ expanded_items[i]
 *      or resolved_items[i] — poller writes both from same payload, so order is preserved).
 *   4. Fallback when array lengths diverge: name-prefix match (canonical short name is
 *      a prefix of the long Hygglo title).
 *   5. Patch hygglo_items only if any entry changed (idempotent).
 *
 * Internal — invoked via `npx convex run`.
 */
export const backfillHyggloItemImages = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    // 1. Build item_id -> image_url map.
    const items = await ctx.db.query("items").collect();
    const imgById = new Map<string, string>();
    for (const it of items) {
      const url = (it as { image_url?: string | null }).image_url;
      if (url) imgById.set(it._id as string, url);
    }

    // 2. Candidate reservations: non-obsolete, has hygglo_items, at least one null image_url.
    const rows = await ctx.db.query("reservations").collect();
    const candidates = rows
      .filter((r) => {
        if ((r as any).is_obsolete) return false;
        const hi = (r as any).hygglo_items as
          | Array<{ image_url: string | null }>
          | undefined;
        if (!Array.isArray(hi) || hi.length === 0) return false;
        return hi.some((h) => !h.image_url);
      })
      .slice(0, limit ?? 100);

    let patched = 0;
    let imagesAdded = 0;
    let positionUsed = 0;
    let fallbackUsed = 0;
    let unmatched = 0;

    const norm = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();

    for (const r of candidates) {
      const hi = (((r as any).hygglo_items ?? []) as Array<{
        name: string;
        image_url: string | null;
        type: string;
        qty?: number;
        product_id?: number;
        slug?: string;
      }>);
      const ei = (((r as any).expanded_items ?? (r as any).resolved_items ?? []) as Array<{
        item_id: string;
        item_name_canonical?: string;
      }>);

      const usePosition = hi.length === ei.length && hi.length > 0;

      const updated = hi.map((h, idx) => {
        if (h.image_url) return h; // already populated — idempotent
        let itemId: string | undefined;
        if (usePosition) {
          itemId = ei[idx]?.item_id;
          if (itemId) positionUsed++;
        } else {
          // Name-prefix fallback: canonical short name must be a prefix
          // of the (normalised) hygglo listing title.
          const target = norm(h.name);
          const match = ei.find(
            (x) =>
              x.item_name_canonical &&
              target.startsWith(norm(x.item_name_canonical)),
          );
          itemId = match?.item_id;
          if (itemId) fallbackUsed++;
        }
        const url = itemId ? imgById.get(itemId) ?? null : null;
        if (url) imagesAdded++;
        else unmatched++;
        return { ...h, image_url: url ?? h.image_url };
      });

      if (updated.some((h, i) => h.image_url !== hi[i].image_url)) {
        await ctx.db.patch(r._id, { hygglo_items: updated } as any);
        patched++;
      }
    }

    return {
      candidates: candidates.length,
      patched,
      imagesAdded,
      positionUsed,
      fallbackUsed,
      unmatched,
      limit: limit ?? 100,
    };
  },
});
