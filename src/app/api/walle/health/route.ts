/**
 * WallE model-lane health check.
 *
 * Why this exists: on 2026-08-16 the shared OpenRouter account ran out of
 * credit. Every WallE surface (chat, joke, narrate) returned HTTP 200 with an
 * empty body, because provider errors surface on the AI SDK stream's error
 * channel rather than throwing — so nothing reached the user OR the logs, and
 * diagnosing it needed a code read plus live probing of three routes.
 *
 * This route turns that into one curl. It does a MINIMAL non-streaming
 * generation against the primary and fallback lanes and reports, per lane,
 * whether it answered and the upstream error if not.
 *
 *   curl -s https://<host>/api/walle/health | jq
 *
 * Deliberately GET + unauthenticated-but-harmless: it takes no input, exposes
 * no business data, and costs a handful of tokens. Errors are truncated and
 * scrubbed so an upstream message can never echo a credential back out.
 */
import "server-only";
import { NextResponse } from "next/server";
import { generateText } from "ai";
import { getVaultOpenRouterModel } from "@/lib/llm-client";
import {
  CHAT_MODEL,
  CHAT_MODEL_SMART,
} from "@/lib/ai-models";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Never let an upstream error echo a key back to the caller. */
function scrub(raw: string): string {
  return raw
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***")
    .slice(0, 300);
}

interface LaneResult {
  lane: string;
  model: string;
  ok: boolean;
  ms: number;
  reply?: string;
  error?: string;
}

async function probe(lane: string, modelId: string): Promise<LaneResult> {
  const started = Date.now();
  try {
    const model = await getVaultOpenRouterModel(modelId);
    const { text } = await generateText({
      model,
      prompt: "Reply with the single word: ok",
      // Must be generous enough for a REASONING model. Gemini 3.x thinks before
      // it speaks and spends output budget on thinking tokens, so a tight cap
      // (this was 8) returns an empty completion and the lane looks dead when
      // it is fine — a false alarm that would send Daniel chasing credits for
      // nothing. Keep it well above the thinking budget for a one-word answer.
      maxOutputTokens: 512,
    });
    const reply = (text ?? "").trim();
    return {
      lane,
      model: modelId,
      // An empty reply is the exact silent-failure signature — treat it as a
      // failure here, not a pass, or this check would have been green during
      // the outage it exists to catch.
      ok: reply.length > 0,
      ms: Date.now() - started,
      reply: reply.slice(0, 40),
      ...(reply.length === 0
        ? { error: "empty_completion — provider accepted the call but returned no tokens" }
        : {}),
    };
  } catch (err) {
    return {
      lane,
      model: modelId,
      ok: false,
      ms: Date.now() - started,
      error: scrub(err instanceof Error ? err.message : String(err)),
    };
  }
}

export async function GET() {
  const vaultConfigured = Boolean(process.env.VAULT_ACCESS_TOKEN);

  // Dedupe: primary fast/smart are usually the same model id.
  // Daniel, 2026-08-21: there is NO fallback lane on either the plain or the
  // smart path any more, so probing one would report on a lane the chat route
  // cannot actually use. Only the real lanes are probed —
  // the smart lane still uses it.
  const wanted: Array<[string, string]> = [
    ["primary", CHAT_MODEL],
    ["primary_smart", CHAT_MODEL_SMART],
  ];
  const seen = new Set<string>();
  const lanes = wanted.filter(([, id]) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const results = await Promise.all(lanes.map(([lane, id]) => probe(lane, id)));
  const chatOk = results.some((r) => r.ok);

  return NextResponse.json(
    {
      ok: chatOk,
      // The single most common root cause, stated plainly.
      diagnosis: chatOk
        ? "At least one model lane is answering — WallE can reply."
        : "No model lane answered. Most likely OpenRouter credits exhausted or the API key was revoked/rotated. Check openrouter.ai/credits and the vault entry service=openrouter key=OPENROUTER_API_KEY.",
      vault_access_token_configured: vaultConfigured,
      lanes: results,
      checked_at: new Date().toISOString(),
    },
    { status: chatOk ? 200 : 503 },
  );
}
