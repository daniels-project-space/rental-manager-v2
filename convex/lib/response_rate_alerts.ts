/**
 * Low-response-rate alert decisions — pure, so the firing rules are unit
 * testable without a Convex harness. `channel_response_rates:write` owns the
 * I/O; this file owns "should we shout, and what do we remember".
 *
 * Why this exists (2026-08-20): the original rule was edge-triggered off the
 * PREVIOUS SNAPSHOT'S `channels` array —
 *
 *     wasAlreadyBelow = previousRate !== null && previousRate < 0.50
 *     if (rate < 0.50 && !wasAlreadyBelow) alert()
 *
 * — which failed in both directions:
 *
 *   1. SILENT WHEN IT MATTERED. Once a channel dipped below the threshold it
 *      latched off forever. dbcinema sat at 46% and never alerted again,
 *      because every subsequent snapshot saw "already below".
 *   2. NOISY WHEN IT DIDN'T. A failed scrape writes `rate: null`. The next
 *      good scrape then read previousRate === null → "not previously below"
 *      → a fresh "dropped below 50%" alert for a channel that had been
 *      quietly low for weeks. One Hygglo blip = one false alarm.
 *
 * The fix is level-triggered with a re-arm timer, plus alert state kept
 * separately from the scrape results so a null reading changes nothing.
 */

/** Below this, a channel's Hygglo response rate is alerted as URGENT. */
export const LOW_RESPONSE_RATE_THRESHOLD = 0.5;

/** While a channel stays below the threshold, re-alert this often. */
export const RE_ARM_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * A further slide of this much re-alerts immediately, without waiting out the
 * re-arm window. 46% → 30% is news; sitting at 46% for another day is not.
 */
export const FURTHER_DROP_DELTA = 0.1;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ChannelReading = {
  slug: string;
  rate: number | null;
  source?: "hygglo_profile" | "not_available";
};

export type ChannelAlertState = {
  slug: string;
  /** Last rate actually scraped. Failed scrapes never overwrite this. */
  last_known_rate: number;
  last_known_at: number;
  /** Start of the current below-threshold streak; cleared on recovery. */
  low_since?: number;
  /** When an alert was last queued for this slug; cleared on recovery. */
  last_alert_at?: number;
  /** Rate at that last alert — the baseline for FURTHER_DROP_DELTA. */
  last_alert_rate?: number;
};

export type ResponseRateAlert = {
  slug: string;
  rate: number;
  title: string;
  body: string;
  /** Which rule fired, for tests and for reading the notification log. */
  reason: "crossed" | "still_low" | "further_drop";
};

export type EvaluateInput = {
  channels: ChannelReading[];
  previousState: ChannelAlertState[];
  now: number;
  /** Injected so copy stays in the caller's voice ("Leo's", "Diogo's"). */
  accountWord: (slug: string) => string;
};

export type EvaluateResult = {
  alerts: ResponseRateAlert[];
  nextState: ChannelAlertState[];
};

const pct = (rate: number) => Math.round(rate * 100);

function buildCopy(
  reason: ResponseRateAlert["reason"],
  who: string,
  rate: number,
  daysLow: number,
): { title: string; body: string } {
  const tail = "Hygglo ranks on this, reply faster to recover it.";
  if (reason === "crossed") {
    return {
      title: `🚨 URGENT: ${who}'s Hygglo response rate dropped below 50%`,
      body: `${pct(rate)}% response rate — ${tail}`,
    };
  }
  if (reason === "further_drop") {
    return {
      title: `🚨 STILL FALLING: ${who}'s Hygglo response rate is now ${pct(rate)}%`,
      body: `${pct(rate)}% response rate and still dropping — ${tail}`,
    };
  }
  const days = `${daysLow} day${daysLow === 1 ? "" : "s"}`;
  return {
    title: `🚨 STILL LOW: ${who}'s Hygglo response rate is ${pct(rate)}%`,
    body: `${pct(rate)}% response rate, below 50% for ${days} — ${tail}`,
  };
}

