/**
 * Wave 4.6 — R2 upload helper for Hygglo UI shadow screenshots.
 *
 * Uses the shared R2 client + vault credentials from
 * `src/mastra/lib/r2-client.ts`. Public read URL is returned so
 * `get_pending_shadow_actions` can render images inline in the chat.
 */
import { getR2 } from "../mastra/lib/r2-client";

export async function uploadShadowScreenshot(key: string, buffer: Buffer): Promise<string> {
  const { s3, bucket, publicBase } = await getR2();
  // Lazy import for the command class only — client itself is memoized.
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: "image/png",
    }),
  );
  return publicBase ? `${publicBase.replace(/\/$/, "")}/${key}` : `r2://${bucket}/${key}`;
}
