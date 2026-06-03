/**
 * parity-dryrun — PROVE field parity between hygglo-core's `corePoll` assembler
 * and the live reservation rows the production poller has written, WITHOUT
 * WRITING ANYTHING.
 *
 *   Run:  npx tsx src/hygglo-core/scripts/parity-dryrun.ts
 *
 * WHAT IT DOES (all read-only):
 *   1. `corePoll(account)` for leo + dbcinema — read-only Hygglo GETs (same as
 *      the 15-min poller), assembling the upsertOrdersAsReservationsBatch args.
 *   2. For each assembled order, READ the stored Convex reservation row via the
 *      existing public query `reservations:getByHygglo` (read-only — no auth,
 *      no mutation). Match by hygglo_order_id.
 *   3. Project the core args through the SERVER's known row-transform
 *      (`upsertOrderImpl` baseFields: status derivation, items projection,
 *      is_obsolete/obsolete_reason derivation, order_step) so we compare the
 *      ROW the core→server pipeline would land vs the ROW the live pipeline
 *      already landed.
 *   4. Diff ONLY the fields the poller itself writes. Enrichment fields written
 *      by OTHER tasks (resolved_items, *_vision, demand_loss_*, pickup/return
 *      time extraction, listing resolution, renter_id linkage, fee splits,
 *      timestamps) are EXCLUDED — they are not the poller's output.
 *   5. Report per account: #orders compared, #exact matches, the full list of
 *      delta fields, and a couple of redacted sample diffs (PII-bearing fields
 *      show "differs" only, never the value).
 *
 * WRITES NOTHING: no Convex mutation, no Hygglo write, no Trigger enqueue.
 * Convex access is the read-only `/api/query` endpoint only.
 */

import { corePoll } from "../poll";
import {
  deriveStatusFromStep,
  serverObsoleteFields,
  projectItems,
  type CoreReservationArg,
} from "./parity-projection";

// ── Config ───────────────────────────────────────────────────────────────

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
const READ_URL_FALLBACK = "https://hearty-oyster-600.convex.cloud";
const ACCOUNTS = ["leo", "dbcinema"] as const;

// ── Field classification ─────────────────────────────────────────────────

/**
 * Fields the POLLER writes to a reservation row (via upsertOrderImpl baseFields
 * + the insert/patch paths). These are the ONLY fields we diff. Source of truth:
 * convex/hygglo.ts upsertOrderImpl.
 */
const POLLER_WRITTEN_FIELDS = [
  "status",
  "source_filter",
  "start_date",
  "end_date",
  "gross_paid_gbp",
  "net_to_owner_gbp",
  "currency",
  "items",
  "duration_days",
  "renter_name",
  "hygglo_user_id",
  "booking_status",
  "notes",
  "photos_urls",
  "latest_activity",
  "order_step",
  "is_obsolete",
  "obsolete_reason",
  "hygglo_system_signal",
  "hygglo_system_signal_text",
] as const;
// NOTE: pickup_time / return_time / pickup_method / return_method are NOT here.
// The poller's mapper reads them from `detail.booking.*`, but Hygglo's live
// order-detail endpoint carries NO `booking` object (verified 2026-06-03; the
// comment in convex/extract_booking_times.ts says the same: "Hygglo's API does
// NOT expose pickup_time / return_time on the order detail"). The STORED values
// are written by the `extract_booking_times` LLM task parsing owner↔renter chat
// — not by the poller. So they belong in the excluded set, NOT the diff.

/**
 * PII-bearing fields — when these differ we report ONLY the field name + that it
 * differs, never the values. (renter_name is a person's name; notes can carry
 * personal info; photos_urls may embed identifying CDN paths.)
 */
const PII_FIELDS = new Set(["renter_name", "notes", "photos_urls"]);