/**
 * Decide which channels to alert on and what to remember for next time.
 *
 * Rules, in order:
 *   - No usable reading (non-Hygglo channel, or the scrape failed) → carry the
 *     previous state forward untouched and never alert. This is what makes a
 *     Hygglo outage a no-op instead of a false alarm.
 *   - At or above threshold → clear the latch, so the next genuine drop alerts
 *     immediately rather than waiting out a stale re-arm window.
 *   - Below threshold → alert if we have never alerted for this streak, or the
 *     re-arm window has elapsed, or it has slid FURTHER_DROP_DELTA since the
 *     last alert.
 *
 * A channel with no prior state that is already below threshold counts as
 * "crossed" and alerts on the next refresh. That is deliberate: on first
 * deploy we want to be told about the channels that are low right now.
 */
export function evaluateResponseRateAlerts({
  channels,
  previousState,
  now,
  accountWord,
}: EvaluateInput): EvaluateResult {
  const prevBySlug = new Map(previousState.map((s) => [s.slug, s]));
  const alerts: ResponseRateAlert[] = [];
  const nextState: ChannelAlertState[] = [];

  for (const channel of channels) {
    const prior = prevBySlug.get(channel.slug);

    if (channel.source !== "hygglo_profile" || channel.rate === null) {
      if (prior) nextState.push(prior);
      continue;
    }

    const rate = channel.rate;

    if (rate >= LOW_RESPONSE_RATE_THRESHOLD) {
      nextState.push({
        slug: channel.slug,
        last_known_rate: rate,
        last_known_at: now,
      });
      continue;
    }

    const lowSince = prior?.low_since ?? now;
    const lastAlertAt = prior?.last_alert_at;
    const lastAlertRate = prior?.last_alert_rate;

    const isFirst = lastAlertAt === undefined;
    const reArmed = lastAlertAt !== undefined && now - lastAlertAt >= RE_ARM_MS;
    const slidFurther =
      lastAlertRate !== undefined && rate <= lastAlertRate - FURTHER_DROP_DELTA;
    const shouldAlert = isFirst || reArmed || slidFurther;

    if (shouldAlert) {
      // further_drop wins over the timer: if both are true the sharper signal
      // is the more useful headline.
      const reason: ResponseRateAlert["reason"] = isFirst
        ? "crossed"
        : slidFurther
          ? "further_drop"
          : "still_low";
      const daysLow = Math.floor((now - lowSince) / DAY_MS);
      alerts.push({
        slug: channel.slug,
        rate,
        reason,
        ...buildCopy(reason, accountWord(channel.slug), rate, daysLow),
      });
    }

    // NOTE: last_alert_at / last_alert_rate are deliberately carried forward
    // UNCHANGED here, even when shouldAlert is true. Queuing can still be
    // refused downstream by the notification dedupe window, and stamping an
    // alert that never went out would start the re-arm clock on a silent
    // notification. The caller applies stamps via markAlertsDelivered() once
    // the insert is confirmed; anything refused simply retries next refresh.
    nextState.push({
      slug: channel.slug,
      last_known_rate: rate,
      last_known_at: now,
      low_since: lowSince,
      last_alert_at: lastAlertAt,
      last_alert_rate: lastAlertRate,
    });
  }

  return { alerts, nextState };
}

/**
 * Stamp the re-arm clock for the slugs whose notification actually landed.
 * `delivered` maps slug → the rate that was reported, so the further-drop
 * baseline reflects what the user was genuinely told.
 */
export function markAlertsDelivered(
  state: ChannelAlertState[],
  delivered: Map<string, number>,
  now: number,
): ChannelAlertState[] {
  if (delivered.size === 0) return state;
  return state.map((s) => {
    const rate = delivered.get(s.slug);
    return rate === undefined
      ? s
      : { ...s, last_alert_at: now, last_alert_rate: rate };
  });
}
