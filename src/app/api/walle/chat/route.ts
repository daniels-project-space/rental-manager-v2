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
 *   2. Streams the LLM response via OpenRouter → CHAT_MODEL (Claude Haiku 4.5),
 *      with the shared read-only Convex query tools available (max 4 hops).
 *   3. On completion, persists the last user turn + the full assistant text
 *      through Convex `dashboard_chat:appendTurn`.
 *
 * No auth: WallE is internal. Session identity comes from the client-
 * generated `sessionId` on the body (UUID per mount). TODO(phase-9):
 * replace with a real user resolver once the dashboard ships auth.
 */
import "server-only";
import { NextResponse } from "next/server";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type ModelMessage,
} from "ai";
import { getVaultOpenRouterModel } from "@/lib/llm-client";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../../convex/_generated/api";
import { WALLE_CHAT_SYSTEM } from "../../../../mastra/agents/walle";
import { buildWalleChatAgent } from "../../../../mastra/agents/walle_chat_agent";
import {
  COMPAT_INTENT,
  AVAILABILITY_INTENT,
  INVENTORY_INTENT,
  buildDashboardTools,
  buildInventoryIndex,
  buildLiveSnapshot,
} from "../../../../lib/chat/dashboard-tools";
import { CHAT_MODEL, CHAT_MODEL_SMART } from "../../../../lib/ai-models";
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

  // ── Convex client (rate-limit + tool execution + persistence) ──
  // Hardcode the canonical deployment (CLAUDE.md hard rule #3): Vercel pins
  // NEXT_PUBLIC_CONVEX_URL to the orphan exciting-lion-29, which lacks the
  // poller-written data AND these chat queries (walle_inventory etc.). CONVEX_URL
  // stays overridable for local/dev.
  const convexUrl =
    process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";
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

  // ── Model (shared vault-backed OpenRouter lane) ────────────────────────

  // Last user content (drives intent routing + persistence).
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastUserContent = lastUser ? extractText(lastUser) : "";
  // Compatibility / optics turns route to Sonnet (Haiku inverted the APS-C vs
  // full-frame fact from memory). Grounding itself is carried by the always-
  // injected inventory index + the grounding rules, not a forced tool call:
  // Mastra's agent loop has no per-step prepareStep, so toolChoice:"required"
  // would force a tool on EVERY step and never emit final text. The model
  // elects the tools on its own (reliably, on Haiku/Sonnet) for the turns that
  // need them.
  // Compatibility/optics, per-item availability, and inventory/spec/autofocus
  // turns all go to the smart model. These are the questions with one correct
  // answer in the data that Haiku kept answering from memory (the "everything
  // he says is wrong" set); Sonnet reliably elects the grounding tool and
  // respects the never-guess rules. Everything else stays on cheap Haiku.
  const needsSmart =
    COMPAT_INTENT.test(lastUserContent) ||
    AVAILABILITY_INTENT.test(lastUserContent) ||
    INVENTORY_INTENT.test(lastUserContent);

  const modelId = needsSmart ? CHAT_MODEL_SMART : CHAT_MODEL;
  let model;
  try {
    model = await getVaultOpenRouterModel(modelId);
  } catch {
    return NextResponse.json({ ok: false, error: "missing_openrouter_vault_key" }, { status: 500 });
  }

  // v1-style compute-then-phrase: inject the LIVE dashboard snapshot (trusted
  // headline numbers) AND the master inventory index (so existence questions
  // never get denied). Tools below are for drill-down + specs/compatibility.
  let snapshot = "";
  let inventoryIndex = "";
  if (convexClient) {
    try {
      [snapshot, inventoryIndex] = await Promise.all([
        buildLiveSnapshot(convexClient),
        buildInventoryIndex(convexClient).catch(() => ""),
      ]);
    } catch (err) {
      console.error("[walle/chat] snapshot failed:", err instanceof Error ? err.stack : err);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const system = `${WALLE_CHAT_SYSTEM}\n\nToday's date is ${today} — use it for "this year / this month / last month" reasoning.${snapshot ? `\n\n${snapshot}` : ""}${inventoryIndex ? `\n\n${inventoryIndex}` : ""}`;
  const tools = convexClient ? buildDashboardTools(convexClient) : undefined;

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

  // Build WallE as a first-class Mastra agent (shared AI SDK tools + the
  // per-request grounded instructions + the Haiku/Sonnet model), then stream it.
  const agent = buildWalleChatAgent({ instructions: system, model, tools });

  let result: Awaited<ReturnType<typeof agent.stream>>;
  try {
    result = await agent.stream(modelMessages, {
      // One tool hop + a summary is the common case; a follow-up tool call
      // needs the extra steps.
      maxSteps: 4,
      // Ample ceiling for a tool call + a conversational summary (headroom
      // carried over from the DeepSeek era; harmless for Haiku/Sonnet).
      modelSettings: { maxOutputTokens: 1800 },
      // "auto", not "required": Mastra has no per-step prepareStep, so
      // "required" forces a tool on every step and the agent never produces a
      // final text answer. Grounding is carried by the injected inventory index
      // + grounding rules; the model elects the drill-down tools itself.
      toolChoice: "auto",
    });
  } catch (err) {
    console.error(
      "[walle/chat] agent.stream failed:",
      err instanceof Error ? err.stack : err,
    );
    return NextResponse.json(
      { ok: false, error: "agent_stream_failed" },
      { status: 500 },
    );
  }

  // Bridge Mastra's (v5-internal) textStream into an AI SDK v6 UI-message
  // stream so the `useChat` widget renders it unchanged. Tool calls run inside
  // the agent; the widget only shows the assistant text.
  let assistantText = "";
  const uiStream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: "text-start", id: "0" });
      for await (const delta of result.textStream) {
        assistantText += delta;
        writer.write({ type: "text-delta", id: "0", delta });
      }
      writer.write({ type: "text-end", id: "0" });
    },
    onError: (err) => {
      console.error("[walle/chat] stream error:", err);
      return "WallE hit a snag mid-reply.";
    },
    onFinish: async () => {
      try {
        const usage = await result.usage;
        generation.end({
          output: assistantText,
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
          assistant_content: assistantText,
        });
      } catch {
        // best-effort persistence
      }
    },
  });

  // AI SDK v6 streams via Server-Sent Events.
  return createUIMessageStreamResponse({ stream: uiStream });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    info: "POST { messages, sessionId } to stream a WallE reply.",
  });
}
