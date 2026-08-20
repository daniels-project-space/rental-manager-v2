import { describe, expect, it } from "vitest";
import {
  evaluateResponseRateAlerts,
  markAlertsDelivered,
  FURTHER_DROP_DELTA,
  RE_ARM_MS,
  type ChannelAlertState,
  type ChannelReading,
} from "./response_rate_alerts";

const T0 = Date.UTC(2026, 7, 20, 8, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const who = (slug: string) => slug.toUpperCase();

const ok = (slug: string, rate: number | null) => ({
  slug,
  rate,
  source: "hygglo_profile" as const,
});

/**
 * Evaluate, then apply the delivery stamps for every alert raised — i.e. the
 * happy path where the notification queue accepts everything. Tests that care
 * about a refused insert call the two halves separately.
 */
const run = (
  channels: ChannelReading[],
  previousState: ChannelAlertState[],
  now: number,
) => {
  const { alerts, nextState } = evaluateResponseRateAlerts({
    channels,
    previousState,
    now,
    accountWord: who,
  });
  const delivered = new Map(alerts.map((a) => [a.slug, a.rate] as const));
  return { alerts, nextState: markAlertsDelivered(nextState, delivered, now) };
};

describe("evaluateResponseRateAlerts", () => {
  it("alerts on the first below-threshold reading", () => {
    const { alerts, nextState } = run([ok("dbcinema", 0.46)], [], T0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].reason).toBe("crossed");
    expect(alerts[0].title).toContain("dropped below 50%");
    expect(alerts[0].body).toContain("46%");
    expect(nextState[0]).toMatchObject({
      slug: "dbcinema",
      low_since: T0,
      last_alert_at: T0,
      last_alert_rate: 0.46,
    });
  });

  it("stays quiet while low inside the re-arm window", () => {
    const prior = run([ok("dbcinema", 0.46)], [], T0).nextState;
    // The old edge-trigger bug: this is the reading that used to be silent
    // forever. Now it is silent only until the re-arm window elapses.
    const { alerts } = run([ok("dbcinema", 0.46)], prior, T0 + RE_ARM_MS - 1);
    expect(alerts).toHaveLength(0);
  });

  it("re-alerts once the re-arm window elapses, with a days-low count", () => {
    const prior = run([ok("dbcinema", 0.46)], [], T0).nextState;
    const { alerts, nextState } = run([ok("dbcinema", 0.46)], prior, T0 + RE_ARM_MS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].reason).toBe("still_low");
    expect(alerts[0].body).toContain("below 50% for 3 days");
    // low_since must survive the re-alert so day counts keep accumulating.
    expect(nextState[0].low_since).toBe(T0);
    expect(nextState[0].last_alert_at).toBe(T0 + RE_ARM_MS);
  });

  it("keeps re-arming for as long as the channel stays low", () => {
    let state = run([ok("dbcinema", 0.46)], [], T0).nextState;
    let fired = 1;
    for (let i = 1; i <= 4; i++) {
      const r = run([ok("dbcinema", 0.46)], state, T0 + RE_ARM_MS * i);
      fired += r.alerts.length;
      state = r.nextState;
    }
    expect(fired).toBe(5);
  });

  it("re-alerts immediately on a further slide, without waiting for re-arm", () => {
    const prior = run([ok("dbcinema", 0.46)], [], T0).nextState;
    const { alerts } = run(
      [ok("dbcinema", 0.46 - FURTHER_DROP_DELTA)],
      prior,
      T0 + DAY,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].reason).toBe("further_drop");
    expect(alerts[0].title).toContain("STILL FALLING");
  });

  it("ignores a drift smaller than the further-drop delta", () => {
    const prior = run([ok("dbcinema", 0.46)], [], T0).nextState;
    const { alerts } = run([ok("dbcinema", 0.42)], prior, T0 + DAY);
    expect(alerts).toHaveLength(0);
  });

  // The false-alarm bug: a failed scrape used to write rate:null, and the next
  // good reading then looked like a brand-new crossing.
  it("treats a failed scrape as a no-op, not a recovery", () => {
    const prior = run([ok("dbcinema", 0.46)], [], T0).nextState;
    const blip = run(
      [{ slug: "dbcinema", rate: null, source: "hygglo_profile" as const }],
      prior,
      T0 + DAY,
    );
    expect(blip.alerts).toHaveLength(0);
    expect(blip.nextState[0]).toEqual(prior[0]);

    const recovered = run([ok("dbcinema", 0.46)], blip.nextState, T0 + 2 * DAY);
    expect(recovered.alerts).toHaveLength(0);
  });

  it("never alerts on a non-Hygglo channel", () => {
    const { alerts, nextState } = run(
      [{ slug: "dbcinema_web", rate: null, source: "not_available" as const }],
      [],
      T0,
    );
    expect(alerts).toHaveLength(0);
    expect(nextState).toHaveLength(0);
  });

  it("clears the latch on recovery so the next drop alerts immediately", () => {
    const low = run([ok("dbcinema", 0.46)], [], T0).nextState;
    const up = run([ok("dbcinema", 0.62)], low, T0 + DAY);
    expect(up.alerts).toHaveLength(0);
    expect(up.nextState[0].low_since).toBeUndefined();
    expect(up.nextState[0].last_alert_at).toBeUndefined();

    const downAgain = run([ok("dbcinema", 0.48)], up.nextState, T0 + 2 * DAY);
    expect(downAgain.alerts).toHaveLength(1);
    expect(downAgain.alerts[0].reason).toBe("crossed");
  });

  it("treats exactly 50% as healthy", () => {
    const { alerts } = run([ok("leo", 0.5)], [], T0);
    expect(alerts).toHaveLength(0);
  });

  // Caught live: the first prod run stamped last_alert_at even though the
  // notification queue's 24h dedupe refused the insert, which would have
  // muted dbcinema for the full re-arm window on an alert nobody received.
  it("does not start the re-arm clock when the queue refuses the insert", () => {
    const { alerts, nextState } = evaluateResponseRateAlerts({
      channels: [ok("dbcinema", 0.46)],
      previousState: [],
      now: T0,
      accountWord: who,
    });
    expect(alerts).toHaveLength(1);

    // Queue refused it — nothing delivered, so nothing gets stamped.
    const unstamped = markAlertsDelivered(nextState, new Map(), T0);
    expect(unstamped[0].last_alert_at).toBeUndefined();
    expect(unstamped[0].last_alert_rate).toBeUndefined();
    // …and low_since is still recorded, so the day counter stays honest.
    expect(unstamped[0].low_since).toBe(T0);

    // Next refresh retries instead of waiting out RE_ARM_MS.
    const retry = run([ok("dbcinema", 0.46)], unstamped, T0 + 6 * 60 * 60 * 1000);
    expect(retry.alerts).toHaveLength(1);
    expect(retry.alerts[0].reason).toBe("crossed");
  });

  it("scores each channel independently", () => {
    const { alerts } = run(
      [ok("dbcinema", 0.46), ok("leo", 0.57), ok("diogo", 0.53)],
      [],
      T0,
    );
    expect(alerts.map((a) => a.slug)).toEqual(["dbcinema"]);
  });
});
