/**
 * LLM provider abstraction — single source of truth for all scheduled
 * Trigger.dev tasks + Convex actions that hit a language model.
 *
 * Default: OpenRouter → DeepSeek-v4-flash (~11x cheaper input than
 *          x-ai/grok-4.3 — $0.112/$0.224 per 1M tok vs $1.25/$2.50).
 *          Strong on JSON / structured outputs, 1M context.
 *
 * Rollback: set AI_PROVIDER=xai in the Vercel env (or per-task env in
 *           Trigger.dev). No code change required — every call site
 *           uses getLlmModel() which routes by env.
 *
 * Keys: read from process.env first, then the project-hub Convex vault
 *       (see C:\Users\danie\.claude\projects\C--Users-danie\memory\reference_secrets_vault.md
 *       for the curl pattern). Lazy-singleton cached per process.
 */
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { DEEPSEEK_MODEL, GROK_CHAT_MODEL } from "./ai-models";

type Provider = "xai" | "openrouter";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";

function provider(): Provider {
  const raw = (process.env.AI_PROVIDER ?? "openrouter").toLowerCase();
  return raw === "xai" ? "xai" : "openrouter";
}

async function getVaultSecret(service: string, keyName: string): Promise<string> {
  const res = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service },
      format: "json",
    }),
  });
  if (!res.ok) throw new Error(`Vault fetch failed: ${res.status}`);
  const data = (await res.json()) as {
    value?: Array<{ keyName: string; value: string }>;
  };
  for (const s of data.value ?? []) if (s.keyName === keyName) return s.value;
  throw new Error(`${keyName} not found in vault service=${service}`);
}

// Lazy singletons per provider — built on first call.
let _openrouter: ReturnType<typeof createOpenRouter> | null = null;
let _xai: ReturnType<typeof createXai> | null = null;

async function getOpenRouter(): Promise<ReturnType<typeof createOpenRouter>> {
  if (_openrouter) return _openrouter;
  const apiKey =
    process.env.OPENROUTER_API_KEY ??
    (await getVaultSecret("openrouter", "OPENROUTER_API_KEY"));
  _openrouter = createOpenRouter({ apiKey });
  return _openrouter;
}

/** Pin OpenRouter to providers that don't aggressively fp8/fp4 quantize.
 *  Observed regression: SiliconFlow's fp8 routing emitted malformed JSON
 *  with stray tab whitespace on batch outputs (canonicalize-denials).
 *  Alibaba + DeepSeek own infra are stable. */
const PROVIDER_PIN = { only: ["deepseek", "alibaba"] } as const;

async function getXai(): Promise<ReturnType<typeof createXai>> {
  if (_xai) return _xai;
  const apiKey =
    process.env.XAI_API_KEY ?? (await getVaultSecret("xai", "XAI_API_KEY"));
  _xai = createXai({ apiKey });
  return _xai;
}

/**
 * Returns a ready-to-use AI SDK model handle. Pass directly to
 * `generateText({ model: ... })` or `generateObject({ model: ... })`.
 *
 * Picks provider + model id from AI_PROVIDER env var.
 */
export async function getLlmModel() {
  if (provider() === "xai") {
    const xai = await getXai();
    return xai(GROK_CHAT_MODEL);
  }
  const openrouter = await getOpenRouter();
  return openrouter(DEEPSEEK_MODEL, {
    extraBody: { provider: PROVIDER_PIN },
  });
}

/** Haiku 4.5 (Anthropic — its own provider, so the deepseek provider pin does
 *  NOT apply) for the agentic renter bot, matching the live convex draft path.
 *  The old getLlmModel() deepseek pin currently returns "no allowed providers". */
export async function getRenterBotModel() {
  if (provider() === "xai") {
    const xai = await getXai();
    return xai(GROK_CHAT_MODEL);
  }
  const openrouter = await getOpenRouter();
  return openrouter(process.env.HAIKU_MODEL ?? "anthropic/claude-haiku-4.5");
}

/**
 * Stronger renter-bot model (Sonnet). Used for the hard cases where Haiku is
 * unreliable at following nuanced rules (e.g. steering off a marketing-only
 * item without revealing why). Falls back to Grok when AI_PROVIDER=xai.
 */
export async function getRenterBotModelStrong() {
  if (provider() === "xai") {
    const xai = await getXai();
    return xai(GROK_CHAT_MODEL);
  }
  const openrouter = await getOpenRouter();
  return openrouter(process.env.STRONG_MODEL ?? "anthropic/claude-sonnet-4.6");
}

/**
 * Returns the resolved model id string (e.g. "deepseek/deepseek-v4-flash"
 * or "grok-4.3"). Useful for logging + the `modelId` audit field on
 * persisted decisions.
 */
export function getLlmModelId(): string {
  return provider() === "xai" ? GROK_CHAT_MODEL : DEEPSEEK_MODEL;
}