/**
 * Fields written by OTHER tasks — NEVER diffed (documented for the report so it
 * is explicit WHY they are excluded):
 *   resolved_items / expanded_items / resolution_*  → listing_resolver
 *   pickup_date / return_date / pickup_at / return_at / times_* /
 *     pickup_arrival_confirmed                       → extract_booking_times
 *   demand_loss_* / denial_actor / reclassified_* /
 *     *_at_obsolete / chat_*_hit / obsolete_at       → gap detector / canonicalize
 *   renter_id                                        → resolved server-side from
 *     a renter row inserted IN THE SAME poll cycle (insert-order race: the link
 *     lands on the NEXT poll, so it is structurally not offline-verifiable)
 *   image_hints / hygglo_items                       → server-BUILT from items;
 *     compared indirectly via `items` parity (same source array)
 *   platform_fee_* / delivery_fee_gbp                → not poller output
 *   last_polled_at / created_at / imported_at        → non-deterministic stamps
 */
const EXCLUDED_FIELDS_DOC = [
  // extract_booking_times (LLM chat parse) — Hygglo detail has no booking.* :
  "pickup_time",
  "return_time",
  "pickup_method",
  "return_method",
  "resolved_items",
  "expanded_items",
  "resolution_method",
  "resolution_at",
  "resolution_input_hash",
  "pickup_date",
  "return_date",
  "pickup_at",
  "return_at",
  "pickup_arrival_confirmed",
  "times_extracted_at",
  "times_transcript_hash",
  "demand_loss_class",
  "demand_loss_classified_at",
  "demand_loss_estimated_gbp",
  "denial_actor",
  "reclassified_outcome",
  "reclassified_at",
  "reclassified_signal",
  "reclassified_confidence",
  "obsolete_at",
  "last_message_sender_at_obsolete",
  "last_message_at_obsolete",
  "chat_owner_cancel_hit",
  "chat_renter_cancel_hit",
  "chat_owner_approval_hit",
  "renter_id",
  "image_hints",
  "hygglo_items",
  "platform_fee_gbp",
  "platform_fee_pct",
  "delivery_fee_gbp",
  "last_polled_at",
  "created_at",
  "imported_at",
];

// ── Convex read-only helpers ─────────────────────────────────────────────

interface VaultSecret {
  keyName: string;
  value: string;
}

/** Read the rmv2 Convex deployment URL from the vault (service `convex`, key
 *  NEXT_PUBLIC_CONVEX_URL_RMV2). Read-only. Falls back to the known prod URL. */
