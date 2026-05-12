/**
 * ToolEnvelope — wraps any tool result with freshness metadata and caveats.
 * Used by dashboard-chat tools to surface data-staleness to the agent.
 */

// Inline type matching the sync_state Convex document shape
// (Doc<"sync_state"> is not yet in generated dataModel; use structural type)
export interface SyncStateDoc {
  _id: string;
  _creationTime: number;
  source: string;
  lastRunAt: number;
  lastRunSucceeded: boolean;
  durationMs?: number;
  rowsUpserted?: number | Record<string, number | undefined>;
  errorMessage?: string;
}

type SyncState = SyncStateDoc | null;

export interface ToolEnvelope<T> {
  ok: boolean;
  data: T;
  source: string;              // e.g. "convex.reservations"
  lastSyncedAt: number | null; // ms since epoch from sync_state, or null
  staleMinutes: number | null; // rounded minutes since last sync, or null
  coverageRatio?: number;      // 0..1, only when computable
  caveats: string[];           // human-readable; agent prepends one if non-empty
}

export function wrap<T>(args: {
  data: T;
  source: string;
  syncState?: SyncState;
  coverageRatio?: number;
  extraCaveats?: string[];
}): ToolEnvelope<T> {
  const { data, source, syncState, coverageRatio, extraCaveats } = args;

  const lastSyncedAt = syncState?.lastRunAt ?? null;
  const staleMinutes =
    lastSyncedAt !== null
      ? Math.round((Date.now() - lastSyncedAt) / 60_000)
      : null;

  const caveats: string[] = [];

  // Staleness caveats
  if (staleMinutes !== null && staleMinutes > 10) {
    caveats.push(
      `Data is ${staleMinutes} min stale (last sync ${new Date(lastSyncedAt!).toISOString()}).`
    );
  }
  if (staleMinutes === null) {
    caveats.push("Live-sync status unknown — freshness cannot be verified.");
  }

  // Coverage caveat
  if (coverageRatio !== undefined && coverageRatio < 1) {
    caveats.push(
      `Reflects imported orders only (${Math.round(coverageRatio * 100)}% coverage); full Hygglo total may be higher.`
    );
  }

  // Sync failure caveat
  if (syncState?.lastRunSucceeded === false) {
    caveats.push(
      `Last sync failed: ${syncState.errorMessage ?? "unknown error"}. Data may be stale.`
    );
  }

  // Caller-supplied caveats appended last
  if (extraCaveats && extraCaveats.length > 0) {
    caveats.push(...extraCaveats);
  }

  const envelope: ToolEnvelope<T> = {
    ok: true,
    data,
    source,
    lastSyncedAt,
    staleMinutes,
    caveats,
  };

  if (coverageRatio !== undefined) {
    envelope.coverageRatio = coverageRatio;
  }

  return envelope;
}
