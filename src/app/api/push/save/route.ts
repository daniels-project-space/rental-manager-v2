import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../../convex/_generated/api";

export const runtime = "nodejs";

// The service worker POSTs a freshly-resubscribed push subscription here (from
// the `pushsubscriptionchange` self-heal). We upsert it via the same Convex
// mutation the bell uses (dedups by endpoint), so a rotated subscription keeps
// receiving notifications without the operator re-enabling the bell.
export async function POST(req: Request) {
  let body: { endpoint?: string; p256dh?: string; auth?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!body?.endpoint) {
    return NextResponse.json({ ok: false, error: "no_endpoint" }, { status: 400 });
  }
  const convexUrl =
    process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";
  try {
    const convex = new ConvexHttpClient(convexUrl);
    await convex.mutation(api.notifications.savePushSubscription, {
      endpoint: body.endpoint,
      p256dh: body.p256dh ?? "",
      auth: body.auth ?? "",
      user_agent: "service-worker-resubscribe",
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
