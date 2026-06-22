/**
 * Listing-image render endpoint (Vercel) — does the sharp/opentype compositing
 * where the native libvips binary is supported. The Trigger render task calls
 * this over HTTP so the heavy image work stays on Vercel while Trigger
 * orchestrates batches.
 *
 * POST /api/render
 *   body: { account, sourceImageUrl, title, productId? }
 *   → cutout (Replicate) + compose → store PNG in R2 → { ok, key, bytes }
 */
import "server-only";
import { NextResponse } from "next/server";
import { renderFromSource } from "@/lib/render/compose";
import { putPng } from "@/mastra/lib/r2-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120; // cutout + compose

function slug(s: string): string {
  return (
    (s || "item")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "item"
  );
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    account?: string;
    sourceImageUrl?: string;
    title?: string;
    productId?: string;
  };
  if (!body.account || !body.sourceImageUrl || !body.title) {
    return NextResponse.json(
      { ok: false, error: "render requires account, sourceImageUrl, title" },
      { status: 400 },
    );
  }
  try {
    const png = await renderFromSource({
      account: body.account,
      sourceImageUrl: body.sourceImageUrl,
      title: body.title,
    });
    const key = `rendered/${body.account}/${body.productId ?? slug(body.title)}.png`;
    await putPng(key, png);
    return NextResponse.json({ ok: true, key, bytes: png.length });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
