/**
 * Hygglo listing management — NATIVE Vercel serverless (no VPS).
 *
 * Replaces the old proxy to the VPS `listings_api.py`. Talks straight to
 * `api.hygglo.com` via `src/lib/hygglo/listings.ts` (vault-backed auth from
 * hygglo-core). Server-side only — Hygglo credentials never reach the browser.
 *
 * Routes (under /api/listings):
 *   GET   /health
 *   GET   /{account}/items                 → slim listing list
 *   GET   /{account}/categories            → [{id,name}]
 *   GET   /{account}/locations             → [{id,name,address}]
 *   GET   /{account}/item/{lid}            → full listing
 *   PATCH /{account}/item/{lid}            → edit (name,description,categoryId,
 *                                            prices,valuation,isPublished,
 *                                            locationIds,openingTimes,…)
 *   POST  /{account}/item                  → create (Phase 2: from R2 image)
 */
import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  listingClient,
  isAllowedAccount,
  listMine,
  getItem,
  categories,
  locations,
  editListing,
  setOpeningTimes,
  createListing,
  slim,
  type ListingChanges,
  type HyggloPrice,
} from "@/lib/hygglo/listings";
import { getR2 } from "@/mastra/lib/r2-client";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { renderFromSource } from "@/lib/render/compose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // edit = GET + PUT (+ retries) + PATCH

const EDITABLE: (keyof ListingChanges)[] = [
  "name",
  "description",
  "categoryId",
  "prices",
  "valuation",
  "isPublished",
  "locationIds",
  "stockLevel",
  "cancellationTerms",
  "minimumRentalDays",
];

function notFound(msg: string) {
  return NextResponse.json({ ok: false, error: msg }, { status: 404 });
}
function fail(msg: string, status = 500) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const [account, sub, lid] = path;

  if (account === "health") {
    return NextResponse.json({ ok: true, accounts: ["leo", "dbcinema", "diogo"] });
  }
  if (!isAllowedAccount(account)) return notFound(`unknown account '${account}'`);

  try {
    const c = listingClient(account);
    if (sub === "items") return NextResponse.json((await listMine(c)).map(slim));
    if (sub === "categories") return NextResponse.json(await categories(c));
    if (sub === "locations") return NextResponse.json(await locations(c));
    if (sub === "item" && lid) {
      const item = await getItem(c, lid);
      return item ? NextResponse.json(item) : notFound("listing not found");
    }
    return notFound(`unknown path '${path.join("/")}'`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 502);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const [account, sub, lid] = path;
  if (!isAllowedAccount(account)) return notFound(`unknown account '${account}'`);
  if (sub !== "item" || !lid) return notFound(`unknown path '${path.join("/")}'`);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown> & {
    openingTimes?: string;
  };
  const opening = typeof body.openingTimes === "string" ? body.openingTimes : undefined;

  const changes: ListingChanges = {};
  for (const k of EDITABLE) {
    if (k in body && body[k] !== undefined) {
      (changes as Record<string, unknown>)[k] = body[k];
    }
  }

  try {
    const c = listingClient(account);
    // Opening times → managed description line. Do it first ONLY when the caller
    // isn't also setting the description (so an explicit desc edit wins).
    if (opening !== undefined && changes.description === undefined) {
      const r = await setOpeningTimes(c, lid, opening);
      if (!r.ok) return NextResponse.json(r);
    }
    if (Object.keys(changes).length > 0) {
      return NextResponse.json(await editListing(c, lid, changes));
    }
    if (opening !== undefined) return NextResponse.json({ ok: true, id: lid });
    return NextResponse.json({ ok: false, error: "no editable fields" });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 502);
  }
}

async function r2Bytes(key: string): Promise<Buffer> {
  const { s3, bucket } = await getR2();
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await resp.Body!.transformToByteArray());
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const [account, sub] = path;
  if (!isAllowedAccount(account)) return notFound(`unknown account '${account}'`);
  if (sub !== "item") return notFound(`unknown path '${path.join("/")}'`);

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    description?: string;
    categoryId?: number;
    prices?: HyggloPrice[];
    valuation?: number;
    isPublished?: boolean;
    // image source (one of):
    r2Key?: string; // pull a rendered PNG from R2
    sourceImageUrl?: string; // render now from this source photo
    renderBrand?: string; // brand for the render (default: the account)
  };

  if (!body.name || !body.categoryId || !Array.isArray(body.prices) || body.prices.length === 0) {
    return fail("create requires name, categoryId and prices[]", 400);
  }

  try {
    // Resolve the rendered image: from R2, or render it now from a source URL.
    let pngBytes: Buffer;
    if (body.r2Key) {
      pngBytes = await r2Bytes(body.r2Key);
    } else if (body.sourceImageUrl) {
      pngBytes = await renderFromSource({
        account: body.renderBrand ?? account,
        sourceImageUrl: body.sourceImageUrl,
        title: body.name,
      });
    } else {
      return fail("create requires r2Key or sourceImageUrl for the image", 400);
    }

    const c = listingClient(account);
    const res = await createListing(c, {
      name: body.name,
      description: body.description,
      categoryId: body.categoryId,
      prices: body.prices,
      valuation: body.valuation,
      isPublished: body.isPublished,
      pngBytes,
    });
    return NextResponse.json(res);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 502);
  }
}
