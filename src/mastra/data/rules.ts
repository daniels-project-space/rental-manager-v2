/**
 * Business-rules read + write.
 * Preview-then-confirm pattern is enforced by the agent prompt — this layer
 * does not gate the call. The `field` constraint (only `content` is mutable)
 * is preserved from the original tool.
 */
import "server-only";
import { anyApi } from "convex/server";
import { getConvex, toError } from "./client";
import { getSyncState, wrap, type ToolEnvelope } from "./envelope";

type Result<T> = ToolEnvelope<T> | { ok: false; error: string };

export async function searchRules(input: {
  query: string;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.rules.search, { query: input.query }),
      getSyncState(),
    ]);
    return wrap({ data, source: "convex.rules", syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

export async function updateRule(input: {
  ruleId: string;
  field: string;
  value: string;
}): Promise<Result<unknown> | { ok: false; error: string }> {
  if (input.field !== "content") {
    return {
      ok: false as const,
      error: "Only content field updates supported. Use field=content.",
    };
  }
  try {
    const convex = getConvex();
    const [data, syncState] = await Promise.all([
      convex.mutation(anyApi.rules.update, {
        id: input.ruleId,
        new_content: input.value,
      }),
      getSyncState(),
    ]);
    return wrap({ data, source: "convex.rules", syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}
