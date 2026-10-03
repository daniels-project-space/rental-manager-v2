import { NextResponse } from "next/server";
import { withOwnerRoute } from "@/lib/owner-http-route";
import { api } from "../../../../../convex/_generated/api";

export const runtime = "nodejs";

// The service worker POSTs a freshly-resubscribed push subscription here (from
// the `pushsubscriptionchange` self-heal). We upsert it via the same Convex
// mutation the bell uses (dedups by endpoint), so a rotated subscription keeps
// receiving notifications without the operator re-enabling the bell.
export const POST = withOwnerRoute(async function POST(req: Request, convex) {
  let body: { endpoint?: string; p256dh?: string; auth?: string; previous_endpoint?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!body?.endpoint) {
    return NextResponse.json({ ok: false, error: "no_endpoint" }, { status: 400 });
  }
  try {

    const result = await convex.mutation(api.notifications.savePushSubscription, {
      endpoint: body.endpoint,
      p256dh: body.p256dh ?? "",
      auth: body.auth ?? "",
      user_agent: "service-worker-resubscribe",
      previous_endpoint: body.previous_endpoint,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
});
