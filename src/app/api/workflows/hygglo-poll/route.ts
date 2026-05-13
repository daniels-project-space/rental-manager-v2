/**
 * Wave 4 — Mastra `hygglo_poll` workflow trigger.
 *
 * POST /api/workflows/hygglo-poll
 *
 * Called by:
 *   1. The Convex cron action (`convex/hygglo_poll_trigger.ts`) — every 3 min.
 *   2. Manual invocations via curl for ops/debug.
 *
 * Auth: `Authorization: Bearer <POLL_TRIGGER_SECRET>` if env var is set.
 * Returns the final workflow state (newRentalsCount, decisionsGeneratedCount,
 * mvRefreshesTriggered).
 */
import "server-only";
import { NextResponse } from "next/server";
import { runHyggloPoll } from "@/mastra/workflows/hygglo_poll";

export const runtime = "nodejs";       // Mastra requires Node, not Edge
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = process.env.POLL_TRIGGER_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    const provided = auth.replace(/^Bearer\s+/i, "").trim();
    if (provided !== secret) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }
  const result = await runHyggloPoll();
  return NextResponse.json(result);
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    info: "POST to trigger the hygglo_poll Mastra workflow.",
  });
}
