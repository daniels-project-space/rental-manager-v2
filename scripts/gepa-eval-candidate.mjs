#!/usr/bin/env node
/**
 * gepa-eval-candidate.mjs — score ONE candidate CONVERSATION_CRAFT prompt.
 *
 * The bridge between the GEPA optimiser (Python) and this TypeScript system.
 * GEPA needs, per rollout, a scalar score plus TEXTUAL feedback it can reflect
 * on. `convex/lib/renter_bot_conversation_rubric.ts` already emits exactly
 * that shape, which is why this integration is thin: the hard part (a
 * programmatic definition of a good conversation) was already built.
 *
 * Reads a JSON job on stdin:
 *   { "craft": "<candidate prompt text>", "scenarios": ["name", ...] }
 *
 * Writes a JSON result on stdout:
 *   { "score": 0..1, "feedback": "...", "per_scenario": [...] }
 *
 * SAFETY: every thread id is `__probe__`-prefixed. The route only honours a
 * craft_override on probe threads, so a candidate prompt can never reach a real
 * renter's conversation. No send path is touched; probe threads are swept after.
 *
 * Cost: each rollout is a real multi-turn LLM conversation. GEPA must be run
 * with an explicit budget (see gepa-optimize-craft.py's MaxMetricCallsStopper).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CVX = "./node_modules/.bin/convex";

function convexRun(fn, args) {
  const out = execFileSync(CVX, ["run", fn, JSON.stringify(args)], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120000,
  }).trim();
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

/** Same scenarios as the manual harness, kept in one place. */
const SCENARIOS = {
  bmpcc_lens_and_daycount: {
    account: "leo",
    item: "BMPCC 6K Pro",
    groundTruth: { requestedItem: "BMPCC 6K Pro", requestedItemAvailable: true, requestedItemOwned: true },
    turns: [
      "hi sorry is this avaliavbke tomorrw and what time could i come to pickup ?",
      "does that price include a lens ?",
      "can i pickup the day before and return the day after ?",
      "whats the total if i keep it 3 days?",
      "ok and can you do anything on the price if i book now?",
    ],
  },
  fx3_kit_and_upsell: {
    account: "leo",
    item: "Sony FX3",
    groundTruth: { requestedItem: "Sony FX3", requestedItemAvailable: true, requestedItemOwned: true },
    turns: [
      "hey is the fx3 free this weekend?",
      "what comes in the kit?",
      "do you have a wide lens for it too?",
      "im shooting a wedding, anything else id need?",
      "can i collect friday evening instead?",
    ],
  },
  not_owned_graceful: {
    account: "dbcinema",
    item: "RED Komodo",
    groundTruth: { requestedItem: "RED Komodo", requestedItemAvailable: false, requestedItemOwned: false },
    turns: [
      "is the red komodo available next week?",
      "what about the week after?",
      "ok what similar cinema camera do you have?",
      "does that come with a lens?",
      "whats your best price for 4 days?",
    ],
  },
};

/**
 * Draft via Convex rather than hitting the Vercel route directly, so
 * RENTER_BOT_API_SECRET stays server-side and is never handled by this script
 * or by whoever runs it. Convex forwards craft_override to the route.
 */
function draft(threadId, craft) {
  const r = convexRun("replyInbox_actions:generateDraft", {
    thread_id: threadId,
    craft_override: craft,
  });
  return { draft: (r?.draft ?? "").trim(), skipped: r?.status === "skipped" };
}

async function runScenario(name, craft) {
  const sc = SCENARIOS[name];
  const threadId = `__probe__gepa_${name}`;
  const history = [];
  const turns = [];
  for (const renterMsg of sc.turns) {
    history.push({ role: "renter", text: renterMsg });
    convexRun("renter_bot_probe:seed", {
      thread_id: threadId,
      account_slug: sc.account,
      stage: "INQUIRY",
      items: [{ name: sc.item }],
      messages: history,
    });
    const { draft: text } = draft(threadId, craft);
    history.push({ role: "owner", text });
    turns.push({ renter: renterMsg, draft: text });
  }
  return { name, turns, groundTruth: sc.groundTruth };
}

async function main() {
  const job = JSON.parse(readFileSync(0, "utf8"));
  const craft = job.craft;
  const names = job.scenarios?.length ? job.scenarios : Object.keys(SCENARIOS);

  const results = [];
  for (const n of names) {
    if (!SCENARIOS[n]) continue;
    results.push(await runScenario(n, craft));
  }
  convexRun("renter_bot_probe:cleanup", {});

  // Score with the SAME rubric that guards production.
  const { scoreConversation } = await import(
    "../convex/lib/renter_bot_conversation_rubric.ts"
  );

  let totalChecks = 0;
  let passedChecks = 0;
  let totalTurns = 0;
  let draftedTurns = 0;
  const feedbackLines = [];
  const perScenario = [];

  for (const r of results) {
    const drafted = r.turns.filter((t) => t.draft);
    const out = scoreConversation(drafted, r.groundTruth);
    const scored = out.results.filter((c) => c.status === "pass" || c.status === "fail");
    const passed = scored.filter((c) => c.status === "pass").length;
    totalChecks += scored.length;
    passedChecks += passed;
    totalTurns += r.turns.length;
    draftedTurns += drafted.length;

    // Empty drafts are a real failure mode (the model produced nothing usable),
    // so penalise them rather than silently scoring fewer turns.
    const emptyTurns = r.turns.length - drafted.length;
    if (emptyTurns > 0) {
      feedbackLines.push(`[${r.name}] ${emptyTurns} of ${r.turns.length} turns produced NO draft at all.`);
    }
    for (const c of out.results.filter((x) => x.status === "fail")) {
      feedbackLines.push(
        `[${r.name}] turn ${c.turn ?? "?"} FAILED ${c.check}: ${c.detail}` +
          (c.evidence ? ` — evidence: "${c.evidence.slice(0, 160)}"` : ""),
      );
    }
    perScenario.push({ scenario: r.name, overall: out.overall, failures: out.failures });
  }

  // Weight rubric quality by DRAFT COVERAGE.
  //
  // Without this, the score averaged only over turns that produced a draft —
  // so a prompt that made the bot escalate more would score HIGHER (fewer
  // turns, fewer chances to fail), and a run that drafted nothing at all would
  // score a vacuous 1.000. An optimiser would have found that immediately.
  // Silence is not quality: a turn that produced no reply is a failed turn.
  const quality = totalChecks ? passedChecks / totalChecks : 0;
  const coverage = totalTurns ? draftedTurns / totalTurns : 0;
  const score = quality * coverage;
  const feedback = feedbackLines.length
    ? `Failures to fix:\n${feedbackLines.join("\n")}`
    : "All rubric checks passed on every scenario.";

  console.log(
    JSON.stringify({ score, quality, coverage, feedback, per_scenario: perScenario }),
  );
}

main().catch((e) => {
  console.log(JSON.stringify({ score: 0, feedback: `evaluator crashed: ${e?.message ?? e}` }));
});
