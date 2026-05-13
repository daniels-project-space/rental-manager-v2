/**
 * Business-memory store: search + upsert.
 * Omit `memoryId` on upsert to insert a new memory.
 */
import "server-only";
import { anyApi } from "convex/server";
import { getConvex, toError } from "./client";
import { getSyncState, wrap, type ToolEnvelope } from "./envelope";

type Result<T> = ToolEnvelope<T> | { ok: false; error: string };

export async function searchMemories(input: {
  query: string;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.memories.search, { query: input.query }),
      getSyncState(),
    ]);
    return wrap({ data, source: "convex.memories", syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

export async function updateMemory(input: {
  memoryId?: string;
  newContent: string;
  scope?: string;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [data, syncState] = await Promise.all([
      convex.mutation(anyApi.memories.upsert, {
        id: input.memoryId,
        scope: input.scope ?? "general",
        content: input.newContent,
      }),
      getSyncState(),
    ]);
    return wrap({ data, source: "convex.memories", syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}
