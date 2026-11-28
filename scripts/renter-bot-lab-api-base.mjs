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
