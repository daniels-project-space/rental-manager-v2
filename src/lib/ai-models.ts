/**
 * Wave 4.7 — central source of truth for Grok model IDs.
 *
 * All agents / API routes / Trigger tasks should import from here, NEVER
 * hard-code a model string inline. The monthly auto-upgrade scanner
 * (`src/trigger/model-auto-upgrade.ts`) rewrites the defaults below when
 * xAI ships a newer minor version.
 *
 * Env-var overrides let ops bump a single deployment without a code change.
 *
 * Aligned with Wave 4.6 Python runner (`python/browser_use_action.py`) which
 * uses `XAI_VISION_MODEL` (default `grok-4.3`) for vision-driven UI actions.
 */

/** Chat / decision agents (dashboard-chat, ai-decision, etc). */
export const GROK_CHAT_MODEL: string =
  process.env.GROK_CHAT_MODEL ?? "grok-4.3";

/** Vision / browser-use UI automation (Wave 4.6). */
export const GROK_VISION_MODEL: string =
  process.env.GROK_VISION_MODEL ?? process.env.XAI_VISION_MODEL ?? "grok-4.3";

/**
 * Default chat model literal — exported so the auto-upgrade scanner can rewrite
 * THIS LINE only when bumping minor versions. Keep the assignment shape stable:
 *   export const DEFAULT_GROK_CHAT_MODEL = "grok-X.Y";
 */
export const DEFAULT_GROK_CHAT_MODEL = "grok-4.3";
