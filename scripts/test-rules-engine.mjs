/**
 * Pure-function tests of the deterministic rules engine in
 * src/mastra/workflows/hygglo_poll.ts:decideRules.
 *
 * Recreates the rule logic verbatim (no Convex calls) and exercises the
 * 5 decision branches: blacklist / no_items / no_dates / underprice /
 * accept.
 */

function dayCount(start, end) {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(1, Math.round((b - a) / 86400000));
}

function firstName(full) {
  if (!full) return "there";
  return full.trim().split(/\s+/)[0] || "there";
}

function buildReply(d, c, ctx) {
  const name = firstName(c.renter_name);
  const items = c.items.map((i) => i.item_name).join(", ") || "your selection";
  const dates =
    c.start_date && c.end_date ? ` from ${c.start_date} to ${c.end_date}` : "";
  switch (d) {
    case "accept":
      return `Hi ${name}! Your request for ${items}${dates} looks good — I'll confirm shortly. — Daniel`;
    case "decline":
      if (ctx.reason === "blacklisted_renter") {
        return `Hi ${name}, unfortunately we're unable to accept this request at this time. — Daniel`;
      }
      if (ctx.reason === "underpriced") {
        return `Hi ${name}! Thanks for the request. The total is below our usual rate for ${items}${dates}. Could you double-check the pricing and re-submit? — Daniel`;
      }
      return `Hi ${name}, unfortunately we can't accept this booking. — Daniel`;
    case "ask_renter":
      if (ctx.reason === "no_items") {
        return `Hi ${name}! Could you let me know exactly which items you'd like to rent? — Daniel`;
      }
      if (ctx.reason === "no_dates") {
        return `Hi ${name}! Thanks for the interest — could you confirm the pickup and return dates? — Daniel`;
      }
      return `Hi ${name}! Thanks for the request for ${items}${dates}. Could you confirm a few details so I can finalise? — Daniel`;
  }
}

// Mock Convex query layer.
function mockConvex({ blacklisted = [], pricing = {} } = {}) {
  return {
    query: async (apiPath, args) => {
      const path = String(apiPath);
      if (path.includes("checkBlacklistByName")) {
        const hit = blacklisted.find((b) => b.name === args.name);
        return hit ? { blacklisted: true, reason: hit.reason ?? null } : { blacklisted: false };
      }
      if (path.includes("pricing_catalog.lookup")) {
        const row = pricing[args.item_name];
        return row ? [{ ok: true, daily_rate: row.daily_rate, item: args.item_name }] : null;
      }
      return null;
    },
  };
}

async function decideRules(candidate, c) {
  const redFlags = [];
  const reasoningParts = [];
  let d = "accept";
  let confidence = 0.7;
  let replyReason;

  // Rule 1 — blacklist.
  let blacklisted = false;
  if (candidate.renter_name) {
    const bl = await c.query("renters.checkBlacklistByName", { name: candidate.renter_name });
    if (bl?.blacklisted) {
      blacklisted = true;
      redFlags.push("blacklisted_renter");
      reasoningParts.push(`Renter "${candidate.renter_name}" is blacklisted${bl.reason ? `: ${bl.reason}` : ""}.`);
    }
  }
  if (blacklisted) {
    return {
      ...candidate,
      decision: "decline",
      confidence: 1.0,
      reasoning: reasoningParts.join(" "),
      suggestedReply: buildReply("decline", candidate, { reason: "blacklisted_renter" }),
      redFlags,
    };
  }

  // Rule 2 — missing items.
  if (candidate.items.length === 0) {
    return {
      ...candidate,
      decision: "ask_renter",
      confidence: 0.3,
      reasoning: "No items listed on the request.",
      suggestedReply: buildReply("ask_renter", candidate, { reason: "no_items" }),
      redFlags: ["incomplete_request"],
    };
  }

  // Rule 3 — missing dates.
  const days = dayCount(candidate.start_date, candidate.end_date);
  if (!days) {
    return {
      ...candidate,
      decision: "ask_renter",
      confidence: 0.3,
      reasoning: "Pickup or return date missing.",
      suggestedReply: buildReply("ask_renter", candidate, { reason: "no_dates" }),
      redFlags: ["incomplete_request"],
    };
  }

  // Rule 4 — pricing.
  if (candidate.gross_paid_gbp !== undefined && candidate.gross_paid_gbp > 0) {
    let expectedTotal = 0;
    let anyPriced = false;
    for (const item of candidate.items) {
      const row = await c.query("pricing_catalog.lookup", { item_name: item.item_name });
      const first = Array.isArray(row) ? row[0] : null;
      if (first?.daily_rate) {
        expectedTotal += first.daily_rate * days;
        anyPriced = true;
      }
    }
    if (anyPriced && expectedTotal > 0) {
      const ratio = candidate.gross_paid_gbp / expectedTotal;
      reasoningParts.push(`Paid £${candidate.gross_paid_gbp.toFixed(0)} vs expected ~£${expectedTotal.toFixed(0)} (ratio ${ratio.toFixed(2)}).`);
      if (ratio < 0.7) { d = "decline"; confidence = 0.75; replyReason = "underpriced"; redFlags.push("underpriced"); }
      else if (ratio < 0.9) { d = "ask_renter"; confidence = 0.6; replyReason = "underpriced_mild"; redFlags.push("underpriced_mild"); }
    } else {
      redFlags.push("pricing_unavailable");
    }
  } else {
    redFlags.push("total_missing");
  }
  if (d === "accept") reasoningParts.push("No blacklist hit, items + dates present, price within tolerance.");

  return {
    ...candidate,
    decision: d,
    confidence,
    reasoning: reasoningParts.join(" "),
    suggestedReply: buildReply(d, candidate, { reason: replyReason }),
    redFlags,
  };
}

