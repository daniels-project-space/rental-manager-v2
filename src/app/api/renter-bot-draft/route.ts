import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import { getRenterBotAgent, type RenterBotOutput } from "@/mastra/agents/renter_bot";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Production draft path — the agentic Mastra renter bot. Given a thread, it pulls
 * the account + latest renter message, gives the agent TODAY's date, runs it, and
 * returns { draft, needs_human, factsClaimed }. Called by convex generateDraft
 * (which keeps the guard + setDraft + learning). This is the bot; the old
 * single-shot is only a fallback if this errors.
 */
export async function POST(req: Request) {
  let body: { thread_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const { thread_id } = body;
  if (!thread_id) return NextResponse.json({ ok: false, error: "no_thread_id" }, { status: 400 });

  const convexUrl = process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";
  const convex = new ConvexHttpClient(convexUrl);

  let account_slug = "";
  let lastRenter = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rc: any = await convex.query(api.renter_bot_tools.get_renter_context, { thread_id });
    account_slug = rc?.account_slug ?? "";
    const msgs = (rc?.last_messages ?? []) as Array<{ sender?: string; body?: string }>;
    const r = [...msgs].reverse().find((m) => m.sender === "renter");
    lastRenter = r?.body ?? "";
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "context_failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const baseMessages = [
    {
      role: "user" as const,
      content: [
        `TODAY IS ${today} (Europe/London). Compute any relative dates the renter uses from TODAY; never guess a date.`,
        `THREAD: ${thread_id}`,
        `ACCOUNT: ${account_slug}`,
        `LATEST INBOUND MESSAGE FROM RENTER:`,
        lastRenter,
      ].join("\n"),
    },
  ];

  try {
    const agent = await getRenterBotAgent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await (agent as any).generate(baseMessages, { maxSteps: 10 });
    const text: string = result?.text ?? "";
    let obj: RenterBotOutput | null = null;
    try {
      let js = text.trim();
      const fence = js.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence) js = fence[1].trim();
      const a = js.indexOf("{");
      const b = js.lastIndexOf("}");
      if (a >= 0 && b > a) obj = JSON.parse(js.slice(a, b + 1)) as RenterBotOutput;
    } catch {
      obj = null;
    }
    if (!obj) {
      // Couldn't parse a decision — escalate rather than send garbage.
      return NextResponse.json({ ok: true, draft: "", needs_human: true, factsClaimed: [] });
    }
    return NextResponse.json({
      ok: true,
      draft: obj.draft ?? "",
      needs_human: !!obj.needs_human,
      intent: obj.intent ?? null,
      factsClaimed: obj.factsClaimed ?? [],
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "agent_failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
