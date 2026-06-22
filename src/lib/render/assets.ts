/**
 * Render asset loader — fetches brand fonts + plates from R2 (server-side).
 *
 * Assets live under `assets/render/...` in the shared R2 bucket (uploaded once;
 * see the Phase-2 migration). Fetched via GetObject (no public URL needed) and
 * memoized per process so a batch render hits R2 once per asset.
 */
import { getR2 } from "@/mastra/lib/r2-client";
import { GetObjectCommand } from "@aws-sdk/client-s3";

const cache = new Map<string, Buffer>();

export async function getAsset(key: string): Promise<Buffer> {
  const hit = cache.get(key);
  if (hit) return hit;
  const { s3, bucket } = await getR2();
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const arr = await resp.Body!.transformToByteArray();
  const buf = Buffer.from(arr);
  cache.set(key, buf);
  return buf;
}
