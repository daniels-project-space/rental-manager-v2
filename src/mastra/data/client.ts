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
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL not set");
  cached = new ConvexHttpClient(url);
  return cached;
}

export function toError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
