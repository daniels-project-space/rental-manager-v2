"use node";

/**
 * Phase 3a / Wave 3a — Cold-storage archiver for high-volume mutable tables.
 *
 * Convex hot-storage cost scales with row count × document size. Two tables
 * grow unboundedly:
 *   - `hygglo_messages` — every message we ever fetched (~1.5KB each)
 *   - `audit_log`       — every schema/seed/migration write (~0.4KB each)
 *
 * Rows older than 90 days are effectively cold: read by reporting / audit
 * trails, never mutated. Moving them to R2 frees Convex bandwidth and keeps
 * index sizes flat.
 *
 * Storage layout:
 *   R2 key  : `cold/archive/<table>/<yyyy-mm-dd>.jsonl.gz`
 *   The `<yyyy-mm-dd>` segment is the UTC date of the MIN `_creationTime`
 *   in the chunk so date-range readers can locate the right blob without
 *   scanning every key.
 *
 * Each chunk: JSONL (one document per line), gzipped, includes `_id` and
 * `_creationTime` so the reader can faithfully reconstruct date-ranged
 * scans. Idempotency: if the target R2 key already exists, the chunk is
 * skipped (so the cron can fire twice on the same day with no double
 * archive).
 *
 * Safety: DRY-RUN IS THE DEFAULT. The cron registration in `crons.ts`
 * passes `dry_run: true`. Flipping to a live archive REQUIRES a manual
 * invocation via Convex dashboard / `npx convex run` to verify the
 * planned R2 keys + row counts before mutating data.
 */
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { gzipSync } from "zlib";
import { getR2 } from "../src/mastra/lib/r2-client";
import { loadArchivedRange } from "../src/lib/r2-cold-storage";

const DAY_MS = 86_400_000;
const NINETY_DAYS_MS = 90 * DAY_MS;
const ARCHIVABLE_TABLES = ["hygglo_messages", "audit_log"] as const;
type ArchivableTable = (typeof ARCHIVABLE_TABLES)[number];

// ── Helpers ────────────────────────────────────────────────────────────

function isArchivableTable(t: string): t is ArchivableTable {
  return (ARCHIVABLE_TABLES as readonly string[]).includes(t);
}

function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10); // yyyy-mm-dd
}

function archiveKey(table: string, minCreationMs: number): string {
  return `cold/archive/${table}/${utcDateString(minCreationMs)}.jsonl.gz`;
}

// Internal queries/mutations moved to archive_to_r2_helpers.ts —
// Convex disallows mutations/queries in files marked `"use node";`.
// This action calls them via internal.archive_to_r2_helpers.*

// ── R2 idempotency check ───────────────────────────────────────────────

async function r2KeyExists(key: string): Promise<boolean> {
  const { s3, bucket } = await getR2();
  const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err: unknown) {
    // S3 SDK throws NotFound (404) — treat anything else as a real error.
    const code = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    if (code === 404) return false;
    if ((err as { name?: string }).name === "NotFound") return false;
    throw err;
  }
}

async function r2PutChunk(key: string, body: Buffer): Promise<void> {
  const { s3, bucket } = await getR2();
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/gzip",
      ContentEncoding: "gzip",
    }),
  );
}

// ── Per-day grouping for stable R2 keys ────────────────────────────────

interface DayGroup {
  dateKey: string; // yyyy-mm-dd of MIN _creationTime in the group
  rows: Array<Record<string, unknown> & { _id: string; _creationTime: number }>;
}

function groupByCreationDate(
  rows: ReadonlyArray<Record<string, unknown> & { _id: string; _creationTime: number }>,
): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const r of rows) {
    const k = utcDateString(r._creationTime);
    let g = map.get(k);
    if (!g) {
      g = { dateKey: k, rows: [] };
      map.set(k, g);
    }
    g.rows.push(r);
  }
  return Array.from(map.values()).sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
}

// ── Result shapes ──────────────────────────────────────────────────────

interface PerTableResult {
  table: ArchivableTable;
  scannedRows: number;
  wouldArchiveRows: number;
  archivedRows: number;
  deletedRows: number;
  uniqueKeys: string[];
  skippedKeysAlreadyExist: string[];
  estimatedBytesUncompressed: number;
  estimatedBytesCompressed: number;
  chunks: number;
}

