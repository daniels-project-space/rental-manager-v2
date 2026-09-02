import { describe, expect, it } from "vitest";
import {
  type MessageLite,
  type ReservationLite,
  OUTCOME_KEYS,
  buildThreadContacts,
  classifyOutcome,
  computeConversationFunnel,
  indexReservationsByOrderId,
} from "./conversation_funnel";

const NOW = Date.parse("2026-09-02T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function msg(over: Partial<MessageLite> & { thread_id: string }): MessageLite {
  return {
    account_slug: "leo",
    sender: "renter",
    hygglo_sent_at: NOW - 10 * DAY,
    fetched_at: NOW - 10 * DAY,
    ...over,
  };
}

function run(
  messages: MessageLite[],
  reservations: ReservationLite[],
  days = 30,
  accountSlug: string | null = null,
) {
  return computeConversationFunnel({
    threads: buildThreadContacts(messages),
    reservationsByOrderId: indexReservationsByOrderId(reservations),
    now: NOW,
    days,
    accountSlug,
  });
}

describe("buildThreadContacts", () => {
  it("takes the EARLIEST renter message as first contact", () => {
    const t = buildThreadContacts([
      msg({ thread_id: "1", hygglo_sent_at: NOW - 5 * DAY }),
      msg({ thread_id: "1", hygglo_sent_at: NOW - 9 * DAY }),
      msg({ thread_id: "1", hygglo_sent_at: NOW - 7 * DAY }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].firstRenterAt).toBe(NOW - 9 * DAY);
  });

  it("ignores an owner message that PREDATES the renter's first line", () => {
    // An owner message sent before the renter ever wrote is not a reply to it.
    const t = buildThreadContacts([
      msg({ thread_id: "1", sender: "owner", hygglo_sent_at: NOW - 12 * DAY }),
      msg({ thread_id: "1", hygglo_sent_at: NOW - 10 * DAY }),
    ]);
    expect(t[0].firstOwnerReplyAt).toBeUndefined();
  });

  it("takes the first owner reply after first contact", () => {
    const t = buildThreadContacts([
      msg({ thread_id: "1", hygglo_sent_at: NOW - 10 * DAY }),
      msg({ thread_id: "1", sender: "owner", hygglo_sent_at: NOW - 8 * DAY }),
      msg({ thread_id: "1", sender: "owner", hygglo_sent_at: NOW - 9 * DAY }),
    ]);
    expect(t[0].firstOwnerReplyAt).toBe(NOW - 9 * DAY);
  });

  it("drops owner-only threads — no renter contact means no inquiry", () => {
    const t = buildThreadContacts([msg({ thread_id: "1", sender: "owner" })]);
    expect(t).toHaveLength(0);
  });

  it("falls back to fetched_at when hygglo_sent_at is missing", () => {
    const t = buildThreadContacts([
      msg({ thread_id: "1", hygglo_sent_at: undefined, fetched_at: NOW - 3 * DAY }),
    ]);
    expect(t[0].firstRenterAt).toBe(NOW - 3 * DAY);
  });
});

describe("classifyOutcome", () => {
  it("maps every hygglo_system_signal to exactly one bucket", () => {
    expect(classifyOutcome(undefined)).toBe("no_request");
    expect(classifyOutcome({ status: "confirmed" })).toBe("booked");
    expect(classifyOutcome({ status: "completed" })).toBe("booked");
    expect(classifyOutcome({ status: "pending_review" })).toBe("still_open");
    expect(classifyOutcome({ status: "cancelled", hygglo_system_signal: "owner_denied" })).toBe("owner_denied");
    expect(classifyOutcome({ status: "cancelled", hygglo_system_signal: "auto_cancelled" })).toBe("expired");
    expect(classifyOutcome({ status: "cancelled", hygglo_system_signal: "renter_cancelled" })).toBe("renter_cancelled");
    expect(classifyOutcome({ status: "cancelled", hygglo_system_signal: "verification_failed" })).toBe("verification_failed");
    expect(classifyOutcome({ status: "cancelled" })).toBe("other");
  });

  it("prefers a real booking over any stale signal on the row", () => {
    expect(
      classifyOutcome({ status: "confirmed", hygglo_system_signal: "owner_denied" }),
    ).toBe("booked");
  });
});

describe("computeConversationFunnel — invariants", () => {
  const messages = [
    // booked
    msg({ thread_id: "b1" }),
    msg({ thread_id: "b1", sender: "owner", hygglo_sent_at: NOW - 10 * DAY + 2 * HOUR }),
    // denied
    msg({ thread_id: "d1" }),
    // expired
    msg({ thread_id: "e1" }),
    // never requested
    msg({ thread_id: "n1" }),
  ];
  const reservations: ReservationLite[] = [
    { hygglo_order_id: "b1", status: "confirmed", net_to_owner_gbp: 100 },
    { hygglo_order_id: "d1", status: "cancelled", hygglo_system_signal: "owner_denied" },
    { hygglo_order_id: "e1", status: "cancelled", hygglo_system_signal: "auto_cancelled" },
  ];

  it("outcomes are exhaustive — they sum back to inquiries", () => {
    const f = run(messages, reservations);
    expect(f.inquiries).toBe(4);
    expect(f.outcomes.reduce((s, o) => s + o.count, 0)).toBe(f.inquiries);
  });

  it("progression is monotonic: inquiries >= requests >= booked", () => {
    const f = run(messages, reservations);
    expect(f.inquiries).toBeGreaterThanOrEqual(f.requests);
    expect(f.requests).toBeGreaterThanOrEqual(f.booked);
    expect(f.requests).toBe(3);
    expect(f.booked).toBe(1);
    expect(f.booked_net_gbp).toBe(100);
  });

  it("every rate is a real 0–1 — no >100% hacks needed", () => {
    const f = run(messages, reservations);
    for (const r of [f.request_rate, f.book_rate_of_requests, f.book_rate_of_inquiries]) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    }
    for (const o of f.outcomes) expect(o.share).toBeLessThanOrEqual(1);
  });

  it("names the biggest BAD outcome as the leak, never 'booked'", () => {
    const f = run(
      [...messages, msg({ thread_id: "d2" }), msg({ thread_id: "d3" })],
      [
        ...reservations,
        { hygglo_order_id: "d2", status: "cancelled", hygglo_system_signal: "owner_denied" },
        { hygglo_order_id: "d3", status: "cancelled", hygglo_system_signal: "owner_denied" },
      ],
    );
    expect(f.top_leak?.key).toBe("owner_denied");
    expect(f.top_leak?.count).toBe(3);
    expect(f.top_leak?.advice).toContain("stock");
  });

  it("is empty-safe rather than NaN", () => {
    const f = run([], []);
    expect(f.inquiries).toBe(0);
    expect(f.request_rate).toBe(0);
    expect(f.reply.rate).toBeNull();
    expect(f.top_leak).toBeNull();
    expect(f.outcomes).toEqual([]);
  });
});

