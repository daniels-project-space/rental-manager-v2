/**
 * WallE chat — first-class Mastra Agent.
 *
 * The streaming chat surface (`/api/walle/chat`) runs through this agent
 * instead of a bare `streamText` call, making WallE a real Mastra agent like
 * `renter_bot` (consistent tool handling, observability, future memory/evals).
 *
 * Per-request construction: the instructions (persona + grounding + live
 * snapshot + master-inventory index) and the model (Haiku for normal turns,
 * Sonnet for compatibility/optics turns) are request-specific, so the agent is
 * built per call. Volume is Daniel-only, so the allocation cost is negligible.
 *
 * Tools are the SHARED AI SDK dashboard tools (`buildDashboardTools`). Mastra
 * accepts Vercel/AI-SDK tools directly (`ToolsInput` includes `VercelTool`), so
 * there is ONE tool registry across both chat surfaces — no duplication, no
 * drift. READ-ONLY, same contract as the rest of the dashboard chat.
 *
 * NOTE on streaming: Mastra 1.35's stream output is AI-SDK-v5-internal and has
 * no `toUIMessageStreamResponse`, so the route bridges `result.textStream` into
 * an AI SDK v6 UI-message stream (the widget runs `useChat` from `ai` v6).
 */
import "server-only";

import { Agent } from "@mastra/core/agent";
import type { Tool } from "ai";

export function buildWalleChatAgent(params: {
  instructions: string;
  /** AI SDK v6 LanguageModel (e.g. openrouter(modelId)). */
  model: unknown;
  /** Shared AI SDK dashboard tools. */
  tools?: Record<string, Tool>;
}): Agent {
  return new Agent({
    id: "walle-chat",
    name: "WallE",
    instructions: params.instructions,
    // Mastra accepts AI SDK v6 models + Vercel tools; the casts bridge the two
    // libraries' nominal types (same pattern as src/mastra/agents/renter_bot.ts).
    model: params.model as never,
    tools: params.tools as never,
  });
}
