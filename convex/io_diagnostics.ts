import { internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { __service_getReplyQueue, __service_getThreadById, loadReplyTileMessages } from "./replyInbox";
import { profileReadonlyDatabase } from "./lib/profile_readonly";
import { canonicalCacheJson } from "./lib/lossless_cache_codec";
import { orderedReplyMessages } from "./lib/reply_message_order";
import { readOnlineListing } from "./lib/online_listing_read";

type ReadonlyHandler = { _handler: (ctx: QueryCtx, args: Record<string, unknown>) => Promise<unknown> };

/** Admin-only, opt-in attribution. Never used by application requests. */
export const profileReplyReads = internalQuery({
  args: { kind: v.union(v.literal("queue"), v.literal("thread")), args: v.any() },
  handler: async (ctx, request) => {
    if (!request.args || typeof request.args !== "object" || Array.isArray(request.args)) throw new Error("Expected query arguments");
    if (request.kind === "thread" && typeof request.args.thread_id !== "string") throw new Error("Expected a thread_id");
    const profile = profileReadonlyDatabase(ctx.db);
    const service = request.kind === "queue" ? __service_getReplyQueue : __service_getThreadById;
    const result = await (service as unknown as ReadonlyHandler)._handler({ ...ctx, db: profile.db }, {
      ...request.args, ...(request.kind === "queue" ? { _bypassMv: true } : {}),
    });
    return { version: 1, kind: request.kind, estimatedDocumentReads: profile.report(),
      resultCount: Array.isArray(result) ? result.length : null,
      measurement: "Returned document JSON bytes and read calls; use Completion usageStats for billed I/O." };
  },
});

/** Compare real input records at one database snapshot, without assembling two
 * complete queues inside one CPU-limited diagnostic query. */
export const auditReplyInputReads = internalQuery({
  args: { threads: v.array(v.string()), listings: v.array(v.object({ account: v.string(), productId: v.number() })) },
  handler: async (ctx, { threads, listings }) => {
    if (threads.length > 30 || listings.length > 30) throw Error("Audit batch exceeds 30 keys");
    const transcripts = await Promise.all(threads.map(async thread => {
      const [timed, created, actual] = await Promise.all([
        ctx.db.query("hygglo_messages").withIndex("by_thread_and_sent_at", q => q.eq("thread_id", thread)).order("desc").take(40),
        ctx.db.query("hygglo_messages").withIndex("by_thread", q => q.eq("thread_id", thread)).order("desc").take(40),
        loadReplyTileMessages(ctx, thread),
      ]);
      const original = orderedReplyMessages([...new Map([...timed, ...created].map(message => [message.message_id, message])).values()]).slice(0, 40);
      return canonicalCacheJson(original) === canonicalCacheJson(actual);
    }));
    const listingRecords = await Promise.all(listings.map(async key => {
      const [source, first, again] = await Promise.all([
        ctx.db.query("online_listings").withIndex("by_account_product", q => q.eq("account_slug", key.account).eq("product_id", key.productId)).first(),
        readOnlineListing(ctx, key.account, key.productId), readOnlineListing(ctx, key.account, key.productId),
      ]);
      return canonicalCacheJson(source) === canonicalCacheJson(first) && canonicalCacheJson(first) === canonicalCacheJson(again);
    }));
    return { equal: [...transcripts, ...listingRecords].every(Boolean), threads: threads.length, listings: listings.length };
  },
});
