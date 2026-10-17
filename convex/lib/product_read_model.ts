import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { cacheByteDigest, cacheValueDigest, canonicalCacheJson, packCacheValue, unpackCacheValue } from "./lossless_cache_codec";

export const PRODUCT_READ_KEY = "full:v1" as const;
export const productReadGate = (ctx: Pick<QueryCtx, "db">) => ctx.db.query("product_read_gate").withIndex("by_key", q => q.eq("key", PRODUCT_READ_KEY)).unique();
export const productReadProgress = (ctx: Pick<QueryCtx, "db">) => ctx.db.query("product_read_progress").withIndex("by_key", q => q.eq("key", PRODUCT_READ_KEY)).unique();
const revisionUpdates = new WeakMap<object, Promise<void>>();
const countUpdates = new WeakMap<object, Promise<void>>();
async function updateAccountCounts(ctx: MutationCtx, previous?: string, next?: string) {
  if (previous === next) return;
  const work = (countUpdates.get(ctx) ?? Promise.resolve()).then(async () => {
    const gate = await productReadGate(ctx);
    if (!gate?.ready || !gate.accounts) return;
    const counts = new Map(gate.accounts.map(row => [row.accountSlug, row.count]));
    if (previous !== undefined) counts.set(previous, (counts.get(previous) ?? 0) - 1);
    if (next !== undefined) counts.set(next, (counts.get(next) ?? 0) + 1);
    if ([...counts.values()].some(count => count < 0)) throw Error("Product read count mismatch");
    await ctx.db.patch(gate._id, { accounts: [...counts].map(([accountSlug, count]) => ({ accountSlug, count })) });
  });
  countUpdates.set(ctx, work);
  await work;
}
async function bumpRevision(ctx: MutationCtx) {
  let pending = revisionUpdates.get(ctx);
  if (!pending) {
    pending = (async () => {
      const progress = await productReadProgress(ctx);
      if (progress) await ctx.db.patch(progress._id, { revision: progress.revision + 1 });
    })();
    revisionUpdates.set(ctx, pending);
  }
  await pending;
}
export async function disableProductReadModel(ctx: MutationCtx) {
  const gate = await productReadGate(ctx);
  if (!gate) return;
  const progress = await productReadProgress(ctx);
  if (gate?.ready) await ctx.db.patch(gate._id, { ready: false });
  if (progress) await ctx.db.patch(progress._id, { accounts: [], revision: progress.revision + 1, stage: "backfill", cursor: null, copied_count: 0, pruned_count: 0, audited_count: 0, audited_fallback_count: 0, audited_revision: undefined });
}
export async function decodeProductRead(record: Doc<"product_read_records">): Promise<Doc<"hygglo_products">> {
  if (!record.valid || record.version !== 1 || !record.data || !record.packed_sha256 || await cacheByteDigest(record.data) !== record.packed_sha256) throw Error("Invalid product read record");
  const source = unpackCacheValue(record.data) as Doc<"hygglo_products">;
  if (!source || source._id !== record.source_id || source._creationTime !== record.source_creation_time || source.accountSlug !== record.accountSlug) throw Error("Product read metadata mismatch");
  return source;
}
export async function productReadRecordMatches(record: Doc<"product_read_records"> | null, source: Doc<"hygglo_products">) {
  if (!record || record.version !== 1 || record.source_id !== source._id || record.source_creation_time !== source._creationTime || record.accountSlug !== source.accountSlug || record.source_sha256 !== await cacheValueDigest(source)) return false;
  return !record.valid || canonicalCacheJson(await decodeProductRead(record)) === canonicalCacheJson(source);
}
const writes = new WeakMap<object, Map<string, Promise<void>>>();
export function syncProductReadRecord(ctx: MutationCtx, id: Id<"hygglo_products">, sourceChange = true, knownSource?: Doc<"hygglo_products">): Promise<void> {
  let pending = writes.get(ctx);
  if (!pending) { pending = new Map(); writes.set(ctx, pending); }
  const work = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(() => syncProductReadRecordImpl(ctx, id, sourceChange, knownSource));
  pending.set(id, work);
  return work;
}
async function syncProductReadRecordImpl(ctx: MutationCtx, id: Id<"hygglo_products">, sourceChange: boolean, knownSource?: Doc<"hygglo_products">) {
  if (!await productReadGate(ctx)) return;
  if (knownSource && knownSource._id !== id) throw Error("Known product does not match source ID");
  const [source, prior] = await Promise.all([
    knownSource ? Promise.resolve(knownSource) : ctx.db.get(id),
    ctx.db.query("product_read_records").withIndex("by_source", q => q.eq("source_id", id)).unique(),
  ]);
  if (!source) {
    if (prior) await ctx.db.delete(prior._id);
    if (sourceChange && prior) await updateAccountCounts(ctx, prior.accountSlug);
    if (sourceChange) await bumpRevision(ctx);
    return;
  }
  const source_sha256 = await cacheValueDigest(source);
  if (prior && prior.source_sha256 === source_sha256 && prior.source_creation_time === source._creationTime && prior.accountSlug === source.accountSlug && prior.version === 1 &&
    (!prior.valid || prior.data && await cacheByteDigest(prior.data) === prior.packed_sha256)) return;
  let payload: { valid: boolean; data?: ArrayBuffer; packed_sha256?: string };
  try {
    const data = packCacheValue(source);
    payload = { valid: true, data, packed_sha256: await cacheByteDigest(data) };
  } catch (error) {
    if (!String(error).includes("permanent:")) throw error;
    payload = { valid: false };
  }
  const value = { source_id: id, source_creation_time: source._creationTime, accountSlug: source.accountSlug, version: 1 as const, source_sha256, ...payload };
  if (prior) await ctx.db.replace(prior._id, value); else await ctx.db.insert("product_read_records", value);
  if (sourceChange) await updateAccountCounts(ctx, prior?.accountSlug, source.accountSlug);
  if (sourceChange) await bumpRevision(ctx);
}

