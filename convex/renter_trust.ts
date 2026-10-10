import { reviewTimestamp, reviewFingerprint } from "./lib/review_time";
import { profileImageUrl } from "./lib/profile_image";
/**
 * Renter trust resolver (2026-06-27) — THE correct rating source.
 *
 * The Hygglo order detail (GET /v4/my/orders/{id}) carries the renter's
 * RENTER-SIDE trust on `users.otherPart` + `customerStats`:
 *   users.otherPart.rating = { value, count }
 *   users.otherPart.customerCompletedOrders = N            (lifetime rentals)
 *   customerStats.reviews = [{ rating, text, relativeLabel, author.shortName }]
 *
 * The poller discarded all of this, and the old renter_reviews path used the
 * product-reviews(vendorId=…) endpoint which returns OWNER-side reviews (empty
 * for renters who never owned) — hence "no people show ratings". This resolves
 * the real rating + reviews and writes them to the renter.
 */
import { action, internalAction, internalQuery, internalMutation, internalActionOf } from "./owner_functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "../src/lib/hygglo-auth";

const TZ = "Europe/London";

export const trustInput = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const res = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", thread_id))
      .first();
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();
    const renter_id = res?.renter_id ?? conv?.renter_id ?? null;
    const account_slug = res?.account_slug ?? conv?.account_slug ?? null;
    return renter_id && account_slug ? { renter_id, account_slug } : null;
  },
});

