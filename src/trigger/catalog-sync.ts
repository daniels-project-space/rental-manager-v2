/**
 * catalog-sync — Phase 3 (ADDITIVE, marketing-listings layer).
 *
 * Syncs the full Hygglo catalog (GET /v2/my/products[/{id}]) for each account
 * into the NEW Convex `hygglo_products` table. READ-ONLY against Hygglo: only
 * v2 GET requests after auth; the only writes are to Convex.
 *
 * For every product we attempt a fuzzy match against the master `items` table
 * (by canonical name / aliases, with the listing slug as a fallback phrase).
 * A confident match (score ≥ MATCH_THRESHOLD) sets `masterItemId`; otherwise
 * the row is flagged `isMarketingOnly: true`.
 *
 * This task does NOT modify `items`, `bundles`, or the poll path, and is not
 * wired into any dashboard widget — it is data ingest only.
 *
 * Two entry points:
 *   - catalogSyncTask        : daily off-peak schedule (cron "37 4 * * *").
 *   - catalogSyncOnDemandTask : manual / on-demand trigger, supports dryRun.
 *
 * Credentials/auth/vault are resolved inside `createHyggloCore` →
 * `getAccountCredentials(slug)` — the SAME vault path the poller's corePoll
 * uses. No secrets are handled in this file.
 */

import { schedules, task, logger } from "@trigger.dev/sdk/v3";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { createHyggloCore } from "../hygglo-core/index";
import type { HyggloProductDetail } from "../hygglo-core/types";
import {
  buildCandidates,
  matchProduct,
  toUpsertArg,
  type InventoryRow,
  type ProductUpsertArg,
} from "./catalog-sync.map";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

// Accounts to sync. country GB for both (matches auth-account defaults).
const ACCOUNTS: ReadonlyArray<{ slug: string; country: string }> = [
  { slug: "leo", country: "GB" },
  { slug: "dbcinema", country: "GB" },
];

// Upsert chunk size — one mutation per chunk, not per product.
const UPSERT_CHUNK = 50;

// ── Core sync routine (shared by scheduled + on-demand) ──────────────────────

interface SyncOptions {
  /** When true, fetch + match + count but do NOT write hygglo_products. */
  dryRun?: boolean;
  /** When true, also GET each product's detail (unavailableDates). Default true. */
  fetchDetail?: boolean;
}

interface AccountSyncResult {
  slug: string;
  ok: boolean;
  products: number;
  matched: number;
  marketingOnly: number;
  inserted: number;
  updated: number;
  error?: string;
}

async function runCatalogSync(
  opts: SyncOptions = {},
): Promise<{ results: AccountSyncResult[]; durationMs: number }> {
  const dryRun = opts.dryRun === true;
  const fetchDetail = opts.fetchDetail !== false;
  const runStart = Date.now();
  const convex = new ConvexHttpClient(CONVEX_URL);

  // Read master inventory once (shared across accounts). listForReconcile
  // returns { _id, name (=name_canonical), aliases, qty } — exactly the shape
  // the fuzzy matcher needs. We never mutate `items`.
  const itemsRaw = (await convex.query(api.items.listForReconcile, {})) as Array<{
    _id: string;
    name: string;
    aliases?: string[];
  }>;
  const inventory: InventoryRow[] = itemsRaw.map((i) => ({
    _id: i._id as Id<"items">,
    name: i.name,
    aliases: i.aliases ?? [],
  }));
  const candidates = buildCandidates(inventory);

  const results: AccountSyncResult[] = [];

  for (const account of ACCOUNTS) {
    try {
      const core = createHyggloCore({ slug: account.slug, country: account.country });
      const products = await core.listProducts();
      logger.info("[catalog-sync] listed products", {
        account: account.slug,
        count: products.length,
      });

      const upserts: ProductUpsertArg[] = [];
      let matched = 0;
      for (const p of products) {
        if (typeof p.id !== "number") continue;

        let detail: HyggloProductDetail | undefined;
        if (fetchDetail) {
          try {
            detail = await core.getProduct(p.id);
          } catch (detErr) {
            // Detail is best-effort enrichment (unavailableDates). A miss must
            // not drop the row — fall back to the list payload.
            logger.warn("[catalog-sync] getProduct detail failed (non-fatal)", {
              account: account.slug,
              productId: p.id,
              err: String(detErr),
            });
          }
        }

        const m = matchProduct(p, inventory, candidates);
        if (m) matched++;
        upserts.push(toUpsertArg(account.slug, p, detail, m));
      }

      let inserted = 0;
      let updated = 0;
      if (!dryRun) {
        for (let i = 0; i < upserts.length; i += UPSERT_CHUNK) {
          const batch = upserts.slice(i, i + UPSERT_CHUNK);
          const r = await convex.mutation(api.hygglo_products.upsertProductsBatch, {
            products: batch,
          });
          inserted += r.inserted;
          updated += r.updated;
        }
      }

      const marketingOnly = upserts.length - matched;
      logger.info("[catalog-sync] account done", {
        account: account.slug,
        products: upserts.length,
        matched,
        marketingOnly,
        inserted,
        updated,
        dryRun,
      });
      results.push({
        slug: account.slug,
        ok: true,
        products: upserts.length,
        matched,
        marketingOnly,
        inserted,
        updated,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("[catalog-sync] account failed", { account: account.slug, err: msg });
      // One account's failure must not crash the other.
      results.push({
        slug: account.slug,
        ok: false,
        products: 0,
        matched: 0,
        marketingOnly: 0,
        inserted: 0,
        updated: 0,
        error: msg,
      });
    }
  }

  const durationMs = Date.now() - runStart;

  // Record a sync_state run (distinct source so it never collides with the
  // poller's row). rowsUpserted keys are constrained by the validator to the
  // poller's set, so we record only source/succeeded/durationMs here.
  try {
    const allOk = results.every((r) => r.ok);
    await convex.mutation(api.sync_state.recordSyncRun, {
      source: "hygglo_catalog_sync",
      succeeded: allOk,
      durationMs,
      ...(allOk
        ? {}
        : {
            errorMessage: results
              .filter((r) => !r.ok)
              .map((r) => `${r.slug}: ${r.error}`)
              .join("; "),
          }),
    });
  } catch (syncErr) {
    logger.error("[catalog-sync] recordSyncRun failed", { err: String(syncErr) });
  }

  return { results, durationMs };
}

// ── Tasks ────────────────────────────────────────────────────────────────────

/** Daily off-peak full catalog sync. */
export const catalogSyncTask = schedules.task({
  id: "catalog-sync",
  cron: "37 4 * * *",
  maxDuration: 300,
  retry: { maxAttempts: 2 },
  run: async () => {
    const { results, durationMs } = await runCatalogSync({ dryRun: false });
    return { results, durationMs, ts: Date.now() };
  },
});

/**
 * On-demand catalog sync. Accepts `{ dryRun, fetchDetail }` so an operator can
 * validate read-only (dryRun: true → no Convex writes) before a live run.
 */
export const catalogSyncOnDemandTask = task({
  id: "catalog-sync-on-demand",
  maxDuration: 300,
  run: async (payload: { dryRun?: boolean; fetchDetail?: boolean } = {}) => {
    const { results, durationMs } = await runCatalogSync({
      dryRun: payload.dryRun === true,
      fetchDetail: payload.fetchDetail,
    });
    return { results, durationMs, dryRun: payload.dryRun === true, ts: Date.now() };
  },
});
