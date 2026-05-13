#!/usr/bin/env node
/**
 * One-shot sync: pull rich reservation fields (renter_name, order_step,
 * pickup_time, return_time, photos_urls, booking_status) from the legacy
 * `exciting-lion-29` Convex deployment (where the Trigger.dev poller had
 * been writing) into the live v2 deployment `hearty-oyster-600`.
 *
 * Idempotent: adminPatchRichFieldsByHyggloId only fills blank fields.
 *
 * Run on VPS:
 *   cd /home/ubuntu/rental-manager-v2
 *   node scripts/sync-rich-fields-from-exciting-lion.mjs
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const SOURCE_URL = "https://exciting-lion-29.convex.cloud";
const TARGET_URL = "https://hearty-oyster-600.convex.cloud";

const source = new ConvexHttpClient(SOURCE_URL);
const target = new ConvexHttpClient(TARGET_URL);

const needsBackfill = await target.query(api.reservations.adminListNeedsRichBackfill, {});
console.log(`[sync] target needs backfill on ${needsBackfill.length} reservations`);

const BATCH = 25;
let patched = 0;
let skipped = 0;
let missingInSource = 0;
let errored = 0;

for (let i = 0; i < needsBackfill.length; i += BATCH) {
  const batch = needsBackfill.slice(i, i + BATCH);
  const results = await Promise.all(
    batch.map(async ({ hygglo_order_id }) => {
      try {
        const src = await source.query(api.reservations.getByHygglo, { hygglo_order_id });
        if (!src) return { kind: "missing" };
        const payload = {
          hygglo_order_id,
          renter_name: src.renter_name ?? undefined,
          order_step: src.order_step ?? undefined,
          booking_status: src.booking_status ?? undefined,
          pickup_time: src.pickup_time ?? undefined,
          return_time: src.return_time ?? undefined,
          pickup_date: src.pickup_date ?? undefined,
          photos_urls: Array.isArray(src.photos_urls) ? src.photos_urls : undefined,
        };
        const hasAny =
          payload.renter_name ||
          payload.order_step ||
          payload.booking_status ||
          payload.pickup_time ||
          payload.return_time ||
          payload.pickup_date ||
          (payload.photos_urls && payload.photos_urls.length > 0);
        if (!hasAny) return { kind: "skipped" };
        const out = await target.mutation(api.reservations.adminPatchRichFieldsByHyggloId, payload);
        return { kind: "patched", ...out };
      } catch (err) {
        return { kind: "error", err: String(err) };
      }
    }),
  );
  for (const r of results) {
    if (r.kind === "patched") patched += r.patched;
    else if (r.kind === "skipped") skipped++;
    else if (r.kind === "missing") missingInSource++;
    else errored++;
  }
  process.stdout.write(
    `[sync] ${Math.min(i + BATCH, needsBackfill.length)}/${needsBackfill.length} — patched:${patched} skipped:${skipped} missing:${missingInSource} err:${errored}\r`,
  );
}
console.log();
console.log("[sync] DONE", { patched, skipped, missingInSource, errored });
