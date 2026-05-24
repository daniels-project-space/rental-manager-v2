#!/usr/bin/env node
/**
 * Listing Info Pool — sample printer (2026-05-24).
 *
 * Eyeball-review CLI for Daniel. Pulls pool rows via Convex HTTP client and
 * pretty-prints {display_name, bundle_components, source_spans,
 * derivation_confidence, needs_review} so we can sanity-check a batch
 * before flipping consumer flags.
 *
 * Usage:
 *   node scripts/audit/print-info-pool-samples.mjs              # FX3 plan-doc sample
 *   node scripts/audit/print-info-pool-samples.mjs --all        # every pool row
 *   node scripts/audit/print-info-pool-samples.mjs --needs      # only needs_review
 *   node scripts/audit/print-info-pool-samples.mjs --account leo
 *
 * Env:
 *   NEXT_PUBLIC_CONVEX_URL (preferred)
 *   CONVEX_URL (fallback)
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";

const URL = process.env.NEXT_PUBLIC_CONVEX_URL
  ?? process.env.CONVEX_URL
  ?? "https://hearty-oyster-600.convex.cloud";

const args = process.argv.slice(2);
const opts = {
  all: args.includes("--all"),
  needs: args.includes("--needs") || args.includes("--needs-review"),
  account: args[args.indexOf("--account") + 1] !== "--account" ? args[args.indexOf("--account") + 1] : undefined,
};

const FX3_PLAN_TARGETS = [
  { account_slug: "dbcinema", product_id: 948607 },
  { account_slug: "dbcinema", product_id: 1011153 },
  { account_slug: "dbcinema", product_id: 1011859 },
  { account_slug: "leo", product_id: 1097499 },
  { account_slug: "leo", product_id: 1097510 },
  { account_slug: "leo", product_id: 1097513 },
  { account_slug: "leo", product_id: 1116309 },
  { account_slug: "leo", product_id: 1122292 },
  { account_slug: "leo", product_id: 1122295 },
];

function color(c, s) {
  const codes = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90, bold: 1 };
  return `[${codes[c] ?? 0}m${s}[0m`;
}

function statusGlyph(row) {
  if (row.is_manually_overridden) return color("magenta", "[OVERRIDE]");
  if (row.needs_review) return color("yellow", "[NEEDS-REVIEW]");
  if (row.derivation_confidence >= 0.7) return color("green", "[OK]");
  return color("cyan", `[CONF ${row.derivation_confidence}]`);
}

function printRow(row) {
  console.log("");
  console.log(color("bold", `  ${row.account_slug}#${row.product_id}`), statusGlyph(row));
  console.log(`    display_name      : ${color("cyan", row.display_name)}`);
  console.log(`    short_name        : ${row.short_name}`);
  console.log(`    bundle_summary    : ${row.bundle_summary ?? color("gray", "(null)")}`);
  console.log(`    primary           : ${row.primary_item_name_canonical ?? color("gray", "unresolved")}`);
  console.log(`    derivation_method : ${row.derivation_method}`);
  console.log(`    confidence        : ${row.derivation_confidence}`);
  console.log(`    signature         : ${row.canonical_bundle_signature}`);
  if (row.review_reasons.length > 0) {
    console.log(`    review_reasons    : ${color("yellow", row.review_reasons.join(", "))}`);
  }
  console.log(`    components (${row.bundle_components.length}):`);
  for (const c of row.bundle_components) {
    const kind = c.source_kind.padEnd(20);
    const canon = c.item_name_canonical ?? color("gray", "unresolved");
    const span = c.source_span ? `  span="${c.source_span.slice(0, 60)}"` : "";
    console.log(`      - [${kind}] qty=${c.qty} conf=${c.confidence}  ${canon}${span}`);
  }
}

async function main() {
  const client = new ConvexHttpClient(URL);

  let rows = [];

  if (opts.needs) {
    rows = await client.query(api.listing_info_pool.listNeedsReview, {
      account_slug: opts.account,
      limit: 200,
    });
    console.log(color("bold", `\nListing Info Pool — needs_review rows (${rows.length}):`));
  } else if (opts.all) {
    // No "list all" mutation; lookupBulk with a known key list is the cheap path.
    // For the audit script we pull all FX3 + any provided product_ids via --pid.
    console.log(color("yellow", "Note: --all currently fetches FX3 plan-doc set + active FX3s."));
    const allKeys = [...FX3_PLAN_TARGETS];
    const ans = await client.query(api.listing_info_pool.lookupBulk, { keys: allKeys });
    rows = Object.values(ans);
  } else {
    const ans = await client.query(api.listing_info_pool.lookupBulk, { keys: FX3_PLAN_TARGETS });
    rows = Object.values(ans);
    console.log(color("bold", `\nListing Info Pool — FX3 plan-doc sample (${rows.length} of ${FX3_PLAN_TARGETS.length}):`));
    const missing = FX3_PLAN_TARGETS.filter((t) =>
      !rows.some((r) => r.account_slug === t.account_slug && r.product_id === t.product_id),
    );
    if (missing.length > 0) {
      console.log(color("gray", `  missing (likely deleted listings): ${missing.map((m) => `${m.account_slug}#${m.product_id}`).join(", ")}`));
    }
  }

  rows.sort((a, b) =>
    a.account_slug.localeCompare(b.account_slug)
    || a.product_id - b.product_id,
  );

  let needsReviewCount = 0;
  for (const r of rows) {
    printRow(r);
    if (r.needs_review) needsReviewCount++;
  }

  console.log("");
  console.log(color("bold", `Summary: ${rows.length} rows, ${needsReviewCount} needs_review, ${rows.length - needsReviewCount} ok`));
}

main().catch((err) => {
  console.error(color("red", "ERROR:"), err);
  process.exit(1);
});
