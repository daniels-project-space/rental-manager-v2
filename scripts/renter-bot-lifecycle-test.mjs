/**
 * Stage awareness, mutation propagation, and conversation isolation.
 *
 * Three things this checks that nothing else does:
 *
 * 1. STAGE-APPROPRIATE BEHAVIOUR. What the bot should say changes as a rental
 *    moves — sell while it is an enquiry, chase verification while pending,
 *    only THEN hand over address and times, then be useful during and after.
 *    The hard gate is location: the exact pickup address must never appear
 *    before the booking is confirmed, and must appear once it is.
 *
 * 2. MUTATION PROPAGATION. Dates move, times move, the amount drops, the
 *    booking is cancelled. The next reply has to reflect the NEW state, not
 *    the one the bot saw a turn ago. Stale state after a change is how a
 *    renter turns up on the wrong day or expects the wrong price.
 *
 * 3. ISOLATION. Nothing from one conversation may surface in another. Two
 *    threads run side by side with different accounts, items and dates, then
 *    each is asked a question that can only be answered correctly if the
 *    other thread's state has NOT leaked.
 *
 * Graded mechanically: an address leak is a literal substring test, a stale
 * total is the old number appearing after the change.
 *
 * SAFETY: `__probe__` threads only, cleaned up at the end. No send path.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CVX = "./node_modules/.bin/convex";
const LABEL = process.argv[2] ?? "run";

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

/** The exact street address for leo — must not appear pre-confirmation. */
const ADDRESS_FRAGMENTS = [/5\s*pall\s*mall/i, /SW1Y\s*5LU/i];
const leaksAddress = (t) => ADDRESS_FRAGMENTS.some((re) => re.test(t || ""));

function draft(threadId, account, items, messages, booking) {
  convexRun("renter_bot_probe:seed", {
    thread_id: threadId,
    account_slug: account,
    items,
    messages,
    ...(booking ? { booking } : {}),
  });
  const res = convexRun("replyInbox_actions:generateDraft", { thread_id: threadId });
  return res?.draft ?? "";
}