export const applyTrust = internalMutation({
  args: {
    renter_id: v.id("renters"),
    rating: v.optional(v.number()),
    profile_image_url: v.optional(v.string()),
    review_count: v.optional(v.number()),
    total_rentals: v.optional(v.number()),
    reviews: v.array(
      v.object({
        rating: v.optional(v.number()),
        text: v.optional(v.string()),
        author: v.optional(v.string()),
        created_at: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { renter_id, rating, profile_image_url, review_count, total_rentals, reviews }) => {
    const patch: Record<string, unknown> = { trust_checked_at: Date.now() };
    if (profile_image_url) patch.profile_image_url = profile_image_url;
    // A 0-review renter has rating 0 on Hygglo — that's "new", NOT bad. Only
    // record a star rating when there are actually reviews behind it.
    const hasReviews = (review_count ?? 0) > 0;
    if (rating != null && hasReviews) patch.hygglo_rating = rating;
    if (hasReviews) patch.hygglo_review_count = review_count;
    else if (review_count === 0) {
      patch.hygglo_rating = undefined;
      patch.hygglo_review_count = 0;
    }
    if (total_rentals != null && Number.isInteger(total_rentals) && total_rentals >= 0) {
      patch.total_rentals_count = total_rentals;
      patch.platform_completed_rentals = total_rentals;
    }
    await ctx.db.patch(renter_id, patch);

    // Empty/partial order-detail review sets must not erase cached history.
    if (reviews.length) {
      const old = await ctx.db.query("renter_reviews").withIndex("by_renter", q=>q.eq("renter_id",renter_id)).collect();
      const byKey=new Map(old.map(row=>[reviewFingerprint(row),row]));
      let nextId=Math.min(-1,...old.map(row=>row.hygglo_review_id-1));
      for (const review of reviews) {
        const key=reviewFingerprint(review),existing=byKey.get(key);
        if(existing){
          // Keep a precise timestamp when the provider now returns a relative label.
          const created_at=review.created_at && (!existing.created_at || /^\d{4}-\d{2}-\d{2}T/.test(review.created_at)) ? review.created_at : existing.created_at;
          await ctx.db.patch(existing._id,{fetched_at:Date.now(),...(created_at?{created_at}:{})});
        } else {
          const id=await ctx.db.insert("renter_reviews",{renter_id,hygglo_review_id:nextId--,...review,fetched_at:Date.now()});
          byKey.set(key,{_id:id,...review} as typeof old[number]);
        }
      }
    }
    return { ok: true };
  },
});

async function fetchOrder(accountSlug: string, hyggloOrderId: string): Promise<any | null> {
  try {
    const creds = await getAccountCredentials(accountSlug);
    const token = await getHyggloAccessToken({ ...creds, accountSlug });
    const res = await fetch(
      `${HYGGLO_API_BASE}/v4/my/orders/${encodeURIComponent(hyggloOrderId)}?timezone=${encodeURIComponent(TZ)}`,
      { headers: hyggloAuthHeaders(token) },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export const resolveForThread = action({
  args: { thread_id: v.string() },
  handler: async (
    ctx,
    { thread_id },
  ): Promise<{ ok: boolean; rating?: number | null; reviews?: number }> => {
    const inp = await ctx.runQuery(internal.renter_trust.trustInput, { thread_id });
    if (!inp) return { ok: false };
    const d = await fetchOrder(inp.account_slug, thread_id);
    if (!d) return { ok: false };
    const other = d.users?.otherPart ?? {};
    const stats = d.customerStats ?? {};
    const rating =
      typeof other.rating?.value === "number"
        ? other.rating.value
        : typeof stats.averageRating === "number"
          ? stats.averageRating
          : undefined;
    const review_count =
      typeof other.rating?.count === "number"
        ? other.rating.count
        : typeof stats.totalReviews === "number"
          ? stats.totalReviews
          : undefined;
    const total_rentals =
      typeof other.customerCompletedOrders === "number"
        ? other.customerCompletedOrders
        : undefined;
    const reviews = Array.isArray(stats.reviews)
      ? stats.reviews
          .filter((r: any) => typeof r?.rating === "number")
          .map((r: any) => ({
            rating: r.rating as number,
            text: r.text ? String(r.text).trim() : undefined,
            author: r.author?.shortName ? String(r.author.shortName).trim() : undefined,
            created_at: reviewTimestamp(r),
          }))
      : [];
    await ctx.runMutation(internal.renter_trust.applyTrust, {
      renter_id: inp.renter_id,
      profile_image_url: profileImageUrl(other.profileImage),
      rating,
      review_count,
      total_rentals,
      reviews,
    });
    return { ok: true, rating: rating ?? null, reviews: reviews.length };
  },
});

/** Active threads (requests awaiting action + renter-last) whose renter hasn't
 *  had their trust checked yet. One thread per renter. */
export const untrustedThreads = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const out: string[] = [];
    const seen = new Set<string>();
    const consider = async (
      thread_id: string | undefined,
      renter_id: Id<"renters"> | undefined | null,
    ) => {
      if (!thread_id || !renter_id || out.length >= limit) return;
      if (seen.has(String(renter_id))) return;
      const renter = await ctx.db.get(renter_id);
      if (renter && (renter.trust_checked_at == null || (!renter.profile_image_url && (renter.trust_checked_at ?? 0) < Date.now() - 24 * 60 * 60 * 1000))) {
        seen.add(String(renter_id));
        out.push(thread_id);
      }
    };
    // Requests awaiting my approve/decline (often owner-last, so not below).
    const reqs = await ctx.db
      .query("reservations")
      .withIndex("by_awaiting_owner_action", (q) => q.eq("awaiting_owner_action", true))
      .take(200);
    for (const r of reqs) await consider(r.hygglo_order_id, r.renter_id);
    // Renter-last conversations.
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_last_sender", (q) => q.eq("last_sender", "renter"))
      .take(400);
    for (const c of convs) await consider(c.thread_id, c.renter_id);
    return out;
  },
});

/** Cron: backfill renter trust for active threads, capped per run. */
export const resolveActiveTrust = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<{ resolved: number }> => {
    const threads = await ctx.runQuery(internal.renter_trust.untrustedThreads, {
      limit: limit ?? 30,
    });
    let resolved = 0;
    for (const t of threads) {
      const r = await ctx.runAction(internal.renter_trust.__service_resolveForThread, {
        thread_id: t,
      });
      if (r.ok) resolved++;
    }
    return { resolved };
  },
});

// Privileged caller counterpart; shares the original handler and validators.
export const __service_resolveForThread = internalActionOf(resolveForThread);

/** Bounded read-only portrait hydration for the visible Quick Reply queue. */
export const profilePhotos = action({args:{thread_ids:v.array(v.string())},handler:async(ctx,{thread_ids}):Promise<Array<{thread_id:string;image_url:string|null}>>=>{
 if(thread_ids.length>12)throw Error("At most twelve portraits per page");
 const results:Array<{thread_id:string;image_url:string|null}>=[];
 for(const thread_id of [...new Set(thread_ids)]) {
   const input=await ctx.runQuery(internal.renter_trust.trustInput,{thread_id});
   const tile = input ? null : await ctx.runQuery(internal.replyInbox.__service_getThreadById,{thread_id});
   const account = input?.account_slug ?? tile?.account_slug;
   if(!account){results.push({thread_id,image_url:null});continue;}
   const detail=await fetchOrder(account,thread_id);
   results.push({thread_id,image_url:profileImageUrl(detail?.users?.otherPart?.profileImage)??null});
 }
 return results;
}});
