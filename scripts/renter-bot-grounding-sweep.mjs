/**
 * System-wide grounding sweep: every gear kind x every class of question.
 *
 * WHY THIS EXISTS. Four grounding bugs were found via one transcript about
 * Sony bodies, and all four were fixed and verified on Sony bodies. That proves
 * very little. The guard arms FOUR "ungrounded" rules off a single pre-turn
 * boolean — availability, unavailability, price, spec — and only the price one
 * has been touched. If the fault is structural it will bite a light, a power
 * station and a microphone exactly as hard, on every account.
 *
 * So: real listings that HAVE price tiers (so a silent reply cannot be blamed
 * on missing catalogue data), spread across kinds and accounts, asked one
 * question per data class. The cell that matters is not the wording of the
 * reply — it is whether the renter got one at all, and which rule withheld it.
 *
 * Usage: node scripts/renter-bot-grounding-sweep.mjs [label] [perKind]
 * SAFETY: `__probe__` threads only, cleaned up at the end. No send path.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CVX = "./node_modules/.bin/convex";
const LABEL = process.argv[2] ?? "run";
const PER_KIND = Number(process.argv[3] || 1);

function convexRun(fn, args) {
  try {
    const out = execFileSync(CVX, ["run", fn, JSON.stringify(args ?? {})], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300000,
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
 * One question per data class, each aimed at a DIFFERENT guard rule, so a
 * silent cell names which kind of grounding failed.
 */
const CLASSES = [
  { id: "availability", q: "hi, is this available?", rule: "UNGROUNDED_AVAILABILITY" },
  { id: "price_multiday", q: "how much would this be for 3 days?", rule: "UNGROUNDED_PRICE" },
  { id: "kit_contents", q: "what exactly comes with it?", rule: "kit/spec" },
  { id: "spec", q: "what are the specs on this — is it 4k?", rule: "UNGROUNDED_SPEC" },
  { id: "mixed_order", q: "can i add a second one, and what would the two come to?", rule: "UNGROUNDED_PRICE" },
];

async function main() {
  const picked = convexRun("renter_bot_sweep_items:pick", { per_kind: PER_KIND });
  const items = picked?.picked ?? [];
  console.log(
    `\n=== GROUNDING SWEEP [${LABEL}] — ${items.length} listings x ${CLASSES.length} question classes ===`,
  );
  console.log(`(catalogue has ${picked?.total_priced_listings ?? "?"} priced listings)\n`);

  const results = [];
  for (const it of items) {
    for (const c of CLASSES) {
      const tid = `__probe__gs_${c.id}_${it.product_id}`;
      convexRun("renter_bot_probe:seed", {
        thread_id: tid,
        account_slug: it.account,
        stage: "INQUIRY",
        items: [{ name: it.name }],
        messages: [{ role: "renter", text: c.q }],
      });
      const res = convexRun("replyInbox_actions:generateDraft", { thread_id: tid });
      const draft = res?.draft ?? "";
      const flags = (res?.flags ?? []).map(
        (f) => f.type ?? f.detail ?? (typeof f === "string" ? f : "?"),
      );
      results.push({
        kind: it.kind,
        account: it.account,
        item: it.name.slice(0, 60),
        class: c.id,
        answered: !!draft,
        reason: res?.reason ?? null,
        flags,
        draft: draft.slice(0, 160),
      });
      process.stdout.write(draft ? "." : "X");
    }
  }
  console.log("\n");

  convexRun("renter_bot_probe:cleanup", {});

  // Silence by question class — which KIND of grounding is failing.
  const byClass = {};
  for (const r of results) {
    byClass[r.class] ??= { asked: 0, silent: 0 };
    byClass[r.class].asked++;
    if (!r.answered) byClass[r.class].silent++;
  }
  console.log("--- SILENCE BY QUESTION CLASS ---");
  for (const [k, v] of Object.entries(byClass))
    console.log(
      `  ${k.padEnd(16)} ${String(v.silent).padStart(2)}/${v.asked} silent  ${"█".repeat(v.silent)}`,
    );

  // Silence by gear kind — is this Sony-specific or systemic?
  const byKind = {};
  for (const r of results) {
    byKind[r.kind] ??= { asked: 0, silent: 0 };
    byKind[r.kind].asked++;
    if (!r.answered) byKind[r.kind].silent++;
  }
  console.log("\n--- SILENCE BY GEAR KIND ---");
  for (const [k, v] of Object.entries(byKind))
    console.log(`  ${k.padEnd(16)} ${String(v.silent).padStart(2)}/${v.asked} silent`);

  // Which guard rule is actually withholding replies.
  const byRule = {};
  for (const r of results.filter((x) => !x.answered))
    for (const f of r.flags.length ? r.flags : [r.reason ?? "unknown"])
      byRule[f] = (byRule[f] ?? 0) + 1;
  console.log("\n--- BLOCKING RULE ---");
  for (const [k, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(3)}x  ${k}`);

  const silent = results.filter((r) => !r.answered).length;
  console.log(
    `\nSCORE [${LABEL}]: ${results.length - silent}/${results.length} answered (${Math.round((100 * (results.length - silent)) / Math.max(results.length, 1))}%)`,
  );
  writeFileSync(`/tmp/grounding-sweep-${LABEL}.json`, JSON.stringify(results, null, 2));
  console.log(`full results -> /tmp/grounding-sweep-${LABEL}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
