import { ensureLabBackendGenerationReady, renterBotLabStatusFromEnv } from "@/lib/renter-bot-lab-readiness";

export { labGenerationStatusFromProbe, renterBotLabStatusFromEnv } from "@/lib/renter-bot-lab-readiness";

const noStoreHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };

export async function GET() {
  const status = renterBotLabStatusFromEnv(process.env);
  if (!status) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  const generationStatus = await ensureLabBackendGenerationReady(process.env);
  return new Response(JSON.stringify({ ...status, ...generationStatus }), { status: 200, headers: noStoreHeaders });
}
