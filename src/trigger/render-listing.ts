/**
 * render-listing — cloud listing-image renderer (replaces the VPS render batch).
 *
 * Per item: fal.ai cutout → sharp brand composite (plate + shadow + house
 * header) → store the PNG in R2 under `rendered/<account>/<slug>.png`. No VPS.
 *
 * Trigger from the dashboard (create flow) or in bulk via `renderListingsBatch`.
 */
import { task } from "@trigger.dev/sdk/v3";
import { renderFromSource } from "@/lib/render/compose";
import { putPng } from "@/mastra/lib/r2-client";

export interface RenderListingPayload {
  /** Render brand/account: "leo" | "diogo". */
  account: string;
  /** Public source photo URL (Hygglo imgix / any public http(s)). */
  sourceImageUrl: string;
  /** Header title (raw product name is fine — it's cleaned + uppercased). */
  title: string;
  /** Used for the R2 key; falls back to a slug of the title. */
  productId?: string;
}

function slug(s: string): string {
  return (s || "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "item";
}

export const renderListing = task({
  id: "render-listing",
  maxDuration: 180,
  run: async (payload: RenderListingPayload) => {
    const png = await renderFromSource({
      account: payload.account,
      sourceImageUrl: payload.sourceImageUrl,
      title: payload.title,
    });
    const key = `rendered/${payload.account}/${payload.productId ?? slug(payload.title)}.png`;
    await putPng(key, png);
    return { ok: true, key, bytes: png.length };
  },
});

export interface RenderListingsBatchPayload {
  account: string;
  items: Array<{ sourceImageUrl: string; title: string; productId?: string }>;
}

export const renderListingsBatch = task({
  id: "render-listings-batch",
  maxDuration: 300,
  run: async (payload: RenderListingsBatchPayload) => {
    const runs = await renderListing.batchTrigger(
      payload.items.map((it) => ({
        payload: { account: payload.account, ...it },
      })),
    );
    return { ok: true, triggered: payload.items.length, batchId: runs.batchId };
  },
});
