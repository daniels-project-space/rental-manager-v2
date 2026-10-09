import { generateText } from "ai";
import { getRenterBotModel } from "@/lib/llm-client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 45;

type ContextMessage = { role: "owner" | "renter"; text: string; at: number };

export async function POST(request: Request) {
  const secret = process.env.RENTER_BOT_API_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { renter_name?: string; booking?: { status?: string; start?: number; end?: number; items?: Array<{ name?: string; qty?: number }> }; messages?: ContextMessage[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
  if (!messages.length || messages.some((message) =>
    (message.role !== "owner" && message.role !== "renter") ||
    typeof message.text !== "string" || message.text.length > 3000,
  )) return NextResponse.json({ error: "invalid_context" }, { status: 400 });

  const items = (body.booking?.items ?? []).slice(0, 12).map((item) => {
    const name = typeof item.name === "string" ? item.name.slice(0, 120) : "Rental item";
    const qty = Number.isSafeInteger(item.qty) ? Math.max(1, Math.min(20, item.qty!)) : 1;
    return `${qty}× ${name}`;
  });
  const date = (value?: number) => Number.isFinite(value) ? new Date(value!).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "unknown";
  const transcript = messages.map((message) => `${message.role === "owner" ? "Rental manager" : "Renter"}: ${message.text}`).join("\n");
  try {
    const { text } = await generateText({
      model: await getRenterBotModel(),
      system: [
        "Write a concise, warm draft reply for the Rental Manager to review. Do not send it.",
        "Answer the renter's latest question using only this conversation and the supplied booking facts.",
        "Never claim that items are available, that a refund/discount/date change has been made, or that a verification step is complete unless the supplied facts explicitly say so.",
        "If the renter asks about availability, money, or a change that is not confirmed in the facts, say the manager will check and follow up. Do not invent policies, prices, promises, or deadlines.",
        "Keep the reply short and conversational. Do not mention AI or internal systems.",
      ].join("\n"),
      prompt: [
        `Renter name: ${String(body.renter_name ?? "Renter").slice(0, 100)}`,
        `Rental status: ${String(body.booking?.status ?? "unknown").slice(0, 80)}`,
        `Dates: ${date(body.booking?.start)} to ${date(body.booking?.end)}`,
        `Items: ${items.join(", ") || "not supplied"}`,
        "Conversation, oldest to newest:",
        transcript,
        "Write only the draft reply to the renter.",
      ].join("\n"),
      maxOutputTokens: 220,
      temperature: 0.3,
    });
    return NextResponse.json({ draft: text.trim() });
  } catch {
    return NextResponse.json({ error: "generation_failed" }, { status: 503 });
  }
}
