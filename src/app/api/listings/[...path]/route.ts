import { NextRequest, NextResponse } from "next/server";

// Server-side proxy to the VPS Hygglo Listings API (listings_api.py @ :8792 via
// nginx /listings-api/). The X-Listings-Token never reaches the browser. RM is
// HTTPS and the listings API is HTTP, so this must be server-side.
const BASE = process.env.LISTINGS_API_BASE ?? "http://87.106.233.113/listings-api";
const TOKEN = process.env.LISTINGS_API_TOKEN ?? "";

export const dynamic = "force-dynamic";

async function forward(method: string, path: string, body?: unknown) {
  if (!TOKEN) {
    return NextResponse.json(
      { error: "LISTINGS_API_TOKEN not configured on the server" },
      { status: 500 },
    );
  }
  try {
    const r = await fetch(`${BASE}/${path}`, {
      method,
      headers: { "X-Listings-Token": TOKEN, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    return NextResponse.json(data, { status: r.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return forward("GET", path.join("/"));
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  return forward("PATCH", path.join("/"), body);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  return forward("POST", path.join("/"), body);
}
