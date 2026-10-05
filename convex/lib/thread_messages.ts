import type { QueryCtx } from "../_generated/server";

/** Imported old messages can arrive later; creation order is not chat order. */
export function recentChronological<T extends { hygglo_sent_at?: number; fetched_at: number; _creationTime: number }>(messages: T[], limit: number): T[] {
  return messages.slice().sort((a, b) =>
    (a.hygglo_sent_at ?? a.fetched_at) - (b.hygglo_sent_at ?? b.fetched_at) || a._creationTime - b._creationTime,
  ).slice(-limit);
}

/** Native facts can outlive the transcript window. This is the same indexed
 * read used for recent messages, with chronological imports kept intact. */
export async function chronologicalThreadMessages(ctx: QueryCtx, threadId: string) {
  const messages = await ctx.db.query("hygglo_messages").withIndex("by_thread", (q) => q.eq("thread_id", threadId)).collect();
  return recentChronological(messages, messages.length);
}

export async function recentThreadMessages(ctx: QueryCtx, threadId: string, limit: number) {
  return (await chronologicalThreadMessages(ctx, threadId)).slice(-limit);
}
