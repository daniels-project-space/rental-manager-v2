import { internalAction, internalMutation, internalQuery, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

/**
 * What actually goes out together, from our own completed rentals.
 *
 * Why: asked "what do most people rent alongside it?", the bot answered with a
 * confident list of "the most common additions" while holding no pairing data
 * whatsoever. That is a factual claim about OUR rental history, invented — the
 * same class as a made-up price, and less obvious because it sounds like
 * ordinary sales patter.
 *
 * The evidence exists: across completed/confirmed reservations the Sony FX3
 * ships with the GM 24-70mm 141 times, the A7 III with the same lens 39, the
 * GoPro with suction cups 13.
 *
 * Materialised because the source is ~3.7k reservations with expanded item
 * arrays — far too much to scan on every draft. Refreshed weekly alongside the
 * price re-sync; pairings move over months, not hours.
 */

/**
 * Canonical names carry decorations that split one item across several keys —
 * "Sony FX3", "Sony FX3 [camera]", "Sony FX3 [camera] — Camera body in padded
 * case" are the same camera, and counting them separately buried the real
 * pairing counts across three rows.
 */
export function normalisePairName(raw: string): string {
  return raw
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .split(/\s+[—–-]\s+/)[0]
    .replace(/\s+/g, " ")
    .trim();
}

export const compute = internalQuery({
  args: {},
  handler: async (ctx) => {
    const REAL = new Set(["confirmed", "completed", "active", "returned"]);
    const reservations = await ctx.db.query("reservations").collect();
    const pairs = new Map<string, Map<string, number>>();
    let counted = 0;
    for (const r of reservations) {
      if (!REAL.has((r.status ?? "").toLowerCase())) continue;
      const names = [
        ...new Set(
          (r.expanded_items ?? [])
            .map((i) => normalisePairName(String(i.item_name_canonical ?? "")))
            .filter(Boolean),
        ),
      ];
      if (names.length < 2) continue;
      counted++;
      for (const a of names)
        for (const b of names) {
          if (a === b) continue;
          const m = pairs.get(a) ?? new Map<string, number>();
          m.set(b, (m.get(b) ?? 0) + 1);
          pairs.set(a, m);
        }
    }
    // Only keep pairings seen enough times to be worth stating as a pattern.
    // Below this a "most people take X" claim is one or two bookings, which is
    // not a pattern and should not be said out loud.
    const MIN = 3;
    return {
      reservations_counted: counted,
      rows: [...pairs.entries()]
        .map(([name, m]) => ({
          item_name_canonical: name,
          pairs: [...m.entries()]
            .filter(([, n]) => n >= MIN)
            .sort((x, y) => y[1] - x[1])
            .slice(0, 5)
            .map(([with_name, count]) => ({ with_name, count })),
        }))
        .filter((r) => r.pairs.length > 0),
    };
  },
});

export const write = internalMutation({
  args: {
    rows: v.array(
      v.object({
        item_name_canonical: v.string(),
        pairs: v.array(v.object({ with_name: v.string(), count: v.number() })),
      }),
    ),
  },
  handler: async (ctx, { rows }) => {
    for (const old of await ctx.db.query("mv_item_pairings").collect())
      await ctx.db.delete(old._id);
    const now = Date.now();
    for (const r of rows)
      await ctx.db.insert("mv_item_pairings", { ...r, updated_at: now });
    return { written: rows.length };
  },
});

export const refresh = internalAction({
  args: {},
  handler: async (ctx): Promise<unknown> => {
    const c = (await ctx.runQuery(internal.mv.item_pairings.compute, {})) as {
      reservations_counted: number;
      rows: Array<{
        item_name_canonical: string;
        pairs: Array<{ with_name: string; count: number }>;
      }>;
    };
    const res = (await ctx.runMutation(internal.mv.item_pairings.write, {
      rows: c.rows,
    })) as { written: number };
    return { reservations_counted: c.reservations_counted, items_with_pairings: res.written };
  },
});

/** Top real pairings for an item — empty when we have no pattern to report. */
export const get = query({
  args: { item_name: v.string() },
  handler: async (ctx, { item_name }) => {
    const key = normalisePairName(item_name);
    const row = await ctx.db
      .query("mv_item_pairings")
      .withIndex("by_name", (q) => q.eq("item_name_canonical", key))
      .unique();
    return row?.pairs ?? [];
  },
});
