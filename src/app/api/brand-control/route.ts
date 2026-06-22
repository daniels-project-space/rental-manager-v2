import { NextRequest, NextResponse } from "next/server";

// Server-side proxy to the Hygglo porting service'\''s Command Center feed.
// The dashboard is served over HTTPS (Vercel) while the porting service is
// plain HTTP on the VPS, so the browser cannot fetch it directly (mixed
// content + CORS). This route fetches it server-side and re-serves it, and
// also proxies the HTTP listing thumbnails (?image=<url>) for the same reason.
const FEED =
  process.env.PORTING_FEED_URL ??
  "http://87.106.233.113/ported-proof-v4/command_center.json";
const ALLOWED_IMAGE_HOST = "87.106.233.113";

export const revalidate = 0;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const img = req.nextUrl.searchParams.get("image");

  // --- image proxy (only for the porting host) ---
  if (img) {
    let url: URL;
    try {
      url = new URL(img);
    } catch {
      return NextResponse.json({ error: "bad image url" }, { status: 400 });
    }
    if (url.hostname !== ALLOWED_IMAGE_HOST) {
      return NextResponse.json({ error: "host not allowed" }, { status: 403 });
    }
    try {
      const r = await fetch(url.toString(), { cache: "no-store" });
      if (!r.ok) return NextResponse.json({ error: `img ${r.status}` }, { status: 502 });
      const buf = await r.arrayBuffer();
      return new NextResponse(buf, {
        headers: {
          "content-type": r.headers.get("content-type") ?? "image/png",
          "cache-control": "public, max-age=300",
        },
      });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 502 });
    }
  }

  // --- feed proxy ---
  try {
    const r = await fetch(FEED, { cache: "no-store" });
    if (!r.ok) return NextResponse.json({ error: `feed ${r.status}` }, { status: 502 });
    const data = await r.json();
    return NextResponse.json(data, {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
