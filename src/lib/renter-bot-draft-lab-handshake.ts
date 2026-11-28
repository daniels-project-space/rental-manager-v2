import { NextResponse } from "next/server";
import { RENTER_BOT_LAB_API_CONTRACT_VERSION } from "../../convex/lib/renter_bot_lab_contract";
import { renterBotDraftApiAuthMode } from "./renter-bot-api-auth";
import { renterBotLabSourceRevision } from "./renter-bot-lab-source";

/** Read-only, secret-gated identity for the exact draft API selected by the Lab backend. */
export function renterBotDraftLabHandshake(request: Request) {
  const authMode = renterBotDraftApiAuthMode(
    request.headers.get("authorization"),
    undefined,
    request.headers.get("x-renter-bot-lab"),
  );
  if (authMode !== "hosted-lab" && authMode !== "local-lab") {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json({
    ok: true,
    api_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
    source_revision: renterBotLabSourceRevision(process.env),
  }, { headers: { "Cache-Control": "no-store" } });
}