const modes = new WeakMap<object, "source" | "prepared">();
export function setProductReadMode(ctx: QueryCtx, mode: "source" | "prepared") { modes.set(ctx, mode); }
export async function loadProductReadRecords(ctx: QueryCtx, accountSlug?: string): Promise<Doc<"hygglo_products">[]> {
  // Existing inventory-list contract requests every field and every matching
  // row. Current inventory is 1,165 owner-managed records, not renter history.
  // Indexed copies preserve that contract; migration always paginates.
  const source = () => accountSlug === undefined ? ctx.db.query("hygglo_products").collect()
    : ctx.db.query("hygglo_products").withIndex("by_account", q => q.eq("accountSlug", accountSlug)).collect();
  const mode = modes.get(ctx);
  if (mode === "source") return source();
  try {
    const gate = await productReadGate(ctx);
    if (!gate?.ready || !gate.enabled && mode !== "prepared") {
      if (mode === "prepared") throw Error("Prepare and audit product records first");
      return source();
    }
    const records = await (accountSlug === undefined
      ? ctx.db.query("product_read_records").withIndex("by_source_creation_time")
      : ctx.db.query("product_read_records").withIndex("by_account", q => q.eq("accountSlug", accountSlug))).collect();
    const expected = accountSlug === undefined ? gate.accounts?.reduce((total, row) => total + row.count, 0)
      : gate.accounts?.find(row => row.accountSlug === accountSlug)?.count ?? (gate.accounts ? 0 : undefined);
    if (expected === undefined || records.length !== expected) throw Error("Incomplete product read records");
    // Equal creation times have a database-owned final tie order. Preserve it.
    if (records.some((row, i) => i > 0 && row.source_creation_time === records[i - 1].source_creation_time)) return source();
    return await Promise.all(records.map(async record => {
      if (record.valid) return decodeProductRead(record);
      const original = await ctx.db.get(record.source_id);
      if (!original || original.accountSlug !== record.accountSlug || original._creationTime !== record.source_creation_time) throw Error("Missing product fallback source");
      return original;
    }));
  } catch (error) {
    if (mode === "prepared") throw error;
    return source();
  }
}
