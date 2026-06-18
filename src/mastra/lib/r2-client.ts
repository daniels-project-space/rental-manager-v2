/**
 * Shared R2 client + credentials loader.
 *
 * Wave 1 extraction: previously duplicated across
 *   - src/lib/r2-cold-storage.ts (getS3 + cachedR2)
 *   - src/lib/hygglo-ui-r2.ts    (getS3 inline)
 *
 * Both re-implementations read identical vault secrets via
 * `PROJECT_HUB_VAULT_KEY` and the project-hub Convex secrets table at
 * fantastic-roadrunner-485.convex.cloud. This module is the single source
 * of truth — call sites import `getS3Client`, `getR2Bucket`,
 * `getR2PublicBase` instead of rolling their own.
 *
 * Credentials and S3Client are memoized at module scope (one fetch per
 * Vercel / Node process cold start).
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";

interface R2Creds {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBase: string;
}

let cachedCreds: R2Creds | null = null;
let cachedClient: S3Client | null = null;
let credsPromise: Promise<R2Creds> | null = null;
let clientPromise: Promise<S3Client> | null = null;

async function loadCredsFromVault(): Promise<R2Creds> {
  // Uses the public `/api/query` endpoint (no auth) — same pattern as
  // src/trigger/poll-hygglo.ts. The previous `/api/run/secrets/listByService`
  // path required PROJECT_HUB_VAULT_KEY which is not set in prod Convex env,
  // causing "vault r2: 400" errors from convex/snapshot_jobs.ts.
  // Service is "cloudflare" (not "cloudflare-r2") per project-hub vault.
  const res = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service: "cloudflare" },
      format: "json",
    }),
  });
  if (!res.ok) throw new Error(`vault r2: ${res.status}`);
  const data = (await res.json()) as {
    status?: string;
    value?: Array<{ keyName: string; value: string }>;
    errorMessage?: string;
  };
  if (data.status && data.status !== "success") {
    throw new Error(`vault r2 query failed: ${data.errorMessage ?? "unknown"}`);
  }
  const rows = data.value ?? [];
  const lookup = (k: string) =>
    rows.find((s) => s.keyName === k)?.value ?? "";
  const accountId = lookup("R2_ACCOUNT_ID");
  return {
    endpoint:
      lookup("R2_ENDPOINT") ||
      (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : ""),
    accessKeyId: lookup("R2_ACCESS_KEY_ID"),
    secretAccessKey: lookup("R2_SECRET_ACCESS_KEY"),
    bucket: lookup("R2_BUCKET") || "rental-manager-v2",
    publicBase: lookup("R2_PUBLIC_BASE") || "",
  };
}

async function getCreds(): Promise<R2Creds> {
  if (cachedCreds) return cachedCreds;
  if (!credsPromise) {
    credsPromise = loadCredsFromVault().then((c) => {
      cachedCreds = c;
      return c;
    });
  }
  return credsPromise;
}

/**
 * Returns a memoized S3Client configured for the vault's R2 endpoint.
 *
 * Single shared client across all callers — preserves the cold-start cost
 * even when multiple modules want R2 access in the same turn.
 */
export async function getS3Client(): Promise<S3Client> {
  if (cachedClient) return cachedClient;
  if (!clientPromise) {
    clientPromise = (async () => {
      const creds = await getCreds();
      // Use the top-level static import; dynamic import + destructured alias
      // (`const { S3Client: S3 } = await import(...)`) was being minified to
      // `t` in the Convex bundle and threw "t is not a constructor" inside
      // snapshot_jobs handlers. Static import resolves cleanly.
      const client = new S3Client({
        endpoint: creds.endpoint,
        region: "auto",
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
        },
      });
      cachedClient = client;
      return client;
    })();
  }
  return clientPromise;
}

export async function getR2Bucket(): Promise<string> {
  return (await getCreds()).bucket;
}

export async function getR2PublicBase(): Promise<string> {
  return (await getCreds()).publicBase;
}

/**
 * Combined helper for legacy call-sites that want `{ s3, bucket, publicBase }`
 * in a single await.
 */
export async function getR2(): Promise<{
  s3: S3Client;
  bucket: string;
  publicBase: string;
  endpoint: string;
}> {
  const [client, creds] = await Promise.all([getS3Client(), getCreds()]);
  return {
    s3: client,
    bucket: creds.bucket,
    publicBase: creds.publicBase,
    endpoint: creds.endpoint,
  };
}

/**
 * Public URL for an R2 object key: `<publicBase>/<key>`.
 * (Exposed for the Ported Listings run route; the VPS uploads directly, but
 * the run route may need to construct/return canonical URLs.)
 */
export async function publicUrl(key: string): Promise<string> {
  const base = (await getR2PublicBase()).replace(/\/+$/, "");
  return `${base}/${key.replace(/^\/+/, "")}`;
}

/**
 * Upload a PNG byte buffer to R2 at `key` (ContentType image/png) and return
 * its public URL. Ported Listings helper.
 */
export async function putPng(
  key: string,
  bytes: Uint8Array | Buffer,
): Promise<string> {
  const [s3, bucket] = await Promise.all([getS3Client(), getR2Bucket()]);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key.replace(/^\/+/, ""),
      Body: bytes,
      ContentType: "image/png",
    }),
  );
  return publicUrl(key);
}

// Test-only: reset module-level memoization between tests.
export function __resetR2ClientForTests(): void {
  cachedCreds = null;
  cachedClient = null;
  credsPromise = null;
  clientPromise = null;
}
