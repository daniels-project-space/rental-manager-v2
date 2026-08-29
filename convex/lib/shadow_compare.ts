/**
 * Compare a generated draft against the reply Daniel ACTUALLY sent.
 *
 * Every quality figure in this project so far was scored against a rubric I
 * wrote, on scenarios I wrote. That measures the bot against my idea of a good
 * answer. Daniel's real replies are the one yardstick nobody here invented.
 *
 * WHAT THIS CAN AND CANNOT JUDGE — the honest part, and the reason the output
 * separates "defect" from "incomparable" instead of producing one score:
 *
 *   Comparable. Prices, what is in the kit, whether we own a thing, whether the
 *   question was answered at all, tone and length. These do not change because
 *   we replayed the thread later.
 *
 *   NOT comparable. Anything about a specific date being free. A thread from
 *   June replayed today runs against today's calendar, so a difference is the
 *   world moving on, not the bot being wrong. Scoring those would manufacture
 *   failures. They are counted separately and excluded.
 *
 *   Not a defect either way. Daniel's reply is what one person said once, under
 *   time pressure, sometimes tersely. A difference is a SIGNAL TO READ, not
 *   proof the bot is wrong — the bot giving a fuller answer than "yes" is
 *   usually better. So divergences are reported with both texts for judgement,
 *   and only direct contradictions of fact are called defects.
 */

export type ShadowVerdict = {
  category: string;
  status: "match" | "divergent" | "defect" | "incomparable";
  detail: string;
  evidence?: string;
};

