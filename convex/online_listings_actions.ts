"use node";
/**
 * Online-listings rescan (2026-07-03). Pulls each account's LIVE Hygglo listings
 * (one GET /v2/my/products) and replaces the `online_listings` cache the
 * Add-items picker reads. READ-ONLY against Hygglo.
 *
 * Wired to the "Rescan listings" button in Settings; run it whenever new
 * listings have been added on Hygglo so they show up in the picker.
 *
 * Fetches directly via hygglo-auth (the convex-safe auth helper renter_trust.ts
 * also uses) rather than importing src/lib/hygglo/listings.ts — that module is
 * Next-oriented (pulls in @/hygglo-core + aws-sdk + the renderer) and doesn't
 * belong in Convex's dependency graph.
 */
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "../src/lib/hygglo-auth";

const ALLOWED = new Set(["leo", "dbcinema", "diogo"]);

interface RawPrice {
  days?: number;
  pricePerDay?: number;
  price?: number | null;
}
interface RawProduct {
  id?: number;
  name?: string;
  description?: string;
  isPublished?: boolean;
  prices?: RawPrice[];
  images?: Array<{ fullSizeUrl?: string; thumbnailUrl?: string }>;
  publicUrl?: string;
}

/** Cheapest per-day price across a listing's price rows (prefers the 1-day rate). */
function dayPrice(p: RawProduct): number | undefined {
  const prices = p.prices ?? [];
  const oneDay = prices.find((x) => x.days === 1);
  const perDay = oneDay?.pricePerDay ?? oneDay?.price ?? undefined;
  if (typeof perDay === "number") return perDay;
  const candidates = prices
    .map((x) => x.pricePerDay ?? x.price)
    .filter((x): x is number => typeof x === "number");
  return candidates.length ? Math.min(...candidates) : undefined;
}

export const rescan = action({
  args: { account_slug: v.string() },
  handler: async (
    ctx,
    { account_slug },
  ): Promise<{ ok: boolean; stored?: number; error?: string }> => {
    if (!ALLOWED.has(account_slug))
      return { ok: false, error: `unknown account '${account_slug}'` };
    try {
      const creds = await getAccountCredentials(account_slug);
      const token = await getHyggloAccessToken({ ...creds, accountSlug: account_slug });
      const res = await fetch(`${HYGGLO_API_BASE}/v2/my/products`, {
        headers: hyggloAuthHeaders(token),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `products ${res.status}: ${body.slice(0, 160)}` };
      }
      const raw = (await res.json()) as unknown;
      const arr: RawProduct[] = Array.isArray(raw)
        ? (raw as RawProduct[])
        : ((raw as { products?: RawProduct[]; data?: RawProduct[] })?.products ??
          (raw as { data?: RawProduct[] })?.data ??
          []);
      const listings = arr
        .filter((p) => typeof p.id === "number")
        .map((p) => ({
          product_id: p.id as number,
          name: (p.name ?? `Listing ${p.id}`).slice(0, 300),
          image: p.images?.[0]?.fullSizeUrl,
          daily_price: dayPrice(p),
          is_published: p.isPublished !== false,
          public_url: p.publicUrl,
          // The list endpoint omits descriptions; leave undefined so the draft
          // path lazily fetches + caches the real "Included in this rental" text.
          description:
            p.description && p.description.trim() ? p.description.slice(0, 600) : undefined,
        }));
      const out = await ctx.runMutation(
        internal.online_listings.replaceForAccount,
        { account_slug, listings },
      );
      return { ok: true, stored: out.stored };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});
