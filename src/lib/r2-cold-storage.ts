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
// Static imports — dynamic `await import("@aws-sdk/client-s3")` patterns
// were minified by Convex's bundler such that the destructured constructor
// became `s`/`t`, then `new s(...)` threw "is not a constructor" inside
// snapshot_jobs handlers. Static imports survive minification.
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

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
  /**
   * Provenance tag identifying which writer produced this envelope.
   * Added 2026-05-15 to support W1 safety gates (cf. phase3c-cleanup).
   * BACKWARD-COMPAT: existing R2 blobs written before this change lack the
   * `source` field; T3 hydration consumers must treat missing source as
   * `undefined` (do NOT throw). Only NEW writes carry the tag.
   */
  source?: "convex" | "trigger";
  data: T;
}
export function wrapSnapshot<T>(
  data: T,
  source: "convex" | "trigger" = "convex",
): SnapshotEnvelope<T> {
  return { generatedAt: Date.now(), source, data };
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

// ── Wave 3a — Cold archive readers (>90d rows moved to R2) ──────────────
//
// The archiver in `convex/archive_to_r2.ts` writes rows older than 90d as
// gzipped JSONL, one R2 key per UTC day:
//   `cold/archive/<table>/<yyyy-mm-dd>.jsonl.gz`
//
// `loadArchivedRange` is the symmetric reader. Pass a UTC `from` and `to`
// (both inclusive, in ms since epoch) and the table; it fetches every
// matching daily blob, gunzips it, and yields the rows.
//
// Per-blob in-memory cache (5 min TTL) — the same Vercel warm worker may
// answer multiple paginated requests on the same archive day.

import type { Readable } from "stream";

const archiveBlobCache = new Map<
  string,
  { rows: unknown[]; expiresAt: number }
>();
const ARCHIVE_TTL_MS = 5 * 60_000;

function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Iterate UTC date keys in [fromMs, toMs] inclusive.
 */
function* iterDateKeys(fromMs: number, toMs: number): Generator<string> {
  if (toMs < fromMs) return;
  // Align to UTC midnight to avoid drift across DST / leap seconds.
  const start = Date.UTC(
    new Date(fromMs).getUTCFullYear(),
    new Date(fromMs).getUTCMonth(),
    new Date(fromMs).getUTCDate(),
  );
  const end = Date.UTC(
    new Date(toMs).getUTCFullYear(),
    new Date(toMs).getUTCMonth(),
    new Date(toMs).getUTCDate(),
  );
  for (let cursor = start; cursor <= end; cursor += 86_400_000) {
    yield utcDateKey(cursor);
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function loadArchiveBlob<T>(
  table: string,
  dateKey: string,
): Promise<T[]> {
  const cacheKey = `${table}/${dateKey}`;
  const now = Date.now();
  const hit = archiveBlobCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.rows as T[];

  const { creds, s3 } = await getS3();
  const { gunzipSync } = await import("zlib");
  const key = `cold/archive/${table}/${dateKey}.jsonl.gz`;

  let rows: T[];
  try {
    const resp = await s3.send(
      new GetObjectCommand({ Bucket: creds.bucket, Key: key }),
    );
    const body = resp.Body as Readable | undefined;
    if (!body) {
      rows = [];
    } else {
      const gz = await streamToBuffer(body);
      const text = gunzipSync(gz).toString("utf8");
      rows = text
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as T);
    }
  } catch (err: unknown) {
    // Missing key = no archive for that day. Treat as empty.
    const code = (err as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    if (code === 404 || (err as { name?: string }).name === "NoSuchKey") {
      rows = [];
    } else {
      throw err;
    }
  }

  archiveBlobCache.set(cacheKey, { rows, expiresAt: now + ARCHIVE_TTL_MS });
  return rows;
}

/**
 * Load all archived rows for `table` whose `_creationTime` falls inside
 * [fromMs, toMs] (both inclusive, ms). Walks daily R2 blobs, gunzips, and
 * filters to the requested range. Missing daily keys are treated as empty.
 *
 * Returns rows in ascending `_creationTime` order — same shape as a Convex
 * query result, so callers can concat with hot-storage rows without extra
 * glue.
 *
 * Use this in readers that paginate over `hygglo_messages` / `audit_log`
 * when the requested date range crosses the 90-day boundary.
 */
export async function loadArchivedRange<
  T extends { _creationTime: number },
>(table: string, fromMs: number, toMs: number): Promise<T[]> {
  if (toMs < fromMs) return [];
  const out: T[] = [];
  for (const dateKey of iterDateKeys(fromMs, toMs)) {
    const rows = await loadArchiveBlob<T>(table, dateKey);
    for (const r of rows) {
      if (r._creationTime >= fromMs && r._creationTime <= toMs) out.push(r);
    }
  }
  out.sort((a, b) => a._creationTime - b._creationTime);
  return out;
}

// Test-only: clear the per-blob cache between tests.
export function __resetArchiveCacheForTests(): void {
  archiveBlobCache.clear();
}
