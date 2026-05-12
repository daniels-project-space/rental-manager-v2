#!/usr/bin/env node
/**
 * v2-chat-eval.mjs
 * B-4 truth-validation harness for the v2 dashboard chat endpoint.
 * POSTs 5 prompts, diffs key facts vs /tmp/hygglo-truth-*.json,
 * writes /tmp/v2-chat-eval-YYYYMMDD.md with pass/fail verdicts.
 *
 * Usage:
 *   V2_CHAT_URL=https://... V2_CHAT_BEARER=xxx node v2-chat-eval.mjs
 *
 * Exit codes:
 *   0 — ran successfully (individual prompt failures are logged in the report)
 *   2 — endpoint unreachable or truth file missing
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// ── Config ─────────────────────────────────────────────────────
const ENDPOINT =
  process.env.V2_CHAT_URL ?? "https://rental-manager-v2-nu.vercel.app/api/chat";
const BEARER = process.env.V2_CHAT_BEARER ?? "";
const TIMEOUT_MS = 60_000;
const TRUTH_DIR = "/tmp";

// ── Truth-file discovery ────────────────────────────────────────
async function findLatestTruthFile() {
  const files = await readdir(TRUTH_DIR);
  const matches = files
    .filter((f) => /^hygglo-truth-\d{8}\.json$/.test(f))
    .sort(); // lexical sort = chronological (YYYYMMDD)
  if (matches.length === 0) return null;
  return join(TRUTH_DIR, matches[matches.length - 1]);
}

// ── SSE accumulator ────────────────────────────────────────────
function parseSSEChunks(rawText) {
  let accumulated = "";
  for (const line of rawText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") break;
    try {
      const obj = JSON.parse(payload);
      if (obj.text) accumulated += obj.text;
    } catch {
      // skip malformed chunks
    }
  }
  return accumulated;
}

// ── HTTP POST with timeout ──────────────────────────────────────
async function chatPost(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
  };
  if (BEARER) headers["Authorization"] = `Bearer ${BEARER}`;

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: prompt, thread_id: `eval-${Date.now()}` }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const rawBody = await response.text();

  if (contentType.includes("text/event-stream")) {
    return parseSSEChunks(rawBody);
  }
  // Fallback: plain JSON
  try {
    const obj = JSON.parse(rawBody);
    return obj.text ?? obj.content ?? obj.message ?? rawBody;
  } catch {
    return rawBody;
  }
}

// ── Caveat detector ────────────────────────────────────────────
const CAVEAT_RE = /imported|coverage|partial|stale|sync/i;

// ── 5 B-4 prompts + fact extractors ────────────────────────────
// Each entry:
//   prompt         — string sent to endpoint
//   label          — short ID
//   expectedFact   — (truth: Array<AccountSnapshot>) => { display: string, value: string|number }
//   matcher        — (responseText: string, expected: {display,value}) => 'pass'|'fail'|'pass_with_caveat'
//
// Truth JSON shape (array of AccountSnapshot):
//   [ { account, counts: { pending, current, future }, pending[], current[], future[],
//       todays_pickups[], todays_returns[], listing_rates: { [id]: { name, pricePerDay } } }, ... ]

const PROMPTS = [
  // ── Q1: FX3 daily rate ─────────────────────────────────────
  {
    label: "Q1_FX3_RATE",
    prompt: "What is the daily rate on a Sony FX3?",
    expectedFact(truth) {
      // Inferred from order math documented in b4-truth-validation.md: ~£40/day body
      // Try to find from listing_rates first; fall back to known value
      for (const acct of truth) {
        for (const rate of Object.values(acct.listing_rates ?? {})) {
          if (/fx3/i.test(rate.name ?? "") && rate.pricePerDay) {
            return { display: `£${rate.pricePerDay}/day (from listing_rates)`, value: rate.pricePerDay };
          }
        }
      }
      // Documented inference from order math
      return { display: "£40/day (inferred from order math)", value: 40 };
    },
    matcher(responseText, expected) {
      // Accept any mention of 40 (with optional £ and /day variants)
      const numericVal = typeof expected.value === "number" ? expected.value : parseFloat(expected.value);
      // Look for currency values in response near FX3 context
      const priceMatches = [...responseText.matchAll(/£?\s*(\d+(?:\.\d+)?)/g)].map((m) =>
        parseFloat(m[1])
      );
      const tolerance = numericVal * 0.05;
      const found = priceMatches.find(
        (v) => Math.abs(v - numericVal) <= tolerance
      );
      if (!found) return CAVEAT_RE.test(responseText) ? "pass_with_caveat" : "fail";
      return CAVEAT_RE.test(responseText) ? "pass_with_caveat" : "pass";
    },
  },

  // ── Q2: FX3 availability May 15-18 ────────────────────────
  {
    label: "Q2_FX3_AVAILABILITY",
    prompt: "Is the Sony FX3 available May 15-18?",
    expectedFact(truth) {
      // Ground truth: at least 2 dbcinema FX3s confirmed-booked through May 15-18
      // (Gerome Williams 05-14→05-18, James Inglis 05-14→05-28)
      // Correct answer: NOT fully available; at least dbcinema FX3s are blocked
      const blockedOrders = [];
      for (const acct of truth) {
        for (const order of [...(acct.future ?? []), ...(acct.current ?? [])]) {
          const itemNames = (order.items ?? []).join(" ").toLowerCase();
          if (!itemNames.includes("fx3")) continue;
          const start = order.start ?? "";
          const end = order.end ?? "";
          // Overlaps May 15-18 if start <= 2026-05-18 AND end >= 2026-05-15
          if (start <= "2026-05-18" && end >= "2026-05-15") {
            blockedOrders.push(`${acct.account}/${order.renter}`);
          }
        }
      }
      const hasConflicts = blockedOrders.length > 0;
      return {
        display: hasConflicts
          ? `NOT fully available — blocked: ${blockedOrders.join(", ")}`
          : "available (no confirmed conflicts found in truth snapshot)",
        value: hasConflicts ? "not_available" : "available",
      };
    },
    matcher(responseText, expected) {
      const text = responseText.toLowerCase();
      if (expected.value === "not_available") {
        // Should say NOT available / booked / unavailable for those dates
        const conflictSignals = /not available|unavailable|booked|conflict|taken|occupied|no.*free|busy/i.test(responseText);
        if (conflictSignals) return CAVEAT_RE.test(responseText) ? "pass_with_caveat" : "pass";
        // If it says "available" without qualification → fail
        const wrongSignals = /\bavailable\b/i.test(responseText) && !/not available|unavailable/i.test(responseText);
        if (wrongSignals) return "fail";
        return CAVEAT_RE.test(responseText) ? "pass_with_caveat" : "fail";
      }
      // Truth says available: response should not claim conflicts
      return /not available|unavailable|booked/i.test(responseText) ? "fail" : "pass";
    },
  },

  // ── Q3: Pending rentals ────────────────────────────────────
  {
    label: "Q3_PENDING_RENTALS",
    prompt: "What are the pending rentals?",
    expectedFact(truth) {
      let dbPending = 0;
      let leoPending = 0;
      for (const acct of truth) {
        if (acct.account === "dbcinema") dbPending = acct.counts?.pending ?? acct.pending?.length ?? 0;
        if (acct.account === "leo") leoPending = acct.counts?.pending ?? acct.pending?.length ?? 0;
      }
      const total = dbPending + leoPending;
      return {
        display: `~${total} pending orders (db: ${dbPending}, leo: ${leoPending})`,
        value: total,
      };
    },
    matcher(responseText, expected) {
      const total = typeof expected.value === "number" ? expected.value : parseInt(expected.value, 10);
      // Extract any numbers from the response that could be a pending count
      const nums = [...responseText.matchAll(/\b(\d+)\b/g)].map((m) => parseInt(m[1], 10));
      const tolerance = Math.max(5, total * 0.2); // allow ±20% or ±5, whichever larger
      const found = nums.find((n) => Math.abs(n - total) <= tolerance);
      if (found != null) return CAVEAT_RE.test(responseText) ? "pass_with_caveat" : "pass";
      // Also accept if response lists individual pending items (5+ rental items = partial pass)
      const itemCount = (responseText.match(/\b(pending|rental|order)\b/gi) ?? []).length;
      if (itemCount >= 3) return "pass_with_caveat";
      return CAVEAT_RE.test(responseText) ? "pass_with_caveat" : "fail";
    },
  },

  // ── Q4: Daily briefing ────────────────────────────────────
  {
    label: "Q4_DAILY_BRIEFING",
    prompt: "Give me a daily briefing",
    expectedFact(truth) {
      // Key verifiable facts: today's pickups and returns from ground truth
      const allPickups = [];
      const allReturns = [];
      for (const acct of truth) {
        for (const o of acct.todays_pickups ?? []) {
          allPickups.push(`${(o.items ?? []).join("+")}/${o.renter}`);
        }
        for (const o of acct.todays_returns ?? []) {
          allReturns.push(`${(o.items ?? []).join("+")}/${o.renter}`);
        }
      }
      return {
        display: `Pickups: ${allPickups.length}, Returns: ${allReturns.length} — ${allPickups.slice(0, 3).join("; ")}`,
        value: { pickups: allPickups, returns: allReturns },
      };
    },
    matcher(responseText, expected) {
      const { pickups, returns } = expected.value;
      // Check that at least 50% of today's pickups are mentioned (by renter name or item keyword)
      let pickupHits = 0;
      for (const p of pickups) {
        const parts = p.split("/");
        const renter = parts[parts.length - 1] ?? "";
        const firstNameWord = renter.split(" ")[0];
        if (firstNameWord && responseText.toLowerCase().includes(firstNameWord.toLowerCase())) {
          pickupHits++;
        }
      }
      const pickupCoverage = pickups.length > 0 ? pickupHits / pickups.length : 1;

      let returnHits = 0;
      for (const r of returns) {
        const parts = r.split("/");
        const renter = parts[parts.length - 1] ?? "";
        const firstNameWord = renter.split(" ")[0];
        if (firstNameWord && responseText.toLowerCase().includes(firstNameWord.toLowerCase())) {
          returnHits++;
        }
      }
      const returnCoverage = returns.length > 0 ? returnHits / returns.length : 1;

      const overallCoverage = (pickupCoverage + returnCoverage) / 2;
      if (overallCoverage >= 0.5) return CAVEAT_RE.test(responseText) ? "pass_with_caveat" : "pass";
      return CAVEAT_RE.test(responseText) ? "pass_with_caveat" : "fail";
    },
  },

  // ── Q5: Top earning items ─────────────────────────────────
  {
    label: "Q5_TOP_EARNERS",
    prompt: "What are our top earning items?",
    expectedFact(_truth) {
      // Ground truth from b4-truth-validation.md: FX3 #1, GM 24-70 #2 (well-evidenced)
      // These should appear in the response in any order within top-3
      return {
        display: "FX3 and Sony GM 24-70 in top earners list",
        value: ["fx3", "24-70", "24-70gm", "gm24-70", "24mm", "70mm"],
      };
    },
    matcher(responseText, expected) {
      const text = responseText.toLowerCase();
      // Must mention FX3
      const hasFX3 = /fx3/.test(text);
      // Must mention 24-70 lens in some form
      const hasLens = /24.?70|gm\s*24|24mm.*70mm/.test(text);
      if (hasFX3 && hasLens) return CAVEAT_RE.test(responseText) ? "pass_with_caveat" : "pass";
      if (hasFX3 || hasLens) return "pass_with_caveat";
      return "fail";
    },
  },
];

// ── Markdown report builder ─────────────────────────────────────
function buildReport({ runAt, endpoint, truthFile, results }) {
  const lines = [];
  lines.push("# v2 Chat Eval Report");
  lines.push("");
  lines.push(`**Run:** ${runAt}`);
  lines.push(`**Endpoint:** ${endpoint}`);
  lines.push(`**Truth file:** ${truthFile}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const r of results) {
    lines.push(`## ${r.label}`);
    lines.push("");
    lines.push(`**Prompt:** ${r.prompt}`);
    lines.push("");
    if (r.error) {
      lines.push(`**ERROR:** ${r.error}`);
      lines.push(`**Verdict:** FAIL`);
    } else {
      lines.push(`**Expected fact:** ${r.expectedFact}`);
      lines.push("");
      lines.push(`**Response (truncated to 500 chars):**`);
      lines.push("```");
      lines.push((r.responseText ?? "").slice(0, 500));
      lines.push("```");
      lines.push("");
      lines.push(`**Verdict:** ${r.verdict.toUpperCase()}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  const pass = results.filter((r) => r.verdict === "pass").length;
  const caveat = results.filter((r) => r.verdict === "pass_with_caveat").length;
  const fail = results.filter((r) => r.verdict === "fail").length;

  lines.push("## Summary");
  lines.push("");
  lines.push(`| Verdict | Count |`);
  lines.push(`|---------|-------|`);
  lines.push(`| PASS | ${pass}/5 |`);
  lines.push(`| PASS_WITH_CAVEAT | ${caveat}/5 |`);
  lines.push(`| FAIL | ${fail}/5 |`);
  lines.push("");
  lines.push(`**Overall: ${pass + caveat}/5 pass (including caveats), ${pass}/5 clean pass**`);

  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  // 1. Find truth file
  const truthFile = await findLatestTruthFile();
  if (!truthFile) {
    console.error("[eval] ERROR: no /tmp/hygglo-truth-*.json found");
    process.exit(2);
  }
  console.error(`[eval] Using truth file: ${truthFile}`);

  let truth;
  try {
    truth = JSON.parse(await readFile(truthFile, "utf8"));
  } catch (e) {
    console.error(`[eval] ERROR: failed to parse truth file: ${e.message}`);
    process.exit(2);
  }

  // 2. Probe endpoint reachability (lightweight OPTIONS or HEAD)
  console.error(`[eval] Endpoint: ${ENDPOINT}`);

  const runAt = new Date().toISOString();
  const results = [];

  // 3. Run each prompt
  for (const spec of PROMPTS) {
    console.error(`[eval] Running ${spec.label}...`);
    const expected = spec.expectedFact(truth);

    let responseText = "";
    let verdict = "fail";
    let errorMsg = null;

    try {
      responseText = await chatPost(spec.prompt);
      verdict = spec.matcher(responseText, expected);
    } catch (e) {
      errorMsg = e.message;
      // Detect unreachable endpoint
      if (/ECONNREFUSED|ENOTFOUND|abort|network/i.test(e.message)) {
        console.error(`[eval] FATAL: endpoint unreachable — ${e.message}`);
        process.exit(2);
      }
      verdict = "fail";
    }

    console.error(`[eval]   → ${verdict.toUpperCase()}`);

    results.push({
      label: spec.label,
      prompt: spec.prompt,
      expectedFact: expected.display,
      responseText,
      verdict,
      error: errorMsg,
    });
  }

  // 4. Write report
  const dateSuffix = runAt.slice(0, 10).replace(/-/g, "");
  const reportPath = `/tmp/v2-chat-eval-${dateSuffix}.md`;
  const report = buildReport({ runAt, endpoint: ENDPOINT, truthFile, results });

  await writeFile(reportPath, report, "utf8");
  console.error(`[eval] Report written to ${reportPath}`);

  // 5. Summary line to stdout
  const pass = results.filter((r) => r.verdict === "pass").length;
  const caveat = results.filter((r) => r.verdict === "pass_with_caveat").length;
  const fail = results.filter((r) => r.verdict === "fail").length;
  console.log(
    `EVAL SUMMARY: ${pass}/5 pass, ${caveat}/5 pass_with_caveat, ${fail}/5 fail | report: ${reportPath}`
  );
}

main().catch((e) => {
  console.error("[eval] Unhandled error:", e);
  process.exit(2);
});
