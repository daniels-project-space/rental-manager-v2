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
// Vault + S3Client logic lives in `src/mastra/lib/r2-client.ts` so this
// helper and `src/lib/hygglo-ui-r2.ts` share one memoized client per process.
import { getR2 } from "../mastra/lib/r2-client";

async function getS3() {
  const { s3, bucket, publicBase, endpoint } = await getR2();
  return {
    creds: {
      endpoint,
      accessKeyId: "", // not exposed; readers don't need raw creds
      secretAccessKey: "",
      bucket,
      publicBase,
    },
    s3,
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

// ── Snapshot envelope (used by Wave 2 writers) ──────────────────────────

export interface SnapshotEnvelope<T> {
  generatedAt: number;
  data: T;
}
export function wrapSnapshot<T>(data: T): SnapshotEnvelope<T> {
  return { generatedAt: Date.now(), data };
}

// ── Aggregate index key union ────────────────────────────────────────────

type AggregateIndexKey =
  | "by_item"
  | "by_renter"
  | "by_month"
  | "totals"
  | "intel_rankings"
  | "daily_briefing"
  | "top_renters"
  | "inventory_overview";

export async function putAggregateIndex(
  indexName: AggregateIndexKey,
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
  indexName: AggregateIndexKey,
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
  indexName: AggregateIndexKey,
): Promise<T | null> {
  const now = Date.now();
  const hit = indexCache.get(indexName);
  if (hit && hit.expiresAt > now) return hit.value as T;
  const fresh = await getAggregateIndex<T>(indexName);
  indexCache.set(indexName, { value: fresh, expiresAt: now + INDEX_TTL_MS });
  return fresh;
}
