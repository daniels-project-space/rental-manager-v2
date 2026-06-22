/**
 * render-listing — cloud listing-image renderer (replaces the VPS render batch).
 *
 * The heavy image work (Replicate cutout + sharp/opentype compose → R2) runs on
 * Vercel at POST /api/render, because sharp's native libvips binary doesn't load
 * in Trigger's deploy image. This task simply ORCHESTRATES: it calls that Vercel
 * endpoint per item. No VPS, and no native deps in the Trigger bundle.
 *
 * Set RENDER_API_BASE (the deployed RM base URL, e.g. https://<app>.vercel.app)
 * in the Trigger environment for these tasks to reach the render endpoint.
 */
import { task } from "@trigger.dev/sdk/v3";

function renderBase(): string {
  const base = process.env.RENDER_API_BASE;
  if (!base) throw new Error("RENDER_API_BASE is not set (deployed RM base URL)");
  return base.replace(/\/+$/, "");
}

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

export const renderListing = task({
  id: "render-listing",
  maxDuration: 180,
  run: async (payload: RenderListingPayload) => {
    const res = await fetch(`${renderBase()}/api/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; key?: string; error?: string };
    if (!res.ok || !data.ok) {
      throw new Error(`render failed (${res.status}): ${data.error ?? "unknown"}`);
    }
    return { ok: true, key: data.key };
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
      payload.items.map((it) => ({ payload: { account: payload.account, ...it } })),
    );
    return { ok: true, triggered: payload.items.length, batchId: runs.batchId };
  },
});
