import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import { dashboardChatAgent } from "../../../mastra/agents/dashboard-chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ChatMessage = { role: "user" | "assistant"; content: string };

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

  const messages: ChatMessage[] = history.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  // 3. Stream agent response
  const result = await dashboardChatAgent.stream(messages);
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
