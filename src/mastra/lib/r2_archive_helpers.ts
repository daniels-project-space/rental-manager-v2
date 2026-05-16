/**
 * Pure helpers used by the R2 cold-storage archiver
 * (`convex/archive_to_r2.ts`) and the symmetric reader
 * (`src/lib/r2-cold-storage.ts`).
 *
 * Split into their own module so the unit tests in this folder can import
 * them without dragging the AWS SDK / vault loader into the vitest config
 * (see `vitest.config.ts` — Node-only, no Convex runtime).
 */

export const ARCHIVE_NINETY_DAYS_MS = 90 * 86_400_000;

/** UTC `yyyy-mm-dd` for a given ms timestamp. */
export function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * R2 key for an archive chunk of `table` whose MIN _creationTime falls on
 * the same UTC day as `minCreationMs`. Grouping by creation date lets
 * date-range readers locate the right blob without scanning every key.
 */
export function archiveKeyFor(table: string, minCreationMs: number): string {
  return `cold/archive/${table}/${utcDateKey(minCreationMs)}.jsonl.gz`;
}

/**
 * Group a chunk of rows by UTC creation date.
 * Returned groups are sorted ascending by dateKey so callers can write the
 * earliest blob first (deterministic ordering across runs).
 */
export interface DayGroup<R extends { _creationTime: number }> {
  dateKey: string;
  rows: R[];
}

export function groupRowsByCreationDate<
  R extends { _creationTime: number },
>(rows: ReadonlyArray<R>): DayGroup<R>[] {
  const map = new Map<string, DayGroup<R>>();
  for (const r of rows) {
    const k = utcDateKey(r._creationTime);
    let g = map.get(k);
    if (!g) {
      g = { dateKey: k, rows: [] };
      map.set(k, g);
    }
    g.rows.push(r);
  }
  return Array.from(map.values()).sort((a, b) =>
    a.dateKey < b.dateKey ? -1 : 1,
  );
}

/**
 * Iterate UTC date keys in [fromMs, toMs] inclusive. Used by
 * `loadArchivedRange` to enumerate the R2 keys it should fetch.
 */
export function* iterUtcDateKeys(
  fromMs: number,
  toMs: number,
): Generator<string> {
  if (toMs < fromMs) return;
  const startDate = new Date(fromMs);
  const endDate = new Date(toMs);
  const start = Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate(),
  );
  const end = Date.UTC(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth(),
    endDate.getUTCDate(),
  );
  for (let cursor = start; cursor <= end; cursor += 86_400_000) {
    yield utcDateKey(cursor);
  }
}

/**
 * Compute the archive cutoff in ms: rows whose `_creationTime` is strictly
 * less than this are eligible for archiving.
 */
export function archiveCutoffMs(nowMs: number): number {
  return nowMs - ARCHIVE_NINETY_DAYS_MS;
}

/**
 * Decision helper: given an existing cold-storage key list and a target
 * key, is this archive write idempotent (i.e. would skip)?
 *
 * Pure function so the integration code in `archive_to_r2.ts` can stay
 * focused on the R2 HeadObject probe; tests stay HeadObject-free.
 */
export function shouldSkipExistingKey(
  existingKeys: ReadonlyArray<string>,
  targetKey: string,
): boolean {
  return existingKeys.includes(targetKey);
}
