/**
 * Phase 5/6 — WallE chat streaming endpoint.
 *
 * POST /api/walle/chat
 *   body: { messages: WallEChatMessage[], sessionId: string }
 *
 *   1. Builds the grounded WallE chat prompt (`WALLE_CHAT_SYSTEM`) — persona
 *      voice + the shared grounding contract — and injects the LIVE dashboard
 *      snapshot for headline figures. Everything OUTSIDE the snapshot (per-item
 *      earnings, utilization, buy/sell advice, trends, issues) must come from a
 *      tool call; analytical questions force `toolChoice:'required'` on step 0
 *      (see prepareStep) so the model can't skip the tool and confabulate.
 *   2. Streams the LLM response via OpenRouter → DEEPSEEK_MODEL, with the
 *      shared read-only Convex query tools available to the model (max 4 hops).
 *   3. On completion, persists the last user turn + the full assistant text
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
import { WALLE_CHAT_SYSTEM } from "../../../../mastra/agents/walle";
import { buildDashboardTools, buildLiveSnapshot } from "../../../../lib/chat/dashboard-tools";
import { traceWalle } from "../../../../lib/walle/langfuse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Questions whose answer is NOT in the headline snapshot (per-item earnings,
// utilization/idle, buy/sell, trends, issues, catalog, funnel…) — these need a
// real tool call. When the user's turn matches, we force toolChoice:'required'
// on the first step so DeepSeek-chat can't answer from the snapshot alone and
// fabricate the numbers (it ignored the "never invent" prompt rule on its own).
// Deliberately broad: a false positive costs one extra grounded tool call; a
// false negative risks a confabulated figure.
const ANALYTICAL_INTENT =
  /\b(buy|buying|bought|purchas|invest|acqui|sell|selling|sold|worth|earn|earning|income|profit|roi|return on|best|worst|top|how much (did|does|has)|per[- ]?item|utili[sz]|idle|unused|sitting|under[- ]?used|trend|growing|declin|missed|denied|lost|capacity|below[- ]?min|funnel|conver|catalog|inventor|out[- ]?of[- ]?stock|overdue|due (back|return)|tax|kpi|recommend|should i)\b/i;

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

  // ── Convex client (rate-limit + tool execution + persistence) ──
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

  // ── No snapshot injection (2026-05-31) ──
  // WallE used to pull a pre-rendered `dashboard_chat:streamContext` snapshot
  // here and bake it into the prompt with "lean on this so you don't waste a
  // tool call". That snapshot is computed by a separate code path from the
  // tools, so its numbers drifted from the live tool answers — the root cause
  // of WallE quoting wrong/stale figures. The chat now grounds every number
  // through a real tool call (WALLE_CHAT_SYSTEM + shared tools), exactly like
  // the AI-assistant widget. (Narration bubbles still use the snapshot — they
  // run tool-less generateText and have no other source.)

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

  // v1-style compute-then-phrase: inject the LIVE dashboard snapshot so the
  // model quotes trusted headline numbers instead of choosing tools and
  // re-deriving them. Tools below are only for drill-down the snapshot lacks.
  let snapshot = "";
  if (convexClient) {
    try {
      snapshot = await buildLiveSnapshot(convexClient);
    } catch (err) {
      console.error("[walle/chat] snapshot failed:", err instanceof Error ? err.stack : err);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const system = `${WALLE_CHAT_SYSTEM}\n\nToday's date is ${today} — use it for "this year / this month / last month" reasoning.${snapshot ? `\n\n${snapshot}` : ""}`;
  const tools = convexClient ? buildDashboardTools(convexClient) : undefined;

  // Last user content (for persistence — assistant text gathered on finish)
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastUserContent = lastUser ? extractText(lastUser) : "";
  // Force a grounded tool call when the question needs drill-down data the
  // snapshot doesn't carry (see ANALYTICAL_INTENT above).
  const needsForcedTool = ANALYTICAL_INTENT.test(lastUserContent);

  const modelMessages: ModelMessage[] = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: extractText(m) }) as ModelMessage)
    .filter((m) => typeof m.content === "string" && m.content.length > 0);

  // ── Langfuse trace (no-op if env keys absent) ──
  const trace = traceWalle({
    name: "walle_chat",
    userId: sessionId,
    sessionId,
    metadata: { model: modelId, grounding: "tools-only" },
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
    // For analytical questions, force a tool call on the FIRST step so the
    // model grounds its answer instead of confabulating per-item earnings /
    // utilization / buy advice (none of which live in the snapshot). Later
    // steps revert to auto so the model can summarise the tool results.
    prepareStep: needsForcedTool
      ? ({ stepNumber }) =>
          stepNumber === 0 ? { toolChoice: "required" } : {}
      : undefined,
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
