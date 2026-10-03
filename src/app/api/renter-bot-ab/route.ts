import { NextResponse } from "next/server";
import { withOwnerRoute } from "@/lib/owner-http-route";
import { api } from "../../../../convex/_generated/api";
import { getRenterBotAgent, type RenterBotOutput } from "@/mastra/agents/renter_bot";
import { renterBotRuntimeAllowed } from "../../../../convex/lib/renter_bot_runtime";
import { withRenterToolScope } from "@/lib/renter-tool-scope";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Lab comparison: canonical reviewed draft versus an unreviewed raw agent
 * candidate. Candidate tools cannot change the booking. Both use the recorded
 * account and latest renter message. Never runs on a real Hygglo conversation.
 */
export const POST = withOwnerRoute(async function POST(req: Request, convex) {
  let body: { thread_id?: string; account_slug?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "bad_json" }, { status: 400 });
  const { thread_id, account_slug, message } = body;
  if (typeof thread_id !== "string" || !thread_id.trim()) return NextResponse.json({ error: "no_thread_id" }, { status: 400 });
  if (!renterBotRuntimeAllowed(thread_id)) return NextResponse.json({ error: "lab_only_pending_written_consent" }, { status: 403 });
  let context;
  try { context = await convex.query(api.renter_bot_tools.get_renter_context, { thread_id }); }
  catch { return NextResponse.json({ error: "comparison_context_unavailable" }, { status: 503 }); }
  if (!context.account_slug || (account_slug && account_slug !== context.account_slug)) {
    return NextResponse.json({ error: "comparison_account_mismatch" }, { status: 409 });
  }
  const latest = context.last_messages.at(-1);
  if (!latest || latest.sender !== "renter" || (message !== undefined && message !== latest.body)) {
    return NextResponse.json({ error: "comparison_message_mismatch" }, { status: 409 });
  }

  // OLD bot — the live convex draft path.
  let oldDraft = "";
  try {
    const r = await convex.action(api.replyInbox_actions.generateDraft, {
      thread_id,
    });
    if (r.status !== "ok" || !r.draft) return NextResponse.json({ error: "canonical_comparison_unavailable" }, { status: 503 });
    oldDraft = r.draft;
  } catch {
    return NextResponse.json({ error: "canonical_comparison_unavailable" }, { status: 503 });
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
          `ACCOUNT: ${context.account_slug}`,
          `LATEST INBOUND MESSAGE FROM RENTER:`,
          latest.body,
        ].join("\n"),
      },
    ];
    // NOTE: NOT using structuredOutput — that forces OpenRouter's json_schema
    // response_format, which Anthropic models on OpenRouter can't route ("no
    // allowed providers"). The agent still runs its tool loop; its prompt asks
    // for the JSON, so we parse it from the plain text (falling back to raw).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await withRenterToolScope({ threadId: thread_id, accountSlug: context.account_slug, bookingWritesAllowed: false }, () => (agent as any).generate(baseMessages, {
      maxSteps: 10,
    }));
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

  return NextResponse.json({ thread_id, old: oldDraft, new: newDraft, new_meta: newMeta, trace, rawText, comparison_kind: "canonical_reviewed_vs_raw_candidate", new_reviewed: false });
});
