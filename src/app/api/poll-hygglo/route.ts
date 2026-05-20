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
 * Auth: `Authorization: Bearer <token>` header must match env
 * `POLL_TRIGGER_SECRET`. If the env var is unset on the server, all
 * requests are rejected — fail closed, no anonymous trigger of
 * background jobs from the public route.
 */
import "server-only";
import { NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function checkAuth(req: Request): NextResponse | null {
  const expected = process.env.POLL_TRIGGER_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "server_missing_POLL_TRIGGER_SECRET" },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  if (!provided || provided !== expected) {
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
    info: "POST (or GET) with `Authorization: Bearer <POLL_TRIGGER_SECRET>` header to enqueue poll-hygglo-inbox.",
  });
}
