/**
 * /api/chat — restored dashboard-chat endpoint.
 *
 * Backstory: PR #15 (commit a105122, 2026-05-18) deleted the original
 * dashboard-chat surface — Mastra agent + memory + 13 router tools + this
 * route — citing "Daniel doesn't use it." Daniel asked for it back on
 * 2026-05-23. The Mastra surface was tied to a `src/mastra/data/` layer that
 * was *also* deleted (commit ed598c0), so this restore is intentionally
 * leaner — no Mastra agent runner, no LibSQL memory, no intent classifier.
 * Same shape as the WallE chat route (which has stayed alive on `useChat`),
 * just with a broader tool set and the wider "AI Assistant" persona the old
 * widget had.
 *
 * Wire shape:
 *   POST /api/chat
 *     body: { message: string, thread_id?: string }
 *     streams text-delta lines as `data: {"text":"…"}` (NOT the ai-sdk-v6
 *     ui-message format — `AIChat.tsx` parses the simpler shape).
 *     terminates with `data: [DONE]`.
 *
 * Persistence:
 *   On `onFinish`, writes both the user message and the full assistant text
 *   to Convex `dashboard_chat:appendTurn` (thread_id = "dashboard" by
 *   default). The widget reads through `dashboard_chat:getMessages` and
 *   re-hydrates on every render, so history survives reloads.
 *
 * Provider:
 *   OpenRouter → DEEPSEEK_MODEL (default `deepseek/deepseek-chat`), the
 *   same path the WallE route uses. AI_PROVIDER=xai flips to Grok 4.3 as
 *   fallback (see [[architecture_rmv2_ai_provider]] memory).
 */
import "server-only";
import { NextResponse } from "next/server";
import { streamText, stepCountIs, tool, type ModelMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { api } from "../../../../convex/_generated/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatRequestBody {
  message: string;
  thread_id?: string;
}

const SYSTEM_PROMPT = `You are Daniel's dashboard AI assistant for Rental Manager v2 — a rental business operations platform.

You have full read-only access to the live operational data via the tools below. ALWAYS call a tool before answering a data question; never guess at numbers. If a user's question is ambiguous between two tools, call both. Cite a number with the unit (£, %, items, days).

Tools:
  query_conflicts        — active double-bookings, not yet dismissed
  query_revenue          — month-to-date revenue + WoW delta vs last month
  query_utilization      — top items by util-delta WoW (>=20% movers)
  query_pending          — pending reservations awaiting decision
  query_funnel           — reservation conversion funnel for last N days
  query_calendar         — weekly calendar view (booked/free/partial)
  query_due_returns      — items overdue or due-soon for return
  query_recent_activity  — last N rental events (newest first)
  query_top_earners      — top items by ROI ranking
  query_smart_buys       — Smart-Buy ranking — items the model thinks Daniel should acquire

Style: concise, plain UK English, no filler ("As an AI…", "I'd be happy to…"). Numbers first, prose second.`;

// Phase 7b (2026-05-24) — module-scoped 60s TTL cache for chat tool calls.
// Saves re-fetching aggregated data within a single multi-step LLM turn AND
// across concurrent chat turns landing within 60s of each other. Applied
// only to read-only aggregates that don't change minute-to-minute. Live
// state (pending, due_returns) is intentionally uncached so Daniel sees the
// freshest action queue.
type CacheEntry = { value: unknown; exp: number };
const TOOL_CACHE = new Map<string, CacheEntry>();
const TOOL_CACHE_TTL_MS = 60_000;

async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = TOOL_CACHE.get(key);
  if (hit && hit.exp > now) return hit.value as T;
  const fresh = await fetcher();
  TOOL_CACHE.set(key, { value: fresh, exp: now + TOOL_CACHE_TTL_MS });
  // Opportunistic GC: drop the oldest 25% of entries once the map crosses 200.
  if (TOOL_CACHE.size > 200) {
    const oldest = [...TOOL_CACHE.entries()]
      .sort((a, b) => a[1].exp - b[1].exp)
      .slice(0, 50);
    for (const [k] of oldest) TOOL_CACHE.delete(k);
  }
  return fresh;
}

