import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Reservations the bot cannot price, because they carry no resolved items.
 *
 * `hasItemGrounding` is derived from a reservation's resolved items. Without
 * them UNGROUNDED_PRICE fires CRITICAL on any £ figure, so the whole reply is
 * withheld — the renter asks "what's the extra day cost?" and gets silence.
 *
 * The number that matters is not the whole table (which includes years of
 * cancelled enquiries) but the LIVE ones: confirmed and in-progress bookings,
 * where a post-booking conversation is actually happening.
 */
export const check = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("reservations").collect();
    const byBucket: Record<
      string,
      { total: number; without_items: number; sample: string[] }
    > = {};
    for (const r of all) {
      const status = (r.status ?? "(none)").toLowerCase();
      const b = (byBucket[status] ??= { total: 0, without_items: 0, sample: [] });
      b.total++;
      if ((r.expanded_items ?? []).length === 0) {
        b.without_items++;
        if (b.sample.length < 3)
          b.sample.push(
            `${r.hygglo_order_id ?? "?"} ${(r.renter_name ?? "").slice(0, 14)} ${r.start_date ?? ""}`,
          );
      }
    }
    // Live = a conversation could plausibly still be happening on it.
    const LIVE = ["confirmed", "ongoing", "active"];
    const live = LIVE.reduce(
      (acc, k) => {
        const b = byBucket[k];
        if (b) {
          acc.total += b.total;
          acc.without_items += b.without_items;
        }
        return acc;
      },
      { total: 0, without_items: 0 },
    );
    // Recency matters more than status: a "confirmed" booking whose dates
    // passed months ago is a stale row, not a conversation in progress.
    const today = new Date().toISOString().slice(0, 10);
    const confirmedish = all.filter((r) =>
      ["confirmed", "ongoing", "active"].includes((r.status ?? "").toLowerCase()),
    );
    const isFutureOrRecent = (r: { end_date?: string }) =>
      (r.end_date ?? "") >= today;
    const liveNow = confirmedish.filter(isFutureOrRecent);
    const stale = confirmedish.filter((r) => !isFutureOrRecent(r));

    return {
      today,
      confirmed_current_or_future: {
        total: liveNow.length,
        without_items: liveNow.filter((r) => (r.expanded_items ?? []).length === 0).length,
      },
      confirmed_but_dates_passed: {
        total: stale.length,
        without_items: stale.filter((r) => (r.expanded_items ?? []).length === 0).length,
      },
      by_status: Object.fromEntries(
        Object.entries(byBucket)
          .sort((a, b) => b[1].total - a[1].total)
          .map(([k, v]) => [
            k,
            `${v.without_items}/${v.total} missing resolved items`,
          ]),
      ),
      live_bookings: live,
      samples_missing: Object.entries(byBucket)
        .filter(([k]) => LIVE.includes(k))
        .flatMap(([, v]) => v.sample),
    };
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.diag_grounding_gap.check, {}),
});