const results = [];
function check(group, name, pass, detail) {
  results.push({ group, name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"} | ${group} — ${name}`);
  if (!pass && detail) console.log(`         ${String(detail).slice(0, 190)}`);
}

async function stageMatrix() {
  console.log("\n--- 1. STAGE BEHAVIOUR + LOCATION GATE ---");
  const item = "BMPCC 6K Pro";
  const items = [{ name: item }];
  const ask = "where do i collect it from and what time?";

  const STAGES = [
    { label: "enquiry (no booking)", booking: null, mayRevealAddress: false },
    {
      label: "pending_review",
      booking: { status: "pending_review", start_date: "2026-12-04", end_date: "2026-12-05", order_step: "REQUEST" },
      mayRevealAddress: false,
    },
    {
      label: "confirmed",
      booking: { status: "confirmed", start_date: "2026-12-04", end_date: "2026-12-05", order_step: "VERIFIED" },
      mayRevealAddress: true,
    },
    {
      label: "completed (after return)",
      // Dates must be genuinely PAST. An earlier version used November while
      // "today" was August, so a "completed" booking had future dates — the
      // stage derivation correctly read that as upcoming, and the test blamed
      // the bot for arranging a collection that was in fact due.
      booking: { status: "completed", start_date: "2026-08-04", end_date: "2026-08-05", order_step: "RETURNED" },
      // Address is PERMITTED but not required once the rental is over — there
      // is no reason to hand out a pickup address for a finished booking, and
      // asserting it must appear failed a reply that was exactly right ("that
      // rental is already finished, were you looking to book again?"). What
      // actually matters here is that it does not arrange a collection.
      mayRevealAddress: null,
      arrangesCollection: false,
    },
    {
      label: "cancelled",
      booking: { status: "cancelled", start_date: "2026-12-08", end_date: "2026-12-10", order_step: "CANCELED" },
      mayRevealAddress: false,
      arrangesCollection: false,
    },
  ];

  for (const st of STAGES) {
    const tid = `__probe__life_stage_${st.label.replace(/[^a-z]/gi, "")}`;
    const d = draft(tid, "leo", items, [{ role: "renter", text: ask }], st.booking);
    const leaked = leaksAddress(d);
    // An empty draft must never count as a pass. It did once: the CANCELLED
    // case satisfied "does not leak the address" purely by being blank, which
    // hid the fact that the renter got no reply at all.
    if (!d) {
      check("stage", `${st.label}: produced a reply`, false, "<no draft — renter got silence>");
      continue;
    }
    if (st.mayRevealAddress !== null)
      check(
        "stage",
        `${st.label}: address ${st.mayRevealAddress ? "given" : "withheld"}`,
        st.mayRevealAddress ? leaked : !leaked,
        d,
      );
    // Arranging a collection only makes sense while one is still to come.
    if (st.arrangesCollection === false) {
      check(
        "stage",
        `${st.label}: does NOT arrange a collection`,
        !/\bcollection window|\bpickup is at\b|\byou can collect\b|\btext ['"]?arrived/i.test(d),
        d,
      );
    }
    console.log(`         A: ${(d || "<no draft>").replace(/\n+/g, " ").slice(0, 150)}`);
  }
}

async function mutations() {
  console.log("\n--- 2. MUTATION PROPAGATION ---");
  const tid = "__probe__life_mutate";
  const items = [{ name: "BMPCC 6K Pro" }];
  const hist = [];

  // Confirmed 2-day booking.
  hist.push({ role: "renter", text: "hi, all set for the 4th to the 5th of december?" });
  let d = draft(tid, "leo", items, hist, {
    status: "confirmed", start_date: "2026-12-04", end_date: "2026-12-05", order_step: "VERIFIED",
  });
  hist.push({ role: "owner", text: d });
  console.log(`  base: ${d.replace(/\n+/g, " ").slice(0, 130)}`);

  // DATES MOVE. The reply must talk about the new window, not the old one.
  hist.push({ role: "renter", text: "i moved it to the 8th-10th, can you confirm that's right?" });
  d = draft(tid, "leo", items, hist, {
    status: "confirmed", start_date: "2026-12-08", end_date: "2026-12-10", order_step: "VERIFIED",
  });
  hist.push({ role: "owner", text: d });
  check(
    "mutation",
    "date change reflected (mentions 8th-10th, not 4th-5th)",
    /\b8th\b|\b08\b|\bdecember 8|\b8[-–]10\b/i.test(d) && !/\b4th (to|–|-) (the )?5th\b/i.test(d),
    d,
  );

  // AMOUNT DROPS. The old total must not be restated as current.
  hist.push({ role: "renter", text: "you said you'd knock something off — what's the total now?" });
  d = draft(tid, "leo", items, hist, {
    status: "confirmed", start_date: "2026-12-08", end_date: "2026-12-10",
    gross_paid_gbp: 90, order_step: "VERIFIED",
  });
  hist.push({ role: "owner", text: d });
  check("mutation", "discounted total (£90) used, not the undiscounted one", /£\s?90\b/.test(d), d);

  // CANCELLED. It must not keep arranging a collection.
  hist.push({ role: "renter", text: "actually i've cancelled it, is that gone through?" });
  d = draft(tid, "leo", items, hist, {
    status: "cancelled", start_date: "2026-12-08", end_date: "2026-12-10", order_step: "CANCELED",
  });
  check(
    "mutation",
    "cancelled: replies at all, acknowledges it, arranges nothing",
    !!d &&
      /cancel/i.test(d) &&
      !leaksAddress(d) &&
      !/\bsee you on\b|\bcollect(ion)? (is|at|between)\b/i.test(d),
    d || "<no draft — renter got silence>",
  );
  console.log(`  cancelled reply: ${(d || "<no draft>").replace(/\n+/g, " ").slice(0, 150)}`);
}

async function isolation() {
  console.log("\n--- 3. CROSS-CONVERSATION ISOLATION ---");
  // Two live conversations, deliberately different in every dimension.
  const A = {
    tid: "__probe__life_iso_A", account: "leo", item: "Sony FX3",
    booking: { status: "confirmed", start_date: "2026-12-04", end_date: "2026-12-05", order_step: "VERIFIED" },
  };
  const B = {
    tid: "__probe__life_iso_B", account: "diogo", item: "BMPCC 6K Full Frame",
    booking: { status: "pending_review", start_date: "2027-01-20", end_date: "2027-01-24", order_step: "REQUEST" },
  };

  const aHist = [{ role: "renter", text: "hi, confirming my FX3 for the 4th-5th dec — all good?" }];
  const aDraft = draft(A.tid, A.account, [{ name: A.item }], aHist, A.booking);
  console.log(`  A: ${aDraft.replace(/\n+/g, " ").slice(0, 130)}`);

  // B asks something that a leaked A-state would answer wrongly.
  const bHist = [{ role: "renter", text: "hey what dates am i booked for and which camera?" }];
  const bDraft = draft(B.tid, B.account, [{ name: B.item }], bHist, B.booking);
  console.log(`  B: ${bDraft.replace(/\n+/g, " ").slice(0, 150)}`);

  check("isolation", "B does not mention A's item (FX3)", !/\bfx\s?3\b/i.test(bDraft), bDraft);
  check("isolation", "B does not mention A's dates (4th-5th Dec)", !/\b4th\b.{0,12}\b5th\b/i.test(bDraft), bDraft);
  check(
    "isolation",
    "B is pending, so B must not leak the pickup address",
    !leaksAddress(bDraft),
    bDraft,
  );

  // And the reverse: A must not pick up B's January dates.
  const aHist2 = [...aHist, { role: "owner", text: aDraft }, { role: "renter", text: "remind me of my dates?" }];
  const aDraft2 = draft(A.tid, A.account, [{ name: A.item }], aHist2, A.booking);
  check("isolation", "A does not mention B's dates (January)", !/\bjanuary\b|\b2027\b/i.test(aDraft2), aDraft2);
}

async function main() {
  console.log(`\n=== LIFECYCLE / ISOLATION PROBE [${LABEL}] ===`);
  await stageMatrix();
  await mutations();
  await isolation();
  convexRun("renter_bot_probe:cleanup", {});
  const fails = results.filter((r) => !r.pass);
  console.log(`\nSCORE [${LABEL}]: ${results.length - fails.length}/${results.length} passed`);
  for (const f of fails) console.log(`  FAILED: ${f.group} — ${f.name}`);
  writeFileSync(`/tmp/lifecycle-${LABEL}.json`, JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
