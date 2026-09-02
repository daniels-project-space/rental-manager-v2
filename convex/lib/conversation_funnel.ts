/**
 * Conversation funnel — rebuilt 2026-09-02.
 *
 * ── Why the old one was replaced ──────────────────────────────────────
 * The previous funnel (reservations.getConversionFunnel) mixed three
 * incompatible things and produced numbers that could not be acted on:
 *
 *  1. `denialRate` used denial_records, which is a ONE-SHOT BULK IMPORT:
 *     all 1081 rows carry created_at = 2026-05-10 and `rental_id` is populated
 *     on ZERO of them. The numerator was therefore all-time while the
 *     denominator was windowed, so the same underlying data read 99.7% at 7d,
 *     94.3% at 30d and 53.1% at 90d. It measured the window, not the business.
 *     It was also never rendered — only fed to the chat tools.
 *
 *  2. Cohorts were keyed on `conversations._creationTime`, i.e. when the POLLER
 *     INSERTED THE ROW, not when the renter made contact. 27% of rows differ
 *     from real thread activity by more than two days, and the whole table
 *     begins at a 2026-05-10 backfill. That manufactured a fake censoring
 *     curve: the 4–7d cohort measured 0% conversion. On a real message
 *     timestamp the same curve is flat at ~9–12%.
 *
 *  3. The denominator was hacked (`Math.max(inquiries, bookings + denials)`)
 *     purely to stop a rate exceeding 100% — a symptom of comparing
 *     populations that were never comparable.
 *
 * ── What replaced it ─────────────────────────────────────────────────
 * Cohort = threads whose FIRST RENTER MESSAGE falls in the window.
 * `hygglo_messages.hygglo_sent_at` is a real per-event Hygglo timestamp
 * (95.8% coverage; `fetched_at` is the fallback) and 98.6% of threads are
 * renter-initiated, so this is a genuine "an inquiry happened, then" clock.
 *
 * Three axes, deliberately NOT one column of bars:
 *
 *   • PROGRESSION (monotonic): inquiries ⊇ requests ⊇ booked.
 *     Each stage is a strict subset of the one before, so every share is a
 *     real 0–100%.
 *
 *   • SERVICE (ours, not the renter's): reply rate + latency. This is NOT a
 *     funnel stage. On Hygglo a renter can place a request without us
 *     answering first — live data: 377 replied vs 459 requested in 30d — so
 *     rendering "replied" between "inquiries" and "requests" would imply a
 *     dependency that does not exist and produce meaningless drop-off arrows.
 *
 *   • OUTCOME (terminal, mutually exclusive, exhaustive): every inquiry lands
 *     in exactly one bucket, and the buckets sum back to `inquiries`. Sourced
 *     from `reservations.hygglo_system_signal`, which records WHY each request
 *     died (owner_denied / renter_cancelled / auto_cancelled /
 *     verification_failed) and — unlike denial_records — carries real dates
 *     and joins to the thread, the item, the renter and the money.
 */

export const REPLY_GRACE_MS = 24 * 60 * 60 * 1000;

export type MessageLite = {
  thread_id: string;
  account_slug?: string;
  sender?: string;
  hygglo_sent_at?: number;
  fetched_at: number;
};

export type ReservationLite = {
  hygglo_order_id?: string;
  status?: string;
  hygglo_system_signal?: string;
  net_to_owner_gbp?: number;
  account_slug?: string;
};

export type ThreadContact = {
  threadId: string;
  accountSlug: string;
  firstRenterAt: number;
  firstOwnerReplyAt?: number;
};

/** Outcome keys. Exhaustive over the cohort — every inquiry gets exactly one. */
export const OUTCOME_KEYS = [
  "booked",
  "owner_denied",
  "expired",
  "renter_cancelled",
  "verification_failed",
  "still_open",
  "no_request",
  "other",
] as const;
export type OutcomeKey = (typeof OUTCOME_KEYS)[number];

export const OUTCOME_META: Record<
  OutcomeKey,
  { label: string; tone: "good" | "bad" | "neutral"; advice: string }
