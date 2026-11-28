import { NextResponse } from "next/server";
import { api } from "../../../../../convex/_generated/api";
import { renterBotRuntimeAllowed } from "../../../../../convex/lib/renter_bot_runtime";
import { renterBotLabAuthMarkerFromSecret } from "../../../../../convex/lib/renter_bot_lab_contract";
import { createRenterBotLabConvexServiceClient } from "@/lib/convex-service";
import { withOwnerRoute } from "@/lib/owner-http-route";
import { ensureLabBackendGenerationReady } from "@/lib/renter-bot-lab-readiness";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * One isolated Lab turn. The browser, retry path, and finalizer all bind to a
 * single Convex turn executor. The browser never receives the Lab API secret;
 * this route sends only its derived server-to-server capability marker.
 */
export const POST = withOwnerRoute(async function POST(request: Request) {
  let body: { threadId?: unknown; accountSlug?: unknown; text?: unknown; turnId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const { threadId, accountSlug, text, turnId } = body;
  if (typeof threadId !== "string" || typeof accountSlug !== "string" || typeof text !== "string" ||
      !text.trim() || text.length > 6000 || typeof turnId !== "string" || !/^[A-Za-z0-9_-]{8,96}$/.test(turnId)) {
    return NextResponse.json({ ok: false, error: "invalid_test_message" }, { status: 400 });
  }
  if (!renterBotRuntimeAllowed(threadId)) {
    return NextResponse.json({ ok: false, error: "lab_only_pending_written_consent" }, { status: 403 });
  }

  const labSecret = process.env.RENTER_BOT_LAB_API_SECRET;
  const localDevelopment = process.env.NODE_ENV === "development" && process.env.RENTER_BOT_LAB_DEPLOYMENT === "local";
  if ((!localDevelopment && process.env.RENTER_BOT_LAB_DEPLOYMENT !== "hosted") ||
      process.env.RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED !== "false" || !labSecret?.trim()) {
    return NextResponse.json({ ok: false, error: "isolated_lab_generation_unavailable" }, { status: 503 });
  }

  // A session may stay open while its API or Convex backend is rebuilt. Check
  // the exact source fingerprints at the server boundary before every turn;
  // disabling only the scenario picker leaves existing chats able to call old code.
  const readiness = await ensureLabBackendGenerationReady(process.env);
  if (!readiness.generation_ready) {
    return NextResponse.json({ ok: false, error: "lab_backend_not_ready" }, { status: 503 });
  }

  let lab;
  try {
    lab = createRenterBotLabConvexServiceClient();
  } catch {
    return NextResponse.json({ ok: false, error: "isolated_lab_unavailable" }, { status: 503 });
  }

  let authMarker: string;
  try {
    authMarker = await renterBotLabAuthMarkerFromSecret(labSecret);
  } catch {
    return NextResponse.json({ ok: false, error: "isolated_lab_generation_unavailable" }, { status: 503 });
  }

  let result: Record<string, unknown>;
  try {
    result = await lab.action(api.renter_bot_lab_actions.runTestTurn, {
      auth_marker: authMarker,
      threadId,
      accountSlug,
      text,
      turnId,
    });
  } catch {
    return NextResponse.json({ ok: false, error: "lab_turn_failed_recoverable", turnId }, { status: 502 });
  }
  if (result.status === "running") {
    return NextResponse.json({ ok: false, pending: true, error: "turn_generation_in_progress", turnId }, { status: 202 });
  }
  return NextResponse.json({ ok: true, ...result });
});
