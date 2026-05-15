/**
 * Wave-5 image-accuracy fix — backfill action.
 *
 * Re-fetches each in-window reservation's Hygglo order detail and writes
 * per-item `image_hints` from the live `detail.items[i].image` payload.
 *
 * Idempotent: skips rows whose `image_hints` exists AND every entry has
 * source !== "hygglo_order". Re-runs only re-process legacy/missing rows or
 * rows whose hints fell back to order-level photos.
 *
 * Driven manually first via Convex dashboard (`backfillImageHints` action),
 * default `dryRun: true`. Daniel reviews the counts before flipping.
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

// ── Local helpers (kept in sync with convex/hygglo.ts) ────────────────────

function normaliseItemNameLocal(s: string): string {
  return s.toLowerCase()
    .replace(/[\s\-_/]+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .trim();
}

type HyggloImageHint = {
  item_name: string;
  item_name_normalised: string;
  image_url: string;
  source: "hygglo_per_item" | "hygglo_order" | "manual_override";
  captured_at: number;
};

type HyggloDetailItem = {
  name?: string;
  image?: {
    url?: string;
    originalUrl?: string;
    largeUrl?: string;
    mediumUrl?: string;
    thumbnailUrl?: string;
  };
};

function pickPerItemUrl(img: HyggloDetailItem["image"]): string | null {
  if (!img) return null;
  return img.largeUrl ?? img.originalUrl ?? img.url ?? img.mediumUrl ?? img.thumbnailUrl ?? null;
}

/**
 * Align Hygglo detail.items[] to reservation.items[] by:
 *   1. Positional (i-th → i-th) when array lengths match exactly,
 *   2. Exact name match,
 *   3. Normalised name match,
 *   4. Fallback to order-level photos_urls positional pick.
 */
function buildHintsByAlignment(
  reservationItems: Array<{ item_name: string }>,
  detailItems: HyggloDetailItem[],
  fallbackOrderPhotos: string[] | undefined,
  now: number,
): HyggloImageHint[] {
  const hints: HyggloImageHint[] = [];
  const lenMatch = reservationItems.length === detailItems.length;

  // Build name lookup tables once
  const byExact = new Map<string, HyggloDetailItem>();
  const byNorm = new Map<string, HyggloDetailItem>();
  for (const di of detailItems) {
    if (typeof di?.name === "string") {
      byExact.set(di.name, di);
      byNorm.set(normaliseItemNameLocal(di.name), di);
    }
  }

  for (let i = 0; i < reservationItems.length; i++) {
    const ri = reservationItems[i];
    if (!ri?.item_name) continue;

    let matched: HyggloDetailItem | undefined;
    // 1. Positional (only when lengths match)
    if (lenMatch) {
      const di = detailItems[i];
      if (typeof di?.name === "string") matched = di;
    }
    // 2. Exact name
    if (!matched) matched = byExact.get(ri.item_name);
    // 3. Normalised name
    if (!matched) matched = byNorm.get(normaliseItemNameLocal(ri.item_name));

    const perItem = pickPerItemUrl(matched?.image);
    if (perItem) {
      hints.push({
        item_name: ri.item_name,
        item_name_normalised: normaliseItemNameLocal(ri.item_name),
        image_url: perItem,
        source: "hygglo_per_item",
        captured_at: now,
      });
      continue;
    }

    // 4. Order-level fallback (positional first, then any /products/)
    const positional = fallbackOrderPhotos?.[i];
    const productLike = (fallbackOrderPhotos ?? []).find((u) => u.includes("/products/"));
    const fallback = positional ?? productLike ?? fallbackOrderPhotos?.[0];
    if (!fallback) continue;
    hints.push({
      item_name: ri.item_name,
      item_name_normalised: normaliseItemNameLocal(ri.item_name),
      image_url: fallback,
      source: "hygglo_order",
      captured_at: now,
    });
  }
  return hints;
}

