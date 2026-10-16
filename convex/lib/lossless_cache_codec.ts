import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";

export function canonicalCacheJson(value: Value) { return JSON.stringify(convexToJson(value)); }
export async function cacheByteDigest(data: ArrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function cacheValueDigest(value: Value) { return cacheByteDigest(Uint8Array.from(strToU8(canonicalCacheJson(value))).buffer); }
export function packCacheValue(value: Value): ArrayBuffer {
  const raw = strToU8(canonicalCacheJson(value));
  if (raw.byteLength > 8 * 1024 * 1024) throw new Error("permanent: cache input exceeds bound; use source reads");
  const packed = gzipSync(raw, { level: 6, mtime: 0 });
  if (packed.byteLength > 800_000) throw new Error("permanent: cache row exceeds bound; use source reads");
  return Uint8Array.from(packed).buffer;
}
export function unpackCacheValue(data: ArrayBuffer): Value {
  if (data.byteLength < 18 || new DataView(data).getUint32(data.byteLength - 4, true) > 8 * 1024 * 1024) throw new Error("Invalid cache size");
  return jsonToConvex(JSON.parse(strFromU8(gunzipSync(new Uint8Array(data)))));
}
/** Independent mutable records, matching separate database reads. */
export function cloneCacheValue<T>(value: T): T {
  if (value instanceof ArrayBuffer) return value.slice(0) as T;
  if (Array.isArray(value)) return value.map(cloneCacheValue) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneCacheValue(item)])) as T;
  return value;
}
