import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../../convex/_generated/api";

export const runtime = "nodejs";

// Public VAPID key so the service worker can resubscribe on
// `pushsubscriptionchange` without shipping the key inside the static SW file.
// Sourced from Convex (where the bell already reads it) so it's always present,
// with a Next-env fallback.
export async function GET() {
  const convexUrl =
    process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";
  try {
    const convex = new ConvexHttpClient(convexUrl);
    const key = await convex.query(api.notifications.getVapidPublicKey, {});
    return NextResponse.json({ key: key ?? process.env.VAPID_PUBLIC_KEY ?? null });
  } catch {
    return NextResponse.json({ key: process.env.VAPID_PUBLIC_KEY ?? null });
  }
}
