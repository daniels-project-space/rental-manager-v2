import { createHash } from "node:crypto";
import { MAIN_RENTAL_CONVEX_URL } from "@/lib/convex-url";
import { RENTER_BOT_MODEL_ID } from "@/lib/llm-client";
import { renterBotLabBackendSourceRevision, renterBotLabSourceFingerprint, renterBotLabSourceRevision } from "@/lib/renter-bot-lab-source";
import { RENTER_BOT_LAB_API_CONTRACT_VERSION } from "../../convex/lib/renter_bot_lab_contract";

export type LabStatusEnvironment = Record<string, string | undefined>;
type LabGenerationProbeResponse = { status?: string; value?: {
  ready?: boolean;
  chat_action_registered?: boolean;
  api_contract_version?: string;
  backend_source_revision?: string;
  draft_api_contract_version?: string;
  draft_api_source_revision?: string;
  catalog_ready?: boolean;
  catalog_status?: string;
  catalog_fetched_at?: number | null;
  catalog_inventory_count?: number;
  catalog_listing_count?: number;
  catalog_eligible_listing_count?: number;
  catalog_blocked_listing_count?: number;
} };
export type LabGenerationStatus = {
  generation_ready: boolean;
  chat_action_registered: boolean;
  backend_contract_version: string | null;
  expected_backend_contract_version: string;
  backend_contract_matches: boolean;
  backend_source_revision: string | null;
  expected_backend_source_revision: string;
  backend_source_matches: boolean;
  draft_api_contract_version: string | null;
  draft_api_contract_matches: boolean;
  draft_api_source_revision: string | null;
  expected_source_revision: string;
  draft_api_source_matches: boolean;
  catalog_ready: boolean;
  catalog_status: string;
  catalog_fetched_at: number | null;
  catalog_inventory_count: number;
  catalog_listing_count: number;
  catalog_eligible_listing_count: number;
  catalog_blocked_listing_count: number;
};

export function labGenerationStatusFromProbe(
  response: LabGenerationProbeResponse,
  env: LabStatusEnvironment = process.env,
): LabGenerationStatus {
  const value = response.value;
  const backendContractVersion = typeof value?.api_contract_version === "string"
    ? value.api_contract_version
    : null;
  const backendContractMatches = backendContractVersion === RENTER_BOT_LAB_API_CONTRACT_VERSION;
  const backendSourceRevision = typeof value?.backend_source_revision === "string"
    ? value.backend_source_revision
    : null;
  const expectedBackendSourceRevision = renterBotLabBackendSourceRevision(env);
  const backendSourceMatches = backendSourceRevision === expectedBackendSourceRevision;
  const draftApiContractVersion = typeof value?.draft_api_contract_version === "string"
    ? value.draft_api_contract_version
    : null;
  const draftApiContractMatches = draftApiContractVersion === RENTER_BOT_LAB_API_CONTRACT_VERSION;
  const draftApiSourceRevision = typeof value?.draft_api_source_revision === "string"
    ? value.draft_api_source_revision
    : null;
  const expectedSourceRevision = renterBotLabSourceRevision(env);
  const draftApiSourceMatches = draftApiSourceRevision === expectedSourceRevision;
  const chatActionRegistered = value?.chat_action_registered === true;
  const catalogReady = env.RENTER_BOT_LAB_DEPLOYMENT !== "local" || value?.catalog_ready === true;
  return {
    generation_ready: response.status === "success" && value?.ready === true &&
      chatActionRegistered && backendContractMatches && backendSourceMatches && draftApiContractMatches && draftApiSourceMatches && catalogReady,
    chat_action_registered: chatActionRegistered,
    backend_contract_version: backendContractVersion,
    expected_backend_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
    backend_contract_matches: backendContractMatches,
    backend_source_revision: backendSourceRevision,
    expected_backend_source_revision: expectedBackendSourceRevision,
    backend_source_matches: backendSourceMatches,
    draft_api_contract_version: draftApiContractVersion,
    draft_api_contract_matches: draftApiContractMatches,
    draft_api_source_revision: draftApiSourceRevision,
    expected_source_revision: expectedSourceRevision,
    draft_api_source_matches: draftApiSourceMatches,
    catalog_ready: catalogReady,
    catalog_status: typeof value?.catalog_status === "string" ? value.catalog_status : "not_checked",
    catalog_fetched_at: typeof value?.catalog_fetched_at === "number" ? value.catalog_fetched_at : null,
    catalog_inventory_count: Number.isSafeInteger(value?.catalog_inventory_count) ? value!.catalog_inventory_count! : 0,
    catalog_listing_count: Number.isSafeInteger(value?.catalog_listing_count) ? value!.catalog_listing_count! : 0,
    catalog_eligible_listing_count: Number.isSafeInteger(value?.catalog_eligible_listing_count) ? value!.catalog_eligible_listing_count! : 0,
    catalog_blocked_listing_count: Number.isSafeInteger(value?.catalog_blocked_listing_count) ? value!.catalog_blocked_listing_count! : 0,
  };
}

function normalizedOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isolatedCloudLabUrl(value: string | undefined): string | null {
  const origin = normalizedOrigin(value);
  if (!origin || origin === MAIN_RENTAL_CONVEX_URL) return null;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.hostname.endsWith(".convex.cloud") ? origin : null;
  } catch {
    return null;
  }
}

