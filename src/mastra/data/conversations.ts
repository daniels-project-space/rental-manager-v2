/**
 * Hygglo message-thread reads.
 */
import "server-only";
import { anyApi } from "convex/server";
import { getConvex, toError } from "./client";
import { getSyncState, wrap, type ToolEnvelope } from "./envelope";

type Result<T> = ToolEnvelope<T> | { ok: false; error: string };

export async function readConversation(input: {
  search: string;
}): Promise<Result<unknown> | { ok: false; error: string }> {
  try {
    const convex = getConvex();
    const [messages, syncState] = await Promise.all([
      convex.query(anyApi.hygglo.listByThread, { thread_id: input.search }),
      getSyncState(),
    ]);
    if ((messages as unknown[]).length === 0) {
      return {
        ok: false as const,
        error: "No messages found for thread: " + input.search,
      };
    }
    return wrap({
      data: {
        ok: true as const,
        thread_id: input.search,
        message_count: (messages as unknown[]).length,
        messages,
      },
      source: "convex.hygglo_messages",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}
