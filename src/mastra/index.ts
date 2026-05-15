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

// Wave 2 — router-tools rollout (env-flag gated). Importing both surfaces
// here keeps them discoverable to the Mastra runtime regardless of which
// set the agent currently binds. The agent picks the active set via
// `MASTRA_ROUTER_TOOLS` (see agents/dashboard-chat.ts).
//
// Tree-shake guard: referencing both modules prevents bundlers from
// dropping the unused branch when the flag is toggled at deploy time.
import { dashboardTools } from "./tools/dashboard-tools";
import { routerTools } from "./tools/router-tools";
void dashboardTools;
void routerTools;

export const mastra = new Mastra({
  agents: { dashboardChatAgent, aiDecisionAgent },
  workflows: { hyggloPollWorkflow },
  logger: new PinoLogger({
    name: "rental-manager-v2",
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
  }),
});
