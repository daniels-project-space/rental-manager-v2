import { internalQuery } from "./_generated/server";

/**
 * TEMPORARY (2026-09-02) — reference implementation of the REWORKED funnel,
 * run against live data so the design can be judged on real numbers before
 * it is built for real.
 */
export const check = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const DAY = 86_400_000;
    const msgs = await ctx.db.query("hygglo_messages").collect(); // check-patterns:ok — diagnostic
    const reservations = await ctx.db.query("reservations").collect(); // check-patterns:ok — diagnostic

    const resByOrderId = new Map<string, (typeof reservations)[number]>();
    for (const r of reservations) {
      if (!r.hygglo_order_id) continue;
      const k = String(r.hygglo_order_id);
      const prev = resByOrderId.get(k);
      if (!prev || (r.net_to_owner_gbp ?? 0) > (prev.net_to_owner_gbp ?? 0)) resByOrderId.set(k, r);
    }

    const tsOf = (m: { hygglo_sent_at?: number; fetched_at: number }) =>
      typeof m.hygglo_sent_at === "number" && m.hygglo_sent_at > 0 ? m.hygglo_sent_at : m.fetched_at;

    const first = new Map<string, { renter?: number; ownerAfter?: number }>();
    for (const m of msgs) {
      const t = String(m.thread_id);
      let a = first.get(t);
      if (!a) { a = {}; first.set(t, a); }
      if (m.sender !== "owner") {
        const ts = tsOf(m);
        if (a.renter === undefined || ts < a.renter) a.renter = ts;
      }
    }
    for (const m of msgs) {
      if (m.sender !== "owner") continue;
      const a = first.get(String(m.thread_id));
      if (!a || a.renter === undefined) continue;
      const ts = tsOf(m);
      if (ts >= a.renter && (a.ownerAfter === undefined || ts < a.ownerAfter)) a.ownerAfter = ts;
    }

    const BOOKED = new Set(["confirmed", "completed"]);

    function build(days: number) {
      const lo = now - days * DAY;
      let inquiries = 0, replied = 0, requested = 0, booked = 0, revenue = 0;
      const outcome: Record<string, number> = {};
      const lags: number[] = [];
      for (const [tid, a] of first) {
        if (a.renter === undefined || a.renter < lo) continue;
        inquiries++;
        if (a.ownerAfter !== undefined) {
          replied++;
          lags.push((a.ownerAfter - a.renter) / 3_600_000);
        }
        const r = resByOrderId.get(tid);
        if (!r) { outcome["no request placed"] = (outcome["no request placed"] ?? 0) + 1; continue; }
        requested++;
        if (BOOKED.has(String(r.status))) {
          booked++;
          revenue += r.net_to_owner_gbp ?? 0;
          continue;
        }
        const sig = String((r as { hygglo_system_signal?: string }).hygglo_system_signal ?? "none");
        const label =
          sig === "owner_denied" ? "you denied"
          : sig === "renter_cancelled" ? "renter cancelled"
          : sig === "auto_cancelled" ? "expired (never paid)"
          : sig === "verification_failed" ? "verification failed"
          : String(r.status) === "pending_review" ? "still open"
          : `other (${sig})`;
        outcome[label] = (outcome[label] ?? 0) + 1;
      }
      lags.sort((x, y) => x - y);
      const q = (p: number) => (lags.length ? Math.round(lags[Math.floor(lags.length * p)] * 10) / 10 : null);
      return {
        window: `${days}d`,
        inquiries,
        replied,
        requested,
        booked,
        netRevenueGbp: Math.round(revenue * 100) / 100,
        replyRatePct: inquiries ? Math.round((replied / inquiries) * 1000) / 10 : 0,
        requestRatePct: inquiries ? Math.round((requested / inquiries) * 1000) / 10 : 0,
        bookRateOfRequestsPct: requested ? Math.round((booked / requested) * 1000) / 10 : 0,
        bookRateOfInquiriesPct: inquiries ? Math.round((booked / inquiries) * 1000) / 10 : 0,
        replyLagHours: { p50: q(0.5), p90: q(0.9) },
        lostBreakdown: Object.entries(outcome).sort((a, b) => b[1] - a[1]),
      };
    }

    return { windows: [build(7), build(30), build(90)] };
  },
});
