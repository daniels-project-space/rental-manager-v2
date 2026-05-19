/**
 * Wave 3b — Redundant L3 backup for Hygglo poller.
 *
 * POST /api/poll-hygglo
 *
 * Called by:
 *   1. The Convex cron action (`convex/hygglo_poll_trigger.ts`) — every 15 min.
 *   2. Manual invocations via curl for ops/debug.
 *
 * Purpose: enqueue a one-shot run of the `poll-hygglo-inbox` Trigger.dev
 * task. This is the redundant L3 backup — if Trigger.dev's own every-5-min
 * cron schedule on the task ever stops firing, the 15-min Convex cron will
 * keep poking the inbox. Idempotent (poller detects "nothing new" fast).
 *
 * Auth: `X-Internal-Token` header must match env `INTERNAL_POLL_TOKEN`.
 * If the env var is unset on the server, all requests are rejected — fail
 * closed, no anonymous trigger of background jobs from the public route.
 */
import "server-only";
import { NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function checkAuth(req: Request): NextResponse | null {
  const expected = process.env.INTERNAL_POLL_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "server_missing_INTERNAL_POLL_TOKEN" },
      { status: 503 },
    );
  }
  const provided = req.headers.get("x-internal-token") ?? "";
  if (provided !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(req: Request) {
  const unauth = checkAuth(req);
  if (unauth) return unauth;

  try {
    const handle = await tasks.trigger("poll-hygglo-inbox", {});
    return NextResponse.json({ ok: true, handle: { id: handle.id } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const unauth = checkAuth(req);
  if (unauth) return unauth;
  return NextResponse.json({
    ok: true,
    info: "POST (or GET) with X-Internal-Token header to enqueue poll-hygglo-inbox.",
  });
}
