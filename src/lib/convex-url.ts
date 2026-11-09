export const MAIN_RENTAL_CONVEX_URL = "https://hearty-oyster-600.convex.cloud";

type LabBrowserEnvironment = {
  NODE_ENV?: string;
  NEXT_PUBLIC_CONVEX_URL?: string;
  NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL?: string;
};

function validateLabUrl(value: string, nodeEnv?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("The Renter Bot Lab needs a valid isolated Convex URL.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) {
    throw new Error("The Renter Bot Lab Convex URL is invalid.");
  }
  const origin = parsed.origin;
  if (origin === MAIN_RENTAL_CONVEX_URL) throw new Error("The Renter Bot Lab cannot use live rental data.");
  const local = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
  const cloud = parsed.protocol === "https:" && parsed.hostname.endsWith(".convex.cloud");
  if ((!local && !cloud) || (local && nodeEnv !== "development")) {
    throw new Error("The Renter Bot Lab needs an isolated Convex cloud deployment.");
  }
  return origin;
}

export function resolveRenterBotLabBrowserUrl(env: LabBrowserEnvironment): string {
  const configured = env.NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL?.trim();
  const localFallback = env.NODE_ENV === "development" ? env.NEXT_PUBLIC_CONVEX_URL?.trim() : undefined;
  const selected = configured || localFallback;
  if (!selected) throw new Error("The isolated Renter Bot Lab backend is not configured.");
  return validateLabUrl(selected, env.NODE_ENV);
}