function isolatedLocalLabUrl(value: string | undefined, env: LabStatusEnvironment): string | null {
  if (env.NODE_ENV !== "development" || env.RENTER_BOT_LAB_DEPLOYMENT !== "local") return null;
  const origin = normalizedOrigin(value);
  if (!origin) return null;
  try {
    const url = new URL(origin);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.protocol === "http:" && loopback ? origin : null;
  } catch {
    return null;
  }
}

export function renterBotLabStatusFromEnv(env: LabStatusEnvironment) {
  if (env.RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED !== "false") return null;
  if (!env.OPENROUTER_API_KEY?.trim() && !env.VAULT_ACCESS_TOKEN?.trim()) return null;
  const fingerprint = renterBotLabSourceFingerprint(env);
  if (!fingerprint) return null;
  if (env.RENTER_BOT_LAB_DEPLOYMENT === "local") {
    const exactLocalSource = /^local:[a-f0-9]{12,64}$/i.test(renterBotLabSourceRevision(env)) &&
      /^[a-f0-9]{64}$/.test(fingerprint);
    if (env.NODE_ENV !== "development" || !env.RENTER_BOT_LAB_API_SECRET?.trim() ||
        !env.RENTER_BOT_LAB_API_BASE_URL?.trim() || !exactLocalSource) return null;
    const labUrl = isolatedLocalLabUrl(env.RENTER_BOT_LAB_CONVEX_URL, env);
    const browserUrl = isolatedLocalLabUrl(env.NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL, env);
    const apiUrl = isolatedLocalLabUrl(env.RENTER_BOT_LAB_API_BASE_URL, env);
    if (!labUrl || !browserUrl || labUrl !== browserUrl || !apiUrl) return null;
    const backendUrl = new URL(labUrl);
    return { deployment: "local" as const, live_chat_authorized: false as const,
      openrouter_configured: true as const, source_fingerprint: fingerprint,
      source_revision: renterBotLabSourceRevision(env), lab_backend_id: `${backendUrl.hostname}:${backendUrl.port}`,
      model_id: RENTER_BOT_MODEL_ID };
  }
  if (env.RENTER_BOT_LAB_DEPLOYMENT !== "hosted") return null;
  const labUrl = isolatedCloudLabUrl(env.RENTER_BOT_LAB_CONVEX_URL);
  const browserUrl = isolatedCloudLabUrl(env.NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL);
  if (!labUrl || !browserUrl || labUrl !== browserUrl || !env.RENTER_BOT_LAB_CONVEX_DEPLOY_KEY?.trim() ||
      !env.RENTER_BOT_LAB_API_SECRET?.trim()) return null;
  const backendId = new URL(labUrl).hostname;
  return { deployment: "hosted" as const, live_chat_authorized: false as const,
    openrouter_configured: true as const, source_fingerprint: fingerprint,
    source_revision: renterBotLabSourceRevision(env), lab_backend_id: backendId, model_id: RENTER_BOT_MODEL_ID };
}

const LAB_BACKEND_HOST = "clean-bulldog-494.convex.cloud";
let cachedGenerationReady: { key: string; until: number; value: LabGenerationStatus } | undefined;
const generationReadyChecks = new Map<string, Promise<LabGenerationStatus>>();

export async function ensureLabBackendGenerationReady(env: LabStatusEnvironment = process.env): Promise<LabGenerationStatus> {
  const localMode = env.RENTER_BOT_LAB_DEPLOYMENT === "local" && env.NODE_ENV === "development";
  const labUrl = localMode
    ? isolatedLocalLabUrl(env.RENTER_BOT_LAB_CONVEX_URL, env)
    : isolatedCloudLabUrl(env.RENTER_BOT_LAB_CONVEX_URL);
  const deployKey = env.RENTER_BOT_LAB_CONVEX_DEPLOY_KEY?.trim();
  const labApiSecret = env.RENTER_BOT_LAB_API_SECRET?.trim();
  const validBackend = localMode
    ? !!labUrl
    : !!labUrl && !!deployKey && new URL(labUrl).hostname === LAB_BACKEND_HOST;
  if (!labUrl || !validBackend || !labApiSecret) {
    return labGenerationStatusFromProbe({ status: "unavailable" }, env);
  }
  const cacheKey = `${labUrl}|${renterBotLabSourceRevision(env)}|${renterBotLabBackendSourceRevision(env)}|${RENTER_BOT_LAB_API_CONTRACT_VERSION}`;
  const secretHash = createHash("sha256").update(labApiSecret).digest("hex");
  const expectedMarker = "lab-auth-v1:" + secretHash;

  const now = Date.now();
  if (cachedGenerationReady?.key === cacheKey && cachedGenerationReady.until > now) return cachedGenerationReady.value;
  const existingCheck = generationReadyChecks.get(cacheKey);
  if (existingCheck) return existingCheck;

  const check = (async () => {
    try {
      const response = await fetch(new URL("/api/action", labUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "renter_bot_lab_status:checkDraftAuth",
          args: { expectedMarker },
          format: "json",
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return labGenerationStatusFromProbe({ status: "unavailable" }, env);
      const result = await response.json() as LabGenerationProbeResponse;
      return labGenerationStatusFromProbe(result, env);
    } catch {
      return labGenerationStatusFromProbe({ status: "unavailable" }, env);
    }
  })();

  generationReadyChecks.set(cacheKey, check);
  const ready = await check;
  if (generationReadyChecks.get(cacheKey) === check) generationReadyChecks.delete(cacheKey);
  cachedGenerationReady = { key: cacheKey, until: Date.now() + 30_000, value: ready };
  return ready;
}
