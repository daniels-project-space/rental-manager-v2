/**
 * Wave 4 — Mastra `hygglo_poll` workflow trigger.
 *
 * POST /api/workflows/hygglo-poll
 *
 * Called by: manual invocations via curl for ops/debug only. The Convex
 * cron that previously called this (every 15 min) was deleted 2026-05-24
 * during the cost audit — Trigger.dev's `poll-hygglo-inbox` task at 5 min
 * is the canonical scraper and writes the same data. This route still
 * works manually and is kept for debug runs of the Mastra workflow.
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
