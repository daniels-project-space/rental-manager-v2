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
import type { S3Client } from "@aws-sdk/client-s3";

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
  const data = (await res.json()) as {
    value: Array<{ keyName: string; value: string }>;
  };
  const lookup = (k: string) =>
    data.value.find((s) => s.keyName === k)?.value ?? "";
  return {
    endpoint: lookup("R2_ENDPOINT"),
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
      const { S3Client: S3 } = await import("@aws-sdk/client-s3");
      const client = new S3({
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

// Test-only: reset module-level memoization between tests.
export function __resetR2ClientForTests(): void {
  cachedCreds = null;
  cachedClient = null;
  credsPromise = null;
  clientPromise = null;
}
