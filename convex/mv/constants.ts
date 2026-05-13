/**
 * MIRROR OF src/mastra/data/constants.ts
 *
 * Convex actions/queries cannot import from `src/` (Convex runtime is isolated).
 * Any value here MUST match the source-of-truth file byte-for-byte.
 * Keep this file in sync — CI script greps for divergence (TODO Wave 4).
 *
 * MIRROR-SYNC-CHECK keys:
 *   PLATFORM_FEE_RATE  →  src/mastra/data/constants.ts:PLATFORM_FEE_RATE
 *   OWNER_SHARE        →  src/mastra/data/constants.ts:OWNER_SHARE
 *   ACCOUNTS           →  src/mastra/data/constants.ts:ACCOUNTS
 */

/** MIRROR OF src/mastra/data/constants.ts:PLATFORM_FEE_RATE */
export const PLATFORM_FEE_RATE = 0.36;

/** MIRROR OF src/mastra/data/constants.ts:OWNER_SHARE */
export const OWNER_SHARE = 0.64;

/** MIRROR OF src/mastra/data/constants.ts:ACCOUNTS */
export const ACCOUNTS = ["dbcinema", "leo"] as const;
export type AccountSlug = (typeof ACCOUNTS)[number];

/**
 * Sentinel account slug for cross-account aggregates in MV singleton rows.
 * Never appears in `accounts.slug` table — MV-only literal.
 */
export const ACCOUNT_ALL = "all";

/**
 * MIRROR OF Daniel's MEMORY.md rule:
 *   Hygglo dates INCLUSIVE: Math.max(1, Math.round(diff/86400000) + 1)
 * MIRROR OF src/mastra/data/date-math.ts:hyggloDaysInclusive
 */
const MS_PER_DAY = 86_400_000;
export function hyggloDaysInclusive(startMs: number, endMs: number): number {
  return Math.max(1, Math.round((endMs - startMs) / MS_PER_DAY) + 1);
}
export function elapsedDays(startMs: number, endMs: number = Date.now()): number {
  return Math.max(1, Math.round((endMs - startMs) / MS_PER_DAY));
}
