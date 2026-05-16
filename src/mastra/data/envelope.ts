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
 * In-process sync_state cache (Wave 2 — Q4 decision).
 *
 * 30-second TTL, keyed by source string. Each Mastra tool call within a 30s
 * window reuses the same sync_state doc instead of re-querying Convex.
 *
 * NOTE: this cache is *per-process*. The cross-consumer cache properly lives
 * at the Convex query layer (Convex memoises identical queries automatically).
 * This local cache eliminates the redundant network round-trip for the common
 * case where one chat turn fires multiple tools back-to-back.
 *
 * Self-correction trail (Wave 1 retrospective): we originally fetched
 * sync_state on every tool call. Daniel approved the 30s memoise in Q4.
 */
const SYNC_STATE_TTL_MS = 30_000;
const syncStateCache = new Map<
  string,
  { value: SyncStateDoc | null; expiresAt: number }
>();

/**
 * Fetch the current hygglo_poller sync_state document.
 * Returns null on any error so callers can still wrap their data with
 * a "live-sync status unknown" caveat instead of failing.
 *
 * Result is cached in-process for 30s per source key.
 */
export async function getSyncState(): Promise<SyncStateDoc | null> {
  const key = HYGGLO_POLLER_SOURCE;
  const now = Date.now();
  const cached = syncStateCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  try {
    const convex = getConvex();
    const value = (await convex.query(anyApi.sync_state.get, {
      source: key,
    })) as SyncStateDoc | null;
    syncStateCache.set(key, { value, expiresAt: now + SYNC_STATE_TTL_MS });
    return value;
  } catch {
    syncStateCache.set(key, { value: null, expiresAt: now + SYNC_STATE_TTL_MS });
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
