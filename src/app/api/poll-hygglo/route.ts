/**
 * Wave 3b — Manual L3 backup for Hygglo poller.
 *
 * POST /api/poll-hygglo
 *
 * Called by:
 *  - `convex/poll_clock.ts` (2026-08-22) — the PRIMARY poll clock. It gates on
 *    local Convex reads first and only POSTs here when real work is due, so
 *    this is not a return of the unconditional 15-min Convex cron that was
 *    deleted 2026-05-24 (that one burned ~192 action-runs/day discovering
 *    there was nothing to do only AFTER paying for the round-trip).
 *  - `convex/poller_health.ts` staleness auto-heal.
 *  - manual invocations via curl for ops/debug.
 *
 * Purpose: enqueue a one-shot run of the `poll-hygglo-inbox` Trigger.dev
 * task. Idempotent (poller detects "nothing new" fast).
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

/**
 * Optional JSON body: `{ mode?: "full" | "operational", source?: "convex-clock" }`.
 *
 * Sent by the Convex poll clock, which has already decided both that a poll is
 * due and which mode it should run in. `source` is what makes the task treat the
 * run as SCHEDULED rather than manual — see the payload-classification comment
 * in src/trigger/poll-hygglo.ts.
 *
 * A request with no body (or an unparseable/foreign one) forwards `{}`, which is
 * the historical manual-poke behaviour: full poll, both gates bypassed. curl and
 * the staleness auto-heal rely on that, so it must keep working as before.
 * Values are allow-listed rather than passed through, so this route can never be
 * used to inject an arbitrary payload into the task.
 */
async function readTriggerPayload(req: Request): Promise<Record<string, string>> {
  try {
    const body = await req.json();
    if (typeof body !== "object" || body === null) return {};
    const { mode, source } = body as { mode?: unknown; source?: unknown };
    const payload: Record<string, string> = {};
    if (mode === "full" || mode === "operational") payload.mode = mode;
    if (source === "convex-clock") payload.source = source;
    return payload;
  } catch {
    return {};
  }
}

export async function POST(req: Request) {
  const unauth = checkAuth(req);
  if (unauth) return unauth;

  try {
    const payload = await readTriggerPayload(req);
    const handle = await tasks.trigger("poll-hygglo-inbox", payload);
    return NextResponse.json({ ok: true, handle: { id: handle.id }, payload });
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
