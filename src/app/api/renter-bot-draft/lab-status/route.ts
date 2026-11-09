import { createHash } from "node:crypto";
import { MAIN_RENTAL_CONVEX_URL } from "@/lib/convex-url";

const noStoreHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };
type LabStatusEnvironment = Record<string, string | undefined>;

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

export function GET() {
  const status = renterBotLabStatusFromEnv(process.env);
  if (!status) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(JSON.stringify(status), { status: 200, headers: noStoreHeaders });
}
