/**
 * Ported Listings — gradient detection (Phase 4, Wave 2, ADDITIVE).
 *
 * POST /api/port-listings/detect-gradient
 *
 * Samples ~12 leo product images, asks the VPS "hygglo" port service to
 * detect the shared background gradient/style, and persists the resulting
 * profile to Convex `ported_listings:setConfig("leo", …)`.
 *
 * Auth: `Authorization: Bearer <token>` must equal env PORT_LISTINGS_SECRET
 * (matches the repo's existing route auth pattern in
 * src/app/api/poll-hygglo/route.ts — fail closed with 503 if env unset).
 *
 * Returns: { ok, orientation, swatches, leoSampleCount }.
 */
import "server-only";
import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../../convex/_generated/api";
import { getVaultSecrets } from "../../../../lib/hygglo-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEO_SAMPLE_TARGET = 12;

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
    // 1) Gather ~12 leo fullSizeUrls.
    const products: Array<{ images?: Array<{ fullSizeUrl?: string; thumbnailUrl?: string }> }> =
      await convex.query(api.hygglo_products.list, { accountSlug: "leo" });

    const imageUrls: string[] = [];
    for (const p of products) {
      if (imageUrls.length >= LEO_SAMPLE_TARGET) break;
      const url = p.images?.find((i) => i.fullSizeUrl)?.fullSizeUrl;
      if (url) imageUrls.push(url);
    }
    if (imageUrls.length === 0) {
      return NextResponse.json(
        { ok: false, error: "no_leo_images" },
        { status: 400 },
      );
    }

    // 2) Ask the VPS port service to detect the gradient.
    const secrets = await getVaultSecrets("hygglo");
    const serviceUrl = secrets.HYGGLO_PORT_SERVICE_URL;
    const serviceToken = secrets.HYGGLO_PORT_SERVICE_TOKEN;
    if (!serviceUrl || !serviceToken) {
      return NextResponse.json(
        { ok: false, error: "vault_missing_port_service_creds" },
        { status: 503 },
      );
    }

    const res = await fetch(
      `${serviceUrl.replace(/\/+$/, "")}/detect-gradient`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceToken}`,
        },
        body: JSON.stringify({ imageUrls }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: `vps_detect_failed: ${res.status} ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const detected = (await res.json()) as {
      orientation?: string;
      stops?: Array<{ pos: number; hex: string }>;
      swatches?: string[];
      width?: number;
      height?: number;
    };

    const swatches = Array.isArray(detected.swatches) ? detected.swatches : [];

    // 3) Persist the profile to Convex.
    await convex.mutation(api.ported_listings.setConfig, {
      key: "leo",
      gradientProfile: detected,
      swatches,
      orientation: detected.orientation,
      leoSampleCount: imageUrls.length,
      detectedAt: Date.now(),
    });

    return NextResponse.json({
      ok: true,
      orientation: detected.orientation ?? null,
      swatches,
      leoSampleCount: imageUrls.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
