"use node";
/**
 * Phase 12.4 — Re-poll Hygglo for stuck active orders to populate product_id
 * + image_url on hygglo_items[].
 *
 * Targets reservations polled BEFORE PASS-10 (rows where some
 * hygglo_items[i].product_id is null). Idempotent — re-running is safe.
 *
 * Why we don't reuse `upsertOrderAsReservation`:
 *   That mutation re-writes the `items` column with the raw items shape
 *   (which carries `image`/`product_id`/`slug`). The reservations table
 *   schema validator only allows `item_name|qty|source|confidence_score|
 *   v1_extracteditem_id` on items[], so the write fails. We side-step it
 *   by patching only `hygglo_items` + `image_hints` (which DO allow the
 *   PASS-10 shape) via `patchHyggloItemsByOrderId`.
 *
 * TODO(dedupe): the buildHyggloItems / image-hint logic was copied from
 * convex/hygglo.ts. The next time either side changes, extract to a shared
 * helper.
 *
 * Constraints:
 *  - Read-only on Hygglo (GET only).
 *  - 500 ms rate-limit between order fetches.
 *  - Per-order failures (401, parse error) do NOT crash the run.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  HYGGLO_API_BASE,
  hyggloAuthHeaders,
  getHyggloAccessToken,
  getAccountCredentials,
} from "../src/lib/hygglo-auth";

type OrderDetailItem = {
  name?: string;
  qty?: number;
  type?: string;
  productId?: number;
  slug?: string;
  image?: {
    url?: string;
    originalUrl?: string;
    largeUrl?: string;
    mediumUrl?: string;
    thumbnailUrl?: string;
    fullSizeUrl?: string;
  };
};

type HyggloItem = {
  name: string;
  image_url: string | null;
  type: string;
  qty?: number;
  product_id?: number;
  slug?: string;
};

type ImageHint = {
  item_name: string;
  item_name_normalised: string;
  image_url: string;
  source: "hygglo_per_item";
  captured_at: number;
};

// Mirrors buildHyggloItems in convex/hygglo.ts.
function buildHyggloItemsLocal(items: OrderDetailItem[]): HyggloItem[] {
  return items
    .filter((i) => i.type !== "INSURANCE")
    .map((i) => {
      const img = i.image ?? {};
      // Priority: fullSizeUrl > large > original > url > medium > thumbnail.
      const url =
        img.fullSizeUrl ??
        img.largeUrl ??
        img.originalUrl ??
        img.url ??
        img.mediumUrl ??
        img.thumbnailUrl ??
        null;
      return {
        name: i.name ?? "Unknown item",
        image_url: url ?? null,
        type: typeof i.type === "string" ? i.type : "",
        qty: typeof i.qty === "number" ? i.qty : undefined,
        product_id: typeof i.productId === "number" ? i.productId : undefined,
        slug: typeof i.slug === "string" ? i.slug : undefined,
      };
    });
}

function buildImageHintsLocal(
  items: OrderDetailItem[],
  now: number,
): ImageHint[] {
  const out: ImageHint[] = [];
  for (const i of items) {
    if (i.type === "INSURANCE") continue;
    const img = i.image ?? {};
    const url =
      img.fullSizeUrl ??
      img.largeUrl ??
      img.originalUrl ??
      img.url ??
      img.mediumUrl ??
      img.thumbnailUrl;
    if (!url) continue;
    const name = i.name ?? "Unknown item";
    out.push({
      item_name: name,
      item_name_normalised: name.toLowerCase().replace(/\s+/g, " ").trim(),
      image_url: url,
      source: "hygglo_per_item",
      captured_at: now,
    });
  }
  return out;
}

function extractPhotosUrls(detail: any): string[] | undefined {
  if (Array.isArray(detail?.photos_urls)) return detail.photos_urls as string[];
  if (Array.isArray(detail?.detail?.photos_urls))
    return detail.detail.photos_urls as string[];
  const urls: string[] = [];
  for (const item of (detail?.items ?? []) as OrderDetailItem[]) {
    if (item?.image?.fullSizeUrl) urls.push(item.image.fullSizeUrl);
  }
  return urls.length > 0 ? urls : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const refreshActiveStuckOrders = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (
    ctx,
    { limit },
  ): Promise<{
    processed: number;
    refreshed: number;
    skipped: number;
    errors: number;
    error_samples: string[];
    refreshed_samples: Array<{
      hygglo_order_id: string;
      account_slug: string;
      product_ids: number[];
    }>;
  }> => {
    const cap = limit ?? 50;

    const candidates = await ctx.runQuery(
      internal.reservations.listStuckActive,
      {},
    );

    let processed = 0;
    let refreshed = 0;
    let skipped = 0;
    let errors = 0;
    const error_samples: string[] = [];
    const refreshed_samples: Array<{
      hygglo_order_id: string;
      account_slug: string;
      product_ids: number[];
    }> = [];

    const tokenCache = new Map<string, string>();

    for (const cand of candidates.slice(0, cap)) {
      processed++;
      if (!cand.hygglo_order_id || !cand.account_slug) {
        skipped++;
        continue;
      }
      try {
        let token = tokenCache.get(cand.account_slug);
        if (!token) {
          const creds = await getAccountCredentials(cand.account_slug);
          token = await getHyggloAccessToken({
            email: creds.email,
            password: creds.password,
            clientSecret: creds.clientSecret,
            accountSlug: cand.account_slug,
          });
          tokenCache.set(cand.account_slug, token);
        }

        const detailRes = await fetch(
          `${HYGGLO_API_BASE}/v4/my/orders/${cand.hygglo_order_id}?timezone=Europe/London`,
          { headers: hyggloAuthHeaders(token) },
        );
        if (!detailRes.ok) {
          errors++;
          if (error_samples.length < 5) {
            error_samples.push(
              `order ${cand.hygglo_order_id} (${cand.account_slug}): HTTP ${detailRes.status}`,
            );
          }
          if (detailRes.status === 401) tokenCache.delete(cand.account_slug);
          await sleep(500);
          continue;
        }
        const detail = (await detailRes.json()) as {
          items?: OrderDetailItem[];
        };

        const rawItems = detail.items ?? [];
        const hyggloItems = buildHyggloItemsLocal(rawItems);
        const now = Date.now();
        const imageHints = buildImageHintsLocal(rawItems, now);
        const photosUrls = extractPhotosUrls(detail);

        if (hyggloItems.length === 0) {
          skipped++;
          await sleep(500);
          continue;
        }

        await ctx.runMutation(
          internal.reservations.patchHyggloItemsByOrderId,
          {
            account_slug: cand.account_slug,
            hygglo_order_id: cand.hygglo_order_id,
            hygglo_items: hyggloItems,
            image_hints: imageHints.length > 0 ? imageHints : undefined,
            photos_urls: photosUrls,
          },
        );

        // Write-through to product_id-keyed image bank.
        await ctx.runMutation(internal.listing_images.upsertFromHyggloItems, {
          account_slug: cand.account_slug,
          items: hyggloItems,
        });

        refreshed++;
        if (refreshed_samples.length < 3) {
          const pids = hyggloItems
            .map((i) => i.product_id)
            .filter((x): x is number => typeof x === "number");
          refreshed_samples.push({
            hygglo_order_id: cand.hygglo_order_id,
            account_slug: cand.account_slug,
            product_ids: pids,
          });
        }
      } catch (err: any) {
        errors++;
        if (error_samples.length < 5) {
          error_samples.push(
            `order ${cand.hygglo_order_id}: ${String(err?.message ?? err).slice(0, 200)}`,
          );
        }
      }
      await sleep(500);
    }

    return {
      processed,
      refreshed,
      skipped,
      errors,
      error_samples,
      refreshed_samples,
    };
  },
});
