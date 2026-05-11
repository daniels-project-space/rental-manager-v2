import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import {
  dashboardChatAgent,
  SYSTEM_PROMPT_BASE,
} from "../../../mastra/agents/dashboard-chat";
import { formatContext } from "../../../mastra/context-formatter";
import type { AgentExecutionOptionsBase } from "@mastra/core/agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ── Rate limiter ───────────────────────────────────────────────
const rateMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }
  return { allowed: true, retryAfter: 0 };
}

type ChatMessage = { role: "user" | "assistant"; content: string };
type StreamOpts = AgentExecutionOptionsBase<unknown>;

export async function POST(req: Request) {
  // Rate limit
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const { allowed, retryAfter } = checkRateLimit(ip);
  if (!allowed) {
    return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
      },
    });
  }

  const body = (await req.json()) as { message?: string; thread_id?: string };
  const message = (body.message ?? "").trim();
  const thread_id = body.thread_id ?? "dashboard";

  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  const turnStart = Date.now();

  // 1. Persist user message
  await convex.mutation(api.dashboard_chat.appendMessage, {
    thread_id,
    role: "user",
    content: message,
  });

  // 2. Pull last 20 messages for context
  const history = await convex.query(api.dashboard_chat.getMessages, {
    thread_id,
    limit: 20,
  });

  // 3. Fetch live business context
  let composedInstructions: string = SYSTEM_PROMPT_BASE;
  try {
    const bundle = await convex.query(
      api.dashboard_chat_context.getContextBundle,
      {}
    );
    const ctxStr = formatContext(bundle);
    if (ctxStr.length > 0) {
      composedInstructions =
        SYSTEM_PROMPT_BASE + "\n\n--- LIVE BUSINESS CONTEXT ---\n" + ctxStr;
    }
  } catch (err) {
    console.error("[chat] context bundle fetch failed:", err);
  }

  const messages: ChatMessage[] = history.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  const streamOpts: StreamOpts = { instructions: composedInstructions };

  // 4. Stream with error handling
  const encoder = new TextEncoder();
  let fullText = "";

  const stream = new ReadableStream({
    async start(controller) {
      let result: Awaited<ReturnType<typeof dashboardChatAgent.stream>>;

      try {
        result = await dashboardChatAgent.stream(messages, streamOpts);
      } catch (initErr) {
        const errMsg = errorMessage(initErr);
        console.error("[chat] agent stream init failed:", initErr);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: errMsg })}\n\n`
          )
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        await persistError(convex, thread_id, errMsg);
        return;
      }

      const reader = result.textStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullText += value;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ text: value })}\n\n`)
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();

        // Capture token usage if available
        const latencyMs = Date.now() - turnStart;
        let metadata: string | undefined;
        try {
          const usage = await result.usage;
          metadata = JSON.stringify({
            model: "grok-4-1-fast-non-reasoning",
            input_tokens: usage?.inputTokens ?? null,
            output_tokens: usage?.outputTokens ?? null,
            latency_ms: latencyMs,
          });
          console.log("[chat] token usage:", metadata);
        } catch {
          metadata = JSON.stringify({
            model: "grok-4-1-fast-non-reasoning",
            latency_ms: latencyMs,
          });
        }

        await convex
          .mutation(api.dashboard_chat.appendMessage, {
            thread_id,
            role: "assistant",
            content: fullText,
            metadata,
          })
          .catch((e: unknown) =>
            console.error("[chat] persist assistant msg failed:", e)
          );
      } catch (streamErr) {
        const errMsg = classifyError(streamErr);
        console.error("[chat] stream read error:", streamErr);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: errMsg })}\n\n`
          )
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        try { controller.close(); } catch { /* already closed */ }
        await persistError(convex, thread_id, errMsg);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ── Helpers ────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function classifyError(err: unknown): string {
  const msg = errorMessage(err);
  if (msg.includes("429") || /rate.?limit/i.test(msg))
    return "The AI service is rate-limited. Please wait a moment and try again.";
  if (msg.includes("401") || /auth|unauthorized/i.test(msg))
    return "AI service authentication failed. Check XAI_API_KEY.";
  if (/convex|query|mutation/i.test(msg))
    return "Database query failed mid-stream. " + msg;
  if (/model.*empty|no.*content/i.test(msg))
    return "The model returned an empty response. Please try again.";
  return "An unexpected error occurred: " + msg;
}

async function persistError(
  convex: ConvexHttpClient,
  thread_id: string,
  errMsg: string
): Promise<void> {
  await convex
    .mutation(api.dashboard_chat.appendMessage, {
      thread_id,
      role: "system",
      content: "Error: " + errMsg,
    })
    .catch((e: unknown) =>
      console.error("[chat] persist error msg failed:", e)
    );
}
