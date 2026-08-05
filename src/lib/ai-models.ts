/**
 * Central source of truth for LLM model IDs.
 *
 * Active provider is selected via the AI_PROVIDER env var (default
 * "openrouter"; set to "xai" for the legacy direct-Grok rollback path).
 * Every scheduled call site uses `getLlmModel()` from `./llm-client`,
 * which reads AI_PROVIDER and picks the matching id below.
 *
 * Cost reference (per 1M tok, in / out, as of 2026-05-18):
 *   deepseek-v4-flash       $0.112 / $0.224   ← default
 *   grok-4.3 (xAI direct)   $1.25  / $2.50    ← fallback
 *
 * Env-var overrides let ops bump a single deployment without a code change.
 *
 * The monthly auto-upgrade scanner (`src/trigger/model-auto-upgrade.ts`)
 * rewrites the Grok defaults when xAI ships a newer minor version.
 * Keep the `DEFAULT_GROK_CHAT_MODEL` literal shape stable for that script.
 */

/** OpenRouter id for the active default model (DeepSeek-v4-flash). */
export const DEEPSEEK_MODEL: string =
  process.env.DEEPSEEK_MODEL ?? "deepseek/deepseek-v4-flash";

/**
 * Chat-time extraction feeds the rental calendar, so it is deliberately
 * separate from the general background model. Grok 4.3 follows conversational
 * time changes more reliably than the DeepSeek lane. It is always called
 * through OpenRouter and is capped to a short structured response.
 */
export const CALENDAR_EXTRACTION_MODEL: string =
  process.env.CALENDAR_EXTRACTION_MODEL ?? "x-ai/grok-4.3";

/**
 * Model for the accuracy-critical CONVERSATIONAL surfaces — the AI-assistant
 * widget (`/api/chat`) and the WallE chat bot (`/api/walle/chat`). These call
 * read-only Convex tools and must ground every number; DeepSeek-chat under
 * toolChoice:auto intermittently skipped the tools and confabulated (FX3
 * earnings/utilization, 2026-06-01), so these run on Claude Haiku — a far more
 * reliable tool-caller — while the cheap single-shot text gens (joke / narrate
 * / compact) stay on DEEPSEEK_MODEL. A distinct env var (NOT DEEPSEEK_MODEL,
 * which is already pinned on Vercel) so this default actually applies in prod.
 * Haiku 4.5 on OpenRouter ≈ $1 / $5 per 1M tok (in/out); volume is Daniel-only.
 */
export const CHAT_MODEL: string =
  process.env.CHAT_MODEL ?? "anthropic/claude-haiku-4.5";

/**
 * Smarter chat model for REASONING-HEAVY chat turns — gear compatibility /
 * optics questions where Haiku confabulated (e.g. inverting the APS-C vs
 * full-frame vignetting fact, 2026-06-02). The chat routes pick this over
 * CHAT_MODEL when a compatibility/optics intent is detected; plain existence
 * and metric turns stay on cheap Haiku. Sonnet 4.6 on OpenRouter; volume is
 * Daniel-only so the cost delta is negligible. Env-overridable per deployment.
 */
export const CHAT_MODEL_SMART: string =
  process.env.CHAT_MODEL_SMART ?? "anthropic/claude-sonnet-4.6";

/** xAI direct Grok chat model — used when AI_PROVIDER=xai. */
export const GROK_CHAT_MODEL: string =
  process.env.GROK_CHAT_MODEL ?? "grok-4.3";

/**
 * Narrow-output Grok variant for structured / classification tasks. Kept
 * for parity with the chat tier; xAI no longer ships a cheaper "fast"
 * SKU (retired 2026-05-15 — requests redirect to grok-4.3 at chat pricing).
 */
export const GROK_NARROW_MODEL: string =
  process.env.GROK_NARROW_MODEL ?? GROK_CHAT_MODEL;

/** Vision / browser-use UI automation (still on xAI; DeepSeek-flash is text-only). */
export const GROK_VISION_MODEL: string =
  process.env.GROK_VISION_MODEL ?? process.env.XAI_VISION_MODEL ?? "grok-4.3";

/**
 * Default chat model literal — exported so the auto-upgrade scanner can rewrite
 * THIS LINE only when bumping minor versions. Keep the assignment shape stable:
 *   export const DEFAULT_GROK_CHAT_MODEL = "grok-X.Y";
 */
export const DEFAULT_GROK_CHAT_MODEL = "grok-4.3";
