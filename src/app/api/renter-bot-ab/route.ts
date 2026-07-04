import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import { getRenterBotAgent, type RenterBotOutput } from "@/mastra/agents/renter_bot";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * A/B harness — runs the SAME thread through the live single-shot bot
 * (replyInbox_actions.generateDraft) and the agentic Mastra renter bot, and
 * returns both drafts side by side so we can compare before retiring the old
 * one. POST { thread_id, account_slug, message }. Diagnostic only.
 */
export async function POST(req: Request) {
  let body: { thread_id?: string; account_slug?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const { thread_id, account_slug, message } = body;
  if (!thread_id) return NextResponse.json({ error: "no_thread_id" }, { status: 400 });

  const convexUrl = process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";
  const convex = new ConvexHttpClient(convexUrl);

  // OLD bot — the live convex draft path.
  let oldDraft = "";
  try {
    const r = (await convex.action(api.replyInbox_actions.generateDraft, {
      thread_id,
    })) as { draft?: string } | null;
    oldDraft = r?.draft ?? "(no draft)";
  } catch (e) {
    oldDraft = "ERR: " + (e instanceof Error ? e.message : String(e));
  }

  // NEW bot — the agentic Mastra renter bot.
  let newDraft = "";
  let newMeta: Partial<RenterBotOutput> | null = null;
  let trace: unknown[] = [];
  let rawText = "";
  try {
    const agent = await getRenterBotAgent();
    const todayLondon = new Date().toLocaleDateString("en-CA", {
      timeZone: "Europe/London",
    });
    const baseMessages = [
      {
        role: "user" as const,
        content: [
          `TODAY IS ${todayLondon} (Europe/London). Compute any relative dates the renter uses ("this weekend", "next Friday", "tomorrow") from TODAY — never guess a date. When you call check_availability, pass real dates derived from today.`,
          `THREAD: ${thread_id}`,
          `ACCOUNT: ${account_slug ?? ""}`,
          `LATEST INBOUND MESSAGE FROM RENTER:`,
          message ?? "",
        ].join("\n"),
      },
    ];
    // NOTE: NOT using structuredOutput — that forces OpenRouter's json_schema
    // response_format, which Anthropic models on OpenRouter can't route ("no
    // allowed providers"). The agent still runs its tool loop; its prompt asks
    // for the JSON, so we parse it from the plain text (falling back to raw).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await (agent as any).generate(baseMessages, {
      maxSteps: 10,
    });
    const text: string = result?.text ?? "";
    let obj: RenterBotOutput | null = null;
    try {
      let jsonStr = text.trim();
      const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence) jsonStr = fence[1].trim();
      const first = jsonStr.indexOf("{");
      const last = jsonStr.lastIndexOf("}");
      if (first >= 0 && last > first) {
        obj = JSON.parse(jsonStr.slice(first, last + 1)) as RenterBotOutput;
      }
    } catch {
      obj = null;
    }
    newDraft = obj?.draft ?? (text || "(empty)");
    // ── DEBUG TRACE: which tools were called + what they returned ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trace = ((result?.steps ?? []) as any[]).map((st) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCalls: ((st?.toolCalls ?? []) as any[]).map((tc) => ({
        tool: tc?.toolName ?? tc?.name,
        args: tc?.args ?? tc?.input,
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolResults: ((st?.toolResults ?? []) as any[]).map((tr) => ({
        tool: tr?.toolName ?? tr?.name,
        result: JSON.stringify(tr?.result ?? tr?.output ?? tr).slice(0, 400),
      })),
      finish: st?.finishReason,
    }));
    rawText = text.slice(0, 600);
    newMeta = obj
      ? {
          intent: obj.intent,
          needs_human: obj.needs_human,
          factsClaimed: obj.factsClaimed,
        }
      : null;
  } catch (e) {
    newDraft = "ERR: " + (e instanceof Error ? e.message : String(e));
  }

  return NextResponse.json({ thread_id, old: oldDraft, new: newDraft, new_meta: newMeta, trace, rawText });
}