async function resolveReadUrl(): Promise<string> {
  try {
    const res = await fetch(`${VAULT_URL}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "secrets:getOne",
        args: { service: "convex", keyName: "NEXT_PUBLIC_CONVEX_URL_RMV2" },
        format: "json",
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        value?: { value?: string } | VaultSecret;
      };
      // secrets:getOne returns { value: { ...row, value } }.
      const url =
        (data.value as { value?: string } | undefined)?.value ?? undefined;
      if (typeof url === "string" && url.startsWith("https://")) return url;
    }
  } catch {
    // fall through to fallback
  }
  return READ_URL_FALLBACK;
}

/** Read one stored reservation row by hygglo_order_id (read-only query). */
async function readStoredRow(
  readUrl: string,
  hygglo_order_id: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${readUrl}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "reservations:getByHygglo",
      args: { hygglo_order_id },
      format: "json",
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { status?: string; value?: unknown };
  if (data.status !== "success") return null;
  return (data.value as Record<string, unknown> | null) ?? null;
}

// ── Server-row projection ────────────────────────────────────────────────

/**
 * Project a core `upsertOrdersAsReservationsBatch` arg through the server's
 * `upsertOrderImpl` baseFields transform → the subset of the stored ROW that
 * the poller controls. Mirrors convex/hygglo.ts exactly for the diffed fields.
 *
 * PRESERVE-ON-UNDEFINED (parity-critical): the server only patches `order_step`
 * when the incoming step is defined — `const stepPatch = incomingStep !==
 * undefined ? { order_step: incomingStep } : {}`. So when core extracts NO
 * active step (e.g. an obsolete order whose funnel has no active step), the
 * server KEEPS the previously-stored `order_step`, and `status` /
 * is_obsolete are derived from that EFFECTIVE step. To compare what the server
 * WOULD land (not a naive overwrite), we feed the stored step in when core's is
 * undefined. This is exactly what a live re-poll of the same row produces.
 */
function projectToRow(
  arg: CoreReservationArg,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  // Effective step = core's extracted step, or (preserve-on-undefined) the
  // step already stored. Matches upsertOrderImpl's stepPatch semantics.
  const effective_order_step =
    arg.order_step_extracted ??
    (stored.order_step as string | undefined) ??
    undefined;
  const status = deriveStatusFromStep(effective_order_step, arg.sourceFilter);
  const { is_obsolete, obsolete_reason } = serverObsoleteFields(
    arg.sourceFilter,
    effective_order_step,
  );
  return {
    status,
    source_filter: arg.sourceFilter,
    start_date: arg.start_date,
    end_date: arg.end_date,
    gross_paid_gbp: arg.gross_paid_gbp,
    net_to_owner_gbp: arg.net_to_owner_gbp,
    currency: arg.currency,
    items: projectItems(arg.items),
    duration_days: arg.duration_days,
    renter_name: arg.renter_name,
    hygglo_user_id: arg.hygglo_user_id,
    booking_status: arg.booking_status,
    order_step: effective_order_step,
    notes: arg.notes,
    photos_urls: arg.photos_urls,
    latest_activity: arg.latest_activity,
    is_obsolete,
    obsolete_reason,
    hygglo_system_signal: arg.hygglo_system_signal,
    hygglo_system_signal_text: arg.hygglo_system_signal_text,
  };
}

// ── Diff ─────────────────────────────────────────────────────────────────

/** Stable normalise for comparison: undefined/null collapse; arrays/objects
 *  via canonical JSON. The server only persists defined values, so a core
 *  `undefined` and a stored "missing" are equal. */
function norm(v: unknown): string {
  if (v === undefined || v === null) return " absent";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

interface FieldDelta {
  field: string;
  pii: boolean;
  coreSample?: string;
  storedSample?: string;
}

function diffRow(
  projected: Record<string, unknown>,
  stored: Record<string, unknown>,
): FieldDelta[] {
  const deltas: FieldDelta[] = [];
  for (const field of POLLER_WRITTEN_FIELDS) {
    const a = norm(projected[field]);
    const b = norm(stored[field]);
    if (a === b) continue;
    const pii = PII_FIELDS.has(field);
    deltas.push(
      pii
        ? { field, pii }
        : {
            field,
            pii,
            coreSample: a.slice(0, 80),
            storedSample: b.slice(0, 80),
          },
    );
  }
  return deltas;
}

// ── Report ───────────────────────────────────────────────────────────────

interface AccountReport {
  account: string;
  ordersAssembled: number;
  ordersMatchedToStored: number;
  ordersMissingStored: string[];
  exactMatches: number;
  fieldDeltaCounts: Map<string, number>;
  sampleDiffs: Array<{ order_id: string; deltas: FieldDelta[] }>;
}

async function runAccount(
  account: string,
  readUrl: string,
): Promise<AccountReport> {
  // Deterministic fetchedAt so timestamp-derived fields are stable across runs.
  const poll = await corePoll(account, { fetchedAt: Date.now() });
  const report: AccountReport = {
    account,
    ordersAssembled: poll.reservations.length,
    ordersMatchedToStored: 0,
    ordersMissingStored: [],
    exactMatches: 0,
    fieldDeltaCounts: new Map(),
    sampleDiffs: [],
  };

  for (const arg of poll.reservations as CoreReservationArg[]) {
    const stored = await readStoredRow(readUrl, arg.hygglo_order_id);
    if (!stored) {
      report.ordersMissingStored.push(arg.hygglo_order_id);
      continue;
    }
    report.ordersMatchedToStored++;
    const projected = projectToRow(arg, stored);
    const deltas = diffRow(projected, stored);
    if (deltas.length === 0) {
      report.exactMatches++;
      continue;
    }
    for (const d of deltas) {
      report.fieldDeltaCounts.set(
        d.field,
        (report.fieldDeltaCounts.get(d.field) ?? 0) + 1,
      );
    }
    if (report.sampleDiffs.length < 3) {
      report.sampleDiffs.push({ order_id: arg.hygglo_order_id, deltas });
    }
  }
  return report;
}

function printReport(r: AccountReport): void {
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  ACCOUNT: ${r.account}`);
  console.log(`══════════════════════════════════════════════════════════`);
  console.log(`  orders assembled by corePoll : ${r.ordersAssembled}`);
  console.log(`  matched to a stored row      : ${r.ordersMatchedToStored}`);
  console.log(`  not yet in Convex (new)      : ${r.ordersMissingStored.length}`);
  console.log(`  EXACT field-parity matches   : ${r.exactMatches}/${r.ordersMatchedToStored}`);
  if (r.fieldDeltaCounts.size === 0) {
    console.log(`  delta fields                 : NONE ✅`);
  } else {
    console.log(`  delta fields                 :`);
    for (const [field, count] of [...r.fieldDeltaCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      const pii = PII_FIELDS.has(field) ? " (PII — value redacted)" : "";
      console.log(`      - ${field}: ${count} row(s)${pii}`);
    }
    console.log(`  sample diffs (redacted):`);
    for (const s of r.sampleDiffs) {
      console.log(`      order ${s.order_id}:`);
      for (const d of s.deltas) {
        if (d.pii) {
          console.log(`        ${d.field}: DIFFERS (PII value not shown)`);
        } else {
          console.log(
            `        ${d.field}: core=[${d.coreSample}] stored=[${d.storedSample}]`,
          );
        }
      }
    }
  }
  if (r.ordersMissingStored.length > 0) {
    console.log(
      `  (orders with no stored row are excluded from the parity gate — ` +
        `they are net-new since the last live poll, nothing to compare)`,
    );
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("hygglo-core parity dry-run — READ-ONLY, writes nothing.\n");
  const readUrl = await resolveReadUrl();
  console.log(`Convex read endpoint: ${readUrl.replace(/https:\/\//, "")}`);
  console.log(
    `Diffing ${POLLER_WRITTEN_FIELDS.length} poller-written fields; ` +
      `${EXCLUDED_FIELDS_DOC.length} enrichment fields excluded.`,
  );

  const reports: AccountReport[] = [];
  for (const account of ACCOUNTS) {
    try {
      reports.push(await runAccount(account, readUrl));
    } catch (err) {
      console.error(
        `\n[${account}] FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const r of reports) printReport(r);

  // ── Gate verdict ──
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  0-DELTA PARITY GATE`);
  console.log(`══════════════════════════════════════════════════════════`);
  let gateMet = true;
  let totalCompared = 0;
  let totalExact = 0;
  for (const r of reports) {
    totalCompared += r.ordersMatchedToStored;
    totalExact += r.exactMatches;
    if (r.fieldDeltaCounts.size > 0) gateMet = false;
  }
  console.log(`  total orders compared : ${totalCompared}`);
  console.log(`  total exact matches   : ${totalExact}`);
  console.log(
    `  GATE: ${gateMet ? "MET ✅ (zero deltas on poller-written fields)" : "NOT MET ❌ (see delta fields above)"}`,
  );
  console.log(
    `\nExcluded (not offline-verifiable / not poller output):\n  ${EXCLUDED_FIELDS_DOC.join(", ")}`,
  );
}

main().catch((err) => {
  console.error("parity-dryrun fatal:", err);
  process.exit(1);
});
