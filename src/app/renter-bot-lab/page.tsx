import { RenterBotLabWorkspace } from "@/components/dashboard/RenterBotLab/RenterBotLabWorkspace";

/**
 * Renter Bot Lab — internal-only test surface. Talks to the REAL
 * generateDraft pipeline via convex/renter_bot_lab_actions.ts, never to a
 * real renter (see docs/renter-bot-policy.md for the send-path guarantees —
 * that's enforced structurally, independent of anything on this page).
 *
 * No passphrase gate (removed per Daniel, 2026-08-17) — reachable by anyone
 * with the URL. Nothing here can reach a real renter regardless.
 */
export default function RenterBotLabPage() {
  return <RenterBotLabWorkspace />;
}
