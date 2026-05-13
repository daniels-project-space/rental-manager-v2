/**
 * Tool-envelope re-export + sync-state fetcher.
 *
 * Keeps the existing `wrap()` contract from
 * `apps/web/src/mastra/lib/tool-envelope.ts` (do NOT change shape — that file
 * is the source of truth for the ToolEnvelope<T> type used by dashboard-chat).
 *
 * `getSyncState()` previously lived inline inside dashboard-tools.ts; it now
 * belongs here so every data-layer function attaches freshness metadata the
 * same way.
 */
import "server-only";
import { anyApi } from "convex/server";
import {
  wrap as wrapEnvelope,
  type ToolEnvelope,
  type SyncStateDoc,
} from "../lib/tool-envelope";
import { getConvex } from "./client";
import { HYGGLO_POLLER_SOURCE } from "./constants";

export type { ToolEnvelope, SyncStateDoc };
export { wrapEnvelope as wrap };

/**
 * Fetch the current hygglo_poller sync_state document.
 * Returns null on any error so callers can still wrap their data with
 * a "live-sync status unknown" caveat instead of failing.
 */
export async function getSyncState(): Promise<SyncStateDoc | null> {
  try {
    const convex = getConvex();
    return await convex.query(anyApi.sync_state.get, {
      source: HYGGLO_POLLER_SOURCE,
    });
  } catch {
    return null;
  }
}

/**
 * Convenience: wrap data with auto-fetched sync_state.
 * Pure sugar over `wrap()` — saves callers from calling getSyncState() themselves.
 */
export async function wrapWithSync<T>(args: {
  data: T;
  source: string;
  coverageRatio?: number;
  extraCaveats?: string[];
}): Promise<ToolEnvelope<T>> {
  const syncState = await getSyncState();
  return wrapEnvelope({ ...args, syncState });
}