> = {
  booked: { label: "Booked", tone: "good", advice: "" },
  owner_denied: {
    label: "You denied",
    tone: "bad",
    advice: "you're turning requests away — check stock levels, blocked dates and pricing.",
  },
  expired: {
    label: "Expired (never paid)",
    tone: "bad",
    advice: "renters aren't completing payment — reduce friction and chase them sooner.",
  },
  renter_cancelled: {
    label: "Renter cancelled",
    tone: "bad",
    advice: "renters back out after requesting — check price, expectations and pickup logistics.",
  },
  verification_failed: {
    label: "Verification failed",
    tone: "bad",
    advice: "Hygglo ID verification is blocking renters — little you can control here.",
  },
  still_open: {
    label: "Still open",
    tone: "neutral",
    advice: "requests still awaiting a decision or payment.",
  },
  no_request: {
    label: "Never requested",
    tone: "bad",
    advice: "inquiries never became requests — check reply speed and how complete your listings are.",
  },
  other: { label: "Other", tone: "neutral", advice: "uncategorised outcomes." },
};

const tsOf = (m: MessageLite): number =>
  typeof m.hygglo_sent_at === "number" && m.hygglo_sent_at > 0 ? m.hygglo_sent_at : m.fetched_at;

const isOwner = (m: MessageLite): boolean => m.sender === "owner";

/**
 * One pass over messages → per-thread first renter contact and first owner
 * reply AFTER it. "After" matters: an owner message that predates the renter's
 * first line is not a reply to it.
 */
export function buildThreadContacts(messages: MessageLite[]): ThreadContact[] {
  const firstRenter = new Map<string, { at: number; account: string }>();
  for (const m of messages) {
    if (isOwner(m)) continue;
    const t = String(m.thread_id);
    const at = tsOf(m);
    const prev = firstRenter.get(t);
    if (!prev || at < prev.at) {
      firstRenter.set(t, { at, account: m.account_slug ?? prev?.account ?? "" });
    }
  }
  const firstReply = new Map<string, number>();
  for (const m of messages) {
    if (!isOwner(m)) continue;
    const t = String(m.thread_id);
    const base = firstRenter.get(t);
    if (!base) continue;
    const at = tsOf(m);
    if (at < base.at) continue;
    const prev = firstReply.get(t);
    if (prev === undefined || at < prev) firstReply.set(t, at);
  }
  const out: ThreadContact[] = [];
  for (const [threadId, base] of firstRenter) {
    out.push({
      threadId,
      accountSlug: base.account,
      firstRenterAt: base.at,
      firstOwnerReplyAt: firstReply.get(threadId),
    });
  }
  return out;
}

/** Index reservations by Hygglo order id, keeping the highest-value duplicate. */
export function indexReservationsByOrderId<T extends ReservationLite>(
  reservations: T[],
): Map<string, T> {
  const byId = new Map<string, T>();
  for (const r of reservations) {
    if (!r.hygglo_order_id) continue;
    const k = String(r.hygglo_order_id);
    const prev = byId.get(k);
    if (!prev || (r.net_to_owner_gbp ?? 0) > (prev.net_to_owner_gbp ?? 0)) byId.set(k, r);
  }
  return byId;
}

const BOOKED_STATUSES = new Set(["confirmed", "completed"]);

/** Terminal outcome for one inquiry. Exactly one key, always. */
export function classifyOutcome(res: ReservationLite | undefined): OutcomeKey {
  if (!res) return "no_request";
  const status = String(res.status ?? "");
  if (BOOKED_STATUSES.has(status)) return "booked";
  if (status === "pending_review") return "still_open";
  switch (String(res.hygglo_system_signal ?? "")) {
    case "owner_denied": return "owner_denied";
    case "auto_cancelled": return "expired";
    case "renter_cancelled": return "renter_cancelled";
    case "verification_failed": return "verification_failed";
    default: return "other";
  }
}

export type FunnelOutcome = {
  key: OutcomeKey;
  label: string;
  tone: "good" | "bad" | "neutral";
  count: number;
  share: number;
};

