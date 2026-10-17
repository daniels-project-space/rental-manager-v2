import { internalQuery, type QueryCtx } from "./_generated/server";
import { v, type Value } from "convex/values";
import { __service_getGanttWeek } from "./calendar";
import { ganttInputReport, useSourceGanttInputs } from "./lib/gantt_listing_inputs";
import { cacheValueDigest, canonicalCacheJson } from "./lib/lossless_cache_codec";

const fields = { weekStartIso: v.optional(v.string()), accountSlug: v.optional(v.union(v.string(), v.null())) };
type Args = { weekStartIso?: string; accountSlug?: string | null };
const service = __service_getGanttWeek as unknown as { _handler: (ctx: QueryCtx, args: Args) => Promise<Value> };
export const read = internalQuery({ args: { ...fields, mode: v.union(v.literal("source"), v.literal("scoped")) }, handler: async (ctx, args) => {
  if (args.mode === "source") useSourceGanttInputs(ctx);
  return service._handler(ctx, { weekStartIso: args.weekStartIso, accountSlug: args.accountSlug });
} });
/** Both real handlers share one database snapshot and frozen query clock. */
export const audit = internalQuery({ args: fields, handler: async (ctx, args) => {
  const raw = { ...ctx }, scoped = { ...ctx }; useSourceGanttInputs(raw);
  const [a, b] = await Promise.all([service._handler(raw, args), service._handler(scoped, args)]);
  return { equal: canonicalCacheJson(a) === canonicalCacheJson(b), source_sha256: await cacheValueDigest(a), scoped_sha256: await cacheValueDigest(b), source: ganttInputReport(raw), scoped: ganttInputReport(scoped) };
} });
