import { SHARED_STOCK_CODE, SHARED_STOCK_ENV_KEYS } from "./shared_stock_implementation";
import { cacheValueDigest } from "./lossless_cache_codec";

export async function sharedStockImplementation() {
  const configuration = Object.fromEntries(SHARED_STOCK_ENV_KEYS.map(key => [key, process.env[key] ?? null]));
  return `${SHARED_STOCK_CODE}:${await cacheValueDigest(configuration)}`;
}
