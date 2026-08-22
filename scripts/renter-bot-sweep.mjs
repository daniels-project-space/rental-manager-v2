/**
 * Adversarial multi-turn sweep for the renter bot.
 *
 * Why a second harness alongside renter-bot-conversation-test.mjs: that one
 * replays a fixed set of known failure modes. This one exists to FIND new ones
 * — it spreads across different gear, different renter profiles, different
 * dates and longer conversations, and now also exercises the simulated booking
 * (add / remove / change dates), which is where item resolution and arithmetic
 * are most likely to go wrong.
 *
 * SAFETY: every thread id is `__probe__`, which the reply inbox and dashboard
 * exclude, and the run ends with renter_bot_probe:cleanup. No send path is
 * imported or reachable from here.
 *
 * Output is deliberately COMPACT: per-turn one-line verdicts plus a defect
 * table at the end. Full transcripts go to /tmp so they can be read on demand
 * rather than flooding the terminal.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CVX = "./node_modules/.bin/convex";

function convexRun(fn, args) {
  try {
    const out = execFileSync(CVX, ["run", fn, JSON.stringify(args ?? {})], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180000,
    });
    const t = out.trim();
    if (!t) return null;
    const i = t.search(/[[{]/);
    try {
      return JSON.parse(i >= 0 ? t.slice(i) : t);
    } catch {
      return t;
    }
  } catch (e) {
    return { __error: String(e.message ?? e).slice(0, 200) };
  }
}

/**
 * Scenarios vary on four axes at once — gear category, renter profile, date
 * shape, and what they actually want — because the defects found so far only
 * appeared at the intersection (a bundle + a mount question, a same-day
 * booking + a multi-item total).
 */
const SCENARIOS = [
  {
    name: "bundle_addons_and_totals",
    account: "leo",
    item: "BMPCC 6K Pro",
    start: "2026-09-04",
    end: "2026-09-06",
    profile: "confident filmmaker who knows the gear",
    turns: [
      "hi is the bmpcc 6k pro free 4th-6th sept?",
      "does it come with glass or is it body only?",
      "add the 24-105 please and a spare battery",
      "actually drop the battery, whats my total now?",
      "can i push the return to the 7th instead?",
      "great and what time can i collect on the 4th?",
    ],
  },
  {
    name: "vague_beginner_upsell",
    account: "leo",
    item: "Sony FX3",
    start: "2026-09-10",
    end: "2026-09-10",
    profile: "beginner, vague, asks for 'a lens'",
    turns: [
      "hey im new to this, is the fx3 available on the 10th?",
      "i just need a lens, can you add one",
      "the wide one i guess? whats cheapest",
      "ok add that then",
      "how much altogether for the day",
      "do i need anything else for interviews",
    ],
  },
  {
    name: "anamorphic_mount_and_swap",
    account: "leo",
    item: "BMPCC 6K Full Frame",
    start: "2026-09-12",
    end: "2026-09-14",
    profile: "knows mounts, will push on compatibility",
    turns: [
      "is the 6k full frame free 12-14 sept?",
      "i want to shoot anamorphic, what do you have",
      "the full frame is L mount though isnt it, will those PL lenses fit",
      "add the 65mm and whatever adapter i need",
      "actually can i swap to the 6k pro instead, same dates",
      "whats the difference in price between the two",
    ],
  },
  {
    name: "haggler_multi_day",
    account: "leo",
    item: "DJI RS3 Pro gimbal",
    start: "2026-09-18",
    end: "2026-09-22",
    profile: "price-focused, pushes for a discount repeatedly",
    turns: [
      "gimbal free 18th to 22nd?",
      "thats 5 days, whats the best you can do",
      "come on, im booking 5 days. 20% off?",
      "ok what if i collect and return myself",
      "fine, add it. and do you have a monitor too",
      "whats the final total",
    ],
  },
  {
    name: "not_owned_concealment",
    account: "leo",
    item: "BMPCC 6K Pro",
    start: "2026-09-25",
    end: "2026-09-25",
    profile: "asks for gear we genuinely do not own",
    turns: [
      "do you have a red komodo or an arri alexa mini?",
      "what about a canon c70?",
      "ok what cinema cameras do you actually have",
      "is the bmpcc free on the 25th then",
      "add it and a 2tb card",
      "whats included in the price",
    ],
  },
  {
    name: "date_confusion_same_day",
    account: "leo",
    item: "Canon EF 24-105mm f4",
    start: "2026-09-28",
    end: "2026-09-28",
    profile: "changes dates repeatedly mid-conversation",
    turns: [
      "is the 24-105 free on the 28th?",
      "actually make it the 28th to the 30th",
      "hmm no, just the 29th single day",
      "whats that cost",
      "and if i added the 16-35 as well for the same day",
      "ok book both for the 29th",
    ],
  },
];

async function main() {
  const only = process.argv[2];
  const scenarios = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;

  const owned = convexRun("items:listActive", {});
  const ownedItems = (Array.isArray(owned) ? owned : []).map((i) => ({
    name: i.name ?? i.name_canonical ?? "",
    kind: i.kind ?? null,
    lens_mount: i.lens_mount ?? null,
  }));

  const report = [];
  for (const sc of scenarios) {
    const threadId = `__probe__sweep_${sc.name}`;
    const history = [];
    const turns = [];
    console.log(`\n${"=".repeat(74)}`);
    console.log(`${sc.name}  [${sc.account}] ${sc.item}  ${sc.start}->${sc.end}`);
    console.log(`profile: ${sc.profile}`);
    console.log("=".repeat(74));

    // Fresh simulated booking per scenario so add/remove/date changes are real.
    convexRun("renter_bot_lab_order:seed", {
      thread_id: threadId,
      account_slug: sc.account,
      item_names: [sc.item],
      start_date: sc.start,
      end_date: sc.end,
    });

    for (let i = 0; i < sc.turns.length; i++) {
      const renterMsg = sc.turns[i];
      history.push({ role: "renter", text: renterMsg });
      convexRun("renter_bot_probe:seed", {
        thread_id: threadId,
        account_slug: sc.account,
        stage: "INQUIRY",
        items: [{ name: sc.item }],
        messages: history,
      });
      const res = convexRun("replyInbox_actions:generateDraft", { thread_id: threadId });
      const draft = res?.draft ?? "";
      console.log(`\n[${i + 1}] RENTER: ${renterMsg}`);
      console.log(
        draft
          ? `    BOT: ${draft.replace(/\n+/g, " ")}`
          : `    BOT: <<NO DRAFT — ${res?.reason ?? res?.status ?? "blocked"}>>`,
      );
      history.push({ role: "owner", text: draft });
      turns.push({ renter: renterMsg, draft, blocked: !draft });
    }

    const order = convexRun("renter_bot_lab_order:get", { thread_id: threadId });
    if (order && !order.__error) {
      console.log(
        `\n    ORDER: ${order.days}d, total ${order.total_gbp != null ? `£${order.total_gbp}` : "n/a"} — ` +
          (order.lines ?? [])
            .map((l) => `${l.qty}x ${l.name}${l.daily_price_gbp != null ? `@£${l.daily_price_gbp}` : "(no price)"}`)
            .join(", "),
      );
    }
    report.push({ scenario: sc.name, profile: sc.profile, turns, order, groundTruth: { ...sc, ownedItems } });
  }

  convexRun("renter_bot_probe:cleanup", {});
  const outPath = "/tmp/renter-bot-sweep.json";
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n\ntranscripts -> ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
