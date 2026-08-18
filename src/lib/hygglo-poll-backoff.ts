/**
 * hygglo-poll-backoff — Phase 31 (Wave 8 cost opt).
 *
 * Pure, dependency-free helpers for the Hygglo poller's adaptive polling
 * backoff. The poller (`src/trigger/poll-hygglo.ts`) already resolves an
 * EFFECTIVE poll interval from the human-set `settings.polling_interval_ms`
 * dial (clamped to a hard 2-60 minute range —
 * MIN_EFFECTIVE_POLL_INTERVAL_MS / MAX_EFFECTIVE_POLL_INTERVAL_MS there).
 * This module adds an independent, automatic WIDENING on top of that dial
 * when consecutive FULL poll cycles find nothing changed across every
 * polled Hygglo account, and an immediate RESET the instant any order
 * actually changes.
 *
 * This is orthogonal to `src/lib/quiet-hours.ts`'s clock-based
 * `hyggloPollMode` (full/operational/skip by time-of-day) — that logic is
 * untouched. This module only widens/narrows the EFFECTIVE interval used to
 * gate how often a scheduled run does real work; it never rewrites the
 * stored `polling_interval_ms` value a human dialled in from Settings/WallE
 * chat, and it can never push the effective interval past the pre-existing
 * hard 2-60 minute bounds a human could already reach manually.
 *
 * CHOSEN CURVE (documented here so it's easy to find and adjust):
 *
 *   effectiveIntervalMs = clamp(baseIntervalMs * 1.5 ^ quietStreak, min, max)
 *
 * i.e. +50% per consecutive fully-quiet FULL-poll cycle (full polls run
 * every 15 min inside the active window — see HYGGLO_POLL_CRON /
 * hyggloPollMode in quiet-hours.ts), reset to `quietStreak = 0` (⇒
 * effectiveIntervalMs = baseIntervalMs) the instant a cycle sees ANY real
 * order change. With the default 2-minute base this only starts to widen
 * the 15-minute full-poll cadence after ~5 consecutive quiet cycles
 * (~75 min of zero activity), and saturates at the existing 60-minute
 * ceiling after ~9 consecutive quiet cycles (~2h15m of zero activity across
 * every polled account) — the SAME ceiling a human could already dial in by
 * hand from Settings. See `nextQuietStreak` for exactly which cycles count
 * as "quiet" (deliberately conservative — see its docstring).
 */

export const HYGGLO_BACKOFF_GROWTH_FACTOR = 1.5;

/**
 * Widen `baseIntervalMs` by `HYGGLO_BACKOFF_GROWTH_FACTOR` per consecutive
 * quiet cycle, hard-clamped to [minIntervalMs, maxIntervalMs] — pass the
 * SAME 2-60 minute bounds the human-set dial is already clamped to
 * (MIN_EFFECTIVE_POLL_INTERVAL_MS / MAX_EFFECTIVE_POLL_INTERVAL_MS in
 * poll-hygglo.ts). The auto-backoff can never push the effective interval
 * outside a range a human could already reach manually, in either
 * direction.
 */
export function computeBackoffIntervalMs(
  baseIntervalMs: number,
  quietStreak: number,
  minIntervalMs: number,
  maxIntervalMs: number,
): number {
  const safeBase =
    Number.isFinite(baseIntervalMs) && baseIntervalMs > 0 ? baseIntervalMs : minIntervalMs;
  const streak = Number.isFinite(quietStreak) ? Math.max(0, Math.floor(quietStreak)) : 0;
  const widened = safeBase * Math.pow(HYGGLO_BACKOFF_GROWTH_FACTOR, streak);
  return Math.min(maxIntervalMs, Math.max(minIntervalMs, Math.round(widened)));
}

/**
 * Per-cycle inputs the poller aggregates across every account it actually
 * queried this cycle (accounts skipped for paused-mode / missing
 * credentials are excluded — there's nothing to learn from an account that
 * wasn't polled at all).
 */
export interface HyggloQuietCycleInput {
  /** Sum of corePoll's `meta.orders_selected` across polled accounts. */
  totalOrdersSelected: number;
  /** Sum of corePoll's `meta.orders_skipped_unchanged` across polled accounts. */
  totalOrdersSkippedUnchanged: number;
  /** True if ANY polled account had a non-zero `list_filter_errors` or
   *  `detail_fetch_errors` this cycle — some orders' true state is simply
   *  unknown this cycle, which is not the same as "confirmed unchanged". */
  hadErrors: boolean;
  /** True if any account's poll threw entirely (caught by the per-account
   *  try/catch in poll-hygglo.ts) — same reasoning as hadErrors. */
  anyAccountFailed: boolean;
}

/**
 * Decide the NEXT quiet-streak counter given this cycle's outcome.
 *
 *  - Any account failure or fetch error this cycle -> HOLD the current
 *    streak (neither widen nor reset — we don't have a trustworthy signal
 *    either way this cycle; never guess, mirroring
 *    `activityStampUnchanged`'s conservative philosophy in hygglo-core/poll.ts).
 *  - Zero orders selected across every polled account (e.g. every account
 *    paused/missing creds, or genuinely nothing on Hygglo) -> HOLD. No data
 *    this cycle to justify widening further.
 *  - Every selected order was confirmed skip-unchanged (and at least one
 *    order was selected) -> INCREMENT (this cycle was fully quiet).
 *  - Otherwise (at least one order actually needed a fresh detail fetch,
 *    i.e. really changed) -> RESET to 0 immediately.
 */
export function nextQuietStreak(
  currentStreak: number,
  cycle: HyggloQuietCycleInput,
): number {
  const safeCurrent = Number.isFinite(currentStreak) ? Math.max(0, Math.floor(currentStreak)) : 0;
  if (cycle.anyAccountFailed || cycle.hadErrors) return safeCurrent;
  if (!Number.isFinite(cycle.totalOrdersSelected) || cycle.totalOrdersSelected <= 0) {
    return safeCurrent;
  }
  const fullyQuiet = cycle.totalOrdersSkippedUnchanged === cycle.totalOrdersSelected;
  return fullyQuiet ? safeCurrent + 1 : 0;
}
