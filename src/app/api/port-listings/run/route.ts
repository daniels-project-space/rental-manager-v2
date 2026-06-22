/**
 * Ported Listings — batch run trigger (Phase 4, Wave 2, ADDITIVE).
 *
 * POST /api/port-listings/run   body: { force?: boolean }
 *
 * Reads which dbcinema products are missing on leo (ported_listings:diff),
 * requires a previously-detected gradient (ported_listings:getConfig("leo")),
 * marks each missing row `pending`, then hands the whole set to the VPS port
 * service (/port-batch, async). The VPS does the full-res 262-image batch
 * itself and reports each result back via the Convex /port-listings/record
 * httpAction — Vercel never holds the long-running work open.
 *
 * Auth: `Authorization: Bearer <token>` must equal env PORT_LISTINGS_SECRET
 * (matches src/app/api/poll-hygglo/route.ts — fail closed 503 if env unset).
 *
 * Returns: { ok, started, count }.
 */
import "server-only";
import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../../convex/_generated/api";
import { renderListingsBatch } from "@/trigger/render-listing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function checkAuth(req: Request): NextResponse | null {
  const expected = process.env.PORT_LISTINGS_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "server_missing_PORT_LISTINGS_SECRET" },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  if (!provided || provided !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(req: Request) {
  const unauth = checkAuth(req);
  if (unauth) return unauth;

  const convexUrl =
    process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";
  const convex = new ConvexHttpClient(convexUrl);

  try {
    // 1) Compute the missing set.
    const { missing } = (await convex.query(api.ported_listings.diff, {})) as {
      missing: Array<{
        productId: string;
        name: string;
        dbImageUrl: string;
        masterItemId?: string;
      }>;
    };

    const renderItems = missing
      .filter((m) => m.dbImageUrl)
      .map((m) => ({ sourceImageUrl: m.dbImageUrl, title: m.name, productId: m.productId }));

    if (renderItems.length === 0) {
      return NextResponse.json({ ok: true, started: false, count: 0 });
    }

    // 2) Mark every target pending (idempotent upsert by productId).
    for (const m of missing) {
      await convex.mutation(api.ported_listings.upsert, {
        productId: m.productId,
        accountSlug: "leo",
        name: m.name,
        dbImageUrl: m.dbImageUrl,
        ...(m.masterItemId ? { masterItemId: m.masterItemId } : {}),
        status: "pending" as const,
      });
    }

    // 3) Render the batch on Trigger.dev (cloud) — each item is cut out
    // (Replicate BiRefNet), composited onto the brand plate + header, and stored
    // in R2. No VPS. (Items keep their dbImageUrl as the render source.)
    const handle = await renderListingsBatch.trigger({ account: "leo", items: renderItems });

    return NextResponse.json({
      ok: true,
      started: true,
      count: renderItems.length,
      runId: handle.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
