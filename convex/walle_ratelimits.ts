/**
 * Phase 9 — WallE rate-limiter buckets.
 *
 * Three named limits (per-user, token bucket):
 *   walle_chat    — 30 req/hour   (interactive streaming)
 *   walle_joke    — 10 req/hour   (server hard-caps at 2/day in recordJoke; this
 *                                  is a belt-and-suspenders guard against client
 *                                  bugs that hammer the route)
 *   walle_compact —  6 req/hour   (compaction is rare; protects against
 *                                  pathological unmount loops)
 *
 * Routes call `checkWalleLimit` from a Convex action / HTTP handler before
 * any LLM call. Returns `{ ok, retryAfter }` (`retryAfter` is ms-until-reset
 * when `ok === false`).
 *
 * Usage from a Next.js route:
 *   import { ConvexHttpClient } from "convex/browser";
 *   const convex = new ConvexHttpClient(url);
 *   const { ok, retryAfter } = await convex.mutation(
 *     api.walle_ratelimits.checkWalleLimit,
 *     { bucket: "walle_chat", key: userId }
 *   );
 *   if (!ok) return Response.json({ error: "rate_limited", retryAfter }, { status: 429 });
 */
import { components } from "./_generated/api";
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { RateLimiter, MINUTE, HOUR } from "@convex-dev/rate-limiter";

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  walle_chat: {
    kind: "token bucket",
    rate: 30,
    period: HOUR,
    capacity: 30,
  },
  walle_joke: {
    kind: "token bucket",
    rate: 10,
    period: HOUR,
    capacity: 10,
  },
  walle_compact: {
    kind: "token bucket",
    rate: 6,
    period: HOUR,
    capacity: 6,
  },
});

/**
 * Public mutation: consumes 1 token from the named bucket for the given key.
 * Returns { ok, retryAfter } — `retryAfter` is milliseconds when blocked.
 *
 * `key` is the per-user identity (sessionId fallback if no auth yet).
 */
export const checkWalleLimit = mutation({
  args: {
    bucket: v.union(
      v.literal("walle_chat"),
      v.literal("walle_joke"),
      v.literal("walle_compact"),
    ),
    key: v.string(),
  },
  handler: async (ctx, { bucket, key }) => {
    const status = await rateLimiter.limit(ctx, bucket, { key });
    if (status.ok) {
      return { ok: true as const, retryAfter: 0 };
    }
    return { ok: false as const, retryAfter: status.retryAfter ?? MINUTE };
  },
});
