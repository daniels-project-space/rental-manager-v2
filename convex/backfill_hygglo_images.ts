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

/** Phase 11.3 — check which canonical names lack inventory images. */
export const checkInventoryImages = internalQuery({
  args: { names: v.array(v.string()) },
  handler: async (ctx, { names }) => {
    const items = await ctx.db.query("items").collect();
    // Normalize: strip [category] suffix, lowercase, replace punctuation with
    // spaces, collapse whitespace. The [category] tag (e.g. "[camera]",
    // "[lens]") is part of canonical names but never appears in Hygglo titles
    // — stripping it before substring matching unblocks kit listings.
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/[^a-z0-9 ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const byNorm = new Map<string, { name: string; hasImg: boolean }>();
    for (const it of items) {
      const cn = (it as any).name_canonical ?? "";
      byNorm.set(norm(cn), { name: cn, hasImg: !!(it as any).image_url });
    }
    const out: any[] = [];
    for (const n of names) {
      const hit = byNorm.get(norm(n));
      out.push({ query: n, found: !!hit, hasImg: hit?.hasImg ?? false, matched: hit?.name ?? null });
    }
    return out;
  },
});

/** Phase 11.3 — list reservations with any null hygglo_items[].image_url. */
export const listStuck = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query("reservations").collect();
    const stuck: any[] = [];
    for (const r of rows) {
      if ((r as any).is_obsolete) continue;
      const hi = (r as any).hygglo_items as Array<{ name: string; image_url: string | null }> | undefined;
      if (!Array.isArray(hi) || hi.length === 0) continue;
      if (!hi.some((h) => !h.image_url)) continue;
      const ei = (r as any).expanded_items ?? (r as any).resolved_items ?? [];
      stuck.push({
        hygglo_order_id: String((r as any).hygglo_order_id ?? ""),
        hi_len: hi.length,
        ei_len: ei.length,
        hi_names: hi.map((h: any) => (h.name ?? "").slice(0, 120)),
        ei_canonical: ei.map((x: any) => x.item_name_canonical ?? null),
      });
      if (stuck.length >= (limit ?? 100)) break;
    }
    return stuck;
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
    const byStrategy = {
      position: 0,
      prefix: 0,
      substring: 0,
      firstWord: 0,
      none: 0,
    };

    // Strip [category] suffix from canonical names so substring matching can
    // succeed against Hygglo titles (titles never contain bracketed tags).
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/[^a-z0-9 ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

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
        let strat: keyof typeof byStrategy = "none";

        // Strategy 1: position correlation (1:1 rows).
        if (usePosition) {
          itemId = ei[idx]?.item_id;
          if (itemId) strat = "position";
        }

        const target = norm(h.name);

        // Strategy 2: prefix match.
        if (!itemId) {
          const match = ei.find(
            (x) =>
              x.item_name_canonical &&
              target.startsWith(norm(x.item_name_canonical)),
          );
          if (match?.item_id) {
            itemId = match.item_id;
            strat = "prefix";
          }
        }

        // Strategy 3: substring containment (kit-style listings).
        // NOTE: kits bundle multiple items under ONE hygglo entry — we pick
        // the FIRST (longest-canonical) item whose name is contained in the
        // hygglo title as a representative thumbnail. Multi-item kits get
        // one image; this is intentional.
        if (!itemId) {
          const matches = ei
            .filter((x) => {
              const cn = x.item_name_canonical;
              if (!cn) return false;
              const n = norm(cn);
              // Length/digit guard: avoid false positives on short generic
              // words like "kit", "pro", "mic".
              if (n.length < 4 && !/\d/.test(n)) return false;
              return target.includes(n);
            })
            .sort(
              (a, b) =>
                norm(b.item_name_canonical ?? "").length -
                norm(a.item_name_canonical ?? "").length,
            );
          if (matches[0]?.item_id) {
            itemId = matches[0].item_id;
            strat = "substring";
          }
        }

        // Strategy 4: first-word startsWith. Skip leading qty-only tokens
        // (e.g. "2" from "2x JBL PartyBox…") and try first 2 significant
        // words plus the first word alone, capped to 30 chars of title.
        if (!itemId) {
          const allWords = target.split(" ").filter(Boolean);
          // Drop leading pure-digit / single-letter qty tokens like "2", "x".
          let i0 = 0;
          while (
            i0 < allWords.length &&
            (/^\d+$/.test(allWords[i0]) || allWords[i0].length < 2)
          ) {
            i0++;
          }
          const sliced = allWords.slice(i0).join(" ").slice(0, 30);
          const words = sliced.split(" ").filter(Boolean);
          const tries = [
            words.slice(0, 2).join(" "),
            words[0] ?? "",
          ].filter((w) => w && (w.length >= 3 || /\d/.test(w)));
          for (const w of tries) {
            const match = ei.find((x) => {
              const cn = x.item_name_canonical;
              if (!cn) return false;
              return norm(cn).startsWith(w);
            });
            if (match?.item_id) {
              itemId = match.item_id;
              strat = "firstWord";
              break;
            }
          }
        }

        const url = itemId ? imgById.get(itemId) ?? null : null;
        if (url) {
          imagesAdded++;
          byStrategy[strat]++;
        } else {
          byStrategy.none++;
        }
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
      byStrategy,
      limit: limit ?? 100,
    };
  },
});
