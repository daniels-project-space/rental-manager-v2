/**
 * Phase 5/6 — WallE chat streaming endpoint.
 *
 * POST /api/walle/chat
 *   body: { messages: WallEChatMessage[], sessionId: string }
 *
 *   1. Pulls fresh dashboard context via Convex `dashboard_chat:streamContext`.
 *   2. Builds the full WallE persona prompt + injects the live snapshot.
 *   3. Streams the LLM response via OpenRouter → DEEPSEEK_MODEL, with
 *      read-only Convex query tools available to the model (max 3 hops).
 *   4. On completion, persists the last user turn + the full assistant text
 *      through Convex `dashboard_chat:appendTurn`.
 *
 * No auth: WallE is internal. Session identity comes from the client-
 * generated `sessionId` on the body (UUID per mount). TODO(phase-9):
 * replace with a real user resolver once the dashboard ships auth.
 */
import "server-only";
import { NextResponse } from "next/server";
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../../convex/_generated/api";
import { buildWalleSystemPrompt, buildWalleTools } from "../../../../mastra/agents/walle";
import { traceWalle } from "../../../../lib/walle/langfuse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IncomingMessagePart {
  type: string;
  text?: string;
}

/**
 * AI SDK v6 `useChat` posts messages shaped as
 *   { id, role, parts: [{type:'text', text:'...'}, ...] }
 * whereas this route was originally written against the v4/v5 shape
 *   { role, content: '...' }
 * which left `content` undefined and silenced the model. Accept BOTH so
 * direct-curl callers (and the older v5 transport) continue to work while
 * the v6 widget actually gets its user turn through.
 */
interface IncomingMessage {
  role: "user" | "assistant" | "system";
  content?: string;
  parts?: ReadonlyArray<IncomingMessagePart>;
}

interface ChatRequestBody {
  messages: IncomingMessage[];
  sessionId: string;
}

function extractText(m: IncomingMessage): string {
  if (typeof m.content === "string" && m.content.length > 0) return m.content;
  if (Array.isArray(m.parts)) {
    return m.parts
      .filter((p): p is IncomingMessagePart & { text: string } =>
        p.type === "text" && typeof p.text === "string",
      )
      .map((p) => p.text)
      .join("");
  }
  return "";
}

export async function POST(req: Request) {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const { messages, sessionId } = body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ ok: false, error: "no_messages" }, { status: 400 });
  }
  if (typeof sessionId !== "string" || !sessionId) {
    return NextResponse.json({ ok: false, error: "missing_session_id" }, { status: 400 });
  }

  // ── Convex client (shared by snapshot fetch + tool execution) ──
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const convexClient = convexUrl ? new ConvexHttpClient(convexUrl) : null;

  // ── Rate limit (per-session; sessionId is our user proxy until auth lands) ──
  if (convexClient) {
    try {
      const status = await convexClient.mutation(
        api.walle_ratelimits.checkWalleLimit,
        { bucket: "walle_chat", key: sessionId },
      );
      if (!status.ok) {
        return NextResponse.json(
          { ok: false, error: "rate_limited", retryAfter: status.retryAfter },
          { status: 429 },
        );
      }
    } catch {
      // fail-open: limiter not available shouldn't break chat
    }
  }

  // ── Build context snapshot (best-effort; chat still works on failure) ──
  let snapshotLine = "";
  if (convexClient) {
    try {
      const ctx = await convexClient.query(api.dashboard_chat.streamContext, { limit: 10 });
      const s = ctx?.snapshot;
      if (s) {
        const td = s.topUtilizationDelta;
        const topUtil = td ? `${td.name}:${td.deltaPct.toFixed(2)}` : "none";
        snapshotLine =
          `Live signals — pending:${s.pendingCount} conflicts:${s.conflictCount} ` +
          `mtdRevenue:£${s.mtdRevenue.toFixed(0)} topUtil:${topUtil}`;
      }
    } catch {
      // swallow — best-effort snapshot
    }
  }

  // ── Model (lazy provider, no vault fallback here; route runs on Vercel) ──
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "missing_openrouter_key" },
      { status: 500 }
    );
  }
  const openrouter = createOpenRouter({ apiKey });
  const modelId = process.env.DEEPSEEK_MODEL ?? "deepseek/deepseek-chat";
  const model = openrouter(modelId);

  const system = buildWalleSystemPrompt(snapshotLine);
  const tools = convexClient ? buildWalleTools(convexClient) : undefined;

  // Last user content (for persistence — assistant text gathered on finish)
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastUserContent = lastUser ? extractText(lastUser) : "";

  const modelMessages: ModelMessage[] = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: extractText(m) }) as ModelMessage)
    .filter((m) => typeof m.content === "string" && m.content.length > 0);

  // ── Langfuse trace (no-op if env keys absent) ──
  const trace = traceWalle({
    name: "walle_chat",
    userId: sessionId,
    sessionId,
    metadata: { model: modelId, hasSnapshot: snapshotLine.length > 0 },
  });
  const generation = trace.generation({
    name: "streamText",
    model: modelId,
    input: modelMessages,
  });

  const result = streamText({
    model,
    system,
    messages: modelMessages,
    tools,
    // DeepSeek reasoning model burns hidden reasoning tokens against this
    // budget before emitting visible text; 800 left no room after a tool
    // call so the model silently finished without answering. >=1500 is the
    // known-good floor (see [[feedback_deepseek_quirks]]).
    maxOutputTokens: 1800,
    // Allow up to 4 hops — one tool call + one summary is the common case,
    // a follow-up tool call needs the extra step.
    stopWhen: stepCountIs(4),
    onFinish: async ({ text, usage }) => {
      try {
        generation.end({
          output: text,
          usage: {
            promptTokens: usage?.inputTokens,
            completionTokens: usage?.outputTokens,
            totalTokens: usage?.totalTokens,
          },
        });
        await trace.flush();
      } catch {
        // observability never breaks the request
      }
      try {
        if (!convexClient) return;
        await convexClient.mutation(api.dashboard_chat.appendTurn, {
          thread_id: "walle",
          session_id: sessionId,
          user_content: lastUserContent,
          assistant_content: text,
        });
      } catch {
        // best-effort persistence
      }
    },
  });

  // AI SDK v6 streams via Server-Sent Events.
  return result.toUIMessageStreamResponse();
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    info: "POST { messages, sessionId } to stream a WallE reply.",
  });
}
