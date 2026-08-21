/**
 * renter_bot_conversation_rubric.ts — CONVERSATION-level quality scoring.
 *
 * Why this exists (2026-08-21):
 * The existing rubric (renter_bot_rubric.ts) scores ONE draft in isolation
 * against regex/tone filters. A live 3-turn review found six serious defects
 * and the single-draft rubric caught none of them, because none of them are
 * visible in a single draft:
 *
 *   1. The bot said an item was unavailable when the calendar said it was FREE.
 *      Invisible without ground truth to compare against.
 *   2. It offered a body-only substitute for a listing that included lenses,
 *      and never offered to add glass.
 *   3. Asked "does that include a lens?", it answered about a different BRAND's
 *      camera — ignoring the body actually under discussion.
 *   4. Asked to collect a day early, it priced it as an extra day and stopped —
 *      no explanation, no workable offer.
 *   5. Upsell / negotiation / recommendation quality generally.
 *   6. It opened all three replies with the SAME "isn't available" sentence.
 *      Invisible unless you compare turns against each other.
 *
 * So the unit under test has to be the CONVERSATION plus the GROUND TRUTH, not
 * the string. Every check here is mechanical and evidence-producing; none of it
 * asks a model to judge.
 */

export interface ConversationTurn {
  renter: string;
  draft: string;
}

export interface ConversationGroundTruth {
  /** The item the renter is actually asking about. */
  requestedItem: string;
  /** Is it genuinely free for the requested dates, per the calendar? */
  requestedItemAvailable: boolean;
  /** Do we actually own/stock it (false ⇒ concealment is legitimate)? */
  requestedItemOwned: boolean;
  /** Real inventory, for substitution-sanity checks. */
  ownedItems?: Array<{
    name: string;
    kind?: string | null;
    lens_mount?: string | null;
    includes_lens?: boolean | null;
  }>;
  /**
   * Known kit text per item name. A key present with `null` means "we have NO
   * kit data" — any specific kit claim about it is therefore fabricated.
   */
  knownKit?: Record<string, string | null>;
}

export type Status = "pass" | "fail" | "flag" | "n_a";

export interface CheckResult {
  check: string;
  status: Status;
  /** 1-based turn index the finding belongs to, when turn-specific. */
  turn?: number;
  detail: string;
  evidence?: string;
}

export interface ConversationRubricOutput {
  results: CheckResult[];
  overall: "pass" | "fail" | "flag";
  failures: string[];
}

// ── text helpers ────────────────────────────────────────────────────────────

const STOP = new Set([
  "the","a","an","and","or","but","if","is","are","was","were","be","for","with",
  "to","of","on","in","at","by","from","as","it","that","this","you","your","i",
  "my","we","our","me","so","just","can","could","would","have","has","had","do",
  "does","did","not","no","yes","let","know","if","them","they","there","then",
]);

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function toks(s: string): Set<string> {
  return new Set(
    (s.toLowerCase().match(/[a-z0-9£]+/g) ?? []).filter(
      (t) => t.length > 1 && !STOP.has(t),
    ),
  );
}

