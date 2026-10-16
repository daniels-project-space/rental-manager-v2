import type { Value } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { cacheByteDigest, canonicalCacheJson, packCacheValue, unpackCacheValue } from "./lossless_cache_codec";

type Row = Doc<"mv_reply_queue">;
type LogicalRow = Omit<Row, "tiles_gzip" | "tiles_sha256" | "tiles_codec_version">;
type StoredTiles = Pick<Row, "tiles" | "tiles_gzip" | "tiles_sha256" | "tiles_codec_version">;

/** Keep legacy values as the capacity/error fallback. Never truncate a queue. */
export async function storeReplyQueueTiles(account: string, generatedAt: number, tiles: Value): Promise<StoredTiles> {
  const legacy: StoredTiles = { tiles, tiles_gzip: undefined, tiles_sha256: undefined, tiles_codec_version: undefined };
  if (!Array.isArray(tiles)) return legacy;
  try {
    // Bind the payload to its account and freshness metadata, so a metadata
    // patch or a legacy writer cannot make an older artifact appear current.
    const packet = { account, generatedAt, tiles }, data = packCacheValue(packet);
    if (canonicalCacheJson(packet) !== canonicalCacheJson(unpackCacheValue(data))) return legacy;
    return { tiles: null, tiles_gzip: data, tiles_sha256: await cacheByteDigest(data), tiles_codec_version: 1 };
  } catch {
    return legacy;
  }
}

/** Public APIs retain the original complete row shape; encoding fields stay in
 * storage. A damaged artifact is a cache miss, handled by the source reader. */
export async function readReplyQueueRow(row: Row | null): Promise<LogicalRow | null> {
  if (!row) return null;
  const { tiles_gzip, tiles_sha256, tiles_codec_version, ...logical } = row;
  // A legacy writer may overwrite tiles after a rollback. Its array/value is
  // authoritative even if older optional encoding fields remain on the row.
  if (row.tiles !== null || !tiles_gzip) return logical;
  try {
    if (tiles_codec_version !== 1 || !tiles_sha256 || await cacheByteDigest(tiles_gzip) !== tiles_sha256) return null;
    const packet = unpackCacheValue(tiles_gzip);
    if (!packet || typeof packet !== "object" || Array.isArray(packet) || packet instanceof ArrayBuffer || packet.account !== row.account || !Object.is(packet.generatedAt, row.generatedAt) || !Array.isArray(packet.tiles)) return null;
    return { ...logical, tiles: packet.tiles };
  } catch {
    return null;
  }
}