export type FunnelPayload = {
  window_days: number;
  account_slug: string | null;
  generated_at: number;
  /** PROGRESSION — strictly monotonic: inquiries >= requests >= booked. */
  inquiries: number;
  requests: number;
  booked: number;
  booked_net_gbp: number;
  request_rate: number;
  book_rate_of_requests: number;
  book_rate_of_inquiries: number;
  /** SERVICE — our responsiveness. Never a funnel stage. */
  reply: {
    eligible: number;
    replied: number;
    rate: number | null;
    awaiting_reply: number;
    too_new: number;
    p50_hours: number | null;
    p90_hours: number | null;
  };
  /** OUTCOME — mutually exclusive, sums to `inquiries`. */
  outcomes: FunnelOutcome[];
  top_leak: { key: OutcomeKey; label: string; count: number; share: number; advice: string } | null;
};

export type FunnelInput = {
  threads: ThreadContact[];
  reservationsByOrderId: Map<string, ReservationLite>;
  now: number;
  days: number;
  accountSlug: string | null;
};

function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return Math.round(sorted[i] * 10) / 10;
}

const rate = (num: number, den: number): number =>
  den > 0 ? Math.round((num / den) * 10000) / 10000 : 0;

export function computeConversationFunnel(input: FunnelInput): FunnelPayload {
  const { threads, reservationsByOrderId, now, days, accountSlug } = input;
  const cutoff = now - days * 86_400_000;
  const graceCutoff = now - REPLY_GRACE_MS;

  const counts = Object.fromEntries(OUTCOME_KEYS.map((k) => [k, 0])) as Record<OutcomeKey, number>;
  let inquiries = 0;
  let requests = 0;
  let booked = 0;
  let bookedNet = 0;
  let replyEligible = 0;
  let replied = 0;
  let awaitingReply = 0;
  let tooNew = 0;
  const lags: number[] = [];

  for (const t of threads) {
    if (t.firstRenterAt < cutoff) continue;
    if (accountSlug && t.accountSlug !== accountSlug) continue;
    inquiries++;

    // ── service axis ──────────────────────────────────────────────
    // An inquiry younger than the grace window has not had a fair chance of a
    // reply yet, so it must not drag the rate down. Those are surfaced as
    // `awaiting_reply` instead of silently counted as a miss.
    if (t.firstRenterAt <= graceCutoff) {
      replyEligible++;
      if (t.firstOwnerReplyAt !== undefined) replied++;
    } else {
      tooNew++;
      if (t.firstOwnerReplyAt === undefined) awaitingReply++;
    }
    if (t.firstOwnerReplyAt !== undefined) {
      lags.push((t.firstOwnerReplyAt - t.firstRenterAt) / 3_600_000);
    }

    // ── progression + outcome axes ────────────────────────────────
    const res = reservationsByOrderId.get(t.threadId);
    const outcome = classifyOutcome(res);
    counts[outcome]++;
    if (outcome !== "no_request") {
      requests++;
      if (outcome === "booked") {
        booked++;
        bookedNet += res?.net_to_owner_gbp ?? 0;
      }
    }
  }

  lags.sort((a, b) => a - b);

  const outcomes: FunnelOutcome[] = OUTCOME_KEYS.map((key) => ({
    key,
    label: OUTCOME_META[key].label,
    tone: OUTCOME_META[key].tone,
    count: counts[key],
    share: rate(counts[key], inquiries),
  })).filter((o) => o.count > 0);

  const leak = outcomes
    .filter((o) => OUTCOME_META[o.key].tone === "bad")
    .sort((a, b) => b.count - a.count)[0];

  return {
    window_days: days,
    account_slug: accountSlug,
    generated_at: now,
    inquiries,
    requests,
    booked,
    booked_net_gbp: Math.round(bookedNet * 100) / 100,
    request_rate: rate(requests, inquiries),
    book_rate_of_requests: rate(booked, requests),
    book_rate_of_inquiries: rate(booked, inquiries),
    reply: {
      eligible: replyEligible,
      replied,
      rate: replyEligible > 0 ? rate(replied, replyEligible) : null,
      awaiting_reply: awaitingReply,
      too_new: tooNew,
      p50_hours: quantile(lags, 0.5),
      p90_hours: quantile(lags, 0.9),
    },
    outcomes,
    top_leak: leak
      ? {
          key: leak.key,
          label: leak.label,
          count: leak.count,
          share: leak.share,
          advice: OUTCOME_META[leak.key].advice,
        }
      : null,
  };
}
