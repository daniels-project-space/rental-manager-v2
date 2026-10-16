import { internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { __service_getReplyQueue, __service_getThreadById } from "./replyInbox";
import { profileReadonlyDatabase } from "./lib/profile_readonly";

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