/** Jaccard similarity between two sentences. */
export function similarity(a: string, b: string): number {
  const ta = toks(a);
  const tb = toks(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const UNAVAILABLE_RE =
  /\b(is\s?n[o']?t\s+available|not\s+available|unavailable|isn't\s+free|fully\s+booked|already\s+booked|is\s+booked|no\s+longer\s+available)\b/i;

// ── intent detection on the RENTER's message ────────────────────────────────

export type RenterTopic =
  | "lens"
  | "price"
  | "pickup_time"
  | "availability"
  | "day_count"
  | "other";

export function renterTopics(msg: string): RenterTopic[] {
  const m = msg.toLowerCase();
  const out: RenterTopic[] = [];
  const lens = /\blens(es)?\b|\bglass\b|\bmm\b/.test(m);
  if (lens) out.push("lens");
  // "does that price include a lens?" is a KIT question that happens to
  // contain the word "price" — the renter wants to know what's in the box, not
  // what the number is. Scoring it as a price question failed replies that
  // answered the actual question perfectly.
  const priceIsQualifier = lens && /\b(include|included|includes|come with|comes with)\b/.test(m);
  if (!priceIsQualifier && /\bprice|cost|how much|£|cheap|discount|deal|rate|quote\b/.test(m))
    out.push("price");
  if (/\bwhat time|when can|pick ?up|collect|drop ?off|return time\b/.test(m))
    out.push("pickup_time");
  if (/\bavailable|availab|free\b/.test(m)) out.push("availability");
  if (
    /\bday before|day after|extra day|night before|evening before|following day|day earlier|day later\b/.test(
      m,
    )
  )
    out.push("day_count");
  if (out.length === 0) out.push("other");
  return out;
}

const TOPIC_MARKERS: Record<Exclude<RenterTopic, "other">, RegExp> = {
  lens: /\blens(es)?\b|\bglass\b|\d{2,3}\s*-?\s*\d{0,3}\s*mm\b/i,
  // A price question can be answered without a number — "that's the best rate
  // I can do" is a complete answer to "can you do anything on the price?".
  price: /£\s?\d|\bprice|cost|per day|\/day|\brate\b|best i can|discount|no lower|firm\b/i,
  pickup_time: /\d{1,2}\s?(am|pm)|\bwindow|pick ?up|collect\b/i,
  availability: /\bavailable|free\b|\bbooked\b/i,
  day_count: /\bday|days|night|evening|morning\b/i,
};

// ── the checks ──────────────────────────────────────────────────────────────

export function scoreConversation(
  turns: ConversationTurn[],
  gt: ConversationGroundTruth,
): ConversationRubricOutput {
  const results: CheckResult[] = [];

  // 1. FALSE UNAVAILABILITY — the single most damaging defect. Claiming gear is
  //    unavailable when the calendar says it is free loses a real booking, and
  //    the renter has no way to know it was wrong.
  if (gt.requestedItemAvailable && gt.requestedItemOwned) {
    let hit: { turn: number; sentence: string } | null = null;
    turns.forEach((t, i) => {
      if (hit) return;
      for (const s of sentences(t.draft)) {
        if (UNAVAILABLE_RE.test(s)) {
          hit = { turn: i + 1, sentence: s };
          break;
        }
      }
    });
    results.push(
      hit
        ? {
            check: "false_unavailability",
            status: "fail",
            turn: (hit as { turn: number }).turn,
            detail: `Told the renter "${gt.requestedItem}" was unavailable, but ground truth says it is OWNED and FREE for these dates.`,
            evidence: (hit as { sentence: string }).sentence,
          }
        : {
            check: "false_unavailability",
            status: "pass",
            detail: "No false unavailability claim.",
          },
    );
  } else {
    results.push({
      check: "false_unavailability",
      status: "n_a",
      detail: gt.requestedItemOwned
        ? "Item genuinely unavailable for these dates."
        : "Item genuinely not rentable — concealment is correct here.",
    });
  }

  // 2. CROSS-TURN REPETITION — the "broken machine" tell. Any sentence that is
  //    a near-duplicate of one already sent in an earlier turn.
  {
    const repeats: CheckResult[] = [];
    for (let i = 1; i < turns.length; i++) {
      const prev = turns.slice(0, i).flatMap((t) => sentences(t.draft));
      for (const s of sentences(turns[i].draft)) {
        if (s.length < 25) continue; // ignore short pleasantries
        // 0.5, not 0.6: the live turn-2 repeat scored 0.550 because the bot
        // re-sent its opener with one parenthetical bolted on. Padding a
        // recycled sentence must not buy its way under the threshold.
        const dup = prev.find((p) => similarity(p, s) >= 0.5);
        if (dup) {
          repeats.push({
            check: "cross_turn_repetition",
            status: "fail",
            turn: i + 1,
            detail: `Turn ${i + 1} repeats a sentence already sent in an earlier reply.`,
            evidence: s,
          });
          break; // one finding per turn is enough
        }
      }
    }
    results.push(
      ...(repeats.length
        ? repeats
        : [
            {
              check: "cross_turn_repetition",
              status: "pass" as Status,
              detail: "No repeated sentences across turns.",
            },
          ]),
    );
  }

  // 3. QUESTION ACTUALLY ANSWERED — the reply must address the topic asked, in
  //    its opening (first two sentences), not bury it under a restatement.
  turns.forEach((t, i) => {
    const topics = renterTopics(t.renter).filter(
      (x): x is Exclude<RenterTopic, "other"> => x !== "other",
    );
    if (topics.length === 0) return;
    // Skip bare greetings when measuring the "opening" — "Hi!" is its own
    // sentence, and counting it pushed the actual answer out of the window,
    // failing replies that answered perfectly well in their first real line.
    const substantive = sentences(t.draft).filter(
      (s) => s.replace(/[^a-z0-9]/gi, "").length > 12,
    );
    const opening = substantive.slice(0, 2).join(" ");
    const first = substantive[0] ?? "";

    // (a) LEADS WITH BOILERPLATE. If they asked something specific and the
    //     reply still OPENS by restating availability, the answer is buried —
    //     this is the "it keeps saying it isn't available" complaint, and
    //     merely containing the topic word later does not fix it.
    if (!topics.includes("availability") && UNAVAILABLE_RE.test(first)) {
      results.push({
        check: "question_answered",
        status: "fail",
        turn: i + 1,
        detail: `Renter asked about ${topics.join(", ")}, but the reply opens by restating availability instead of answering.`,
        evidence: first.slice(0, 160),
      });
      return;
    }

    // (b) TOPIC NEVER ADDRESSED at all in the opening.
    const missed = topics.filter((topic) => !TOPIC_MARKERS[topic].test(opening));
    if (missed.length) {
      results.push({
        check: "question_answered",
        status: "fail",
        turn: i + 1,
        detail: `Renter asked about ${missed.join(", ")}; the reply's opening does not address it.`,
        evidence: opening.slice(0, 160),
      });
    }
  });
  if (!results.some((r) => r.check === "question_answered")) {
    results.push({
      check: "question_answered",
      status: "pass",
      detail: "Every question was addressed up front.",
    });
  }

  // 4. SUBSTITUTION SANITY — a substitute should stay in the renter's system.
  //    Crossing brand/mount silently is what produced a Sony answer to a
  //    Blackmagic question.
  if (gt.ownedItems?.length) {
    const target = gt.ownedItems.find(
      (o) => o.name.toLowerCase() === gt.requestedItem.toLowerCase(),
    );
    const brandOf = (n: string) => n.toLowerCase().split(/[^a-z0-9]+/)[0];
    const targetBrand = brandOf(gt.requestedItem);
    const findings: CheckResult[] = [];
    turns.forEach((t, i) => {
      const mentioned = (gt.ownedItems ?? []).filter(
        (o) =>
          o.name.toLowerCase() !== gt.requestedItem.toLowerCase() &&
          t.draft.toLowerCase().includes(o.name.toLowerCase()),
      );
      for (const alt of mentioned) {
        const sameKind = !target?.kind || !alt.kind || target.kind === alt.kind;
        const sameBrand = brandOf(alt.name) === targetBrand;
        const acknowledged =
          /different system|different mount|won'?t fit|not compatible|wouldn'?t fit|different brand/i.test(
            t.draft,
          );
        if (!sameKind) {
          findings.push({
            check: "substitution_sanity",
            status: "fail",
            turn: i + 1,
            detail: `Offered "${alt.name}" (${alt.kind}) as a substitute for a ${target?.kind ?? "?"}.`,
            evidence: alt.name,
          });
        } else if (!sameBrand && !acknowledged) {
          // Only a problem when a same-brand option actually existed.
          const sameBrandAlt = (gt.ownedItems ?? []).find(
            (o) =>
              brandOf(o.name) === targetBrand &&
              o.name.toLowerCase() !== gt.requestedItem.toLowerCase() &&
              (!target?.kind || o.kind === target.kind),
          );
          if (sameBrandAlt) {
            findings.push({
              check: "substitution_sanity",
              status: "fail",
              turn: i + 1,
              detail: `Crossed to "${alt.name}" without acknowledging it's a different system, while "${sameBrandAlt.name}" was available in the renter's own family.`,
              evidence: alt.name,
            });
          }
        }
      }
    });
    results.push(
      ...(findings.length
        ? findings
        : [
            {
              check: "substitution_sanity",
              status: "pass" as Status,
              detail: "Substitutes stayed in the renter's category/system.",
            },
          ]),
    );
  }

  // 5. KIT HALLUCINATION — specific contents asserted for an item we hold NO
  //    kit data on. This is how "comes with cage, 1TB card, and batteries"
  //    reached a renter for a body with no listing at all.
  if (gt.knownKit) {
    // Only POSITIVE, specific claims count. "no lens included" / "body only"
    // is a statement of ABSENCE — truthful and useful, and handled by
    // lens_follow_through — so the naive verb match flagged good replies.
    // Match the claim verb, take what FOLLOWS it, cut at the first negation,
    // and require a concrete kit noun in what remains.
    const CLAIM_VERB = /\b(comes with|ships with|bundled with|includes?)\b/i;
    const KIT_NOUN =
      /\b(cage|card|cards|sd|cfast|ssd|batter\w*|charger|lens|lenses|tripod|mic|microphone|case|bag|filter|rig|monitor|gimbal|adapter)\b/i;
    const findings: CheckResult[] = [];
    turns.forEach((t, i) => {
      for (const s of sentences(t.draft)) {
        const m = CLAIM_VERB.exec(s);
        if (!m) continue;
        let after = s.slice(m.index + m[0].length);
        const neg = after.search(/\b(no|not|without|except|excluding|apart from)\b/i);
        if (neg >= 0) after = after.slice(0, neg);
        if (!KIT_NOUN.test(after)) continue;

        // Which item is this claim ABOUT? Named items first.
        const named = Object.keys(gt.knownKit ?? {}).filter((item) =>
          s.toLowerCase().includes(item.toLowerCase()),
        );
        // ANAPHORA: the live miss was "that's just for the camera body (it
        // comes with batteries, charger, and SSD)" — a fabricated kit list
        // that never names the product, so name-matching skipped it entirely.
        // An unattributed kit claim refers to whatever is under discussion.
        const subjects =
          named.length > 0
            ? named
            : /\b(it|the camera|the body|camera body|the kit|this one|that one)\b/i.test(s)
              ? [gt.requestedItem]
              : [];

        for (const item of subjects) {
          if (!(item in (gt.knownKit ?? {}))) continue;
          if ((gt.knownKit ?? {})[item] === null) {
            findings.push({
              check: "kit_hallucination",
              status: "fail",
              turn: i + 1,
              detail: `Asserted kit contents for "${item}", but we have NO kit data for it — this is fabricated.`,
              evidence: s,
            });
          }
        }
      }
    });
    results.push(
      ...(findings.length
        ? findings
        : [
            {
              check: "kit_hallucination",
              status: "pass" as Status,
              detail: "No kit claims beyond known data.",
            },
          ]),
    );
  }

  // 6. DAY-COUNT NEGOTIATION — an early-collection / late-return ask must be
  //    explained AND met with a workable offer, not just priced and dropped.
  {
    const findings: CheckResult[] = [];
    turns.forEach((t, i) => {
      if (!renterTopics(t.renter).includes("day_count")) return;
      const d = t.draft;
      const explains = /extra day|counts as|two days|2 days|additional day|charged as/i.test(d);
      const offers =
        /evening|late|last window|early|first window|\d{1,2}\s?(am|pm)|could work|can do|happy to|that way|so it only/i.test(
          d,
        );
      if (!explains) {
        findings.push({
          check: "day_count_negotiation",
          status: "fail",
          turn: i + 1,
          detail: "Renter asked about early collection / late return; the reply never explains how the day count works.",
          evidence: d.slice(0, 160),
        });
      } else if (!offers) {
        findings.push({
          check: "day_count_negotiation",
          status: "fail",
          turn: i + 1,
          detail: "Explained the extra-day cost but made no workable counter-offer (e.g. a late-evening collection + early return).",
          evidence: d.slice(0, 160),
        });
      }
    });
    results.push(
      ...(findings.length
        ? findings
        : [
            {
              check: "day_count_negotiation",
              status: "pass" as Status,
              detail: "Day-count asks were explained and negotiated.",
            },
          ]),
    );
  }

  // 7. LENS FOLLOW-THROUGH — saying "no lens" without offering one is a lost
  //    booking and a lost upsell in the same sentence.
  {
    const findings: CheckResult[] = [];
    turns.forEach((t, i) => {
      const d = t.draft;
      const saysNoLens = /\b(lens not included|without a lens|body only|no lens|doesn'?t include a lens|does not include a lens)\b/i.test(d);
      if (!saysNoLens) return;
      // Must be an offer to ADD glass to the body under discussion, with a
      // price. Deliberately narrow: the live failure was "I have the Sony A7
      // III kit with a 28-70mm lens for £25/day" — a DIFFERENT camera that
      // happens to ship with glass. That is a brand pivot, not an offer to
      // solve the lens gap on the item they asked about, so it must not
      // satisfy this check. Note the added lens is often named directly
      // ("the Canon EF 24-105mm f4") without the word "lens", so the price is
      // the anchor rather than the noun.
      const offersLens =
        /\b(add|adding|throw in|pair it|bolt on|put)\b[^.]{0,110}£\s?\d/i.test(d);
      if (!offersLens) {
        findings.push({
          check: "lens_follow_through",
          status: "fail",
          turn: i + 1,
          detail: "Told the renter no lens is included but never offered to add one (with a price).",
          evidence: d.slice(0, 160),
        });
      }
    });
    results.push(
      ...(findings.length
        ? findings
        : [
            {
              check: "lens_follow_through",
              status: "pass" as Status,
              detail: "Lens gaps were met with a concrete offer.",
            },
          ]),
    );
  }

  // 8. PRICE CONSISTENCY ACROSS TURNS. Quoting one daily rate early and a
  //    different one later destroys trust and is invisible per-draft. Caught
  //    live: "the Sony FX3 at £18/day" in one turn, "£112 for 4 days" (=£40/day)
  //    in another, because two tools resolved price by different methods.
  {
    const perDay = new Map<number, number[]>(); // rate -> turns
    turns.forEach((t, i) => {
      for (const m of t.draft.matchAll(/£\s?(\d+(?:\.\d+)?)\s*(?:\/|\s*(?:per|a)\s*)day/gi)) {
        const v = Math.round(parseFloat(m[1]));
        if (!Number.isFinite(v)) continue;
        const arr = perDay.get(v) ?? [];
        arr.push(i + 1);
        perDay.set(v, arr);
      }
    });
    const rates = [...perDay.keys()];
    // More than one distinct per-day rate is only OK if several different items
    // are genuinely in play; with a single subject item it is a contradiction.
    if (rates.length > 1 && (gt.ownedItems?.length ?? 0) === 0) {
      results.push({
        check: "price_consistency",
        status: "fail",
        detail: `Quoted ${rates.length} different daily rates across the conversation: ${rates.map((r) => `£${r}`).join(", ")}.`,
        evidence: rates.map((r) => `£${r}/day (turn ${perDay.get(r)!.join(",")})`).join("; "),
      });
    } else {
      results.push({
        check: "price_consistency",
        status: "pass",
        detail: rates.length ? `Daily rates quoted: ${rates.map((r) => `£${r}`).join(", ")}.` : "No daily rate quoted.",
      });
    }
  }

  const failures = results.filter((r) => r.status === "fail").map((r) => r.check);
  const overall: "pass" | "fail" | "flag" =
    failures.length > 0 ? "fail" : results.some((r) => r.status === "flag") ? "flag" : "pass";
  return { results, overall, failures: [...new Set(failures)] };
}
