import { hasLabAccess } from "@/lib/test-lab-gate";
import { LabGateForm } from "@/components/dashboard/RenterBotLab/LabGateForm";
import { RenterBotLabWorkspace } from "@/components/dashboard/RenterBotLab/RenterBotLabWorkspace";

/**
 * Renter Bot Lab — internal-only test surface. Talks to the REAL
 * generateDraft pipeline via convex/renter_bot_lab_actions.ts, never to a
 * real renter (see docs/renter-bot-policy.md for the send-path guarantees).
 *
 * NOT YET LINKED from HeaderBar — reachable only by direct URL + the gate
 * below, pending Daniel's decision on the actual Vercel-side perimeter.
 */
export default async function RenterBotLabPage() {
  const granted = await hasLabAccess();
  if (!granted) return <LabGateForm />;
  return <RenterBotLabWorkspace />;
}
