/**
 * Convex HTTP client factory. Single point of construction so all
 * Mastra consumers (dashboard chat, polling agent, renter-bot) share
 * identical env-var handling and error surface.
 */
import "server-only";
import { ConvexHttpClient } from "convex/browser";

let cached: ConvexHttpClient | null = null;

export function getConvex(): ConvexHttpClient {
  if (cached) return cached;
  // Must match the dashboard's read deployment (src/lib/convex.ts) and the
  // poller's write deployment (src/trigger/poll-hygglo.ts). Vercel's
  // NEXT_PUBLIC_CONVEX_URL points to exciting-lion-29 (the default prod
  // deployment), but the poller and dashboard run on hearty-oyster-600.
  // Reading from the wrong one made every Mastra tool serve data ~2 days
  // stale and miss every live update (causing chat answers like "£0
  // revenue" for items the dashboard correctly showed had earnings).
  // HARDCODED to hearty-oyster-600 (mirrors src/lib/convex.ts). Tried the
  // env-override pattern first but Vercel had CONVEX_URL pinned to
  // exciting-lion-29, so every Mastra query still served data ~42hrs stale.
  // This is the only deployment the poller writes to and the dashboard
  // reads from — Mastra MUST agree with it.
  const url = "https://hearty-oyster-600.convex.cloud";
  cached = new ConvexHttpClient(url);
  return cached;
}

export function toError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
