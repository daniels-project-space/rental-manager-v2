/**
 * /api/chat — restored dashboard-chat endpoint.
 *
 * Backstory: PR #15 (commit a105122, 2026-05-18) deleted the original
 * dashboard-chat surface — Mastra agent + memory + 13 router tools + this
 * route — citing "Daniel doesn't use it." Daniel asked for it back on
 * 2026-05-23. The Mastra surface was tied to a `src/mastra/data/` layer that
 * was *also* deleted (commit ed598c0), so this restore is intentionally
 * leaner — no Mastra agent runner, no LibSQL memory, no intent classifier.
 * Same shape as the WallE chat route (which has stayed alive on `useChat`),
 * just with a broader tool set and the wider "AI Assistant" persona the old
 * widget had.
 *
 * Wire shape:
 *   POST /api/chat
 *     body: { message: string, thread_id?: string }
 *     streams text-delta lines as `data: {"text":"…"}` (NOT the ai-sdk-v6
 *     ui-message format — `AIChat.tsx` parses the simpler shape).
 *     terminates with `data: [DONE]`.
 *
 * Persistence:
 *   On `onFinish`, writes both the user message and the full assistant text
 *   to Convex `dashboard_chat:appendTurn` (thread_id = "dashboard" by
 *   default). The widget reads through `dashboard_chat:getMessages` and
 *   re-hydrates on every render, so history survives reloads.
 *
 * Provider:
 *   OpenRouter → DEEPSEEK_MODEL (default `deepseek/deepseek-chat`), the
 *   same path the WallE route uses. AI_PROVIDER=xai flips to Grok 4.3 as
 *   fallback (see [[architecture_rmv2_ai_provider]] memory).
 */
import "server-only";
import { NextResponse } from "next/server";
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import {
  ANALYTICAL_INTENT,
  buildDashboardTools,
  buildLiveSnapshot,
  DASHBOARD_GROUNDING_RULES,
} from "../../../lib/chat/dashboard-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatRequestBody {
  message: string;
  thread_id?: string;
}

const SYSTEM_PROMPT = `You are Daniel's dashboard AI assistant for Rental Manager v2 — a rental business operations platform.

${DASHBOARD_GROUNDING_RULES}

Style: concise, plain UK English, no filler ("As an AI…", "I'd be happy to…"). Numbers first, prose second.`;

export async function POST(req: Request) {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const { message } = body ?? {};
  const thread_id = body?.thread_id ?? "dashboard";
  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ ok: false, error: "no_message" }, { status: 400 });
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const convexClient = convexUrl ? new ConvexHttpClient(convexUrl) : null;

  // Light per-thread rate limit (reuses the WallE bucket — sessionId stand-in).
  if (convexClient) {
    try {
      const status = await convexClient.mutation(
        api.walle_ratelimits.checkWalleLimit,
        { bucket: "walle_chat", key: `dashboard:${thread_id}` },
      );
      if (!status.ok) {
        return new Response(
          `data: ${JSON.stringify({ error: `Rate limit reached. Retry in ${status.retryAfter}s.` })}\n\ndata: [DONE]\n\n`,
          {
            status: 429,
            headers: {
              "content-type": "text/event-stream",
              "Retry-After": String(status.retryAfter ?? 60),
              "cache-control": "no-cache",
            },
          },
        );
      }
    } catch {
      // limiter unavailable — fail-open
    }
  }

  // Pull last ~10 turns for context.
  let history: ModelMessage[] = [];
  if (convexClient) {
    try {
      const prior = await convexClient.query(api.dashboard_chat.getMessages, {
        thread_id,
        limit: 10,
      });
      history = (prior ?? [])
        .filter(
          (m: { role: string; content: string }) =>
            m.role === "user" || m.role === "assistant",
        )
        .map(
          (m: { role: string; content: string }) =>
            ({ role: m.role as "user" | "assistant", content: m.content }) as ModelMessage,
        );
    } catch {
      // best-effort
    }
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "missing_openrouter_key" },
      { status: 500 },
    );
  }
  const openrouter = createOpenRouter({ apiKey });
  const modelId = process.env.DEEPSEEK_MODEL ?? "deepseek/deepseek-chat";
  const model = openrouter(modelId);
  const tools = convexClient ? buildDashboardTools(convexClient) : undefined;
  // v1-style compute-then-phrase: live dashboard snapshot injected as trusted
  // context so headline numbers aren't re-derived by the model.
  const snapshot = convexClient
    ? await buildLiveSnapshot(convexClient).catch(() => "")
    : "";

  const modelMessages: ModelMessage[] = [
    ...history,
    { role: "user", content: message },
  ];

  // Stream + collect final assistant text for persistence.
  let finalText = "";
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const result = streamText({
          model,
          system: `${SYSTEM_PROMPT}\n\nToday's date is ${new Date().toISOString().slice(0, 10)} — use it for "this year / this month / last month" reasoning.${snapshot ? `\n\n${snapshot}` : ""}`,
          messages: modelMessages,
          tools,
          maxOutputTokens: 1500,
          stopWhen: stepCountIs(4),
          // Force a tool call on the first step for analytical questions (their
          // data isn't in the snapshot) so the model grounds instead of guessing
          // per-item earnings / utilization / buy advice. Headline turns stay
          // auto; later steps revert to auto so the model can summarise.
          prepareStep: ANALYTICAL_INTENT.test(message)
            ? ({ stepNumber }) =>
                stepNumber === 0 ? { toolChoice: "required" } : {}
            : undefined,
          onFinish: async ({ text }) => {
            finalText = text;
            try {
              if (convexClient) {
                await convexClient.mutation(api.dashboard_chat.appendTurn, {
                  thread_id,
                  session_id: thread_id,
                  user_content: message,
                  assistant_content: finalText,
                });
              }
            } catch {
              // best-effort persistence
            }
          },
        });
        for await (const delta of result.textStream) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ text: delta })}\n\n`),
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    info: "POST { message, thread_id? } to stream a dashboard-chat reply.",
  });
}
