import { createHash } from "node:crypto";

const HOSTED_LAB_API_HOST = "rental-manager-v2-nu.vercel.app";

/** Resolve the verified, stable production host used by the isolated Lab backend. */
export function hostedRenterBotLabApiBase(env) {
  const configured = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!configured) throw new Error("Production requires VERCEL_PROJECT_PRODUCTION_URL for the isolated Lab API.");

  let url;
  try {
    url = new URL(configured.includes("://") ? configured : `https://${configured}`);
  } catch {
    throw new Error("VERCEL_PROJECT_PRODUCTION_URL is not a valid production host.");
  }
  if (url.protocol !== "https:" || url.hostname !== HOSTED_LAB_API_HOST || url.port || url.username || url.password ||
      (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("Production Lab API host does not match the verified Rental Manager production domain.");
  }
  return url.origin;
}

/** Values that must be synchronized to the isolated Convex backend at every release. */
export function hostedRenterBotLabRuntimeConfig(env) {
  const secret = env.RENTER_BOT_LAB_API_SECRET?.trim();
  if (!secret) throw new Error("Production requires RENTER_BOT_LAB_API_SECRET.");
  return {
    RENTER_BOT_LAB_API_BASE_URL: hostedRenterBotLabApiBase(env),
    RENTER_BOT_LAB_API_SECRET: secret,
    RENTER_BOT_LAB_DEPLOYMENT: "hosted",
    RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED: "false",
    RENTER_BOT_API_SECRET: secret,
    RENTER_BOT_LAB_AUTH_CONFIG_VERSION: "lab-auth-v1:" + createHash("sha256").update(secret).digest("hex"),
  };
}