interface ArchiveResult {
  dryRun: boolean;
  cutoffMs: number;
  cutoffISO: string;
  startedAt: number;
  durationMs: number;
  perTable: PerTableResult[];
}

// ── Main internalAction ────────────────────────────────────────────────

export const archiveToR2 = internalAction({
  args: {
    dry_run: v.optional(v.boolean()),
    tables: v.optional(v.array(v.string())),
    chunk_size: v.optional(v.number()),
  },
  handler: async (
    ctx,
    {
      dry_run = true,
      tables = ["hygglo_messages", "audit_log"],
      chunk_size = 500,
    },
  ): Promise<ArchiveResult> => {
    // H2 double-gate: even if `dry_run: false` is passed (e.g. cron edit slip),
    // require ARCHIVE_TO_R2_LIVE=1 env var to actually delete rows. Otherwise
    // force back to dry-run with a warning. Belt-and-braces for irreversible op.
    const live = process.env.ARCHIVE_TO_R2_LIVE === "1";
    if (!live && !dry_run) {
      console.warn(
        "[archive_to_r2] ARCHIVE_TO_R2_LIVE not set; forcing dry_run=true",
      );
      dry_run = true;
    }
    const startedAt = Date.now();
    const cutoffMs = startedAt - NINETY_DAYS_MS;
    const cutoffISO = new Date(cutoffMs).toISOString();
    const safeChunk = Math.max(1, Math.min(2000, chunk_size));

    console.log("[archive_to_r2] starting", {
      dry_run,
      live_gate: live,
      tables,
      chunk_size: safeChunk,
      cutoffISO,
    });

    const perTable: PerTableResult[] = [];

    for (const rawTable of tables) {
      if (!isArchivableTable(rawTable)) {
        console.warn("[archive_to_r2] skipping unknown table", { table: rawTable });
        continue;
      }
      const table: ArchivableTable = rawTable;

      const result: PerTableResult = {
        table,
        scannedRows: 0,
        wouldArchiveRows: 0,
        archivedRows: 0,
        deletedRows: 0,
        uniqueKeys: [],
        skippedKeysAlreadyExist: [],
        estimatedBytesUncompressed: 0,
        estimatedBytesCompressed: 0,
        chunks: 0,
      };

      let cursorMs: number | undefined = undefined;
      const seenKeys = new Set<string>();

      // Safety cap so a runaway loop on a corrupt cursor can't blow the
      // action budget. 200 chunks × 500 rows = 100k rows per run, plenty.
      const MAX_CHUNKS_PER_RUN = 200;
      let chunkIdx = 0;

      while (chunkIdx < MAX_CHUNKS_PER_RUN) {
        const chunkResult: {
          rows: Array<
            Record<string, unknown> & { _id: string; _creationTime: number }
          >;
          nextCursorMs: number | null;
        } = await ctx.runQuery(internal.archive_to_r2_helpers.listOldChunk, {
          table,
          cutoffMs,
          cursorMs,
          chunkSize: safeChunk,
        });
        const rows = chunkResult.rows;
        const nextCursorMs = chunkResult.nextCursorMs;

        if (rows.length === 0) break;
        result.scannedRows += rows.length;

        // Group the chunk by creation date so each yyyy-mm-dd lands in one
        // R2 key. Within a single action run, the same date may appear
        // again across chunks — those subsequent appearances are appended
        // to a fresh blob (idempotency check uses HeadObject before write).
        const groups = groupByCreationDate(
          rows as Array<Record<string, unknown> & { _id: string; _creationTime: number }>,
        );

        for (const g of groups) {
          const key = archiveKey(table, g.rows[0]!._creationTime);

          const jsonl = g.rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
          const uncompressed = Buffer.byteLength(jsonl, "utf8");
          const gz = gzipSync(Buffer.from(jsonl, "utf8"));
          const compressed = gz.byteLength;

          result.wouldArchiveRows += g.rows.length;
          result.estimatedBytesUncompressed += uncompressed;
          result.estimatedBytesCompressed += compressed;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            result.uniqueKeys.push(key);
          }
          result.chunks += 1;

          if (dry_run) {
            console.log("[archive_to_r2] DRY RUN — would archive", {
              table,
              key,
              rows: g.rows.length,
              bytesGz: compressed,
            });
            continue;
          }

          // Live path. Idempotency: skip if key already present in R2.
          const alreadyExists = await r2KeyExists(key);
          if (alreadyExists) {
            result.skippedKeysAlreadyExist.push(key);
            console.log("[archive_to_r2] key exists, skipping write+delete", {
              table,
              key,
              rows: g.rows.length,
            });
            continue;
          }

          await r2PutChunk(key, gz);
          result.archivedRows += g.rows.length;
          console.log("[archive_to_r2] r2 put OK", {
            table,
            key,
            rows: g.rows.length,
            bytesGz: compressed,
          });

          // ONLY after PUT succeeded — bulk delete the archived rows.
          const deleted = await ctx.runMutation(
            internal.archive_to_r2_helpers.deleteChunk,
            { table, ids: g.rows.map((r) => r._id) },
          );
          result.deletedRows += deleted.deleted;
          console.log("[archive_to_r2] deleted from convex", {
            table,
            key,
            deleted: deleted.deleted,
          });
        }

        if (nextCursorMs === null) break;
        cursorMs = nextCursorMs;
        chunkIdx += 1;
      }

      console.log("[archive_to_r2] per-table done", result);
      perTable.push(result);
    }

    const durationMs = Date.now() - startedAt;
    const summary: ArchiveResult = {
      dryRun: dry_run,
      cutoffMs,
      cutoffISO,
      startedAt,
      durationMs,
      perTable,
    };
    console.log("[archive_to_r2] complete", summary);
    return summary;
  },
});

