import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { RequestContext } from "@mastra/core/request-context";
import { api } from "../../../../convex/_generated/api";
import {
  getDashboardChatAgent,
  SYSTEM_PROMPT_BASE,
} from "../../../mastra/agents/dashboard-chat";
import { createHydrationLayer } from "../../../mastra/lib/hydration";
import { GROK_CHAT_MODEL } from "../../../lib/ai-models";
import type { AgentExecutionOptionsBase } from "@mastra/core/agent";

// ── Per-account slim bundle cache (cost control) ───────────────────────
// Wave 2 (phase1-tool-router-hydration): the prior implementation invoked
// `getContextBundle` — 7 full table scans on Convex per call (reservations,
// renters, bundles, pricing_catalog, historical_revenue, denial_records,
// items). That has been replaced by the HydrationLayer + a small freshness/
// alerts header (see buildSlimBundle below). The 60-s in-process cache
// stays, but the key now includes the accountSlug so multi-account tenants
// don't poison each other's bundles.
const BUNDLE_TTL_MS = 60_000;
type SlimBundle = {
  generatedAt: number;
  lastPollAt: number | null;
  staleMin: number | null;
  pollSucceeded: boolean;
  briefingSnapshotAt: number | null;
  r2BundleSnapshotAt: number | null;
  openShadowActions: number;
  readOnlyMode: boolean;
  accountSlug: string;
};
const bundleCache = new Map<
  string,
  { value: SlimBundle; expiresAt: number }
