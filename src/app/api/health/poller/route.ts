/**
 * Wave 3c — Public poller-health probe.
 *
 * GET /api/health/poller
 *
 * Designed for external uptime monitors (UptimeRobot, Pingdom, etc.) pinging
 * every ~5 min. Responses are deliberately minimal — no account names, no
 * internal data — so this endpoint is safe to expose unauthenticated.
 *
 *   200 { status: "ok" }     all active accounts polled within the last 30 min
 *   503 { status: "stale" }  one or more active accounts are stale
 *   500 { status: "error" }  query failed
 *   500 { status: "config_error" }  NEXT_PUBLIC_CONVEX_URL missing
 */
import "server-only";
import { NextResponse } from "next/server";
import { withServiceRoute } from "@/lib/owner-http-route";
import { api } from "../../../../../convex/_generated/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withServiceRoute(async function GET(_request: Request, client) {
  try { // canonical (NEXT_PUBLIC pins to orphan)

    const result = await client.query(api.poller_health.checkPollerHealth, {});
    if (result.ok) {
      return NextResponse.json({ status: "ok" }, { status: 200 });
    }
    return NextResponse.json({ status: "stale" }, { status: 503 });
  } catch {
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
});
