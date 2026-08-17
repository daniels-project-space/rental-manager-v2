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
 * 2026-08-16: primary lane moved to Gemini 3.7 Flash on cost — $0.375 / $1.875
 * per 1M tok (in/out) vs Haiku 4.5's $1 / $5 and Sonnet 4.6's $3 / $15, i.e.
 * ~62% and ~87% cheaper.
 * 2026-08-17 (Daniel): removed the Haiku fallback for this plain lane — no
 * Haiku calls anywhere. A primary failure now surfaces as a real, visible
 * error (see /api/walle/chat, /api/walle/health) instead of a silent switch
 * to Claude. The smart lane's Sonnet fallback (CHAT_MODEL_SMART_FALLBACK)
 * is untouched — that decision was scoped to Haiku specifically.
 */
export const CHAT_MODEL: string =
  process.env.CHAT_MODEL ?? "google/gemini-3.7-flash";

/**
 * Smarter chat model for REASONING-HEAVY chat turns — gear compatibility /
 * optics questions where Haiku confabulated (e.g. inverting the APS-C vs
 * full-frame vignetting fact, 2026-06-02). The chat routes pick this over
 * CHAT_MODEL when a compatibility/optics intent is detected; plain existence
 * and metric turns stay on the cheap lane. Now the same Gemini 3.7 Flash: it
 * already undercuts the OLD cheap lane (Haiku) on price, so there is no saving
 * left to win by splitting, and one model means one grounding behaviour to
 * reason about. Env-overridable per deployment if the two need to diverge.
 */
export const CHAT_MODEL_SMART: string =
  process.env.CHAT_MODEL_SMART ?? "google/gemini-3.7-flash";

/**
 * Fallback for the reasoning-heavy (compat/availability/inventory) lane only,
 * used when CHAT_MODEL_SMART yields an error or an empty reply. This is the
 * pre-2026-08-16 smart-lane primary (Claude Sonnet 4.6), kept because it is
 * the proven grounded tool-caller for these routes, and because Daniel's
 * 2026-08-17 "no Haiku" decision was scoped to Haiku specifically — Sonnet
 * isn't Haiku.
 *
 * The plain lane's old Haiku fallback (CHAT_MODEL_FALLBACK) was removed the
 * same day: no Haiku calls anywhere, even as a dormant safety net. See
 * /api/walle/chat for why a fallback existed at all (2026-08-16 OpenRouter
 * outage caused every WallE surface to go silently blank).
 */
export const CHAT_MODEL_SMART_FALLBACK: string =
  process.env.CHAT_MODEL_SMART_FALLBACK ?? "anthropic/claude-sonnet-4.6";

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
