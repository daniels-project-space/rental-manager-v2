#!/usr/bin/env node
// Backfill v2 daniel_revenue_gbp + vertus_revenue_gbp from v1's /api/revenue/lifetime.
// Idempotent — calls historical_revenue:patchDanielVertusMonth per month.
import { ConvexHttpClient } from "convex/browser";
import fs from "node:fs";

const CONVEX_URL = "https://exciting-lion-29.convex.cloud";
const client = new ConvexHttpClient(CONVEX_URL);

const v1 = JSON.parse(fs.readFileSync("/tmp/v1-revenue/lifetime.json", "utf8"));
const months = v1.months
  .filter((m) => (m.danielRevenue || 0) > 0 || (m.vertusRevenue || 0) > 0)
  .map((m) => ({
    month: m.month,
    daniel: Number((m.danielRevenue || 0).toFixed(2)),
    vertus: Number((m.vertusRevenue || 0).toFixed(2)),
  }));

console.log(`Backfilling ${months.length} months...`);
let patched = 0;
const results = [];
for (const m of months) {
  try {
    const r = await client.mutation("historical_revenue:patchDanielVertusMonth", {
      month: m.month,
      daniel_revenue_gbp: m.daniel,
      vertus_revenue_gbp: m.vertus,
      source: "v1-port-2026-05-12",
    });
    patched += 1;
    results.push({ ...m, action: r.action });
    console.log(`  ${m.month}  daniel=£${m.daniel.toFixed(2)}  vertus=£${m.vertus.toFixed(2)}  -> ${r.action}`);
  } catch (e) {
    console.error(`  FAIL ${m.month}: ${e.message}`);
  }
}
console.log(`\nDone. Rows patched: ${patched}/${months.length}`);
const totalD = months.reduce((s, m) => s + m.daniel, 0);
const totalV = months.reduce((s, m) => s + m.vertus, 0);
console.log(`Totals from v1: daniel=£${totalD.toFixed(2)}  vertus=£${totalV.toFixed(2)}`);
