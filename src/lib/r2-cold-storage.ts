/**
 * R2 cold-storage helper for v1-imported reservations.
 *
 * Convex stores ~1767 reservation rows, but ~1490 of those are immutable
 * v1 imports from Postgres. Each `ctx.db.query("reservations").collect()`
 * pulls the v1 history back through Convex's bandwidth meter even though
 * the data never changes.
 *
 * Cold-storage approach:
 *   R2 bucket : "rental-manager-v2"
 *   Path     : cold/v1/reservations/by-rental-id/<v1_rental_id>.json
 *
 * Each row stored as standalone JSON so individual reads stay cheap.
 * Aggregate indexes (by_item, by_renter, by_month) are built separately
 * — see buildIndexes() — so per-item revenue queries don't have to
 * fetch every rental file.
 *
 * Reads use signed URLs against the same R2 endpoint as the screenshot
 * helper (src/lib/hygglo-ui-r2.ts); credentials come from the vault.
 *
 * Lifecycle:
 *   1. Export script writes all v1 reservations + indexes to R2 (one-off).
 *   2. Convex queries that need lifetime data fetch the relevant index
 *      from R2 (cached in-memory per Vercel cold start).
 *   3. v1 rows can then be deleted from Convex (after verification).
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
  const data = (await res.json()) as {
    value: Array<{ keyName: string; value: string }>;
  };
  const lookup = (k: string) =>
    data.value.find((s) => s.keyName === k)?.value ?? "";
  cachedR2 = {
    endpoint: lookup("R2_ENDPOINT"),
    accessKeyId: lookup("R2_ACCESS_KEY_ID"),
    secretAccessKey: lookup("R2_SECRET_ACCESS_KEY"),
    bucket: lookup("R2_BUCKET") || "rental-manager-v2",
    publicBase: lookup("R2_PUBLIC_BASE") || "",
  };
  return cachedR2;
}

async function getS3() {
  const creds = await getR2Creds();
  const { S3Client } = await import("@aws-sdk/client-s3");
  return {
    creds,
    s3: new S3Client({
      endpoint: creds.endpoint,
      region: "auto",
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      },
    }),
  };
}

// ── Reservation snapshot type (subset of Convex reservation row) ────────

export interface ReservationSnapshot {
  v1_rental_id: string;
  hygglo_order_id?: string | null;
  account_slug?: string;
  start_date?: string;
  end_date?: string;
  pickup_date?: string;
  status?: string;
  gross_paid_gbp?: number;
  net_to_owner_gbp?: number;
  platform_fee_gbp?: number;
  duration_days?: number;
  notes?: string;
  renter_name?: string;
  // Per-item resolution carried from migration
  resolved_items?: Array<{
    item_id: string;
    item_name_canonical: string;
    revenue_gbp?: number;
    qty?: number;
  }>;
}

// ── Public API ──────────────────────────────────────────────────────────

export async function putReservationSnapshot(
  row: ReservationSnapshot,
): Promise<string> {
  if (!row.v1_rental_id) throw new Error("v1_rental_id required");
  const { creds, s3 } = await getS3();
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const key = `cold/v1/reservations/by-rental-id/${row.v1_rental_id}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: creds.bucket,
      Key: key,
      Body: JSON.stringify(row),
      ContentType: "application/json",
    }),
  );
  return key;
}

export async function putAggregateIndex(
  indexName: "by_item" | "by_renter" | "by_month" | "totals",
  payload: unknown,
): Promise<string> {
  const { creds, s3 } = await getS3();
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const key = `cold/v1/indexes/${indexName}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: creds.bucket,
      Key: key,
      Body: JSON.stringify(payload),
      ContentType: "application/json",
    }),
  );
  return key;
}

export async function getAggregateIndex<T = unknown>(
  indexName: "by_item" | "by_renter" | "by_month" | "totals",
): Promise<T | null> {
  const { creds, s3 } = await getS3();
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const key = `cold/v1/indexes/${indexName}.json`;
  try {
    const resp = await s3.send(
      new GetObjectCommand({ Bucket: creds.bucket, Key: key }),
    );
    const body = await resp.Body?.transformToString();
    if (!body) return null;
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

// ── In-process index cache (per Vercel cold start) ──────────────────────

const indexCache = new Map<string, { value: unknown; expiresAt: number }>();
const INDEX_TTL_MS = 5 * 60_000;

export async function cachedIndex<T>(
  indexName: "by_item" | "by_renter" | "by_month" | "totals",
): Promise<T | null> {
  const now = Date.now();
  const hit = indexCache.get(indexName);
  if (hit && hit.expiresAt > now) return hit.value as T;
  const fresh = await getAggregateIndex<T>(indexName);
  indexCache.set(indexName, { value: fresh, expiresAt: now + INDEX_TTL_MS });
  return fresh;
}
