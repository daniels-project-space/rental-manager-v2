import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { hubProjectionState, prepareHubProjection, sourceHubRows, withPreparedHubRows, withSourceHubRows, loadHubRows } from "./lib/account_hub_projection";
import { canonicalCacheJson, cacheValueDigest } from "./lib/lossless_cache_codec";
import { loadHubBook } from "./replyInbox";

export const status = internalQuery({ args: {}, handler: async ctx => {
  const state = await hubProjectionState(ctx);
  return state ? { enabled: state.enabled, ready: state.ready, revision: state.revision, sha256: state.sha256, count: state.rows.length } : null;
} });
export const warm = internalMutation({ args: {}, handler: prepareHubProjection });
export const audit = internalQuery({ args: {}, handler: async ctx => {
  const sourceCtx = { ...ctx }, preparedCtx = { ...ctx }, rowsCtx = { ...ctx };
  const [source, cached, rawBook, cachedBook] = await Promise.all([
    sourceHubRows(ctx), withPreparedHubRows(rowsCtx, () => loadHubRows(rowsCtx)),
    withSourceHubRows(sourceCtx, () => loadHubBook(sourceCtx)),
    withPreparedHubRows(preparedCtx, () => loadHubBook(preparedCtx)),
  ]);
  const bookValue = (book: Awaited<ReturnType<typeof loadHubBook>>) => ({ ...book, bySlug: [...book.bySlug] });
  return { rowsEqual: canonicalCacheJson(source) === canonicalCacheJson(cached), hubBookEqual: canonicalCacheJson(bookValue(rawBook)) === canonicalCacheJson(bookValue(cachedBook)), sha256: await cacheValueDigest(source), count: source.length };
} });
export const enable = internalMutation({ args: { revision: v.number(), sha256: v.string() }, handler: async (ctx, args) => {
  const state = await hubProjectionState(ctx);
  if (!state?.ready || state.revision !== args.revision || state.sha256 !== args.sha256 || await cacheValueDigest(state.rows) !== args.sha256) throw Error("Hub inputs changed; qualify again");
  await ctx.db.patch(state._id, { enabled: true });
  return { enabled: true, revision: state.revision };
} });
export const disable = internalMutation({ args: {}, handler: async ctx => {
  const state = await hubProjectionState(ctx); if (state) await ctx.db.patch(state._id, { enabled: false });
  return { sourceReads: true };
} });
