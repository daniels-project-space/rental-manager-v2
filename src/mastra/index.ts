// Mastra root — server-only. Agents registered here; workflows added in later phases.
//
// Conventions (per Decisions Matrix):
//   - default model: Grok 4.1 Fast via @ai-sdk/xai
//   - escalation model: Claude Sonnet 4.6 via @ai-sdk/anthropic
//   - logger: PinoLogger from @mastra/loggers (level driven by NODE_ENV)
//
// SAFETY: Never imported into client bundles.

import "server-only";

import { Mastra } from "@mastra/core";
import { PinoLogger } from "@mastra/loggers";
import { dashboardChatAgent } from "./agents/dashboard-chat";
import { aiDecisionAgent } from "./agents/ai-decision";
import { hyggloPollWorkflow } from "./workflows/hygglo_poll";

export const mastra = new Mastra({
  agents: { dashboardChatAgent, aiDecisionAgent },
  workflows: { hyggloPollWorkflow },
  logger: new PinoLogger({
    name: "rental-manager-v2",
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
  }),
});
