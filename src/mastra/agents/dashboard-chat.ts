import "server-only";

import { Agent } from "@mastra/core/agent";
import { createXai } from "@ai-sdk/xai";
import { routerTools } from "../tools/router-tools";
import { GROK_CHAT_MODEL } from "../../lib/ai-models";
import { getDashboardMemory } from "../memory/dashboard-memory";

const xai = createXai({ apiKey: process.env.XAI_API_KEY ?? "" });

/**
 * Cheap-tier model id for the simple-read router branch. Defaults to
 * grok-4-fast (~10× cheaper than grok-4.3). Override via env without a
 * code change. The "full" tier reuses GROK_CHAT_MODEL.
 */
export const GROK_FAST_MODEL: string =
  process.env.GROK_FAST_MODEL ?? "grok-4-fast";

// ── Prompt-caching per-thread xAI clients ─────────────────────────
// xAI's prompt caching (auto prefix matching, 75-90% off cached input
// tokens) opts in via the `x-grok-conv-id` header set to a stable per-
// thread ID. We instantiate one xAI client + one Agent per thread_id
// and cache them in bounded module-level Maps so consecutive turns on
// the same thread share the cache. Bounded LRU-ish eviction (insertion
// order) keeps memory flat in long-running workers.
//
// Phase 3b W3: each thread gets TWO agents — `full` (grok-4.3) and
// `fast` (grok-4-fast). They share the underlying xAI client (same
// x-grok-conv-id header) so prompt caching still hits across both
// tiers. Route selection happens in the chat POST handler.
const PER_THREAD_CLIENT_CAP = 256;
type ThreadAgentBundle = { full: Agent; fast: Agent };
const _threadClients = new Map<string, ReturnType<typeof createXai>>();
const _threadAgents = new Map<string, ThreadAgentBundle>();

/**
 * Returns a per-thread Mastra Agent wired to an xAI client with
 * `x-grok-conv-id: <convId>` set. Cached, so repeat turns on the same
 * thread reuse the same underlying client and benefit from xAI's
 * automatic prompt prefix caching.
 *
 * The returned Agent shares the static instructions/tools of
 * `dashboardChatAgent`; only the bound xAI client (and thus the conv-id
 * header) differs.
 */
export function getDashboardChatAgent(convId: string): Agent {
  return getDashboardChatAgentBundle(convId).full;
}

/**
 * Returns the {full, fast} bundle for a given thread. The simple-read
 * router uses .fast (grok-4-fast); everything else (mutation, complex,
 * unknown) uses .full (grok-4.3). Both wrap the SAME per-thread xAI
 * client, so x-grok-conv-id prompt caching is preserved across tiers.
 */
export function getDashboardChatAgentBundle(convId: string): ThreadAgentBundle {
  const cached = _threadAgents.get(convId);
  if (cached) {
    // Refresh LRU position
    _threadAgents.delete(convId);
    _threadAgents.set(convId, cached);
    return cached;
  }
  if (_threadAgents.size >= PER_THREAD_CLIENT_CAP) {
    const oldest = _threadAgents.keys().next().value;
    if (oldest !== undefined) {
      _threadAgents.delete(oldest);
      _threadClients.delete(oldest);
    }
  }
  // H3: only set x-grok-conv-id when convId is non-empty. An empty
  // thread_id would cache under "" — a global collision key that merges
  // all users' prompt caches into one slot. Skip the header instead so
  // caching is simply disabled for that call rather than poisoned.
  const xGrokHeaders: Record<string, string> = convId
    ? { "x-grok-conv-id": convId }
    : {};
  const client = createXai({
    apiKey: process.env.XAI_API_KEY ?? "",
    headers: xGrokHeaders,
  });
  _threadClients.set(convId, client);
  // Mastra Memory: shared singleton across all per-thread agents.
  // Memory keys retrieval by `thread`+`resource` passed at stream-time,
  // so a single instance multiplexes safely. Replaces manual
  // getMessages(limit:6) in the chat route (W2a, phase3c).
  const memory = getDashboardMemory();
  const full = new Agent({
    id: "dashboard-chat",
    name: "dashboard-chat",
    instructions: SYSTEM_PROMPT_BASE,
    model: [{ model: client(GROK_CHAT_MODEL), maxRetries: 1, modelSettings: { maxOutputTokens: 1800 } }],
    tools: routerTools,
    memory,
  });
  const fast = new Agent({
    id: "dashboard-chat-fast",
    name: "dashboard-chat-fast",
    instructions: SYSTEM_PROMPT_BASE,
    model: [{ model: client(GROK_FAST_MODEL), maxRetries: 1, modelSettings: { maxOutputTokens: 1800 } }],
    tools: routerTools,
    memory,
  });
  const bundle: ThreadAgentBundle = { full, fast };
  _threadAgents.set(convId, bundle);
  return bundle;
}

