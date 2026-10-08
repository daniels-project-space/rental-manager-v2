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
import { action, internalActionOf } from "./owner_functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { HYGGLO_API_VERSION } from "../src/hygglo-core/auth";
import { retainedListingDescription } from "./lib/listing_description";
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
  ): Promise<{ ok: boolean; stored?: number; descriptionsRefreshed?: number; error?: string }> => {
    if (!ALLOWED.has(account_slug))
      return { ok: false, error: `unknown account '${account_slug}'` };
    try {
      const creds = await getAccountCredentials(account_slug);
      const token = await getHyggloAccessToken({ ...creds, accountSlug: account_slug });
      const res = await fetch(`${HYGGLO_API_BASE}/${HYGGLO_API_VERSION}/my/products`, {
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
            p.description && p.description.trim() ? retainedListingDescription(p.description) : undefined,
        }));
      const out = await ctx.runMutation(
        internal.online_listings.replaceForAccount,
        { account_slug, listings },
      );
      const product_ids=await ctx.runQuery(internal.online_listings.descriptionRepairCandidates,{account_slug});
      const repaired=product_ids.length?await ctx.runAction(internal.online_listings_actions.__service_refreshDescriptions,{account_slug,product_ids}):null;
      return { ok: true, stored: out.stored, ...(repaired?{descriptionsRefreshed:repaired.refreshed}: {}) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

/** Bounded authenticated source repair, also used by the existing rescan UI.
 * Every detail is read from the current provider; no provider writes occur. */
export const refreshDescriptions=action({args:{account_slug:v.string(),product_ids:v.array(v.number())},handler:async(ctx,{account_slug,product_ids}):Promise<{refreshed:number;failed:number;results:{product_id:number;status:string;length?:number}[]}>=>{
  if(!ALLOWED.has(account_slug)||product_ids.length>8||!product_ids.length||new Set(product_ids).size!==product_ids.length||product_ids.some(id=>!Number.isSafeInteger(id)||id<1))throw Error("Select up to eight source listings");
  const creds=await getAccountCredentials(account_slug),token=await getHyggloAccessToken({...creds,accountSlug:account_slug});
  const results:{product_id:number;status:string;length?:number}[]=[];
  for(const product_id of product_ids){
    try{
      const response=await fetch(`${HYGGLO_API_BASE}/${HYGGLO_API_VERSION}/my/products/${product_id}`,{headers:hyggloAuthHeaders(token),signal:AbortSignal.timeout(15000)});
      if(!response.ok){results.push({product_id,status:`provider_${response.status}`});continue;}
      const product=await response.json() as {id?:number;description?:string};
      if(product.id!==product_id||typeof product.description!=="string"||!product.description.trim()){results.push({product_id,status:"invalid_source"});continue;}
      const saved=await ctx.runMutation(internal.online_listings.setDescription,{account_slug,product_id,description:retainedListingDescription(product.description)});
      results.push({product_id,status:saved.ok?"refreshed":"missing_cache_record",length:product.description.length});
    }catch{results.push({product_id,status:"source_unavailable"});}
  }
  return {refreshed:results.filter(r=>r.status==="refreshed").length,failed:results.filter(r=>r.status!=="refreshed").length,results};
}});
export const __service_refreshDescriptions=internalActionOf(refreshDescriptions);
