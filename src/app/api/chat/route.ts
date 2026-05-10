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

type ChatMessage = { role: "user" | "assistant"; content: string };
type StreamOpts = AgentExecutionOptionsBase<unknown>;

export async function POST(req: Request) {
  const body = (await req.json()) as { message?: string; thread_id?: string };
  const message = (body.message ?? "").trim();
  const thread_id = body.thread_id ?? "dashboard";

  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

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

  // 3. Fetch live business context and build composed system prompt
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
    // Non-fatal: agent still works without injected context
    console.error("[chat] context bundle fetch failed:", err);
  }

  const messages: ChatMessage[] = history.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  // 4. Stream with composed system prompt overriding agent's static instructions.
  // AgentExecutionOptionsBase.instructions accepts SystemMessage (string | ...).
  const streamOpts: StreamOpts = { instructions: composedInstructions };
  const result = await dashboardChatAgent.stream(messages, streamOpts);
  const textStream = result.textStream;

  const encoder = new TextEncoder();
  let fullText = "";

  const stream = new ReadableStream({
    async start(controller) {
      const reader = textStream.getReader();
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
      } catch (err) {
        controller.error(err);
      } finally {
        convex
          .mutation(api.dashboard_chat.appendMessage, {
            thread_id,
            role: "assistant",
            content: fullText,
          })
          .catch((e: unknown) =>
            console.error("[chat] persist assistant msg failed:", e)
          );
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
