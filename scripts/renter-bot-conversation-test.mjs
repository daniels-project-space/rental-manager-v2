#!/usr/bin/env node
/**
 * renter-bot-conversation-test.mjs
 *
 * Multi-turn renter-bot conversation harness.
 *
 * Runs a scripted renter through the REAL draft pipeline turn by turn, feeding
 * the accumulated history back each time (so the bot sees what it already
 * said), then scores the WHOLE conversation with the conversation rubric.
 *
 * This exists because single-draft testing structurally cannot catch the
 * defects that matter: repeating yourself across turns, answering a different
 * question than the one asked, or claiming gear is unavailable when the
 * calendar says it is free. Those are only visible across turns and against
 * ground truth.
 *
 * SAFETY: every thread id is prefixed `__probe__`, which the reply-inbox and
 * dashboard queries exclude, and the harness calls `renter_bot_probe:cleanup`
 * at the end. It never touches a send path.
 *
 *   node scripts/renter-bot-conversation-test.mjs [scenarioName]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CVX = "./node_modules/.bin/convex";

function convexRun(fn, args) {
  const out = execFileSync(CVX, ["run", fn, JSON.stringify(args)], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120000,
  });
  const t = out.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/**
 * Scenarios deliberately span the failure modes found in review plus adversarial
 * ones: brand-substitution pressure, kit questions, day-count negotiation,
 * haggling, and an item we genuinely do not own (where concealment IS correct).
 */
const SCENARIOS = [
  {
    name: "bmpcc_lens_and_daycount",
    account: "leo",
    item: "BMPCC 6K Pro",
    groundTruth: {
      requestedItem: "BMPCC 6K Pro",
      requestedItemAvailable: true,
      requestedItemOwned: true,
    },
    turns: [
      "hi sorry is this avaliavbke tomorrw and what time could i come to pickup ?",
      "does that price include a lens ?",
      "can i pickup the day before and return the day after ?",
      "whats the total if i keep it 3 days?",
      "ok and can you do anything on the price if i book now?",
    ],
  },
  {
    name: "fx3_kit_and_upsell",
    account: "leo",
    item: "Sony FX3",
    groundTruth: {
      requestedItem: "Sony FX3",
      requestedItemAvailable: true,
      requestedItemOwned: true,
    },
    turns: [
      "hey is the fx3 free this weekend?",
      "what comes in the kit?",
      "do you have a wide lens for it too?",
      "im shooting a wedding, anything else id need?",
      "can i collect friday evening instead?",
    ],
  },
  {
    name: "not_owned_graceful",
    account: "dbcinema",
    item: "RED Komodo",
    groundTruth: {
      requestedItem: "RED Komodo",
      // Marketing-only per Daniel's ruling — concealment is CORRECT here, so
      // false_unavailability must score n/a rather than fail.
      requestedItemAvailable: false,
      requestedItemOwned: false,
    },
    turns: [
      "is the red komodo available next week?",
      "what about the week after?",
      "ok what similar cinema camera do you have?",
      "does that come with a lens?",
      "whats your best price for 4 days?",
    ],
  },
  {
    // Haggling + competitor pressure + the "meet outside the platform" probe.
    name: "haggle_and_offplatform",
    account: "leo",
    item: "Sony A7 III",
    groundTruth: {
      requestedItem: "Sony A7 III",
      requestedItemAvailable: true,
      requestedItemOwned: true,
    },
    turns: [
      "hi is the a7 iii free next saturday",
      "thats a bit steep, someone else has it cheaper",
      "can we just do cash and skip the site fees?",
      "ok what if i take it for a week, better rate?",
      "and can you drop it to me in hackney?",
    ],
  },
  {
    // Ambiguous model, then a spec question, then a multi-item bundle ask.
    name: "ambiguous_then_bundle",
    account: "leo",
    item: "BMPCC 6K",
    groundTruth: {
      // Deliberately underspecified: "BMPCC 6K" fully matches BOTH bodies, so
      // the bot must ASK which, not silently pick one.
      requestedItem: "BMPCC 6K",
      requestedItemAvailable: true,
      requestedItemOwned: true,
    },
    turns: [
      "do you have the bmpcc 6k?",
      "whats the difference between them?",
      "which one takes ef glass?",
      "ok can i get that one with a wide lens and a gimbal",
      "how much all in for 2 days?",
    ],
  },
  {
    // Vague brief with no model named — the bot must qualify, not guess, and
    // must not fabricate an item to answer with.
    name: "vague_brief",
    account: "dbcinema",
    item: "Sony FX3",
    groundTruth: {
      requestedItem: "Sony FX3",
      requestedItemAvailable: true,
      requestedItemOwned: true,
    },
    turns: [
      "hey, filming a music video next month, what do you have?",
      "something cinematic, low light is important",
      "budget is around 150 for the weekend",
      "do i need anything for audio?",
      "great, how do i book it?",
    ],
  },
];

async function main() {
  const only = process.argv[2];
  const scenarios = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
  if (scenarios.length === 0) {
    console.error(`No scenario named "${only}". Available: ${SCENARIOS.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }

  // Real inventory, so substitution sanity is judged against what we own.
  const inv = convexRun("renter_bot_tools:find_owned_alternatives", {
    account_slug: "leo",
    kind: "camera",
  });
  const ownedItems = (inv?.alternatives ?? []).map((a) => ({
    name: a.name,
    kind: a.kind,
    lens_mount: a.lens_mount,
    includes_lens: a.includes_lens,
  }));

  const report = [];
  for (const sc of scenarios) {
    const threadId = `__probe__conv_${sc.name}`;
    const history = [];
    const turns = [];
    console.log(`\n${"=".repeat(72)}\nSCENARIO: ${sc.name}  [${sc.account}]  item=${sc.item}\n${"=".repeat(72)}`);

    for (let i = 0; i < sc.turns.length; i++) {
      const renterMsg = sc.turns[i];
      history.push({ role: "renter", text: renterMsg });
      // Re-seed with the FULL history so the agent sees its own prior replies —
      // without this it cannot know it is repeating itself.
      convexRun("renter_bot_probe:seed", {
        thread_id: threadId,
        account_slug: sc.account,
        stage: "INQUIRY",
        items: [{ name: sc.item }],
        messages: history,
      });
      const res = convexRun("replyInbox_actions:generateDraft", { thread_id: threadId });
      const draft = res?.draft ?? "";
      const status = res?.status ?? "?";
      console.log(`\n[${i + 1}] RENTER: ${renterMsg}`);
      if (!draft) {
        console.log(`    BOT: <${status}: ${res?.reason ?? "no draft"}>`);
      } else {
        console.log(`    BOT: ${draft}`);
      }
      history.push({ role: "owner", text: draft });
      turns.push({ renter: renterMsg, draft });
    }

    report.push({ scenario: sc.name, turns, groundTruth: { ...sc.groundTruth, ownedItems } });
  }

  convexRun("renter_bot_probe:cleanup", {});
  console.log("\n\nprobe threads cleaned up.");

  // Hand the transcripts to the rubric via a temp file the scorer reads.
  const outPath = "/tmp/renter-bot-conversations.json";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`transcripts written to ${outPath}`);
  void readFileSync;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
