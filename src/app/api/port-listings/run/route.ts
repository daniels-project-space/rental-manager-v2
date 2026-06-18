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
import { getVaultSecrets } from "../../../../lib/hygglo-auth";

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
    // 1) Require a detected gradient profile.
    const config = await convex.query(api.ported_listings.getConfig, {
      key: "leo",
    });
    const gradientProfile = (config as { gradientProfile?: unknown } | null)
      ?.gradientProfile;
    if (!config || !gradientProfile) {
      return NextResponse.json(
        { ok: false, error: "no_gradient_profile_detected" },
        { status: 400 },
      );
    }

    // 2) Compute the missing set.
    const { missing } = (await convex.query(api.ported_listings.diff, {})) as {
      missing: Array<{
        productId: string;
        name: string;
        dbImageUrl: string;
        masterItemId?: string;
      }>;
    };

    const items = missing
      .filter((m) => m.dbImageUrl)
      .map((m) => ({ productId: m.productId, imageUrl: m.dbImageUrl }));

    if (items.length === 0) {
      return NextResponse.json({ ok: true, started: false, count: 0 });
    }

    // 3) Mark every target pending (idempotent upsert by productId).
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

    // 4) Hand the batch to the VPS port service (async — it calls back).
    const secrets = await getVaultSecrets("hygglo");
    const serviceUrl = secrets.HYGGLO_PORT_SERVICE_URL;
    const serviceToken = secrets.HYGGLO_PORT_SERVICE_TOKEN;
    if (!serviceUrl || !serviceToken) {
      return NextResponse.json(
        { ok: false, error: "vault_missing_port_service_creds" },
        { status: 503 },
      );
    }

    const res = await fetch(`${serviceUrl.replace(/\/+$/, "")}/port-batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({
        items,
        gradientProfile,
        mode: "products_only",
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: `vps_port_batch_failed: ${res.status} ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const out = (await res.json()) as { started?: boolean; count?: number };

    return NextResponse.json({
      ok: true,
      started: out.started ?? true,
      count: out.count ?? items.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
