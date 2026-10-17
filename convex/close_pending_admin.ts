import { internalQuery, type QueryCtx } from "./_generated/server";
import { v, type Value } from "convex/values";
import { __service_getDueReturns } from "./reservations";
import { closePendingReadReport, useLegacyClosePending } from "./lib/current_close_pending";
import { cacheValueDigest, canonicalCacheJson } from "./lib/lossless_cache_codec";

const fields = { accountSlug: v.union(v.string(), v.null()), bypassMv: v.optional(v.boolean()) };
type Args = { accountSlug: string | null; bypassMv?: boolean };
const service = __service_getDueReturns as unknown as { _handler: (ctx: QueryCtx, args: { accountSlug: string | null; _bypassMv?: boolean }) => Promise<Value> };
const call = (ctx: QueryCtx, args: Args) => service._handler(ctx, { accountSlug: args.accountSlug, _bypassMv: args.bypassMv });
export const read = internalQuery({ args: { ...fields, mode: v.union(v.literal("source"), v.literal("current")) }, handler: async (ctx, args) => {
  if (args.mode === "source") useLegacyClosePending(ctx);
  return call(ctx, args);
} });
/** Complete real handlers share one database snapshot and frozen clock. */
export const audit = internalQuery({ args: fields, handler: async (ctx, args) => {
  const source = { ...ctx }, current = { ...ctx }; useLegacyClosePending(source);
  const [a,b] = await Promise.all([call(source,args),call(current,args)]);
  return { equal: canonicalCacheJson(a) === canonicalCacheJson(b), source_sha256: await cacheValueDigest(a), current_sha256: await cacheValueDigest(b), source: closePendingReadReport(source), current: closePendingReadReport(current) };
} });