// ── R2 fallback reader (Node action — Convex `query` can't reach S3) ───
//
// Use this from server-side endpoints that need messages crossing the 90d
// archive boundary. Pure queries (e.g. `hygglo.getRecentMessages`) keep
// their hot-only behaviour; date-range readers call this action explicitly.
//
// Convex `query` cannot call `fetch`/AWS SDK — so the merge between hot
// rows (in Convex) and cold rows (in R2) has to live in an action.
// Pattern: action `runQuery`s the hot range, then concat with R2 rows
// when the requested window crosses the 90d boundary.

export const getMessagesIncludingArchive = internalAction({
  args: {
    accountSlug: v.optional(v.string()),
    fromMs: v.number(),
    toMs: v.number(),
  },
  handler: async (
    ctx,
    { accountSlug, fromMs, toMs },
  ): Promise<{
    hotRows: Array<Record<string, unknown>>;
    archiveRows: Array<Record<string, unknown>>;
  }> => {
    const ninetyDaysAgo = Date.now() - NINETY_DAYS_MS;

    // Hot rows: anything still in Convex matching the requested window.
    // We reuse `listOldChunk`'s shape via a tiny dedicated query for the
    // recent slice — kept simple here by re-using getRecentMessages-ish
    // semantics. In practice callers can substitute their own query.
    const hotRows = (await ctx.runQuery(
      internal.archive_to_r2_helpers.listRangeForReader,
      {
        table: "hygglo_messages",
        fromMs,
        toMs,
        accountSlug,
      },
    )) as Array<Record<string, unknown>>;

    let archiveRows: Array<Record<string, unknown>> = [];
    if (fromMs < ninetyDaysAgo) {
      // Bound the archive window by the 90d cutoff so we don't refetch
      // anything that overlaps the hot slice.
      const archiveTo = Math.min(toMs, ninetyDaysAgo - 1);
      const raw = await loadArchivedRange<
        Record<string, unknown> & {
          _creationTime: number;
          account_slug?: string;
        }
      >("hygglo_messages", fromMs, archiveTo);
      archiveRows = accountSlug
        ? raw.filter((r) => r.account_slug === accountSlug)
        : raw;
    }

    return { hotRows, archiveRows };
  },
});

// listRangeForReader query moved to archive_to_r2_helpers.ts
