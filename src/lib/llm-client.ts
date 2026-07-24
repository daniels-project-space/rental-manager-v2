/**
 * LLM provider abstraction — single source of truth for all scheduled
 * Trigger.dev tasks + Convex actions that hit a language model.
 *
 * Default: OpenRouter → DeepSeek-v4-flash (~11x cheaper input than
 *          x-ai/grok-4.3 — $0.112/$0.224 per 1M tok vs $1.25/$2.50).
 *          Strong on JSON / structured outputs, 1M context.
 *
 * All rental-manager background work uses the OpenRouter key from the
 * project-hub Convex vault. This prevents a per-deployment override from
 * sending one account or widget down a different provider/billing lane.
 *
 * Keys: read from the project-hub Convex vault
 *       (see C:\Users\danie\.claude\projects\C--Users-danie\memory\reference_secrets_vault.md
 *       for the curl pattern). Lazy-singleton cached per process.
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { CALENDAR_EXTRACTION_MODEL, DEEPSEEK_MODEL } from "./ai-models";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";

async function getVaultSecret(service: string, keyName: string): Promise<string> {
  const vaultToken = process.env.VAULT_ACCESS_TOKEN;
  if (!vaultToken) throw new Error("VAULT_ACCESS_TOKEN is not configured");
  const res = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service, vaultToken },
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
let _vaultOpenrouter: ReturnType<typeof createOpenRouter> | null = null;

async function getOpenRouter(): Promise<ReturnType<typeof createOpenRouter>> {
  if (_vaultOpenrouter) return _vaultOpenrouter;
  _vaultOpenrouter = createOpenRouter({
    apiKey: await getVaultSecret("openrouter", "OPENROUTER_API_KEY"),
  });
  return _vaultOpenrouter;
}

/** Pin OpenRouter to providers that don't aggressively fp8/fp4 quantize.
 *  Observed regression: SiliconFlow's fp8 routing emitted malformed JSON
 *  with stray tab whitespace on batch outputs (canonicalize-denials).
 *  Alibaba + DeepSeek own infra are stable. */
const PROVIDER_PIN = { only: ["deepseek", "alibaba"] } as const;

/**
 * Returns a ready-to-use AI SDK model handle. Pass directly to
 * `generateText({ model: ... })` or `generateObject({ model: ... })`.
 */
export async function getLlmModel() {
  const openrouter = await getOpenRouter();
  return openrouter(DEEPSEEK_MODEL, {
    extraBody: { provider: PROVIDER_PIN },
  });
}

/**
 * Booking-time extraction is the sole calendar-adjacent LLM task. It uses the
 * OpenRouter vault credential and Grok 4 Fast with reasoning disabled; all
 * ordinary calendar reads, holds, refreshes, and syncs are deterministic code.
 */
export async function getExtractorModel() {
  const openrouter = await getOpenRouter();
  return openrouter(CALENDAR_EXTRACTION_MODEL, {
    // The output is nine short, schema-like lines. Extra reasoning adds cost
    // and latency without improving the calendar write.
    extraBody: { reasoning: { enabled: false } },
  });
}

/** On-demand renter drafts always use OpenRouter's Haiku lane and the vault
 * credential. This deliberately ignores AI_PROVIDER so a legacy xAI setting
 * cannot route Quick Reply away from the low-cost shared account. */
export async function getRenterBotModel() {
  const openrouter = await getOpenRouter();
  return openrouter("anthropic/claude-haiku-4.5");
}

/** Vault-backed model accessor for server-only dashboard widget routes. */
export async function getVaultOpenRouterModel(modelId: string) {
  return (await getOpenRouter())(modelId);
}

/**
 * Returns the DeepSeek model id used by scheduled/background tasks.
 */
export function getLlmModelId(): string {
  return DEEPSEEK_MODEL;
}
