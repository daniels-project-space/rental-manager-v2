import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getR2 } from "@/mastra/lib/r2-client";
import { GetObjectCommand } from "@aws-sdk/client-s3";

// Brand Control feed — served entirely from R2 (no VPS). The porting gallery
// (command_center.json + rendered PNGs) was migrated to `gallery/...` in the
// shared bucket; this route serves the feed and proxies the images by key
// (R2 has no public base, so reads go through GetObject server-side).
const FEED_KEY = "gallery/command_center.json";

export const revalidate = 0;
export const dynamic = "force-dynamic";

async function r2Object(key: string) {
  const { s3, bucket } = await getR2();
  return s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
}

export async function GET(req: NextRequest) {
  const img = req.nextUrl.searchParams.get("image");

  // --- image proxy (R2 keys under gallery/) ---
  if (img) {
    if (!img.startsWith("gallery/")) {
      return NextResponse.json({ error: "key not allowed" }, { status: 403 });
    }
    try {
      const resp = await r2Object(img);
      const bytes = await resp.Body!.transformToByteArray();
      return new NextResponse(Buffer.from(bytes), {
        headers: {
          "content-type": resp.ContentType ?? "image/png",
          "cache-control": "public, max-age=300",
        },
      });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 502 });
    }
  }

  // --- feed ---
  try {
    const resp = await r2Object(FEED_KEY);
    const text = await resp.Body!.transformToString();
    return new NextResponse(text, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
