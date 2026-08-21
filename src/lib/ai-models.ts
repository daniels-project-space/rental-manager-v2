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
 * earnings/utilization, 2026-06-01), so these need a reliable tool-caller,
 * while the cheap single-shot text gens (joke / narrate / compact) stay on
 * DEEPSEEK_MODEL. A distinct env var (NOT DEEPSEEK_MODEL, which is already
 * pinned on Vercel) so this default actually applies in prod.
 *
 * 2026-08-16: moved to Gemini 3.7 Flash on cost — $0.375 / $1.875 per 1M tok
 * (in/out), roughly 62% cheaper than the Claude Haiku 4.5 lane it replaced and
 * ~87% cheaper than Sonnet 4.6.
 * 2026-08-21 (Daniel): Gemini everywhere. No Anthropic model is referenced in
 * this codebase on any lane, primary or fallback.
 */
export const CHAT_MODEL: string =
  process.env.CHAT_MODEL ?? "google/gemini-3.7-flash";

/**
 * Smarter chat model for REASONING-HEAVY chat turns — gear compatibility /
 * optics questions that a weaker model answered from memory (e.g. inverting
 * the APS-C vs full-frame vignetting fact, 2026-06-02). The chat routes pick
 * this over CHAT_MODEL when a compatibility/optics intent is detected; plain
 * existence and metric turns stay on the cheap lane.
 *
 * Currently the SAME Gemini 3.7 Flash as CHAT_MODEL: it already undercuts the
 * old cheap lane on price, so there is no saving left to win by splitting, and
 * one model means one grounding behaviour to reason about. The seam is kept
 * (and env-overridable) so the two can diverge again without touching routes.
 */
export const CHAT_MODEL_SMART: string =
  process.env.CHAT_MODEL_SMART ?? "google/gemini-3.7-flash";

/*
 * NO ANTHROPIC FALLBACK — removed entirely 2026-08-21 (Daniel).
 *
 * History: the plain lane's Haiku fallback went on 2026-08-17, scoped to Haiku
 * specifically, leaving the smart lane a Claude Sonnet 4.6 safety net
 * (CHAT_MODEL_SMART_FALLBACK). That is now gone too — there is no Anthropic
 * model referenced anywhere in this codebase, not even as a dormant net.
 *
 * Consequence, deliberately accepted: if the Gemini lane errors or returns
 * empty, that surfaces as a real, visible error (see /api/walle/chat's
 * deltas===0 branch and /api/walle/health) instead of being silently masked by
 * a switch to another provider. The 2026-08-16 OpenRouter outage — which made
 * every WallE surface go blank — is the scenario a fallback covered; it is now
 * covered by failing loudly rather than by paying for a second provider.
 *
 * Do not reintroduce a cross-provider fallback here without saying so.
 */

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