describe("computeConversationFunnel — cohort window", () => {
  it("cohorts on first RENTER CONTACT, not on reservation dates", () => {
    const old = msg({ thread_id: "old", hygglo_sent_at: NOW - 60 * DAY });
    const recent = msg({ thread_id: "new", hygglo_sent_at: NOW - 2 * DAY });
    const res: ReservationLite[] = [
      { hygglo_order_id: "old", status: "confirmed", net_to_owner_gbp: 10 },
      { hygglo_order_id: "new", status: "confirmed", net_to_owner_gbp: 20 },
    ];
    expect(run([old, recent], res, 30).booked).toBe(1);
    expect(run([old, recent], res, 30).booked_net_gbp).toBe(20);
    expect(run([old, recent], res, 90).booked).toBe(2);
  });

  it("scopes by account", () => {
    const a = msg({ thread_id: "a", account_slug: "leo" });
    const b = msg({ thread_id: "b", account_slug: "dbcinema" });
    expect(run([a, b], [], 30, "leo").inquiries).toBe(1);
    expect(run([a, b], [], 30, null).inquiries).toBe(2);
  });
});

describe("computeConversationFunnel — reply grace window", () => {
  it("excludes inquiries younger than 24h from the reply RATE", () => {
    // Two old inquiries (one replied) + one brand-new unreplied. The new one
    // must not drag the rate to 33% — it has not had a fair chance yet.
    const f = run(
      [
        msg({ thread_id: "o1", hygglo_sent_at: NOW - 5 * DAY }),
        msg({ thread_id: "o1", sender: "owner", hygglo_sent_at: NOW - 5 * DAY + HOUR }),
        msg({ thread_id: "o2", hygglo_sent_at: NOW - 5 * DAY }),
        msg({ thread_id: "fresh", hygglo_sent_at: NOW - 2 * HOUR }),
      ],
      [],
    );
    expect(f.inquiries).toBe(3);
    expect(f.reply.eligible).toBe(2);
    expect(f.reply.replied).toBe(1);
    expect(f.reply.rate).toBe(0.5);
    expect(f.reply.too_new).toBe(1);
    expect(f.reply.awaiting_reply).toBe(1);
  });

  it("a young inquiry we ALREADY answered is not 'awaiting reply'", () => {
    const f = run(
      [
        msg({ thread_id: "fresh", hygglo_sent_at: NOW - 2 * HOUR }),
        msg({ thread_id: "fresh", sender: "owner", hygglo_sent_at: NOW - HOUR }),
      ],
      [],
    );
    expect(f.reply.too_new).toBe(1);
    expect(f.reply.awaiting_reply).toBe(0);
    expect(f.reply.rate).toBeNull(); // nothing eligible yet
  });

  it("reports reply latency percentiles in hours", () => {
    const build = (id: string, lagH: number) => [
      msg({ thread_id: id, hygglo_sent_at: NOW - 5 * DAY }),
      msg({ thread_id: id, sender: "owner", hygglo_sent_at: NOW - 5 * DAY + lagH * HOUR }),
    ];
    const f = run([...build("a", 1), ...build("b", 2), ...build("c", 30)], []);
    expect(f.reply.p50_hours).toBe(2);
    expect(f.reply.p90_hours).toBe(30);
  });
});

describe("regression guards for the old funnel's defects", () => {
  it("never reports a denial rate derived from undated bulk records", () => {
    // denial_records had 1081 rows all stamped 2026-05-10, producing 99.7% /
    // 94.3% / 53.1% for the SAME data at 7/30/90d. The payload must not carry
    // any such field — denials are now the dated `owner_denied` outcome.
    const f = run([msg({ thread_id: "x" })], []);
    expect(f).not.toHaveProperty("denialRate");
    expect(f).not.toHaveProperty("denials");
    expect(OUTCOME_KEYS).toContain("owner_denied");
  });

  it("window length changes the cohort, not the definition", () => {
    // The old denial rate moved purely because the window moved. Here, a window
    // with identical content must produce identical rates.
    const m = [msg({ thread_id: "a", hygglo_sent_at: NOW - 2 * DAY })];
    const r: ReservationLite[] = [
      { hygglo_order_id: "a", status: "cancelled", hygglo_system_signal: "owner_denied" },
    ];
    const d7 = run(m, r, 7);
    const d30 = run(m, r, 30);
    expect(d7.inquiries).toBe(d30.inquiries);
    expect(d7.outcomes).toEqual(d30.outcomes);
  });
});
