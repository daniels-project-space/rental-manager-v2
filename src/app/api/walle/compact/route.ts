/**
 * Phase 6 — WallE session-compaction endpoint.
 *
 * POST /api/walle/compact
 *   body: { sessionId: string, messages: Array<{role,content}> }
 *
 * Called from WallEChat's unmount cleanup. We do the LLM-digest call
 * server-side so the OpenRouter key never ships to the client, then
 * fire the Convex `dashboard_chat.compactSession` mutation with the
 * generated summary.
 *
 * On any failure the route still attempts the naive count-summary
 * fallback so the conversation row is collapsed regardless.
 */
import "server-only";
import { NextResponse } from "next/server";
import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../../convex/_generated/api";
import { WALLE_COMPACT_SYSTEM } from "../../../../mastra/agents/walle";
import { traceWalle } from "../../../../lib/walle/langfuse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CompactMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface CompactBody {
  sessionId: string;
  messages: CompactMessage[];
}

export async function POST(req: Request) {
  let body: CompactBody;
  try {
    body = (await req.json()) as CompactBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const { sessionId, messages } = body ?? {};
  if (typeof sessionId !== "string" || !sessionId) {
    return NextResponse.json({ ok: false, error: "missing_session_id" }, { status: 400 });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ ok: false, error: "no_messages" }, { status: 400 });
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return NextResponse.json({ ok: false, error: "missing_convex_url" }, { status: 500 });
  }
  const convexClient = new ConvexHttpClient(convexUrl);

  // ── Rate limit (per session; compaction is rare, 6/hr is generous) ──
  try {
    const status = await convexClient.mutation(
      api.walle_ratelimits.checkWalleLimit,
      { bucket: "walle_compact", key: sessionId },
    );
    if (!status.ok) {
      return NextResponse.json(
        { ok: false, error: "rate_limited", retryAfter: status.retryAfter },
        { status: 429 },
      );
    }
  } catch {
    // fail-open: don't break compaction on limiter outage
  }

  // ── Try LLM digest first ──
  let summary = "";
  const apiKey = process.env.OPENROUTER_API_KEY;
  const modelId = process.env.DEEPSEEK_MODEL ?? "deepseek/deepseek-chat";
  const trace = traceWalle({
    name: "walle_compact",
    userId: sessionId,
    sessionId,
    metadata: { model: modelId, messageCount: messages.length },
  });
  if (apiKey) {
    try {
      const openrouter = createOpenRouter({ apiKey });
      const model = openrouter(modelId);

      const transcript = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join("\n");

      const generation = trace.generation({
        name: "generateText",
        model: modelId,
        input: transcript,
      });
      const { text, usage } = await generateText({
        model,
        system: WALLE_COMPACT_SYSTEM,
        prompt: transcript,
        // Phase 9 cost guardrail — digest must be short by design.
        maxOutputTokens: 300,
      });
      generation.end({
        output: text,
        usage: {
          promptTokens: usage?.inputTokens,
          completionTokens: usage?.outputTokens,
          totalTokens: usage?.totalTokens,
        },
      });
      summary = text?.trim() ?? "";
    } catch {
      // fall through to naive fallback
    }
  }
  try {
    await trace.flush();
  } catch {
    /* observability never breaks the request */
  }

  // ── Fallback: naive count summary ──
  if (!summary) {
    summary = `Previous session: ${messages.length} messages.`;
  }

  try {
    const r = await convexClient.mutation(api.dashboard_chat.compactSession, {
      thread_id: "walle",
      session_id: sessionId,
      summary,
    });
    return NextResponse.json({ ok: true, compacted: r?.compacted ?? 0, summary });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "compact_failed", detail: String(err) },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    info: "POST { sessionId, messages } to LLM-summarize then compact a WallE session.",
  });
}
