/**
 * ToolEnvelope — wraps any tool result with freshness metadata and caveats.
 * Used by dashboard-chat tools to surface data-staleness to the agent.
 *
 * Wave 1 extension: tools that read through the HydrationLayer can pass
 * `hydrationSource` (tier + fetchedAt + cached) instead of a `syncState`.
 * The envelope derives `source` ("<base>.static|.live|.r2"), `lastSyncedAt`,
 * and `staleMinutes` from the hydration lineage. Backward-compatible — the
 * original `syncState`-based call path is unchanged.
 */

// Lightweight structural mirror of the HydrationSource type from
// `./hydration`. Re-declared here (not imported) so this file remains a
// zero-dependency leaf used by every tool.
export interface HydrationSourceLite {
  tier: 1 | 2 | 3;
  table?: string;
  fetchedAt: number;
  cached: boolean;
  ttlExpiresAt?: number;
}

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

export interface WrapArgs<T> {
  data: T;
  source: string;
  syncState?: SyncState;
  coverageRatio?: number;
  extraCaveats?: string[];
  /**
   * Wave 1: lineage metadata from `HydrationLayer`. When provided, the
   * envelope's `source` is suffixed with `.static` / `.live` / `.r2`
   * (per tier), and `lastSyncedAt` / `staleMinutes` are derived from
   * `hydrationSource.fetchedAt`. Overrides `syncState` if both are passed.
   */
  hydrationSource?: HydrationSourceLite;
  /**
   * Optional explicit override for `lastSyncedAt`. Use this when the
   * envelope's freshness should track a different sync_state row than the
   * hydration lineage suggests (e.g. reservations table-level fallback).
   */
  lastSyncedAt?: number | null;
  /** Caveats list to merge in addition to `extraCaveats`. */
  caveats?: string[];
}

/**
 * Backward-compatible variadic signature so legacy call-sites that pass a
 * positional `(data, source, opts?)` triple continue to work.
 *
 *   wrap({ data, source, syncState })          // original style
 *   wrap(data, "convex.items", { hydrationSource })  // new style
 */
export function wrap<T>(args: WrapArgs<T>): ToolEnvelope<T>;
export function wrap<T>(
  data: T,
  source: string,
  opts?: Omit<WrapArgs<T>, "data" | "source">,
): ToolEnvelope<T>;
export function wrap<T>(
  argsOrData: T | WrapArgs<T>,
  maybeSource?: string,
  maybeOpts?: Omit<WrapArgs<T>, "data" | "source">,
): ToolEnvelope<T> {
  const args: WrapArgs<T> =
    maybeSource !== undefined
      ? {
          data: argsOrData as T,
          source: maybeSource,
          ...(maybeOpts ?? {}),
        }
      : (argsOrData as WrapArgs<T>);

  const {
    data,
    source: baseSource,
    syncState,
    coverageRatio,
    extraCaveats,
    hydrationSource,
    lastSyncedAt: explicitLastSyncedAt,
    caveats: extraCaveats2,
  } = args;

  // Tier-aware source suffix (e.g. "convex.items.static") when hydration
  // lineage is supplied.
  const tierSuffix = (() => {
    if (!hydrationSource) return "";
    if (hydrationSource.tier === 1) return ".static";
    if (hydrationSource.tier === 3) return ".r2";
    return ".live";
  })();
  const source = hydrationSource ? `${baseSource}${tierSuffix}` : baseSource;

  // Resolve freshness — explicit override beats hydrationSource beats syncState.
  const lastSyncedAt: number | null =
    explicitLastSyncedAt !== undefined
      ? explicitLastSyncedAt
      : hydrationSource
        ? hydrationSource.fetchedAt
        : (syncState?.lastRunAt ?? null);

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

  // Caller-supplied caveats appended last (legacy + new arg names).
  if (extraCaveats && extraCaveats.length > 0) caveats.push(...extraCaveats);
  if (extraCaveats2 && extraCaveats2.length > 0) caveats.push(...extraCaveats2);

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
