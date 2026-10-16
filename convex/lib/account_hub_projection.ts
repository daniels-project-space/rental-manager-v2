import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { cacheValueDigest, cloneCacheValue, canonicalCacheJson } from "./lossless_cache_codec";

export const HUB_PROJECTION_KEY = "profiles:v1" as const;
export type HubRow = { source_id: Id<"account_profiles">; account_id: Id<"accounts">; hub_lat: number | null; hub_lng: number | null };
export function projectHubRows(profiles: Doc<"account_profiles">[]): HubRow[] {
  // Keep the original profile collection order, including duplicate accounts.
  // Account slugs and settings remain live reads in loadHubBook.
  return profiles.map(p => ({ source_id: p._id, account_id: p.account_id, hub_lat: p.hub_lat ?? null, hub_lng: p.hub_lng ?? null }));
}
export async function sourceHubRows(ctx: Pick<QueryCtx, "db">) { return projectHubRows(await ctx.db.query("account_profiles").collect()); }
export async function hubProjectionState(ctx: Pick<QueryCtx, "db">) {
  return ctx.db.query("account_hub_projection").withIndex("by_key", q => q.eq("key", HUB_PROJECTION_KEY)).unique();
}
const sourceOnly = new WeakSet<object>(), prepared = new WeakSet<object>();
export async function withSourceHubRows<T>(ctx: QueryCtx, work: () => Promise<T>) { sourceOnly.add(ctx); return work(); }
export async function withPreparedHubRows<T>(ctx: QueryCtx, work: () => Promise<T>) { prepared.add(ctx); await loadHubRows(ctx); return work(); }
export async function loadHubRows(ctx: Pick<QueryCtx, "db">): Promise<HubRow[]> {
  if (!sourceOnly.has(ctx)) {
    try {
      const state = await hubProjectionState(ctx);
      if (!state || (!state.enabled && !prepared.has(ctx)) || !state.ready || state.version !== 1 || state.sha256 !== await cacheValueDigest(state.rows)) throw Error("Hub projection is unavailable");
      return cloneCacheValue(state.rows);
    } catch (error) { if (prepared.has(ctx)) throw error; }
  }
  return sourceHubRows(ctx);
}
async function invalidate(ctx: MutationCtx) {
  const state = await hubProjectionState(ctx);
  if (!state) return null;
  await ctx.db.patch(state._id, { ready: false, revision: state.revision + 1, sha256: undefined });
  return state._id;
}
export async function rebuildHubProjection(ctx: MutationCtx, id: Id<"account_hub_projection">) {
  const profiles = await ctx.db.query("account_profiles").take(2001);
  if (profiles.length > 2000) { await ctx.db.patch(id, { ready: false, rows: [], sha256: undefined }); return { ready: false }; }
  const rows = projectHubRows(profiles);
  if (new TextEncoder().encode(canonicalCacheJson(rows)).byteLength > 800_000) {
    await ctx.db.patch(id, { ready: false, rows: [], sha256: undefined }); return { ready: false };
  }
  await ctx.db.patch(id, { ready: true, rows, sha256: await cacheValueDigest(rows) });
  return { ready: true, count: rows.length };
}
const writes = new WeakMap<object, Promise<unknown>>();
function serialize<T>(ctx: MutationCtx, work: () => Promise<T>): Promise<T> {
  const prior = writes.get(ctx) ?? Promise.resolve(), next = prior.then(work, work);
  writes.set(ctx, next);
  const clear = () => { if (writes.get(ctx) === next) writes.delete(ctx); };
  void next.then(clear, clear);
  return next;
}
// Invalidate before the source write: a caller that catches a failed per-row
// write/rebuild can only leave source fallback active, never a stale projection.
export async function patchAccountProfile(ctx: MutationCtx, id: Id<"account_profiles">, patch: Partial<WithoutSystemFields<Doc<"account_profiles">>>) {
  return serialize(ctx, async () => {
    const relevant = ["account_id", "hub_lat", "hub_lng"].some(key => Object.prototype.hasOwnProperty.call(patch, key));
    const stateId = relevant ? await invalidate(ctx) : null;
    await ctx.db.patch(id, patch);
    if (stateId) await rebuildHubProjection(ctx, stateId);
  });
}
export async function insertAccountProfile(ctx: MutationCtx, value: WithoutSystemFields<Doc<"account_profiles">>) {
  return serialize(ctx, async () => {
    const stateId = await invalidate(ctx), id = await ctx.db.insert("account_profiles", value);
    if (stateId) await rebuildHubProjection(ctx, stateId);
    return id;
  });
}
export async function deleteAccountProfile(ctx: MutationCtx, id: Id<"account_profiles">) {
  return serialize(ctx, async () => {
    const stateId = await invalidate(ctx); await ctx.db.delete(id);
    if (stateId) await rebuildHubProjection(ctx, stateId);
  });
}
export async function replaceAccountProfile(ctx: MutationCtx, id: Id<"account_profiles">, value: WithoutSystemFields<Doc<"account_profiles">>) {
  return serialize(ctx, async () => {
    const stateId = await invalidate(ctx); await ctx.db.replace(id, value);
    if (stateId) await rebuildHubProjection(ctx, stateId);
  });
}
export async function prepareHubProjection(ctx: MutationCtx) {
  let state = await hubProjectionState(ctx);
  if (!state) {
    const id = await ctx.db.insert("account_hub_projection", { key: HUB_PROJECTION_KEY, version: 1, revision: 0, enabled: false, ready: false, rows: [] });
    await rebuildHubProjection(ctx, id);
  } else {
    await ctx.db.patch(state._id, { ready: false, revision: state.revision + 1, sha256: undefined });
    await rebuildHubProjection(ctx, state._id);
  }
  state = await hubProjectionState(ctx);
  return { ready: state?.ready ?? false, revision: state?.revision, sha256: state?.sha256, count: state?.rows.length };
}