// ── TESTS ────────────────────────────────────────────────────────────
let passed = 0, total = 0;
function assert(label, cond, detail) {
  total++;
  if (cond) { console.log(`✓ ${label}`); passed++; }
  else { console.log(`✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

// Test 1 — blacklisted renter
{
  const c = mockConvex({ blacklisted: [{ name: "John Doe", reason: "chargeback in Q3" }] });
  const r = await decideRules({
    reservation_id: "r1", account_slug: "leo", renter_name: "John Doe",
    items: [{ item_name: "Sony FX3" }], start_date: "2026-06-01", end_date: "2026-06-03", gross_paid_gbp: 200,
  }, c);
  assert("blacklist → decline @ 1.0", r.decision === "decline" && r.confidence === 1.0 && r.redFlags.includes("blacklisted_renter"));
  assert("blacklist reply does NOT mention items", !r.suggestedReply.includes("Sony FX3"));
}

// Test 2 — no items
{
  const c = mockConvex();
  const r = await decideRules({
    reservation_id: "r2", account_slug: "leo", renter_name: "Alice",
    items: [], start_date: "2026-06-01", end_date: "2026-06-03", gross_paid_gbp: 50,
  }, c);
  assert("no_items → ask_renter @ 0.3", r.decision === "ask_renter" && r.confidence === 0.3 && r.redFlags.includes("incomplete_request"));
}

// Test 3 — no dates
{
  const c = mockConvex();
  const r = await decideRules({
    reservation_id: "r3", account_slug: "leo", renter_name: "Bob",
    items: [{ item_name: "Sony FX3" }], gross_paid_gbp: 200,
  }, c);
  assert("no_dates → ask_renter @ 0.3", r.decision === "ask_renter" && r.confidence === 0.3);
}

// Test 4 — severe underprice (ratio < 0.7) → decline
{
  const c = mockConvex({ pricing: { "Sony FX3": { daily_rate: 100 } } });
  const r = await decideRules({
    reservation_id: "r4", account_slug: "leo", renter_name: "Carol",
    items: [{ item_name: "Sony FX3" }], start_date: "2026-06-01", end_date: "2026-06-04", gross_paid_gbp: 100,
  }, c);
  // expected = 100 × 3 days = £300; paid £100 → ratio 0.33 → decline
  assert("severe underprice → decline @ 0.75", r.decision === "decline" && r.confidence === 0.75 && r.redFlags.includes("underpriced"));
}

// Test 5 — mild underprice (0.7 <= ratio < 0.9) → ask_renter
{
  const c = mockConvex({ pricing: { "Sony FX3": { daily_rate: 100 } } });
  const r = await decideRules({
    reservation_id: "r5", account_slug: "leo", renter_name: "Dave",
    items: [{ item_name: "Sony FX3" }], start_date: "2026-06-01", end_date: "2026-06-04", gross_paid_gbp: 240,
  }, c);
  // expected = 300; paid 240 → ratio 0.8 → ask_renter mild
  assert("mild underprice → ask_renter @ 0.6", r.decision === "ask_renter" && r.confidence === 0.6 && r.redFlags.includes("underpriced_mild"));
}

// Test 6 — fair price → accept
{
  const c = mockConvex({ pricing: { "Sony FX3": { daily_rate: 100 } } });
  const r = await decideRules({
    reservation_id: "r6", account_slug: "leo", renter_name: "Eve",
    items: [{ item_name: "Sony FX3" }], start_date: "2026-06-01", end_date: "2026-06-04", gross_paid_gbp: 300,
  }, c);
  assert("fair price → accept @ 0.7", r.decision === "accept" && r.confidence === 0.7 && r.redFlags.length === 0);
}

// Test 7 — no pricing data → accept with flag (not block)
{
  const c = mockConvex(); // empty pricing
  const r = await decideRules({
    reservation_id: "r7", account_slug: "leo", renter_name: "Frank",
    items: [{ item_name: "Unknown Item" }], start_date: "2026-06-01", end_date: "2026-06-03", gross_paid_gbp: 50,
  }, c);
  assert("no pricing → accept with pricing_unavailable flag",
    r.decision === "accept" && r.redFlags.includes("pricing_unavailable"));
}

// Test 8 — blacklist + no items: blacklist wins
{
  const c = mockConvex({ blacklisted: [{ name: "Mallory" }] });
  const r = await decideRules({
    reservation_id: "r8", account_slug: "leo", renter_name: "Mallory",
    items: [], start_date: "2026-06-01", end_date: "2026-06-03", gross_paid_gbp: 100,
  }, c);
  assert("blacklist trumps no_items", r.decision === "decline" && r.confidence === 1.0);
}

// Test 9 — reply addresses renter by first name
{
  const c = mockConvex({ pricing: { "Sony FX3": { daily_rate: 100 } } });
  const r = await decideRules({
    reservation_id: "r9", account_slug: "leo", renter_name: "Alice Wonderland",
    items: [{ item_name: "Sony FX3" }], start_date: "2026-06-01", end_date: "2026-06-04", gross_paid_gbp: 300,
  }, c);
  assert("reply starts with 'Hi Alice!'", r.suggestedReply.startsWith("Hi Alice!"));
}

console.log("\n──────────────────────────────────────");
console.log(`${passed}/${total} tests passed`);
process.exit(passed === total ? 0 : 1);
