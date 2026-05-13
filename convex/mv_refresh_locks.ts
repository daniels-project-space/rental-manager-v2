/**
 * Wave 4 — MV refresh concurrency control.
 *
 * Pattern: workflow takes a lock per (mvName, account) before invoking
 * the corresponding MV refresher. Releases on completion. Stale locks
 * (>5 min) are auto-stolen — they always mean a crashed or timed-out
 * worker, NEVER a healthy long-running refresh (our MV refreshers are
 * sub-second on production datasets).
 *
 * Q5 (Wave 3 open): debounce. If 10 simultaneous renters trigger
 * `refresh` from message handlers, the first wins the lock; the rest
 * skip-and-return-cached.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const STALE_LOCK_MS = 5 * 60_000; // 5 min

export const tryAcquire = mutation({
  args: {
    mvName: v.string(),
    account: v.string(),
    lockedBy: v.string(), // workflow run id or caller tag
  },
  handler: async (ctx, { mvName, account, lockedBy }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("mv_refresh_locks")
      .withIndex("by_mv_account", (q) =>
        q.eq("mvName", mvName).eq("account", account),
      )
      .first();

    if (existing) {
      const age = now - existing.lockedAt;
      if (age < STALE_LOCK_MS) {
        return { acquired: false, reason: "held", heldBy: existing.lockedBy, ageMs: age };
      }
      // Stale — steal it.
      await ctx.db.patch(existing._id, { lockedAt: now, lockedBy });
      return { acquired: true, reason: "stale_stolen" };
    }

    await ctx.db.insert("mv_refresh_locks", { mvName, account, lockedAt: now, lockedBy });
    return { acquired: true, reason: "fresh" };
  },
});

export const release = mutation({
  args: {
    mvName: v.string(),
    account: v.string(),
    lockedBy: v.string(),
  },
  handler: async (ctx, { mvName, account, lockedBy }) => {
    const existing = await ctx.db
      .query("mv_refresh_locks")
      .withIndex("by_mv_account", (q) =>
        q.eq("mvName", mvName).eq("account", account),
      )
      .first();
    if (!existing) return { released: false, reason: "not_found" };
    if (existing.lockedBy !== lockedBy) {
      // Lost ownership (was stolen). Don't delete someone else's lock.
      return { released: false, reason: "owner_mismatch" };
    }
    await ctx.db.delete(existing._id);
    return { released: true };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("mv_refresh_locks").collect();
  },
});