/** True when the row already has fully-populated per-item hints. Skip target. */
function isFullyPerItem(row: Doc<"reservations">): boolean {
  const hints = row.image_hints;
  if (!hints || hints.length === 0) return false;
  return hints.every((h) => h.source !== "hygglo_order");
}

// ── Internal query: paginated list of candidates ─────────────────────────

export const _listCandidates = internalQuery({
  args: {
    cursor: v.optional(v.number()),
    limit: v.number(),
    accountSlug: v.optional(v.string()),
  },
  handler: async (ctx, { cursor, limit, accountSlug }) => {
    // Deterministic order by _creationTime asc; cursor = last seen _creationTime.
    let q = ctx.db.query("reservations").order("asc");
    const rows = await q.take(10000); // bounded scan; we filter in-memory
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

export const _patchHints = internalMutation({
  args: {
    reservation_id: v.id("reservations"),
    image_hints: v.array(v.object({
      item_name: v.string(),
      item_name_normalised: v.string(),
      image_url: v.string(),
      source: v.union(
        v.literal("hygglo_per_item"),
        v.literal("hygglo_order"),
        v.literal("manual_override"),
      ),
      captured_at: v.number(),
    })),
  },
  handler: async (ctx, { reservation_id, image_hints }) => {
    await ctx.db.patch(reservation_id, { image_hints });
  },
});

// ── Main action ───────────────────────────────────────────────────────────

export const backfillImageHints = internalAction({
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
    perItem: number;
    orderLevel: number;
    errors: string[];
  }> => {
    const errors: string[] = [];
    let processed = 0;
    let patched = 0;
    let skipped = 0;
    let perItemCount = 0;
    let orderLevelCount = 0;

    // Cache token + last-call-ts per account to rate-limit (200ms).
    const tokenByAccount = new Map<string, string>();
    const lastCallAtByAccount = new Map<string, number>();

    const candidates = await ctx.runQuery(
      internal.migrations.backfill_image_hints._listCandidates,
      { limit, accountSlug },
    );

    for (const row of candidates) {
      processed++;
      try {
        if (isFullyPerItem(row)) {
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

        // Auth (cached per account)
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
        const detailItems: HyggloDetailItem[] = Array.isArray(detail?.items)
          ? detail.items.filter((i: any) => i?.type !== "INSURANCE")
          : [];

        const reservationItems = (row.items ?? []) as Array<{ item_name: string }>;
        if (reservationItems.length === 0) {
          skipped++;
          continue;
        }
        const now = Date.now();
        const hints = buildHintsByAlignment(
          reservationItems,
          detailItems,
          row.photos_urls,
          now,
        );
        if (hints.length === 0) {
          skipped++;
          continue;
        }
        perItemCount += hints.filter((h) => h.source === "hygglo_per_item").length;
        orderLevelCount += hints.filter((h) => h.source === "hygglo_order").length;

        if (dryRun) {
          console.info(
            `[backfill_image_hints] DRY-RUN order=${orderId} slug=${slug} ` +
              `would write ${hints.length} hints ` +
              `(per-item=${hints.filter((h) => h.source === "hygglo_per_item").length}, ` +
              `order-level=${hints.filter((h) => h.source === "hygglo_order").length})`,
          );
        } else {
          await ctx.runMutation(
            internal.migrations.backfill_image_hints._patchHints,
            { reservation_id: row._id as Id<"reservations">, image_hints: hints },
          );
          patched++;
        }
      } catch (e) {
        errors.push(`row ${row._id}: ${String((e as Error)?.message ?? e)}`);
      }
    }

    console.info(
      `[backfill_image_hints] done dryRun=${dryRun} processed=${processed} ` +
        `patched=${patched} skipped=${skipped} per-item=${perItemCount} ` +
        `order-level=${orderLevelCount} errors=${errors.length}`,
    );
    return {
      processed,
      patched,
      skipped,
      perItem: perItemCount,
      orderLevel: orderLevelCount,
      errors,
    };
  },
});