const DEFER =
  /\b(let me check|i'?ll check|i will check|i'?ll confirm|let me confirm|get back to you|i'?ll find out|let me look)\b/i;

/** A claim about a specific date/period being free — not replayable later. */
const TIME_DEPENDENT =
  /\b(available|free|booked|taken)\b[^.!?]{0,50}\b(on|from|for|that|those|these|the)\b[^.!?]{0,30}\b(\d{1,2}(st|nd|rd|th)?|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|weekend|week)\b/i;

/** Money figures, normalised to numbers. "£35/day" and "35 pounds" both count. */
export function extractPrices(text: string): number[] {
  const out: number[] = [];
  const re = /£\s?(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s?(?:pounds|quid|gbp)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const n = Number(m[1] ?? m[2]);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

/** Does the text answer in the affirmative / negative about possessing or including something? */
function polarity(text: string): "yes" | "no" | null {
  const t = text.toLowerCase();
  // Check negative first: "not included" contains "included".
  if (
    /\b(not included|doesn'?t come|does not come|don'?t have|do not have|not by itself|isn'?t included|is not included|no,|unfortunately|afraid not|don'?t stock)\b/.test(
      t,
    )
  )
    return "no";
  if (/\b(yes|yep|yeah|included|comes with|it does|i have|we have|i've got|sure)\b/.test(t))
    return "yes";
  return null;
}

/** A question mark that is genuinely asking the renter something. */
function asksQuestion(text: string): boolean {
  return /\?/.test(text);
}

export type ShadowInput = {
  /** What the renter asked. */
  ask: string;
  /** What Daniel actually replied. Ground truth. */
  realReply: string;
  /** What the bot produced now. */
  draft: string;
  /** Guard flags raised on the draft by the real filters. */
  guardFlags?: string[];
};

export function compareToReal(input: ShadowInput): {
  verdicts: ShadowVerdict[];
  defects: number;
  divergences: number;
  incomparable: number;
} {
  const { ask, realReply, draft, guardFlags = [] } = input;
  const verdicts: ShadowVerdict[] = [];

  if (!draft.trim()) {
    verdicts.push({
      category: "produced_a_reply",
      status: "defect",
      detail: "No draft at all — in production this renter gets silence.",
      evidence: `real reply was: ${realReply.slice(0, 120)}`,
    });
    return { verdicts, defects: 1, divergences: 0, incomparable: 0 };
  }

  // 1. Deferral where a human answered. The single most useful comparison:
  //    Daniel gave a concrete answer, so the answer was knowable.
  const realDefers = DEFER.test(realReply);
  const draftDefers = DEFER.test(draft);
  if (draftDefers && !realDefers)
    verdicts.push({
      category: "deferred_where_human_answered",
      status: "defect",
      detail: "Bot said it would check; the real reply answered outright.",
      evidence: `real: ${realReply.slice(0, 120)}`,
    });
  else if (!draftDefers && realDefers)
    verdicts.push({
      category: "deferred_where_human_answered",
      status: "divergent",
      detail: "Bot answered outright where the real reply deferred — usually better, worth reading.",
    });
  else
    verdicts.push({
      category: "deferred_where_human_answered",
      status: "match",
      detail: draftDefers ? "both deferred" : "both answered directly",
    });

  // 2. Price contradiction. Only meaningful when BOTH quote a figure.
  const realPrices = extractPrices(realReply);
  const draftPrices = extractPrices(draft);
  if (realPrices.length && draftPrices.length) {
    const shared = draftPrices.some((d) => realPrices.includes(d));
    verdicts.push({
      category: "price_agreement",
      status: shared ? "match" : "defect",
      detail: shared
        ? `both quote ${realPrices.filter((p) => draftPrices.includes(p)).join(", ")}`
        : `bot quoted ${draftPrices.join("/")}, real reply quoted ${realPrices.join("/")}`,
      evidence: shared ? undefined : `real: ${realReply.slice(0, 120)}`,
    });
  } else if (realPrices.length && !draftPrices.length) {
    verdicts.push({
      category: "price_agreement",
      status: "divergent",
      detail: `real reply quoted ${realPrices.join("/")}, bot quoted nothing`,
      evidence: `real: ${realReply.slice(0, 120)}`,
    });
  }

  // 3. Yes/no contradiction — "do you have X", "is Y included".
  const realPol = polarity(realReply);
  const draftPol = polarity(draft);
  if (realPol && draftPol) {
    // Availability polarity is time-dependent; everything else is not.
    const timeDep = TIME_DEPENDENT.test(realReply) || TIME_DEPENDENT.test(draft);
    if (realPol !== draftPol)
      verdicts.push({
        category: "yes_no_agreement",
        status: timeDep ? "incomparable" : "defect",
        detail: timeDep
          ? `differs (real ${realPol} / bot ${draftPol}) but the claim is about specific dates — the calendar has moved since, so this is not evidence either way`
          : `real reply said ${realPol}, bot said ${draftPol}`,
        evidence: `real: ${realReply.slice(0, 120)}`,
      });
    else verdicts.push({ category: "yes_no_agreement", status: "match", detail: `both ${realPol}` });
  }

  // 4. Did the real reply ask the renter something the bot didn't? Daniel
  //    routinely answers a vague ask with a question ("when would you be
  //    looking to pick up?"). A bot that guesses instead of asking is a
  //    different, worse conversation.
  if (asksQuestion(realReply) && !asksQuestion(draft))
    verdicts.push({
      category: "clarifying_question",
      status: "divergent",
      detail: "Real reply asked the renter a question; bot did not.",
      evidence: `real: ${realReply.slice(0, 120)}`,
    });

  // 5. Length. Daniel's median real reply is ~52 characters. A bot writing five
  //    times that on every turn does not sound like this business, even when
  //    every fact in it is right.
  const ratio = draft.length / Math.max(realReply.length, 1);
  if (ratio > 4)
    verdicts.push({
      category: "length",
      status: "divergent",
      detail: `bot wrote ${draft.length} chars vs ${realReply.length} real (${ratio.toFixed(1)}x)`,
    });

  // 6. Guard flags stand on their own — no comparison needed.
  for (const f of guardFlags)
    verdicts.push({ category: "guard", status: "defect", detail: `guard flag: ${f}` });

  // 7. Note when the exchange was fundamentally about dates, so the reader knows
  //    how much of this comparison to trust.
  if (TIME_DEPENDENT.test(ask) || TIME_DEPENDENT.test(realReply))
    verdicts.push({
      category: "time_dependent_exchange",
      status: "incomparable",
      detail: "Exchange turns on specific dates; replayed against a different calendar.",
    });

  return {
    verdicts,
    defects: verdicts.filter((v) => v.status === "defect").length,
    divergences: verdicts.filter((v) => v.status === "divergent").length,
    incomparable: verdicts.filter((v) => v.status === "incomparable").length,
  };
}
