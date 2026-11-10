import { createHash } from "node:crypto";
import { MAIN_RENTAL_CONVEX_URL } from "@/lib/convex-url";

const noStoreHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
type LabStatusEnvironment = Record<string, string | undefined>;
type LabGenerationProbeResponse = { status?: string; value?: { ready?: boolean } };

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

function sourceFingerprint(env: LabStatusEnvironment): string | null {
  const configured = env.RENTER_BOT_LAB_API_SOURCE_FINGERPRINT;
  if (configured && /^[a-f0-9]{64}$/.test(configured)) return configured;
  const source = env.VERCEL_GIT_COMMIT_SHA ?? env.VERCEL_URL;
  return source ? createHash("sha256").update(source).digest("hex") : null;
}

export function renterBotLabStatusFromEnv(env: LabStatusEnvironment) {
  if (env.RENTER_BOT_LAB_DEPLOYMENT !== "hosted" || env.RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED !== "false") return null;
  if (!env.OPENROUTER_API_KEY?.trim() && !env.VAULT_ACCESS_TOKEN?.trim()) return null;
  const fingerprint = sourceFingerprint(env);
  if (!fingerprint) return null;
  const labUrl = isolatedCloudLabUrl(env.RENTER_BOT_LAB_CONVEX_URL);
  const browserUrl = isolatedCloudLabUrl(env.NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL);
  if (!labUrl || !browserUrl || labUrl !== browserUrl || !env.RENTER_BOT_LAB_CONVEX_DEPLOY_KEY?.trim() ||
      !env.RENTER_BOT_LAB_API_SECRET?.trim()) return null;
  return { deployment: "hosted" as const, live_chat_authorized: false as const,
    openrouter_configured: true as const, source_fingerprint: fingerprint };
}

const LAB_BACKEND_HOST = "clean-bulldog-494.convex.cloud";
const LAB_AUTH_MARKER = "RENTER_BOT_LAB_AUTH_CONFIG_VERSION";
let cachedGenerationReady: { until: number; value: boolean } | undefined;
let generationReadyCheck: Promise<boolean> | undefined;

async function ensureLabBackendGenerationReady(env: LabStatusEnvironment): Promise<boolean> {
  const labUrl = isolatedCloudLabUrl(env.RENTER_BOT_LAB_CONVEX_URL);
  const deployKey = env.RENTER_BOT_LAB_CONVEX_DEPLOY_KEY?.trim();
  const labApiSecret = env.RENTER_BOT_LAB_API_SECRET?.trim();
  if (!labUrl || !deployKey || !labApiSecret || new URL(labUrl).hostname !== LAB_BACKEND_HOST) return false;
  const secretHash = createHash("sha256").update(labApiSecret).digest("hex");
  const expectedMarker = "lab-auth-v1:" + secretHash;

  const now = Date.now();
  if (cachedGenerationReady && cachedGenerationReady.until > now) return cachedGenerationReady.value;
  if (generationReadyCheck) return generationReadyCheck;

  generationReadyCheck = (async () => {
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
      if (!response.ok) return false;
      const result = await response.json() as LabGenerationProbeResponse;
      return result.status === "success" && result.value?.ready === true;
    } catch {
      return false;
    } finally {
      generationReadyCheck = undefined;
    }
  })();

  const ready = await generationReadyCheck;
  cachedGenerationReady = { until: Date.now() + 30_000, value: ready };
  return ready;
}

export async function GET() {
  const status = renterBotLabStatusFromEnv(process.env);
  if (!status) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  const generation_ready = await ensureLabBackendGenerationReady(process.env);
  return new Response(JSON.stringify({ ...status, generation_ready }), { status: 200, headers: noStoreHeaders });
}
