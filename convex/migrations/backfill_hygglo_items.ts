/**
 * PASS-9 hygglo_items backfill — per-rental authoritative items snapshot.
 *
 * Re-fetches each reservation's Hygglo order detail and writes the raw
 * `detail.items[]` payload into `reservation.hygglo_items[]`. This bypasses
 * any cross-rental matching against the global items table (which mis-bound
 * Michelle's Atomos Ninja V to a GM 24-70 + Monitor Bundle image).
 *
 * Idempotent: skips rows that already have `hygglo_items` AND
 * `hygglo_items.length > 0`. Default dryRun=true.
 *
 * Auth path: src/lib/hygglo-auth.ts
 *   getAccountCredentials(slug) → getHyggloAccessToken(...) → Bearer token.
 * Endpoint: /v4/my/orders/{order_id}?timezone=Europe/London (Hygglo-web client).
 */
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { internalQuery, internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "../../src/lib/hygglo-auth";

type HyggloDetailItem = {
  name?: string;
  type?: string;
  qty?: number;
  productId?: number;
  slug?: string;
  image?: {
    url?: string;
    originalUrl?: string;
    largeUrl?: string;
    mediumUrl?: string;
    thumbnailUrl?: string;
    // PASS-10: Hygglo's actual key on /v4/my/orders/{id}.items[].image.
    fullSizeUrl?: string;
  };
};

type HyggloItemRow = {
  name: string;
  image_url: string | null;
  type: string;
  qty?: number;
  product_id?: number;
  slug?: string;
};

function pickPerItemUrl(img: HyggloDetailItem["image"]): string | null {
  if (!img) return null;
  // PASS-10: prefer fullSizeUrl (Hygglo's real key). Legacy *Url keys kept
  // in chain for forward-compat. thumbnailUrl is last-resort.
  return (
    img.fullSizeUrl ??
    img.largeUrl ?? img.url ?? img.mediumUrl ?? img.originalUrl ??
    img.thumbnailUrl ?? null
  );
}

function buildHyggloItems(detailItems: HyggloDetailItem[]): HyggloItemRow[] {
  return (detailItems ?? [])
    .filter((i) => i?.type !== "INSURANCE")
    .map((i) => ({
      name: String(i?.name ?? ""),
      image_url: pickPerItemUrl(i?.image),
      type: String(i?.type ?? ""),
      qty: typeof i?.qty === "number" ? i.qty : undefined,
      product_id: typeof i?.productId === "number" ? i.productId : undefined,
      slug: typeof i?.slug === "string" ? i.slug : undefined,
    }));
}

/** Already-backfilled: hygglo_items present, non-empty AND has at least one
 *  item with a real image_url. PASS-10: rows whose every item.image_url is
 *  null are stale (Pass-9 mapping missed fullSizeUrl) and must be re-processed.
 */
function alreadyBackfilled(row: Doc<"reservations">): boolean {
  const hi = (row as any).hygglo_items;
  if (!Array.isArray(hi) || hi.length === 0) return false;
  const anyImaged = hi.some((it: any) => typeof it?.image_url === "string" && it.image_url.length > 0);
  return anyImaged;
}

// ── Internal query: paginated list of candidates ─────────────────────────

export const _listCandidates = internalQuery({
  args: {
    cursor: v.optional(v.number()),
    limit: v.number(),
    accountSlug: v.optional(v.string()),
  },
  handler: async (ctx, { cursor, limit, accountSlug }) => {
    let q = ctx.db.query("reservations").order("asc");
    const rows = await q.take(10000); // bounded scan; filter in-memory
    const filtered = rows.filter((r) => {
      if (!r.hygglo_order_id) return false;
      if (accountSlug && r.account_slug !== accountSlug) return false;
      if (cursor !== undefined && r._creationTime <= cursor) return false;
      return true;
    });
    return filtered.slice(0, limit);
  },
});

// ── Internal mutation: patch one reservation ─────────────────────────────

export const _patchItems = internalMutation({
  args: {
    reservation_id: v.id("reservations"),
    hygglo_items: v.array(v.object({
      name: v.string(),
      image_url: v.union(v.string(), v.null()),
      type: v.string(),
      qty: v.optional(v.number()),
      product_id: v.optional(v.number()),
      slug: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { reservation_id, hygglo_items }) => {
    await ctx.db.patch(reservation_id, { hygglo_items });
  },
});

// ── Main action ───────────────────────────────────────────────────────────

export const run = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    accountSlug: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { dryRun = true, accountSlug, limit = 200 },
  ): Promise<{
    processed: number;
    patched: number;
    skipped: number;
    withImages: number;
    withoutImages: number;
    errors: string[];
  }> => {
    const errors: string[] = [];
    let processed = 0;
    let patched = 0;
    let skipped = 0;
    let withImages = 0;
    let withoutImages = 0;

    const tokenByAccount = new Map<string, string>();
    const lastCallAtByAccount = new Map<string, number>();

    const candidates = await ctx.runQuery(
      internal.migrations.backfill_hygglo_items._listCandidates,
      { limit, accountSlug },
    );

    for (const row of candidates) {
      processed++;
      try {
        if (alreadyBackfilled(row)) {
          skipped++;
          continue;
        }
        const slug = row.account_slug;
        const orderId = row.hygglo_order_id;
        if (!slug || !orderId) {
          skipped++;
          continue;
        }

        // Rate-limit: 200ms between Hygglo calls per account
        const last = lastCallAtByAccount.get(slug) ?? 0;
        const wait = Math.max(0, 200 - (Date.now() - last));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        let token = tokenByAccount.get(slug);
        if (!token) {
          const creds = await getAccountCredentials(slug);
          token = await getHyggloAccessToken({
            email: creds.email,
            password: creds.password,
            clientSecret: creds.clientSecret,
            accountSlug: slug,
          });
          tokenByAccount.set(slug, token);
        }

        const url = `${HYGGLO_API_BASE}/v4/my/orders/${orderId}?timezone=Europe/London`;
        const res = await fetch(url, { headers: hyggloAuthHeaders(token) });
        lastCallAtByAccount.set(slug, Date.now());
        if (!res.ok) {
          errors.push(`order ${orderId} (${slug}): HTTP ${res.status}`);
          continue;
        }
        const detail: any = await res.json();
        const detailItems: HyggloDetailItem[] = Array.isArray(detail?.items) ? detail.items : [];
        const hygglo_items = buildHyggloItems(detailItems);

        if (hygglo_items.length === 0) {
          skipped++;
          continue;
        }
        const imaged = hygglo_items.filter((h) => !!h.image_url).length;
        withImages += imaged;
        withoutImages += hygglo_items.length - imaged;

        if (dryRun) {
          console.info(
            `[backfill_hygglo_items] DRY-RUN order=${orderId} slug=${slug} ` +
              `items=${hygglo_items.length} with_images=${imaged}`,
          );
        } else {
          await ctx.runMutation(
            internal.migrations.backfill_hygglo_items._patchItems,
            {
              reservation_id: row._id as Id<"reservations">,
              hygglo_items,
            },
          );
          patched++;
        }
      } catch (e) {
        errors.push(`row ${row._id}: ${String((e as Error)?.message ?? e)}`);
      }
    }

    console.info(
      `[backfill_hygglo_items] done dryRun=${dryRun} processed=${processed} ` +
        `patched=${patched} skipped=${skipped} with_images=${withImages} ` +
        `without_images=${withoutImages} errors=${errors.length}`,
    );
    return { processed, patched, skipped, withImages, withoutImages, errors };
  },
});
