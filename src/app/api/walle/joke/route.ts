/**
 * Phase 7 — WallE idle-joke endpoint.
 *
 * POST /api/walle/joke
 *   body: { userId: string }
 *
 * Flow:
 *   1. Check Convex `dashboard_chat:getJokeQuota` — if exhausted, return
 *      { joke: null, reason: "quota_exhausted" } (200, NOT 4xx).
 *   2. Single-shot generateText() through OpenRouter / DeepSeek with the
 *      WallE joke voice as system + a randomly picked seed as user.
 *   3. Atomically `recordJoke` AFTER generation — if the mutation reports
 *      the slot was claimed by a concurrent request, return quota_exhausted.
 *   4. Any unexpected failure returns { joke: null, reason: "error" } (200).
 *
 * The endpoint never returns 4xx/5xx for runtime issues: the client treats
 * a null joke as a silent no-op so chat UX never surfaces an error toast.
 */
import "server-only";
import { NextResponse } from "next/server";
import { generateText } from "ai";
import { getVaultOpenRouterModel } from "@/lib/llm-client";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../../convex/_generated/api";
import { pickJokeSeed } from "../../../../components/dashboard/WallE/walle.jokes";
import { traceWalle } from "../../../../lib/walle/langfuse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface JokeRequestBody {
  userId: string;
}

const JOKE_SYSTEM = `You are WallE — a dry-witted, camera-aware assistant for a UK Hygglo camera-rental business.
Voice: dry, terse, camera-aware. No laugh-track. No "Why did...?" setups. No emoji. No exclamation marks.
Output: exactly one joke, plain text, under 220 characters. No preamble. No quotation marks around the joke.`;

export async function POST(req: Request) {
  let body: JokeRequestBody;
  try {
    body = (await req.json()) as JokeRequestBody;
  } catch {
    return NextResponse.json({ joke: null, reason: "error" }, { status: 200 });
  }

  const userId = body?.userId;
  if (typeof userId !== "string" || !userId) {
    return NextResponse.json({ joke: null, reason: "error" }, { status: 200 });
  }

  const convexUrl = process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud"; // canonical (NEXT_PUBLIC pins to orphan)
  if (!convexUrl) {
    return NextResponse.json({ joke: null, reason: "error" }, { status: 200 });
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);

    // 0) Rate limit (10/hr per user; cheap protection against client bugs).
    try {
      const rl = await convex.mutation(api.walle_ratelimits.checkWalleLimit, {
        bucket: "walle_joke",
        key: userId,
      });
      if (!rl.ok) {
        return NextResponse.json(
          { joke: null, reason: "rate_limited" },
          { status: 200 },
        );
      }
    } catch {
      // fail-open
    }

    // 1) Quota pre-check (cheap, avoids burning tokens for nothing).
    const quota = await convex.query(api.dashboard_chat.getJokeQuota, {
      user_id: userId,
    });
    if (!quota || quota.remaining <= 0) {
      return NextResponse.json(
        { joke: null, reason: "quota_exhausted" },
        { status: 200 }
      );
    }

    // 2) Single-shot LLM call.
    const modelId = process.env.DEEPSEEK_MODEL ?? "deepseek/deepseek-chat";
    const model = await getVaultOpenRouterModel(modelId);

    const seed = pickJokeSeed();
    const trace = traceWalle({
      name: "walle_joke",
      userId,
      metadata: { model: modelId, seed },
    });
    const generation = trace.generation({
      name: "generateText",
      model: modelId,
      input: seed,
    });
    const { text, usage } = await generateText({
      model,
      system: JOKE_SYSTEM,
      prompt: seed,
      // Phase 9 cost guardrail — jokes are short by design.
      maxOutputTokens: 150,
    });
    generation.end({
      output: text,
      usage: {
        promptTokens: usage?.inputTokens,
        completionTokens: usage?.outputTokens,
        totalTokens: usage?.totalTokens,
      },
    });
    await trace.flush();

    const joke = (text ?? "").trim();
    if (!joke) {
      return NextResponse.json({ joke: null, reason: "error" }, { status: 200 });
    }

    // 3) Atomic claim (race-safe: mutation returns ok:false if cap hit).
    const claim = await convex.mutation(api.dashboard_chat.recordJoke, {
      user_id: userId,
    });
    if (!claim?.ok) {
      return NextResponse.json(
        { joke: null, reason: "quota_exhausted" },
        { status: 200 }
      );
    }

    return NextResponse.json({ joke }, { status: 200 });
  } catch {
    return NextResponse.json({ joke: null, reason: "error" }, { status: 200 });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    info: "POST { userId } to fetch a single WallE idle joke (quota 2/day).",
  });
}
