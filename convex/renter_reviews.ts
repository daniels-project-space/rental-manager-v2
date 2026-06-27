/**
 * Renter reviews (2026-06-27). Individual reviews a renter RECEIVED, pulled from
 * Hygglo's PUBLIC endpoint:
 *   GET https://api.hygglo.com/api/v2/product-reviews?vendorId=<hygglo_user_id>
 *   → { data: [{ id, rating, text, createdAt, author:{shortName} }] }   (no auth)
 *
 * Cached in `renter_reviews` so the Quick Reply chat can show them on star-click
 * and flag any review under 4★. Refreshed on demand (action).
 */
import { v } from "convex/values";
import {
  action,
  query,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";

const HYGGLO_API = "https://api.hygglo.com/api";

type RawReview = {
  id?: number;
  rating?: number | null;
  text?: string | null;
  createdAt?: string;
  author?: { shortName?: string } | null;
};

async function renterFromThread(
  ctx: { db: import("./_generated/server").QueryCtx["db"] },
  thread_id: string,
) {
  const conv = await ctx.db
    .query("conversations")
    .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
    .first();
  const res = await ctx.db
    .query("reservations")
    .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", thread_id))
    .first();
  return res?.renter_id ?? conv?.renter_id ?? null;
}

export const renterForThread = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const renterId = await renterFromThread(ctx, thread_id);
    if (!renterId) return null;
    const renter = await ctx.db.get(renterId);
    if (!renter) return null;
    return { renter_id: renterId, hygglo_user_id: renter.hygglo_user_id ?? null };
  },
});

export const store = internalMutation({
  args: {
    renter_id: v.id("renters"),
    reviews: v.array(
      v.object({
        hygglo_review_id: v.number(),
        rating: v.optional(v.number()),
        text: v.optional(v.string()),
        author: v.optional(v.string()),
        created_at: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { renter_id, reviews }) => {
    const now = Date.now();
    for (const r of reviews) {
      const existing = await ctx.db
        .query("renter_reviews")
        .withIndex("by_renter_review", (q) =>
          q.eq("renter_id", renter_id).eq("hygglo_review_id", r.hygglo_review_id),
        )
        .first();
      const doc = { renter_id, ...r, fetched_at: now };
      if (existing) await ctx.db.patch(existing._id, doc);
      else await ctx.db.insert("renter_reviews", doc);
    }
  },
});

export const refreshForThread = action({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }): Promise<{ count: number }> => {
    const info = await ctx.runQuery(internal.renter_reviews.renterForThread, {
      thread_id,
    });
    if (!info || !info.hygglo_user_id) return { count: 0 };
    let rows: RawReview[] = [];
    try {
      const res = await fetch(
        `${HYGGLO_API}/v2/product-reviews?vendorId=${encodeURIComponent(info.hygglo_user_id)}&$limit=50&$skip=0`,
        { headers: { Country: "GB", "User-Client": "Hygglo-web" } },
      );
      if (res.ok) {
        const env = (await res.json()) as { data?: RawReview[] };
        rows = Array.isArray(env?.data) ? env.data : [];
      }
    } catch {
      /* network — return whatever's cached */
    }
    const reviews = rows
      .filter((r) => typeof r.id === "number")
      .map((r) => ({
        hygglo_review_id: r.id as number,
        rating: typeof r.rating === "number" ? r.rating : undefined,
        text: r.text?.trim() || undefined,
        author: r.author?.shortName || undefined,
        created_at: r.createdAt || undefined,
      }));
    if (reviews.length)
      await ctx.runMutation(internal.renter_reviews.store, {
        renter_id: info.renter_id,
        reviews,
      });
    return { count: reviews.length };
  },
});

export const getForThread = query({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const renterId = await renterFromThread(ctx, thread_id);
    if (!renterId) return { reviews: [], lowCount: 0, fetched: false };
    const rows = await ctx.db
      .query("renter_reviews")
      .withIndex("by_renter", (q) => q.eq("renter_id", renterId))
      .collect();
    // Lowest-rated first (the ones to read), then most recent.
    rows.sort(
      (a, b) =>
        (a.rating ?? 5) - (b.rating ?? 5) ||
        (b.created_at ?? "").localeCompare(a.created_at ?? ""),
    );
    return {
      reviews: rows.map((r) => ({
        id: String(r._id),
        rating: r.rating ?? null,
        text: r.text ?? null,
        author: r.author ?? null,
        created_at: r.created_at ?? null,
      })),
      lowCount: rows.filter((r) => r.rating != null && r.rating < 4).length,
      fetched: rows.length > 0,
    };
  },
});
