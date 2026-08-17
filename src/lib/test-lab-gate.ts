/**
 * test-lab-gate — defense-in-depth access check for the Renter Bot Lab
 * (/renter-bot-lab). Same shared-secret idiom as RENTER_BOT_API_SECRET in
 * src/app/api/renter-bot-draft/route.ts: fail-closed if the secret isn't
 * configured, not "open by default."
 *
 * This is NOT the real perimeter — there is no in-app auth anywhere else in
 * this repo, so whatever actually protects the deployed app today (if
 * anything) is Vercel-side and outside this file's control. Daniel needs to
 * confirm/set that separately. This is one additional layer, not the whole
 * story.
 */
import { cookies } from "next/headers";

export const LAB_ACCESS_COOKIE = "renter_bot_lab_access";

function expectedSecret(): string | undefined {
  return process.env.RENTER_BOT_LAB_SECRET || undefined;
}

export function isLabGateConfigured(): boolean {
  return Boolean(expectedSecret());
}

export function checkLabSecret(candidate: string): boolean {
  const expected = expectedSecret();
  return Boolean(expected) && candidate === expected;
}

/** Server-side check for the current request, via the access cookie. */
export async function hasLabAccess(): Promise<boolean> {
  const expected = expectedSecret();
  if (!expected) return false; // fail-closed: unconfigured = no access, ever
  const store = await cookies();
  return store.get(LAB_ACCESS_COOKIE)?.value === expected;
}