>();

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

  const body = (await req.json()) as {
    message?: string;
    thread_id?: string;
    accountSlug?: string;
  };
  const message = (body.message ?? "").trim();
  const thread_id = body.thread_id ?? "dashboard";
  const accountSlug = (body.accountSlug ?? "default").trim() || "default";

  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  // Must match the dashboard's read deployment (src/lib/convex.ts) — Vercel's
  // NEXT_PUBLIC_CONVEX_URL points to exciting-lion-29, but the dashboard reads
  // from hearty-oyster-600. Using the wrong URL silently writes chat messages
  // to a deployment the UI never queries → "chat doesn't answer".
  const CONVEX_URL =
    process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";
  const convex = new ConvexHttpClient(CONVEX_URL);
  const turnStart = Date.now();

  // 1. Persist user message
  await convex.mutation(api.dashboard_chat.appendMessage, {
    thread_id,
    role: "user",
    content: message,
  });

  // 2. Pull last 6 messages for context (3 user + 3 assistant turns).
  //    Wave 2: history was 20 — slashed to 6 because the agent now resolves
  //    factual state from tool calls + hydration, not from chat scrollback.
  const history = await convex.query(api.dashboard_chat.getMessages, {
    thread_id,
    limit: 6,
  });

  // 3. Build the slim live-context bundle and the per-turn HydrationLayer.
  //    The 7-scan getContextBundle is gone; per the audit substitution
  //    table (/tmp/wfo-phase1/audit_context_bundle_scans.md):
  //      Scan 1 reservations  → split: live schedule via HydrationLayer T2
  //                              + revenue/BI via mv_daily_briefing (MV)
  //      Scan 2 renters       → stay live (small table)
  //      Scan 3 bundles       → R2 snapshot (by_item)
  //      Scan 4 pricing_cat.  → dropped (mv_purchase_signals covers fallback)
  //      Scan 5 hist_revenue  → R2 snapshot (by_month)
  //      Scan 6 denial_records→ dropped (rolled into mv_purchase_signals)
  //      Scan 7 items         → stay live (71 rows, conflict detection)
  //    The system-prompt header is intentionally tiny now; this header
  //    carries freshness + critical alerts + static facts. Detailed reads
  //    happen via tools that themselves read the same HydrationLayer via
  //    requestContext.get("hydration").
  const hydration = createHydrationLayer({
    convex,
    syncSources: {
      items: "hygglo-items-sync",
      renters: "hygglo-renters-sync",
      reservations: "hygglo_poller",
    },
  });

  let composedInstructions: string = SYSTEM_PROMPT_BASE;
  let slimBundle: SlimBundle | null = null;
  try {
    slimBundle = await getCachedSlimBundle(convex, hydration, accountSlug);
    const header = formatSlimHeader(slimBundle);
    if (header.length > 0) {
      composedInstructions = SYSTEM_PROMPT_BASE + "\n\n" + header;
    }
  } catch (err) {
    console.error("[chat] slim context bundle fetch failed:", err);
  }

  // Attach the hydration layer to the per-request context (keyed "hydration"
  // per design spec /tmp/wfo-phase1/design_hydration_interface.md). Tools
  // read this via requestContext.get("hydration") to reuse T1/T2/T3 caches.
  const requestContext = new RequestContext();
  requestContext.set("hydration", hydration);
  if (accountSlug) requestContext.set("accountSlug", accountSlug);

  const messages: ChatMessage[] = history.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  const streamOpts: StreamOpts = {
    instructions: composedInstructions,
    requestContext,
  };

  // 4. Stream with error handling
  const encoder = new TextEncoder();
  let fullText = "";

  // Per-thread agent: bound to an xAI client with `x-grok-conv-id: <thread_id>`
  // so xAI prompt caching (75-90% off cached input tokens) kicks in for
  // consecutive turns on the same conversation. See dashboard-chat.ts.
  const agent = getDashboardChatAgent(thread_id);

  const stream = new ReadableStream({
    async start(controller) {
      let result: Awaited<ReturnType<typeof agent.stream>>;

      try {
        result = await agent.stream(messages, streamOpts);
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

        // Capture token usage if available. `cached_tokens` is the xAI
        // prompt-caching hit count (cachedInputTokens on the AI SDK usage
        // object) — proxied through Mastra. Non-zero means our
        // `x-grok-conv-id` header is paying off; 0 on the first turn is
        // expected, subsequent turns on the same thread should climb.
        const latencyMs = Date.now() - turnStart;
        let metadata: string | undefined;
        try {
          const usage = await result.usage;
          const cachedTokens = usage?.cachedInputTokens ?? null;
          metadata = JSON.stringify({
            model: GROK_CHAT_MODEL,
            input_tokens: usage?.inputTokens ?? null,
            output_tokens: usage?.outputTokens ?? null,
            cached_tokens: cachedTokens,
            latency_ms: latencyMs,
          });
          console.log("[chat] token usage:", {
            thread_id,
            input_tokens: usage?.inputTokens ?? null,
            output_tokens: usage?.outputTokens ?? null,
            cached_tokens: cachedTokens,
            latency_ms: latencyMs,
          });
        } catch {
          metadata = JSON.stringify({
            model: GROK_CHAT_MODEL,
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

// ── Slim bundle helpers ────────────────────────────────────────

async function getCachedSlimBundle(
  convex: ConvexHttpClient,
  hydration: ReturnType<typeof createHydrationLayer>,
  accountSlug: string,
): Promise<SlimBundle> {
  const now = Date.now();
  const cached = bundleCache.get(accountSlug);
  if (cached && now < cached.expiresAt) return cached.value;
  const fresh = await buildSlimBundle(convex, hydration, accountSlug);
  bundleCache.set(accountSlug, { value: fresh, expiresAt: now + BUNDLE_TTL_MS });
  return fresh;
}

async function buildSlimBundle(
  convex: ConvexHttpClient,
  hydration: ReturnType<typeof createHydrationLayer>,
  accountSlug: string,
): Promise<SlimBundle> {
  const generatedAt = Date.now();
  // Pull in parallel: poller freshness (live), daily briefing MV (revenue
  // & alerts), R2 by_item snapshot (catalog last refresh time). Each path
  // is independently best-effort — failures degrade the header, not the
  // user response. mv.daily_briefing is read via the hydration layer's
  // memoQuery so a duplicate call within the same turn (e.g. from a tool)
  // hits the T2 cache.
  const briefingFn = (
    api as unknown as { dashboard_briefing?: { get?: unknown } }
  ).dashboard_briefing?.get;
  const [pollerState, briefing, r2Snapshot] = await Promise.all([
    convex
      .query(api.sync_state.get, { source: "hygglo_poller" })
      .catch(() => null),
    briefingFn
      ? hydration
          .memoQuery(
            briefingFn,
            {},
            () => convex.query(briefingFn as never, {}) as Promise<unknown>,
            { table: "daily_briefing" },
          )
          .catch(() => null)
      : Promise.resolve(null),
    hydration
      .loadSnapshot<{ generatedAt?: number } | null>("by_item")
      .catch(() => null),
  ]);

  const lastPollAt =
    pollerState && typeof pollerState.lastRunAt === "number"
      ? pollerState.lastRunAt
      : null;
  const staleMin =
    lastPollAt !== null
      ? Math.round((generatedAt - lastPollAt) / 60_000)
      : null;
  const pollSucceeded = pollerState?.lastRunSucceeded ?? true;
  const briefingSnapshotAt =
    briefing && typeof briefing === "object" && "meta" in briefing
      ? (briefing as { meta?: { source?: { fetchedAt?: number } } }).meta
          ?.source?.fetchedAt ?? null
      : null;
  const briefingData =
    briefing && typeof briefing === "object" && "data" in briefing &&
    briefing.data && typeof briefing.data === "object"
      ? (briefing.data as Record<string, unknown>)
      : null;
  const r2BundleSnapshotAt =
    r2Snapshot && typeof r2Snapshot === "object" && "meta" in r2Snapshot
      ? (r2Snapshot as { meta?: { source?: { fetchedAt?: number } } }).meta
          ?.source?.fetchedAt ?? null
      : null;
  // Open shadow actions: tolerate either a precomputed count field on the
  // daily briefing MV or 0 when unavailable. We intentionally do NOT do a
  // separate Convex scan here — that is exactly the cost this rewrite
  // exists to eliminate.
  const openShadowActions =
    briefingData && typeof briefingData.openShadowActions === "number"
      ? (briefingData.openShadowActions as number)
      : 0;
  const readOnlyMode = process.env.READ_ONLY_MODE === "true";
  return {
    generatedAt,
    lastPollAt,
    staleMin,
    pollSucceeded,
    briefingSnapshotAt,
    r2BundleSnapshotAt,
    openShadowActions,
    readOnlyMode,
    accountSlug,
  };
}

function formatSlimHeader(b: SlimBundle): string {
  const lines: string[] = ["--- LIVE BUSINESS CONTEXT (SLIM) ---"];
  const generatedIso = new Date(b.generatedAt).toISOString();
  lines.push(`Generated: ${generatedIso}.`);
  if (b.lastPollAt) {
    const pollIso = new Date(b.lastPollAt).toISOString();
    const staleTxt = b.staleMin !== null ? `${b.staleMin} min ago` : "unknown";
    const failTxt = b.pollSucceeded ? "" : " (last poll FAILED)";
    lines.push(`Last Hygglo poll: ${pollIso} (${staleTxt})${failTxt}.`);
  } else {
    lines.push("Last Hygglo poll: unknown.");
  }
  if (b.briefingSnapshotAt) {
    lines.push(
      `Daily briefing MV snapshot: ${new Date(b.briefingSnapshotAt).toISOString()}.`,
    );
  }
  if (b.r2BundleSnapshotAt) {
    lines.push(
      `R2 by_item snapshot: ${new Date(b.r2BundleSnapshotAt).toISOString()}.`,
    );
  }
  if (b.openShadowActions > 0) {
    lines.push(
      `ALERT: ${b.openShadowActions} open shadow action(s) awaiting approval.`,
    );
  }
  lines.push(
    `Account: ${b.accountSlug}; Mode: ${b.readOnlyMode ? "READ_ONLY" : "live"}.`,
  );
  lines.push(
    "This block is a freshness header only. For pricing, availability, pending rentals, revenue, top earners, etc. you MUST call the appropriate tool.",
  );
  return lines.join("\n");
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
