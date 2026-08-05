/**
 * WallE narration endpoint — single-shot, character-voice 1-2 sentence lines
 * for the dashboard speech bubble (greeting / alert / click / idle).
 *
 * POST /api/walle/narrate
 *   body: { userId: string, mode: "greeting" | "alert" | "click" | "idle",
 *           context?: string }
 *
 *   - "context" is an optional free-form note the client can pass (e.g.
 *     "New double-booking on Sony A7 IV", "Daniel just clicked me"). It is
 *     appended to the user prompt so the model has something concrete to
 *     react to even if the live snapshot is empty.
 *
 * Returns 200 always (never surfaces an error toast). On rate-limit, missing
 * keys, or generation failure, returns { line: null, reason }.
 *
 * Reuses the persona + snapshot logic from /api/walle/chat. Rate-limited via
 * the new `walle_narrate` bucket (12 req/hr/user).
 */
import "server-only";
import { NextResponse } from "next/server";
import { generateText } from "ai";
import { getVaultOpenRouterModel } from "@/lib/llm-client";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../../convex/_generated/api";
import {
  buildWalleNarrationPrompt,
  type NarrationMode,
} from "../../../../mastra/agents/walle";
import { traceWalle } from "../../../../lib/walle/langfuse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface NarrateRequestBody {
  userId: string;
  mode: NarrationMode;
  context?: string;
}

const MODES: ReadonlySet<NarrationMode> = new Set([
  "greeting",
  "alert",
  "click",
  "idle",
]);

export async function POST(req: Request) {
  let body: NarrateRequestBody;
  try {
    body = (await req.json()) as NarrateRequestBody;
  } catch {
    return NextResponse.json({ line: null, reason: "error" }, { status: 200 });
  }

  const { userId, mode, context } = body ?? ({} as NarrateRequestBody);
  if (typeof userId !== "string" || !userId) {
    return NextResponse.json({ line: null, reason: "error" }, { status: 200 });
  }
  if (!MODES.has(mode)) {
    return NextResponse.json({ line: null, reason: "error" }, { status: 200 });
  }

  const convexUrl = process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud"; // canonical (NEXT_PUBLIC pins to orphan)
  if (!convexUrl) {
    return NextResponse.json({ line: null, reason: "error" }, { status: 200 });
  }

  const convex = new ConvexHttpClient(convexUrl);

  // ── Rate limit ────────────────────────────────────────────────────
  try {
    const rl = await convex.mutation(api.walle_ratelimits.checkWalleLimit, {
      bucket: "walle_narrate",
      key: userId,
    });
    if (!rl.ok) {
      return NextResponse.json(
        { line: null, reason: "rate_limited", retryAfter: rl.retryAfter },
        { status: 200 },
      );
    }
  } catch {
    // fail-open
  }

  // ── Live snapshot (best-effort) ───────────────────────────────────
  let snapshotLine = "";
  try {
    const ctx = await convex.query(api.dashboard_chat.streamContext, { limit: 1 });
    const s = ctx?.snapshot;
    if (s) {
      const mover = s.topWoWMover;
      const util = s.topUtilization;
      const moverStr = mover ? `${mover.name}:${mover.deltaPct.toFixed(2)}%` : "none";
      const utilStr = util ? `${util.name}:${util.pct.toFixed(0)}%` : "none";
      snapshotLine =
        `Live signals — pending:${s.pendingCount} conflicts:${s.conflictCount} ` +
        `mtdNet:£${s.mtdEarningsNet.toFixed(0)} (gross £${s.mtdGrossPaid.toFixed(0)}) ` +
        `topUtil:${utilStr} topMover:${moverStr}`;
    }
  } catch {
    // best-effort
  }

  // ── Model ─────────────────────────────────────────────────────────
  const modelId = process.env.DEEPSEEK_MODEL ?? "deepseek/deepseek-chat";
  let model;
  try {
    model = await getVaultOpenRouterModel(modelId);
  } catch {
    return NextResponse.json({ line: null, reason: "error" }, { status: 200 });
  }

  const system = buildWalleNarrationPrompt(snapshotLine, mode);

  // User-side prompt is a tiny stub naming the trigger. The persona block
  // already carries all business context. Keeping this short keeps the LLM
  // honest about brevity.
  const userPrompt = (() => {
    switch (mode) {
      case "greeting":
        return "Say hello. One short line about what you see on the dashboard right now.";
      case "alert":
        return `A new alert just appeared. ${context ?? ""} React in one line.`.trim();
      case "click":
        return `Daniel just clicked you. ${context ?? ""} React in one line.`.trim();
      case "idle":
        return `It's been quiet. ${context ?? ""} Drop a dry one-line aside.`.trim();
    }
  })();

  const trace = traceWalle({
    name: "walle_narrate",
    userId,
    metadata: { model: modelId, mode, hasSnapshot: snapshotLine.length > 0 },
  });
  const generation = trace.generation({
    name: "generateText",
    model: modelId,
    input: { mode, userPrompt, snapshotLine },
  });

  try {
    const { text, usage } = await generateText({
      model,
      system,
      prompt: userPrompt,
      // Hard cap — narration must stay short.
      maxOutputTokens: 80,
    });
    generation.end({
      output: text,
      usage: {
        promptTokens: usage?.inputTokens,
        completionTokens: usage?.outputTokens,
        totalTokens: usage?.totalTokens,
      },
    });
    await trace.flush();

    let line = (text ?? "").trim();
    // Strip wrapping quotes / leading "WallE:" labels just in case.
    line = line.replace(/^["'`]+|["'`]+$/g, "").trim();
    line = line.replace(/^(WallE|Walle|WALL-E)\s*[:\-—]\s*/i, "").trim();

    if (!line) {
      return NextResponse.json({ line: null, reason: "empty" }, { status: 200 });
    }
    // Defensive hard truncation if the model overshoots.
    if (line.length > 220) line = line.slice(0, 217).trimEnd() + "…";

    return NextResponse.json({ line, mode }, { status: 200 });
  } catch {
    return NextResponse.json({ line: null, reason: "error" }, { status: 200 });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    info: "POST { userId, mode, context? } to get a 1-2 sentence speech-bubble line.",
  });
}
