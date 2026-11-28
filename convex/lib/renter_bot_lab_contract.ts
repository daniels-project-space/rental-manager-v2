/** Bump when Lab conversation behavior, generation, or turn persistence changes. */
export const RENTER_BOT_LAB_API_CONTRACT_VERSION = "renter-bot-lab-turn-v4";

export type RenterBotLabAuthEnvironment = {
  RENTER_BOT_LAB_DEPLOYMENT?: string;
  RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED?: string;
  RENTER_BOT_LAB_API_SECRET?: string;
  RENTER_BOT_LAB_AUTH_CONFIG_VERSION?: string;
};

/** Server-to-server capability marker derived from the Lab API secret. */
export async function renterBotLabAuthMarkerFromSecret(secret: string): Promise<string> {
  const value = secret.trim();
  if (!value) throw new Error("Renter Bot Lab API secret is missing");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `lab-auth-v1:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Public Lab actions accept only the marker configured beside their API secret. */
export function renterBotLabAuthMarkerMatches(
  supplied: string,
  env: Record<string, string | undefined>,
): boolean {
  const expected = env.RENTER_BOT_LAB_AUTH_CONFIG_VERSION;
  const configuredLab = env.RENTER_BOT_LAB_DEPLOYMENT === "local" || env.RENTER_BOT_LAB_DEPLOYMENT === "hosted";
  return configuredLab && env.RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED === "false" &&
    Boolean(env.RENTER_BOT_LAB_API_SECRET?.trim()) &&
    typeof expected === "string" && /^lab-auth-v1:[a-f0-9]{64}$/.test(expected) && supplied === expected;
}