function buildTools(convex: ConvexHttpClient) {
  return {
    query_conflicts: tool({
      description: "Active double-bookings (same item, overlapping dates) not yet dismissed.",
      inputSchema: z.object({}),
      execute: async () =>
        cached("conflicts:all", () =>
          convex.query(api.dashboard_insights.getActiveConflicts, {}),
        ),
    }),
    query_revenue: tool({
      description: "Month-to-date take-home revenue (GBP) and percentage vs last month.",
      inputSchema: z.object({}),
      execute: async () =>
        cached("revenue:mtd", () =>
          convex.query(api.dashboard_insights.getRevenueDelta, {}),
        ),
    }),
    query_utilization: tool({
      description: "Top item utilization movers week-over-week (filtered to >=20% delta).",
      inputSchema: z.object({}),
      execute: async () =>
        cached("utilization:movers", () =>
          convex.query(api.dashboard_insights.getUtilizationDelta, {}),
        ),
    }),
    query_pending: tool({
      description: "Pending reservations awaiting Daniel's decision.",
      inputSchema: z.object({
        limit: z.number().min(1).max(50).optional().describe("Max rows; default 10."),
      }),
      execute: async ({ limit }: { limit?: number }) =>
        convex.query(api.reservations.listPendingWithoutDecision, { limit: limit ?? 10 }),
    }),
    query_funnel: tool({
      description:
        "Reservation conversion funnel for the last N days. Returns bookings / declines / cancellations.",
      inputSchema: z.object({
        days: z.number().min(1).max(180).optional().describe("Lookback days; default 30."),
      }),
      execute: async ({ days }: { days?: number }) => {
        const d = days ?? 30;
        return cached(`funnel:${d}`, () =>
          convex.query(api.reservations.getConversionFunnel, {
            accountSlug: null,
            days: d,
          }),
        );
      },
    }),
    query_calendar: tool({
      description: "Weekly calendar — items booked / partial / free over the next 7 days.",
      inputSchema: z.object({}),
      execute: async () => {
        const weekStartDate = new Date().toISOString().slice(0, 10);
        return cached(`calendar:${weekStartDate}`, () =>
          convex.query(api.calendar.getWeeklyCalendar, {
            accountSlug: null,
            weekStartDate,
          }),
        );
      },
    }),
    query_due_returns: tool({
      description: "Items overdue or due-soon for return.",
      inputSchema: z.object({}),
      execute: async () => convex.query(api.reservations.getDueReturns, { accountSlug: null }),
    }),
    query_recent_activity: tool({
      description: "Newest rental events (status changes, new bookings, etc).",
      inputSchema: z.object({
        limit: z.number().min(1).max(50).optional(),
      }),
      execute: async ({ limit }: { limit?: number }) =>
        convex.query(api.reservations.getRecentActivity, {
          accountSlug: null,
          limit: limit ?? 15,
        }),
    }),
    query_top_earners: tool({
      description: "Top items by ROI ranking.",
      inputSchema: z.object({
        limit: z.number().min(1).max(30).optional(),
      }),
      execute: async ({ limit }: { limit?: number }) => {
        const l = limit ?? 10;
        return cached(`roi:${l}`, () =>
          convex.query(api.intel.getItemROIRanking, { limit: l }),
        );
      },
    }),
    query_smart_buys: tool({
      description: "Items the Smart-Buy model thinks Daniel should acquire next.",
      inputSchema: z.object({
        limit: z.number().min(1).max(30).optional(),
      }),
      execute: async ({ limit }: { limit?: number }) => {
        const l = limit ?? 10;
        return cached(`smart_buys:${l}`, () =>
          convex.query(api.intel.getSmartBuyRanking, { limit: l }),
        );
      },
    }),
  };
}

export async function POST(req: Request) {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const { message } = body ?? {};
  const thread_id = body?.thread_id ?? "dashboard";
  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ ok: false, error: "no_message" }, { status: 400 });
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const convexClient = convexUrl ? new ConvexHttpClient(convexUrl) : null;

  // Light per-thread rate limit (reuses the WallE bucket — sessionId stand-in).
  if (convexClient) {
    try {
      const status = await convexClient.mutation(
        api.walle_ratelimits.checkWalleLimit,
        { bucket: "walle_chat", key: `dashboard:${thread_id}` },
      );
      if (!status.ok) {
        return new Response(
          `data: ${JSON.stringify({ error: `Rate limit reached. Retry in ${status.retryAfter}s.` })}\n\ndata: [DONE]\n\n`,
          {
            status: 429,
            headers: {
              "content-type": "text/event-stream",
              "Retry-After": String(status.retryAfter ?? 60),
              "cache-control": "no-cache",
            },
          },
        );
      }
    } catch {
      // limiter unavailable — fail-open
    }
  }

  // Pull last ~10 turns for context.
  let history: ModelMessage[] = [];
  if (convexClient) {
    try {
      const prior = await convexClient.query(api.dashboard_chat.getMessages, {
        thread_id,
        limit: 10,
      });
      history = (prior ?? [])
        .filter(
          (m: { role: string; content: string }) =>
            m.role === "user" || m.role === "assistant",
        )
        .map(
          (m: { role: string; content: string }) =>
            ({ role: m.role as "user" | "assistant", content: m.content }) as ModelMessage,
        );
    } catch {
      // best-effort
    }
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "missing_openrouter_key" },
      { status: 500 },
    );
  }
  const openrouter = createOpenRouter({ apiKey });
  const modelId = process.env.DEEPSEEK_MODEL ?? "deepseek/deepseek-chat";
  const model = openrouter(modelId);
  const tools = convexClient ? buildTools(convexClient) : undefined;

  const modelMessages: ModelMessage[] = [
    ...history,
    { role: "user", content: message },
  ];

  // Stream + collect final assistant text for persistence.
  let finalText = "";
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const result = streamText({
          model,
          system: SYSTEM_PROMPT,
          messages: modelMessages,
          tools,
          maxOutputTokens: 1500,
          stopWhen: stepCountIs(4),
          onFinish: async ({ text }) => {
            finalText = text;
            try {
              if (convexClient) {
                await convexClient.mutation(api.dashboard_chat.appendTurn, {
                  thread_id,
                  session_id: thread_id,
                  user_content: message,
                  assistant_content: finalText,
                });
              }
            } catch {
              // best-effort persistence
            }
          },
        });
        for await (const delta of result.textStream) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ text: delta })}\n\n`),
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    info: "POST { message, thread_id? } to stream a dashboard-chat reply.",
  });
}
