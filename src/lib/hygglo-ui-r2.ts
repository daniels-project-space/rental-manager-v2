/**
 * Wave 4.6 — R2 upload helper for Hygglo UI shadow screenshots.
 *
 * Uses the existing R2 vault credentials. Public read URL is returned
 * so `get_pending_shadow_actions` can render images inline in the chat.
 */
const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";

let cachedR2: {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBase: string;
} | null = null;

async function getR2Creds() {
  if (cachedR2) return cachedR2;
  const vaultKey = process.env.PROJECT_HUB_VAULT_KEY ?? "";
  const res = await fetch(`${VAULT_URL}/api/run/secrets/listByService`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${vaultKey}`,
    },
    body: JSON.stringify({ service: "cloudflare-r2" }),
  });
  if (!res.ok) throw new Error(`vault r2: ${res.status}`);
  const data = (await res.json()) as { value: Array<{ keyName: string; value: string }> };
  const lookup = (k: string) => data.value.find((s) => s.keyName === k)?.value ?? "";
  cachedR2 = {
    endpoint: lookup("R2_ENDPOINT"),
    accessKeyId: lookup("R2_ACCESS_KEY_ID"),
    secretAccessKey: lookup("R2_SECRET_ACCESS_KEY"),
    bucket: lookup("R2_BUCKET") || "rental-manager-v2",
    publicBase: lookup("R2_PUBLIC_BASE") || "",
  };
  return cachedR2;
}

export async function uploadShadowScreenshot(key: string, buffer: Buffer): Promise<string> {
  const creds = await getR2Creds();
  // Lazy import @aws-sdk/client-s3 — keeps poll task cold-start light.
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    endpoint: creds.endpoint,
    region: "auto",
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
  await s3.send(
    new PutObjectCommand({
      Bucket: creds.bucket,
      Key: key,
      Body: buffer,
      ContentType: "image/png",
    }),
  );
  return creds.publicBase ? `${creds.publicBase.replace(/\/$/, "")}/${key}` : `r2://${creds.bucket}/${key}`;
}
