/**
 * Outbound feedback to renter. Currently a stub gated by ALLOW_HYGGLO_SEND /
 * READ_ONLY_MODE (the master safety rail in V1, see playwright.service.ts:18).
 * This file preserves the V1 behaviour: never sends; returns a blocked envelope.
 */
import "server-only";
import { wrap, type ToolEnvelope } from "./envelope";

export async function sendCorrection(_input: {
  rentalId: string;
  message: string;
}): Promise<ToolEnvelope<unknown>> {
  return wrap({
    data: {
      ok: false as const,
      blocked: true as const,
      reason:
        "ALLOW_HYGGLO_SEND=false (master safety rail). Cannot send to renter.",
      message:
        "Read-only mode is active. To compose a correction, paste suggested text here and the operator will send manually.",
    },
    source: "stub",
    syncState: null,
    extraCaveats: ["This tool is currently a stub."],
  });
}