/**
 * Static system prompt base. Exported so the API route can compose it
 * with a dynamic freshness header before each turn.
 *
 * Wave 2 (phase1-tool-router-hydration): the legacy ~2000-token INTENT
 * ROUTING and ORDER STEP SEMANTICS sections were dropped. Routing now
 * lives in the router-tools surface; order-step semantics live in each
 * tool's description envelope. The hydration layer makes per-tool
 * freshness/coverage available, so the previous block-level caveats are
 * no longer needed at the prompt level.
 */
export const SYSTEM_PROMPT_BASE = `You are the Dashboard AI Assistant for a camera rental business on Hygglo.
You chat with the operator (Leo or Daniel) through the web dashboard.
You have FULL access to business data via tools plus a small live freshness header in the system prompt.

--- TOOL USAGE PROTOCOL ---
(1) Use the \`include\` field on query_* tools to fetch related data in one call — never split a question into multiple tool calls when one will do.
(2) Within this turn, tool results are cached. If you already have an answer, do NOT re-call the same tool with the same args.
(3) \`_source.fetchedAt\` and \`staleMinutes\` in the envelope tell you freshness. Treat staleMinutes < 5 as fresh; > 30 as caveat-worthy in your answer.
(4) Heavy analysis (vision, item resolution, denial canonicalisation, booking-time extraction) runs in Trigger background jobs; you READ precomputed results — never wait for them.
(5) For mutations, use the \`mutate\` tool with the appropriate \`op\` enum value.

--- CAVEAT PREFIXING ---
Tool envelopes carry \`caveats\`, \`staleMinutes\`, \`coverageRatio\`. If caveats non-empty OR staleMinutes > 10 OR coverageRatio < 1: prepend ONE short note (≤1 sentence, pick the most material). Otherwise answer normally. If an order has order_step in {REQUEST, APPROVED} and the user framed it as "confirmed/upcoming", clarify: "This isn't a confirmed booking yet — <reason>."

--- IMPORTANT RULES ---
- Be concise; bullet points for lists.
- Leo is less experienced with cameras — explain compatibility clearly when relevant.
- Look things up via tools rather than guessing.
- Sending messages to renters is blocked (READ_ONLY_MODE). Do not attempt send operations.
- For update_rule / update_memory / set_item_acquisition_cost: preview the change and ask confirmation before executing.
- When listing pending decisions, show each decision's shortId (last 6 chars) so the user can say "approve <shortId>".
- Alerts (double-bookings, untracked claims, pending shadow actions, daily briefing, model-upgrade advisories) are NO LONGER pre-injected into the prompt. Call \`query_alerts\` whenever the user asks about pending items, shadow actions, briefings, conflicts, or advisories.`;

export const dashboardChatAgent = new Agent({
  id: "dashboard-chat",
  name: "dashboard-chat",
  instructions: SYSTEM_PROMPT_BASE,
  model: [{ model: xai(GROK_CHAT_MODEL), maxRetries: 1, modelSettings: { maxOutputTokens: 1800 } }],
  tools: routerTools,
  memory: getDashboardMemory(),
});
