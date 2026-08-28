import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Data that could change the OUTCOME of a conversation, not just its accuracy.
 *
 * The last audit fixed questions the bot answered wrongly. This one looks for
 * moments where the bot answers correctly and still loses the booking:
 *
 *  - dates are taken and it says "no" instead of offering the nearest free window
 *  - a returning renter is greeted like a stranger
 *  - a first-timer asks "are you any good?" and gets nothing, while 5.5k reviews sit here
 *  - "what else do I need?" answered by guesswork rather than what actually
 *    goes out together
 *
 * Read-only; counts only.
 */
export const check = internalQuery({
  args: {},
  handler: async (ctx) => {
    const [reviews, renters, reservations, canned, holds] = await Promise.all([
      ctx.db.query("renter_reviews").collect(),
      ctx.db.query("renters").collect(),
      ctx.db.query("reservations").collect(),
      ctx.db.query("canned_responses").collect(),
      ctx.db.query("calendar_holds").collect(),
    ]);

    // Repeat business — counted from RESERVATIONS THAT ACTUALLY HAPPENED.
    //
    // `renters.total_rentals_count` is NOT this. It is the renter's
    // platform-wide Hygglo profile stat (alongside hygglo_rating), so it counts
    // hire from every owner on Hygglo, not from us: the top rows read "108
    // rentals, £0 spend" and "76 rentals, £96 spend", which is incoherent as
    // business with us and is the giveaway. Counting >1 on that field claimed
    // 726 regulars and was wrong.
    const statusOf = (r: { status?: string }) => (r.status ?? "").toLowerCase();
    const REAL = new Set(["confirmed", "completed", "active", "returned"]);
    const realRes = reservations.filter((r) => REAL.has(statusOf(r)));
    const byRenterAll = new Map<string, number>();
    const byRenterReal = new Map<string, number>();
    for (const r of reservations) {
      const k = String(r.renter_id ?? r.renter_name ?? "");
      if (!k) continue;
      byRenterAll.set(k, (byRenterAll.get(k) ?? 0) + 1);
    }
    for (const r of realRes) {
      const k = String(r.renter_id ?? r.renter_name ?? "");
      if (!k) continue;
      byRenterReal.set(k, (byRenterReal.get(k) ?? 0) + 1);
    }
    const repeatAnyRow = [...byRenterAll.values()].filter((n) => n > 1).length;
    const repeatReal = [...byRenterReal.values()].filter((n) => n > 1).length;
    const repeat3Plus = [...byRenterReal.values()].filter((n) => n > 2).length;
    const statusCounts: Record<string, number> = {};
    for (const r of reservations) {
      const s = statusOf(r) || "(none)";
      statusCounts[s] = (statusCounts[s] ?? 0) + 1;
    }

    // Reviews: are they OURS (about our gear) and do they carry a rating?
    const withRating = reviews.filter(
      (r) => typeof (r as { rating?: number }).rating === "number",
    );
    const sample = reviews.slice(0, 3).map((r) => {
      const x = r as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(x)
          .filter(([k]) => !k.startsWith("_"))
          .slice(0, 8)
          .map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 70) : v]),
      );
    });

    // Co-rental: which items actually go out together?
    const pairCount = new Map<string, number>();
    for (const r of reservations) {
      // The field is item_name_canonical — reading `.name` returned nothing and
      // made real co-rental data look absent.
      if (!REAL.has(statusOf(r))) continue;
      const names = [
        ...new Set(
          (r.expanded_items ?? [])
            .map((i) => String(i.item_name_canonical ?? ""))
            .filter(Boolean),
        ),
      ];
      for (let a = 0; a < names.length; a++)
        for (let b = a + 1; b < names.length; b++) {
          const key = [names[a], names[b]].sort().join(" + ");
          pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
        }
    }
    const topPairs = [...pairCount.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 8)
      .map(([k, n]) => `${k} (${n})`);

    // A real returning renter to probe with — the bot currently greets all
    // 726 of these exactly like a first-timer.
    const repeatSamples = [...byRenterReal.entries()]
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, n]) => {
        const r = renters.find((x) => String(x._id) === k);
        return {
          key: k.slice(0, 34),
          real_rentals_with_us: n,
          display_name: r?.display_name ?? "(by name only)",
          platform_count: r?.total_rentals_count ?? null,
        };
      });

    return {
      repeat_renter_samples: repeatSamples,
      reviews: {
        rows: reviews.length,
        with_rating: withRating.length,
        sample,
      },
      renters: {
        total: renters.length,
        // Platform-wide field, NOT business with us — kept only to show the gap.
        misleading_total_rentals_count_gt1: renters.filter(
          (r) => (r.total_rentals_count ?? 0) > 1,
        ).length,
        repeat_by_any_reservation_row: repeatAnyRow,
        repeat_by_real_rentals: repeatReal,
        three_plus_real_rentals: repeat3Plus,
      },
      reservation_status_counts: statusCounts,
      reservations: {
        total: reservations.length,
        with_expanded_items: reservations.filter((r) => (r.expanded_items ?? []).length > 0)
          .length,
      },
      co_rental_top_pairs: topPairs,
      canned_responses: canned.map((c) => ({
        // Shape unknown — show the first few fields so we can judge usefulness.
        ...Object.fromEntries(
          Object.entries(c as Record<string, unknown>)
            .filter(([k]) => !k.startsWith("_"))
            .map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 80) : v]),
        ),
      })),
      calendar_holds: holds.length,
    };
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.diag_conv_levers.check, {}),
});
