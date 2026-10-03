import { NextResponse } from "next/server";
import { withServiceRoute } from "@/lib/owner-http-route";
import { api } from "../../../../../convex/_generated/api";

export const runtime = "nodejs";

// Public VAPID key so the service worker can resubscribe on
// `pushsubscriptionchange` without shipping the key inside the static SW file.
// Sourced from Convex (where the bell already reads it) so it's always present,
// with a Next-env fallback.
export const GET = withServiceRoute(async function GET(_request: Request, convex) {
  try {

    const key = await convex.query(api.notifications.getVapidPublicKey, {});
    return NextResponse.json({ key: key ?? process.env.VAPID_PUBLIC_KEY ?? null });
  } catch {
    return NextResponse.json({ key: process.env.VAPID_PUBLIC_KEY ?? null });
  }
});
