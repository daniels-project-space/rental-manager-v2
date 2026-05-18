// Mastra root — server-only. Agents registered here; workflows added in later phases.
//
// Conventions (per Decisions Matrix):
//   - background LLM provider: OpenRouter → DeepSeek-v4-flash via getLlmClient()
//     in src/lib/ai-models.ts (flip back to xAI/Grok with AI_PROVIDER=xai).
//   - logger: PinoLogger from @mastra/loggers (level driven by NODE_ENV)
//   - tracing: Langfuse OTel sink via src/lib/langfuse.ts (no-op when env missing)
//
// SAFETY: Never imported into client bundles.

import "server-only";

import { Mastra } from "@mastra/core";
import { PinoLogger } from "@mastra/loggers";
import { hyggloPollWorkflow } from "./workflows/hygglo_poll";

// Wire Langfuse as OTel sink.
// getLangfuse() is a lazy singleton — returns a no-op shim when
// LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are absent (safe in all envs).
import { getLangfuse, traceMastraSpan } from "@/lib/langfuse";
export { getLangfuse, traceMastraSpan };

export const mastra = new Mastra({
  workflows: { hyggloPollWorkflow },
  logger: new PinoLogger({
    name: "rental-manager-v2",
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
  }),
});
