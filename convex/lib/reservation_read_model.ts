import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { reservationReadFields } from "./reservation_read_indexes";
import { cacheValueDigest, cacheByteDigest, packCacheValue, unpackCacheValue, canonicalCacheJson } from "./lossless_cache_codec";

export const RESERVATION_READ_KEY = "full:v1" as const;
export function reservationReadGate(ctx: Pick<QueryCtx, "db">) {
  return ctx.db.query("reservation_read_gate").withIndex("by_key", q => q.eq("key", RESERVATION_READ_KEY)).unique();
}
export function reservationReadProgress(ctx: Pick<QueryCtx, "db">) {
  return ctx.db.query("reservation_read_progress").withIndex("by_key", q => q.eq("key", RESERVATION_READ_KEY)).unique();
}
export function reservationReadMetadata(row: Doc<"reservations">) {
  return Object.fromEntries(reservationReadFields.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
}
export function reservationReadMetadataMatches(record: Doc<"reservation_read_records">, source: Doc<"reservations">) {
  return record.source_id === source._id && Object.is(record.source_creation_time, source._creationTime)
    && reservationReadFields.every(key => Object.is(record[key], source[key]));
}
export async function decodeReservationRead(record: Doc<"reservation_read_records">): Promise<Doc<"reservations">> {
  if (!record.valid || record.version !== 1 || !record.data || await cacheByteDigest(record.data) !== record.packed_sha256) throw Error("Reservation read record is unavailable");
  const value = unpackCacheValue(record.data) as Doc<"reservations">;
  if (!value || !reservationReadMetadataMatches(record, value)) throw Error("Reservation read metadata mismatch");
  return value;
}
const revisionUpdates = new WeakMap<object, Promise<void>>();
async function bumpRevision(ctx: MutationCtx) {
  const existing = revisionUpdates.get(ctx); if (existing) return existing;
  const work = (async () => {
    const progress = await reservationReadProgress(ctx);
    if (progress) await ctx.db.patch(progress._id, { revision: progress.revision + 1 });
  })();
  revisionUpdates.set(ctx, work); return work;
}
/** A failed per-row operation must not leave an enabled stale read model. */
export async function disableReservationReadModel(ctx: MutationCtx) {
  const gate = await reservationReadGate(ctx);
  if (!gate) return;
  if (gate.ready) await ctx.db.patch(gate._id, { ready: false });
  const progress = await reservationReadProgress(ctx);
  if (progress) await ctx.db.patch(progress._id, { revision: progress.revision + 1, stage: "backfill", cursor: null, audited_count: 0, audited_fallback_count: 0, copied_count: 0, pruned_count: 0, audited_revision: undefined });
}
export async function syncReservationReadRecord(ctx: MutationCtx, id: Id<"reservations">, sourceChange = true, knownSource?: Doc<"reservations">) {
  if (!await reservationReadGate(ctx)) return;
  const [source, prior, presence] = await Promise.all([
    knownSource ? Promise.resolve(knownSource) : ctx.db.get(id),
    ctx.db.query("reservation_read_records").withIndex("by_source", q => q.eq("source_id", id)).unique(),
    ctx.db.query("reservation_order_presence").withIndex("by_source", q => q.eq("source_id", id)).unique(),
  ]);
  if (knownSource && knownSource._id !== id) throw Error("Known reservation does not match source ID");
  if (!source) {
    if (prior) await ctx.db.delete(prior._id);
    if (presence) await ctx.db.delete(presence._id);
    if (sourceChange) await bumpRevision(ctx);
    return;
  }
  const presenceChanged = !presence || presence.hygglo_order_id !== source.hygglo_order_id;
  if (presenceChanged) {
    const value = { source_id: id, ...(source.hygglo_order_id === undefined ? {} : { hygglo_order_id: source.hygglo_order_id }) };
    if (presence) await ctx.db.replace(presence._id, value); else await ctx.db.insert("reservation_order_presence", value);
  }
  const source_sha256 = await cacheValueDigest(source);
  if (prior && prior.source_sha256 === source_sha256 && reservationReadMetadataMatches(prior, source)
      && (!prior.valid || prior.data && await cacheByteDigest(prior.data) === prior.packed_sha256)) {
    if (presenceChanged && sourceChange) await bumpRevision(ctx);
    return;
  }
  let payload: { valid: boolean; data?: ArrayBuffer; packed_sha256?: string };
  try {
    const data = packCacheValue(source);
    payload = { valid: true, data, packed_sha256: await cacheByteDigest(data) };
  } catch (error) {
    if (!String(error).includes("permanent:")) throw error;
    // An incompressible large record keeps an indexed fallback marker. Readers
    // never omit that source record or reduce its precision or fields.
    payload = { valid: false };
  }
  const value = { ...reservationReadMetadata(source), source_id: id, source_creation_time: source._creationTime, version: 1 as const, source_sha256, ...payload } as Omit<Doc<"reservation_read_records">, "_id" | "_creationTime">;
  if (prior) await ctx.db.replace(prior._id, value);
  else await ctx.db.insert("reservation_read_records", value);
  if (sourceChange) await bumpRevision(ctx);
}
export async function reservationReadRecordMatches(record: Doc<"reservation_read_records"> | null, source: Doc<"reservations">) {
  if (!record || !reservationReadMetadataMatches(record, source) || record.source_sha256 !== await cacheValueDigest(source)) return false;
  if (!record.valid) return true; // Explicit original-source fallback, not a dropped record.
  try { return canonicalCacheJson(await decodeReservationRead(record)) === canonicalCacheJson(source); }
  catch { return false; }
}
