// Mastra root — bare scaffold. Agents and workflows are added in Phase 2+.
//
// Conventions (per Decisions Matrix):
//   - default model: Grok 4.1 Fast via @ai-sdk/xai
//   - escalation model: Claude Sonnet 4.6 via @ai-sdk/anthropic
//   - logger: PinoLogger from @mastra/loggers (level driven by NODE_ENV)
//
// SAFETY: Server-only. Never imported into client bundles.

import "server-only";

import { Mastra } from "@mastra/core";
import { PinoLogger } from "@mastra/loggers";

export const mastra = new Mastra({
  agents: {},
  workflows: {},
  logger: new PinoLogger({
    name: "rental-manager-v2",
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
  }),
});
