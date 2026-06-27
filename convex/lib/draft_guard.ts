/**
 * Draft guard — output policing for AI-generated owner replies (Phase 1).
 *
 * A faithful port of the V1 rental bot's FILTER + CONTRACT layers
 * (/home/ubuntu/rental-manager/src/pipeline/{filter,contract,patterns}.ts),
 * adapted for a HUMAN-IN-THE-LOOP draft generator:
 *
 *  - Unambiguous garbage is STRIPPED/REWRITTEN automatically (internal-action
 *    leaks, chain-of-thought, the "Hygglo" platform name, timestamps, markdown,
 *    Leo's we/our→I/my first-person rewrite).
 *  - Judgement calls are FLAGGED, never silently rewritten with canned text —
 *    the owner reviews every draft, so a clear warning beats a guessed fix
 *    (price hallucination, premature confirmation, false action claims,
 *    fabricated quotes, model/substitution confusion, out-of-hours times, …).
 *
 * Pure functions, no Convex/Node deps — safe to import from the draft action.
 * Pickup windows are passed in (owner-editable in Settings) rather than the
 * V1 hardcoded 10-12 / 19-21, and account-specific addresses are NOT injected
 * (they'd be stale); those cases flag instead.
 */

export type FlagSeverity = "critical" | "high" | "medium" | "low";
export type FlagAction = "stripped" | "rewritten" | "flagged";

export interface DraftFlag {
  type: string;
  detail: string;
  severity: FlagSeverity;
  action: FlagAction;
}

export interface GuardResult {
  text: string;
  flags: DraftFlag[];
  confidence: number; // 0..1, derived from UNRESOLVED (flagged) issues only
  modified: boolean;
}

export interface GuardOpts {
  /** Prior turns, oldest→newest. role is the V2 sender ("owner"/"renter"). */
  history: { role: "owner" | "renter"; content: string }[];
  /** The renter's most recent message (drives time/intent checks). */
  lastRenterMessage: string;
  /** Account slug (leo / dbcinema / diogo / …). */
  account?: string;
  /** Lowercased rental stage (booked / confirmed / completed / …). */
  stage?: string;
  /** Owner-configured pickup/return windows, "HH:MM". Empty = skip time checks. */
  pickupWindows?: { start: string; end: string }[];
  /** Accounts that speak in the first person singular ("I", not "we"). */
  firstPerson?: boolean;
  /** Grounding facts (Phase 2). Optional — price/model checks no-op without it. */
  factPack?: {
    pricing?: { itemPrices?: { name: string; min: number; max: number }[] };
    verifiedListingItem?: string;
    marketingItems?: string[];
    lowValueInstruction?: string;
  };
  /** Real per-item availability for the rental dates (verify.ts cross-check). */
  availability?: { items: { name: string; available: boolean }[] };
  /** True once the owner has actually approved the booking — so an accurate
   *  "I've approved your request" is not mis-flagged as a false action claim. */
  ownerApproved?: boolean;
  /** Booked items we can't fulfil (marketing/SEO listing, not owned). The draft
   *  must not confirm them. */
  unfulfillableItems?: string[];
}

// ── Shared patterns (from patterns.ts) ────────────────────────────

const QUALIFY_PATTERNS: RegExp[] = [
  /(?:what|which)(?:'s| is| kind of| type of)?\s*(?:the |your )?\s*(?:shoot|project|production|film|video|gig)\s*(?:for|about|type|going to be)?\??/i,
  /(?:what|which) (?:kind|type|sort) of (?:shoot|project|production|film|video|gig|work)\b/i,
  /(?:what|which) are you (?:shooting|filming|working on|planning|using (?:it|them|the gear) for)\??/i,
  /what(?:'s| is) (?:it|this|the shoot|the project) for\??/i,
  /that way I can (?:suggest|recommend|help|advise)/i,
];
const SHOOT_QUESTION_PATTERN = /\bwhat(?:'s| is) the shoot for\b/i;

// ── Severity map ──────────────────────────────────────────────────

const SEVERITY: Record<string, FlagSeverity> = {
  INTERNAL_ACTION: "critical",
  CHAIN_OF_THOUGHT: "critical",
  PRICE_HALLUCINATION: "critical",
  FALSE_ACTION_CLAIM: "critical",
  PREMATURE_CONFIRMATION: "critical",
  MARKETING_ITEM_AVAILABLE: "critical",
  EQUIPMENT_SUBSTITUTION: "critical",
  FABRICATED_QUOTE: "critical",
  UNFULFILLABLE_BOOKING: "critical",
  AVAILABILITY_CONTRADICTION: "high",
  PHYSICAL_PRESENCE: "high",
  MISSED_ARRIVAL: "high",
  INVALID_TIME_ACCEPTED: "high",
  ACCESSORY_CHARGED_SEPARATELY: "high",
  SELF_CONTRADICTION: "high",
  GEAR_RECEIPT_CONFIRMED: "high",
  NON_INVENTORY_ADDON: "high",
  TIMING_CAPITULATION: "high",
  LOW_VALUE_BLOCK: "high",
  PLATFORM_LEAK: "medium",
  PROACTIVE_DELIVERY: "medium",
  QUALIFY_QUESTION_SPAM: "medium",
  TIME_LOGIC: "medium",
  PROACTIVE_EXTRA_DAY_WARNING: "medium",
  VAGUE_CONFIRMED_LOCATION: "medium",
  TIME_WITHOUT_LOCATION: "medium",
  CONTRACT: "medium",
  TIMESTAMP: "low",
  FORMATTING: "low",
};

const sev = (type: string): FlagSeverity =>
  SEVERITY[type] ?? SEVERITY[type.split(":")[0]] ?? "medium";

// ── Time helpers ──────────────────────────────────────────────────

function hhmmToMin(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseInt(m[2]);
}

/** Build [startMin,endMin] ranges from owner pickup windows. */
function windowRanges(
  windows?: { start: string; end: string }[],
): [number, number][] {
  if (!windows) return [];
  const out: [number, number][] = [];
  for (const w of windows) {
    const a = hhmmToMin(w.start);
    const b = hhmmToMin(w.end);
    if (a != null && b != null && b >= a) out.push([a, b]);
  }
  return out;
}

const inAnyWindow = (t: number, ranges: [number, number][]): boolean =>
  ranges.some(([a, b]) => t >= a && t <= b);

function parseTimeToMinutes(timeStr: string): number | null {
  const cleaned = timeStr.trim().toLowerCase();
  const match = cleaned.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;
  let hours = parseInt(match[1]);
  const minutes = match[2] ? parseInt(match[2]) : 0;
  const meridiem = match[3];
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

// ── Main entry ────────────────────────────────────────────────────

export function guardDraft(draft: string, opts: GuardOpts): GuardResult {
  const flags: DraftFlag[] = [];
  let text = draft;
  const push = (type: string, detail: string, action: FlagAction) =>
    flags.push({ type, detail, severity: sev(type), action });

  const account = opts.account;
  const stage = opts.stage?.toLowerCase();
  const message = opts.lastRenterMessage ?? "";
  const ranges = windowRanges(opts.pickupWindows);
  const factPack = opts.factPack;
  // V1 filter expects user/assistant roles.
  const history = opts.history.map((m) => ({
    role: m.role === "owner" ? "assistant" : "user",
    content: m.content,
  }));

  // 1. INTERNAL ACTION LEAK (asterisk-wrapped) — STRIP
  const internalActionPattern =
    /\*[^*]*(?:Daniel|Telegram|escalat|internal|notify|alert|inform|immediately|owner|urgent)[^*]*\*/gi;
  const internalMatches = text.match(internalActionPattern);
  if (internalMatches) {
    for (const m of internalMatches) text = text.replace(m, "");
    push("INTERNAL_ACTION", "Stripped internal action note", "stripped");
  }
  const anyAsteriskAction = /\*[^*]{10,}\*/g;
  const asteriskMatches = text.match(anyAsteriskAction);
  if (asteriskMatches) {
    let stripped = false;
    for (const m of asteriskMatches) {
      if (
        /\b(inform|send|notify|check|update|contact|call|text|message|alert|escalat|forward)\b/i.test(
          m,
        )
      ) {
        text = text.replace(m, "");
        stripped = true;
      }
    }
    if (stripped) push("INTERNAL_ACTION", "Stripped asterisk action", "stripped");
  }

  // 1b. PLAIN-TEXT INTERNAL LEAKS — STRIP
  const internalPlainPatterns = [
    /CRITICAL\s*(?:SECURITY\s*)?ALERT[^.!?\n]*/gi,
    /INTERNAL\s*(?:NOTE|MEMO|ACTION)[^.!?\n]*/gi,
    /MANDATORY\s*DELIVERY\s*(?:RULE|POLICY)[^.!?\n]*/gi,
    /\[INTERNAL\][^.!?\n]*/gi,
    /\[ESCALATION\][^.!?\n]*/gi,
    /DRAFT\s*REPLY\s*:/gi,
  ];
  for (const p of internalPlainPatterns) {
    if (p.test(text)) {
      text = text.replace(p, "").replace(/\n{3,}/g, "\n\n").trim();
      push("INTERNAL_ACTION", "Stripped plain-text internal leak", "stripped");
    }
  }

  // 1c. CROSS-ACCOUNT NAME LEAK (Leo claims to be the owner) — REWRITE
  if (account === "leo" && /\bDaniel\b/.test(text)) {
    text = text.replace(
      /\b(with|to|from|for|by|contact|notify|notifying|ask|tell|reach)\s+Daniel\b/gi,
      "$1 me",
    );
    text = text.replace(/\bDaniel's\b/g, "my");
    text = text.replace(/\bDaniel\b/g, "I");
    push("INTERNAL_ACTION", 'Replaced "Daniel" with first-person', "rewritten");
  }

  // 1d. FIRST-PERSON SINGULAR: we/our → I/my — REWRITE
  if (opts.firstPerson && /\b(we|our)\b/i.test(text)) {
    text = text.replace(/\bwe'?ve\b/gi, "I've");
    text = text.replace(
      /\bwe'?re (separate|different|independent|distinct|two|not the same|not related)\b/gi,
      "they're $1",
    );
    text = text.replace(/\bwe'?re\b/gi, "I'm");
    text = text.replace(/\bwe'?ll\b/gi, "I'll");
    text = text.replace(
      /\bwe (have|can|do|offer|provide|also|stock|carry|include|don'?t|did|are|get|will|should|could|would|need)\b/gi,
      "I $1",
    );
    text = text.replace(
      /\bour (gear|kit|equipment|stock|inventory|items|prices?|rates?|rental|business|location|shop|studio|place|selection)\b/gi,
      "my $1",
    );
    text = text.replace(/\bour\b/gi, "my");
    text = text.replace(/\bWe\b/g, "I");
    text = text.replace(/\bwe\b/g, "I");
    text = text.replace(/\bI'm I\b/g, "I'm");
    text = text.replace(/\bI I\b/g, "I");
    text = text.replace(/\bI'm\.\s*/g, "");
    text = text.replace(
      /\bI'm (separate|different|independent|distinct)\b/gi,
      "they're $1",
    );
    push("INTERNAL_ACTION", 'Rewrote "we/our" to "I/my"', "rewritten");
  }

  // 1e. CHAIN-OF-THOUGHT LEAK — STRIP
  const cot = detectAndStripChainOfThought(text);
  if (cot.stripped) {
    text = cot.cleanText;
    push(
      "CHAIN_OF_THOUGHT",
      cot.details[0] ?? "Stripped leaked reasoning",
      "stripped",
    );
  }

  // 2. PLATFORM NAME LEAK — REWRITE
  if (/\bHygglo\b/gi.test(text)) {
    text = text.replace(/\bHygglo\b/gi, "the platform");
    push("PLATFORM_LEAK", 'Replaced "Hygglo" with "the platform"', "rewritten");
  }
  text = text
    .replace(/\bthe the platform\b/gi, "the platform")
    .replace(/\bthe platform platform\b/gi, "the platform")
    .replace(/\bthe platform the platform\b/gi, "the platform");

  // 3. PHYSICAL PRESENCE CLAIMS — STRIP (or flag if it's the whole reply)
  const physicalPresencePatterns = [
    /\bI'?m here with your (gear|kit|equipment|lens|camera)\b/i,
    /\bjust (grabbed|picked up|got) (the|your) (gear|kit|lens|camera|equipment)\b/i,
    /\b(arriving|arrived) with (the|your) (gear|kit|equipment)\b/i,
    /\bI'?ll (come|bring|carry|hand) (it |the gear |your gear |everything )?(out|over|to you|down)\b/i,
    /\bcoming out to (you|meet you) (now|with)\b/i,
    /\bjust arrived with your\b/i,
    /\bI'?ve got (the|your) (gear|kit|equipment|lens|camera) (here|ready|with me)\b/i,
    /\bdon'?t have a phone with me\b/i,
    /\bI'?m (bringing|carrying) (the|your|it)\b/i,
    /\b(on my way|heading (to |over|there)|coming over|coming (to|now))\b/i,
    /\bbe with you in\b/i,
    /\bI'?ll (be there|meet you|wait for you|come to you)\b/i,
    /\bI'?m (at|by|near|outside|waiting|here)\b/i,
    /\bspotted you\b/i,
    /\bsee you (in|shortly|soon|there)\b/i,
    /\bjust (parking|arrived|pulled up|getting out)\b/i,
    /\bI'?ll wait (for you |here )/i,
  ];
  for (const p of physicalPresencePatterns) {
    if (p.test(text)) {
      const sentences = text.split(/(?<=[.!?])\s+/);
      const cleaned = sentences.filter((s) => !p.test(s));
      if (cleaned.length < sentences.length && cleaned.length > 0) {
        text = cleaned.join(" ").replace(/\n{3,}/g, "\n\n").trim();
        push("PHYSICAL_PRESENCE", "Stripped physical-presence claim", "stripped");
      } else {
        push("PHYSICAL_PRESENCE", "Physical-presence claim detected", "flagged");
      }
    }
  }

  // 4. FABRICATED RENTER QUOTES — FLAG
  const quotePatterns = [
    /you (?:said|mentioned|told me|asked about|indicated|noted|specified) (?:that )?(?:the |your |a )?(.{5,60}?)(?:\.|,|!|\?|$)/gi,
    /earlier (?:you|in our chat) (?:said|mentioned|asked|told|indicated) (.{5,60}?)(?:\.|,|!|\?|$)/gi,
  ];
  const renterMessages = history
    .filter((m) => m.role === "user")
    .map((m) => m.content.toLowerCase())
    .join(" ");
  for (const p of quotePatterns) {
    p.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.exec(text)) !== null) {
      const claimed = m[1]?.trim().toLowerCase();
      if (!claimed || claimed.length < 5) continue;
      const words = claimed.split(/\s+/).filter((w) => w.length > 3);
      if (renterMessages.length > 0 && !words.some((w) => renterMessages.includes(w))) {
        push(
          "FABRICATED_QUOTE",
          `Claims renter said "${m[1]?.trim()}" — not found in their messages`,
          "flagged",
        );
      }
    }
  }

  // 5. TIME SLOT LOGIC — FLAG (bot rejects a time inside its own stated window)
  const timeSlotRejection =
    /(?:my|our|the) slots? (?:are|is) (\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*(?:to|-)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i;
  const rej = text.match(timeSlotRejection);
  if (rej) {
    const a = parseTimeToMinutes(rej[1]);
    const b = parseTimeToMinutes(rej[2]);
    const rt = message.match(/(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\b/i);
    if (rt && a != null && b != null) {
      const t = parseTimeToMinutes(rt[1]);
      if (
        t != null &&
        t >= a &&
        t <= b &&
        /\b(outside|can'?t|not available|doesn'?t work|won'?t work|not within|instead)\b/i.test(
          text,
        )
      )
        push(
          "TIME_LOGIC",
          `Rejected ${rt[1]} as outside ${rej[1]}-${rej[2]} but it's within range`,
          "flagged",
        );
    }
  }

  // 6. SELF-CONTRADICTION vs last owner message — FLAG
  const assistantMsgs = history
    .filter((m) => m.role === "assistant")
    .map((m) => m.content.toLowerCase());
  if (assistantMsgs.length > 0) {
    const last = assistantMsgs[assistantMsgs.length - 1];
    const av = /\b(available|in stock|I'?ve got|we'?ve got|I have|we have)\b/i.test(text);
    const un = /\b(out of stock|unavailable|not available|don'?t have|can'?t get)\b/i.test(text);
    const pAv = /\b(available|in stock|i'?ve got|we'?ve got|i have|we have)\b/i.test(last);
    const pUn = /\b(out of stock|unavailable|not available|don'?t have)\b/i.test(last);
    if (un && pAv && !av)
      push("SELF_CONTRADICTION", "Previously said available, now unavailable", "flagged");
    if (av && pUn && !un)
      push("SELF_CONTRADICTION", "Previously said unavailable, now available", "flagged");
  }

  // 7. TIMESTAMPS — STRIP
  const tsPattern =
    /\[(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\d{1,2}\s+\w+\s+\d{1,2}:\d{2}\]\s*/gi;
  if (tsPattern.test(text)) {
    text = text.replace(tsPattern, "");
    push("TIMESTAMP", "Stripped embedded timestamps", "stripped");
  }

  // 8. MARKETING-ONLY ITEM CLAIMED AVAILABLE — FLAG (factPack-gated)
  const marketingItems = factPack?.marketingItems ?? [];
  if (marketingItems.length > 0) {
    if (
      /\b(available|in stock|I'?ve got|we'?ve got|I have|we have|can get|ready for)\b/i.test(
        text,
      )
    ) {
      const tl = text.toLowerCase();
      for (const item of marketingItems)
        if (tl.includes(item.toLowerCase()))
          push(
            "MARKETING_ITEM_AVAILABLE",
            `Claims marketing-only item "${item}" is available`,
            "flagged",
          );
    }
  }

  // 8b. AVAILABILITY CONTRADICTION (verify.ts) — draft vs the real calendar
  if (opts.availability?.items?.length) {
    const tl = text.toLowerCase();
    const saysUnavail =
      /\b(not available|unavailable|out of stock|booked out|fully booked|already booked|currently rented|all booked|none (?:left|available))\b/i.test(
        text,
      );
    const saysAvail =
      /\b(available|in stock|i'?ve got|i have|free for|ready for|can do|yep,? got)\b/i.test(
        text,
      );
    for (const it of opts.availability.items) {
      if (!tl.includes(it.name.toLowerCase())) continue;
      if (it.available && saysUnavail && !saysAvail)
        push(
          "AVAILABILITY_CONTRADICTION",
          `Draft says ${it.name} is unavailable, but the calendar shows it free for these dates`,
          "flagged",
        );
      if (!it.available && saysAvail && !saysUnavail)
        push(
          "AVAILABILITY_CONTRADICTION",
          `Draft implies ${it.name} is available, but it's booked out for these dates`,
          "flagged",
        );
    }
  }

  // 9. INVALID PICKUP TIME (renter proposed, draft accepted) — FLAG
  if (ranges.length > 0) {
    const rt = message.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
    if (rt) {
      const t = parseTimeToMinutes(rt[0]);
      if (t != null && !inAnyWindow(t, ranges)) {
        const accept =
          /\b(works|sounds good|perfect|great|confirmed|booked|see you|arranged|sorted|no problem|can do|that'?s fine|sure|ok|okay|delivery at|pickup at|collect at)\b/i.test(
            text,
          );
        if (accept)
          push(
            "INVALID_TIME_ACCEPTED",
            `Draft accepts ${rt[0]}, outside your pickup windows`,
            "flagged",
          );
      }
    }
    // 9b. Draft OFFERS a time outside windows — FLAG
    const botTimePattern = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi;
    let bm: RegExpExecArray | null;
    const badOffers: string[] = [];
    while ((bm = botTimePattern.exec(text)) !== null) {
      const t = parseTimeToMinutes(bm[0]);
      if (t == null || inAnyWindow(t, ranges)) continue;
      const near = text.substring(
        Math.max(0, bm.index - 40),
        Math.min(text.length, bm.index + bm[0].length + 40),
      );
      if (
        /\b(can do|pickup at|earliest|come at|drop.?off at|arrive at|available at|delivery at)\b/i.test(
          near,
        )
      )
        badOffers.push(bm[0]);
    }
    if (badOffers.length)
      push(
        "INVALID_TIME_ACCEPTED",
        `Draft offers out-of-hours time(s): ${badOffers.join(", ")}`,
        "flagged",
      );
  }

  // 10. PROACTIVE DELIVERY OFFER (renter didn't ask) — STRIP
  if (!/\b(deliver|delivery|courier|drop.?off|send it|bring it|ship)\b/i.test(message)) {
    const offers =
      /\b(we (also |can )?offer delivery|delivery is available|I can (arrange|organise) delivery|want me to deliver|I can drop|we do delivery|delivery option)\b/i;
    if (offers.test(text)) {
      const sentences = text.split(/(?<=[.!?])\s+/);
      const cleaned = sentences.filter((s) => !offers.test(s));
      if (cleaned.length > 0 && cleaned.length < sentences.length) {
        text = cleaned.join(" ").trim();
        push("PROACTIVE_DELIVERY", "Stripped unprompted delivery offer", "stripped");
      }
    }
  }

  // 11. QUALIFY QUESTION SPAM (non-greeting) — STRIP with safety
  if (
    /\b(price|cost|how much|£|deliver|pickup|return|time|slot|available|cancel|refund|discount|cheaper|expensive|address|where|when)\b/i.test(
      message,
    )
  ) {
    for (const qp of QUALIFY_PATTERNS) {
      if (qp.test(text)) {
        const sentences = text.split(/(?<=[.!?])\s+/);
        const cleaned = sentences.filter(
          (s) => !QUALIFY_PATTERNS.some((p) => p.test(s)),
        );
        const cleanedText = cleaned.join(" ").trim();
        const keptRatio = cleaned.length / sentences.length;
        if (
          cleaned.length > 0 &&
          cleaned.length < sentences.length &&
          cleanedText.length > 80 &&
          keptRatio >= 0.5
        ) {
          text = cleanedText;
          push(
            "QUALIFY_QUESTION_SPAM",
            'Stripped "what are you shooting?" from a non-greeting reply',
            "stripped",
          );
        } else if (cleaned.length < sentences.length) {
          push(
            "QUALIFY_QUESTION_SPAM",
            "Qualify question detected (kept — stripping would gut the reply)",
            "flagged",
          );
        }
        break;
      }
    }
  }

  // 12. EQUIPMENT SUBSTITUTION (insurance: never promise a different item) — FLAG
  const substitutionPatterns = [
    /\b(?:step[\s-]+up|upgrade)\s+from\b/i,
    /\b(?:instead|rather\s+than)\s+(?:of\s+)?the\b/i,
    /[—–-]\s*(?:an?\s+)?(?:step[\s-]+up|upgrade|improvement|better\s+version)\b/i,
    /\bas\s+opposed\s+to\b/i,
  ];
  for (const p of substitutionPatterns) {
    if (p.test(text)) {
      push(
        "EQUIPMENT_SUBSTITUTION",
        "Implies the renter gets a different item than listed (insurance mismatch)",
        "flagged",
      );
      break;
    }
  }

  // 13. TIMING OBJECTION CAPITULATION — FLAG
  const timingObjection =
    /\b(?:timing|time)s?\s*(?:don'?t|won'?t|doesn'?t|can'?t|not)\s*(?:work|fit|suit|line\s+up|match)\b|\b(?:can'?t|cannot)\s+make\s+(?:it|the|a)\s*(?:time|slot|window|pickup|drop)\b|\btimes?\s+(?:are\s+)?(?:wrong|off|bad|tricky|difficult)\b|\bschedule\s+(?:doesn'?t|won'?t)\s+work\b|\bwon'?t\s+work\s+(?:for|with)\s+us\b/i.test(
      message,
    );
  if (timingObjection) {
    const offered =
      /\b(?:evening|day|morning|night)\s+(?:before|after)\b|\bpick\s*up\s+(?:the\s+)?(?:evening|night|day)\s+before\b|\bdrop\s*(?:off)?\s+(?:the\s+)?(?:morning|day)\s+after\b|\balternative\s+(?:time|slot|day)\b/i.test(
        text,
      );
    const gaveUp =
      /\bno\s+worries\b|\bhope\s+you\s+find\b|\bfeel\s+free\s+to\s+come\s+back\b|\bhope\s+(?:it|something|things?)\s+works?\s+out\b|\bmaybe\s+another\s+time\b/i.test(
        text,
      );
    if (gaveUp && !offered)
      push(
        "TIMING_CAPITULATION",
        "Gave up on a timing objection without offering day-before/day-after",
        "flagged",
      );
  }

  // 14. NON-INVENTORY ADDON OFFER — FLAG
  const addonPatterns = [
    /\bwe\s+can\s+(?:look\s+at|try\s+to|see\s+about)\s+(?:look\s+at\s+)?add(?:ing)?\b.*\b(?:batter(?:y|ies)|extra\s+set|additional\s+set|memory|card|sd\b|accessory|accessories)\b/i,
    /\b(?:extra|additional|more)\s+(?:set\s+of\s+)?batter(?:y|ies)\b.*\bwe\s+(?:can|could|might)\s+(?:look\s+at\s+)?(?:add|include|throw\s+in|sort)\b/i,
    /\bwe\s+(?:can|could)\s+(?:look\s+at\s+)?(?:throw\s+in|include|add)\s+(?:extra|additional|more|an?\s+extra)\s+(?:batter(?:y|ies)|set)\b/i,
  ];
  for (const p of addonPatterns) {
    if (p.test(text)) {
      push("NON_INVENTORY_ADDON", "Offers to add accessories that may not be in stock", "flagged");
      break;
    }
  }

  // 15. MISSED ARRIVAL — FLAG (renter is already here, draft sends them somewhere)
  const renterHere =
    /\b(?:i'?m here|i am here|we'?re here|we are here|i'?ve arrived|i have arrived|we'?ve arrived|just arrived|here now|waiting here|i'?m waiting|been waiting|standing here|stood here|i'?m standing|we'?re waiting|already (?:here|there|arrived)|i'?m outside|we'?re outside|i'?m at the|we'?re at the)\b/i.test(
      message,
    );
  if (renterHere) {
    const directs =
      /\b(?:head(?:ing)?\s+(?:to|over)|make your way|go\s+(?:to|over)|come\s+(?:to|over)|message (?:here|us|me) when you arrive|text (?:us|me|here) when you(?:'re| are) (?:here|there|arrived)|let (?:us|me) know when you arrive|when you(?:'re| are) (?:here|there))\b/i.test(
        text,
      );
    if (directs)
      push("MISSED_ARRIVAL", "Renter said they're already here but draft directs them to a location", "flagged");
  }

  // 16. PRICE HALLUCINATION — FLAG (factPack-gated)
  if (factPack?.pricing?.itemPrices && factPack.pricing.itemPrices.length) {
    const stated = [...text.matchAll(/£\s*(\d+(?:\.\d{2})?)/g)].map((m) =>
      parseFloat(m[1]),
    );
    if (stated.length) {
      const valid = new Set<number>();
      for (const p of factPack.pricing.itemPrices) {
        for (let v = Math.floor(p.min * 0.9); v <= Math.ceil(p.max * 1.1); v++) valid.add(v);
        for (const mult of [2, 2.5, 3, 4, 5, 6, 7])
          for (let v = Math.floor(p.min * mult * 0.9); v <= Math.ceil(p.max * mult * 1.1); v++)
            valid.add(v);
      }
      // Only widen for delivery/deposit when the conversation is actually about
      // them — otherwise a £10-100 catch-all hides wrong daily-rate quotes (v1 bug).
      const ctxText = `${message} ${text}`.toLowerCase();
      if (/\b(deliver|delivery|courier|drop.?off|postage|ship)\b/.test(ctxText))
        for (let v = 10; v <= 100; v++) valid.add(v);
      if (/\b(deposit|security|hold)\b/.test(ctxText))
        for (let v = 50; v <= 500; v += 10) valid.add(v);
      for (let v = 5; v <= 15; v++) valid.add(v); // small included-extra add-ons
      const wrong = stated.filter((p) => p >= 5 && !valid.has(Math.round(p)));
      if (wrong.length) {
        const known = factPack.pricing.itemPrices
          .map((p) => `${p.name}: £${p.min}-${p.max}`)
          .join(", ");
        push(
          "PRICE_HALLUCINATION",
          `Stated £${wrong.join(", £")} not in catalog [${known}]`,
          "flagged",
        );
      }
    }
  }

  // 17. INCLUDED ACCESSORY CHARGED SEPARATELY — FLAG
  const pricedAccessory =
    /(?:(?:SD|memory)\s*card|batter(?:y|ies)|lens\s*cap|body\s*cap|camera\s*strap|charger|USB\s*cable|cleaning\s*cloth|lens\s*hood)\s*(?:is|for|at|=|:)?\s*£\d+|£\d+\s*(?:for|to add|extra)\s*(?:an?\s+)?(?:SD|memory|batter|strap|charger|cable|cap)/i;
  if (pricedAccessory.test(text))
    push(
      "ACCESSORY_CHARGED_SEPARATELY",
      "Charges for an included accessory (cards/batteries/straps are free)",
      "flagged",
    );

  // 18. MODEL NAME CONFUSION — FLAG (factPack-gated)
  // Token-boundary match, NOT substring: "fx30" contains "fx3" and "x100vi"
  // contains "x100v", so a naive includes() never fires (v1 bug). (?<![a-z0-9])
  // … (?![a-z0-9]) ensures a model token isn't matched inside a longer one.
  if (factPack?.verifiedListingItem) {
    const listing = factPack.verifiedListingItem.toLowerCase();
    const present = (hay: string, tok: string) =>
      new RegExp(
        `(?<![a-z0-9])${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`,
        "i",
      ).test(hay);
    const confusions: [string, string][] = [
      ["x100vi", "x100v"],
      ["x100v", "x100vi"],
      ["fx3", "fx30"],
      ["fx30", "fx3"],
      ["a7iv", "a7iii"],
      ["a7iii", "a7iv"],
      ["a7v", "a7iv"],
      ["a7rv", "a7riv"],
      ["rs3 pro", "rs4 pro"],
      ["rs4 pro", "rs3 pro"],
      ["r5c", "r5"],
      ["bmpcc 4k", "bmpcc 6k"],
      ["bmpcc 6k", "bmpcc 4k"],
      ["6k pro", "6k g2"],
      ["6k g2", "6k pro"],
    ];
    for (const [correct, wrong] of confusions)
      if (present(listing, correct) && present(text, wrong) && !present(text, correct)) {
        push("EQUIPMENT_SUBSTITUTION", `Wrong model "${wrong}" — listing is "${correct}"`, "flagged");
        break;
      }
  }

  // 19. PROACTIVE EXTRA-DAY WARNING — FLAG
  if (
    !/\b(evening before|day before|night before|morning after|pick up.*(?:early|before|friday|thursday|wednesday|monday|tuesday)|return.*(?:late|after|next day)|extra day|is there.*extra|an extra charge|extend)\b/i.test(
      message,
    )
  ) {
    if (
      /\b(counts as an extra (?:rental )?day|that(?:'s| is| would be) an extra (?:rental )?day|would add (?:an )?extra (?:rental )?day)\b/i.test(
        text,
      )
    )
      push(
        "PROACTIVE_EXTRA_DAY_WARNING",
        "Warns about an extra-day charge the renter didn't ask about",
        "flagged",
      );
  }

  // 20. VAGUE CONFIRMED LOCATION — FLAG (don't inject a possibly-stale address)
  const postBooking = ["confirmed", "completed", "booked", "ongoing", "upcoming", "active"];
  if (stage && postBooking.includes(stage)) {
    const vague =
      (account === "leo" &&
        /\b(pret|charing cross|pall mall)\b/i.test(text) &&
        !/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/.test(text)) ||
      (account !== "leo" &&
        /\b(pret a manger|national gallery|the gallery|the statue|trafalgar square|by the statue)\b/i.test(
          text,
        ) &&
        !/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/.test(text));
    if (vague)
      push(
        "VAGUE_CONFIRMED_LOCATION",
        "Gives a vague meeting point post-booking — add the full address + postcode",
        "flagged",
      );
  }

  // 21. PREMATURE BOOKING CONFIRMATION — FLAG
  if (stage === "booked") {
    if (
      /\b(?:gone through|it'?s? (?:been |now )?(?:confirmed|accepted|approved|verified|sorted|done|processed|all good|locked in|secured)|booking (?:is |has been )?(?:confirmed|accepted|approved|live|active)|you'?re (?:all )?(?:confirmed|booked|sorted|good to go|locked in|set))\b/i.test(
        text,
      )
    )
      push(
        "PREMATURE_CONFIRMATION",
        "Claims the booking is confirmed but verification is still pending",
        "flagged",
      );
  }

  // 21b. UNFULFILLABLE BOOKING — FLAG (confirms gear we don't own)
  if (opts.unfulfillableItems?.length) {
    const confirms =
      /\b(available|in stock|approved|confirmed|all set|sorted|good to go|booked for you|just (?:needs?|pay)|go ahead and pay|ready for you|locked in)\b/i.test(
        text,
      );
    if (confirms)
      push(
        "UNFULFILLABLE_BOOKING",
        `Confirms/offers an item we don't own (${opts.unfulfillableItems.slice(0, 2).join(", ")}) — should decline or offer a real alternative`,
        "flagged",
      );
  }

  // 22. FALSE ACTION CLAIM — FLAG
  // Future-tense "I'll get it accepted" / "let me approve it" always flags (the
  // chat can't do admin actions). Past-tense "I've approved your request" only
  // flags when the booking ISN'T actually approved yet — otherwise it's true.
  if (
    /\b(?:I'?ll (?:get it|have it) (?:accepted|confirmed|approved|sorted)|let me (?:accept|confirm|approve) (?:it|that|the|your)|I'?m (?:accepting|confirming|approving) (?:it|the|your))\b/i.test(
      text,
    )
  )
    push(
      "FALSE_ACTION_CLAIM",
      "Claims it will perform an admin action (accept/approve/verify) the chat can't do",
      "flagged",
    );
  else if (
    !opts.ownerApproved &&
    /\bI'?ve (?:just |now )?(?:accepted|confirmed|approved) (?:it|the|your)\b/i.test(
      text,
    )
  )
    push(
      "FALSE_ACTION_CLAIM",
      "Claims the booking is already approved, but it isn't approved yet",
      "flagged",
    );

  // 23. GEAR RECEIPT CONFIRMED — FLAG (owner must inspect first)
  if (
    /(all received|got it back|equipment received|gear received|all good on the return|return(ed)? (complete|successful|confirmed)|everything.{0,15}(back|returned|received)|received.{0,10}(back|thanks))/i.test(
      text,
    )
  )
    push("GEAR_RECEIPT_CONFIRMED", "Confirms gear received back — inspect before confirming", "flagged");

  // 24. LOW-VALUE RENTAL ACCEPTED WITHOUT UPSELL — FLAG (factPack-gated)
  if (factPack?.lowValueInstruction) {
    const accepts =
      /\b(available|free for|sorted|confirmed|all set|booked for you|good to go|locked in|reserved for you)\b/i.test(
        text,
      );
    const hasUpsell =
      /\b(also|add|pair|bundle|minimum|booking total|complement|together with|suggest|recommend)\b/i.test(
        text,
      );
    if (accepts && !hasUpsell)
      push("LOW_VALUE_BLOCK", "Accepts a sub-minimum booking without an upsell/minimum note", "flagged");
  }

  // 25. FORMATTING CLEANUP — STRIP
  const before = text;
  text = text
    .replace(/\]\]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(\*{2,}|_{2,}|#{1,})/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s+|\s+$/g, "")
    .replace(/  +/g, " ");
  if (text !== before) push("FORMATTING", "Cleaned formatting artifacts", "stripped");

  // ── CONTRACT (intent-based must/mustNot) ────────────────────────
  const intent = classifyDraftIntent(message);
  const hasPricing = !!factPack?.pricing?.itemPrices?.length;
  const contract = enforceContract(text, intent, hasPricing);
  if (contract.blockPatterns.length) {
    const fixed = surgicalContractFix(text, contract.blockPatterns);
    if (fixed) {
      text = fixed;
      push("CONTRACT", `Removed ${intent} contract violation(s)`, "stripped");
    } else {
      for (const v of contract.violations)
        push(`CONTRACT:${v.label}`, v.detail, "flagged");
    }
  } else {
    for (const v of contract.violations)
      push(`CONTRACT:${v.label}`, v.detail, "flagged");
  }

  // Dedup identical flags (the same issue can match more than one pattern).
  const seen = new Set<string>();
  const deduped = flags.filter((f) => {
    const k = `${f.type}|${f.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // ── Confidence: only UNRESOLVED (flagged) issues count against it ──
  let confidence = 1;
  for (const f of deduped) {
    if (f.action !== "flagged") continue;
    confidence -=
      f.severity === "critical"
        ? 0.4
        : f.severity === "high"
          ? 0.15
          : f.severity === "medium"
            ? 0.07
            : 0.02;
  }
  confidence = Math.max(0.1, Math.min(1, Number(confidence.toFixed(2))));

  return { text, flags: deduped, confidence, modified: text !== draft };
}

// ── Intent classifier (compact port of classify.ts INTENT_PATTERNS) ─

export type DraftIntent =
  | "GREETING"
  | "ACKNOWLEDGMENT"
  | "GOODBYE"
  | "PRICING_INQUIRY"
  | "AVAILABILITY_CHECK"
  | "LOGISTICS"
  | "EQUIPMENT_QUESTION"
  | "NEGOTIATION"
  | "COMPLAINT"
  | "GENERAL";

export function classifyDraftIntent(msg: string): DraftIntent {
  const m = (msg ?? "").toLowerCase().trim();
  if (!m) return "GENERAL";
  const scores: Record<DraftIntent, number> = {
    GREETING: 0,
    ACKNOWLEDGMENT: 0,
    GOODBYE: 0,
    PRICING_INQUIRY: 0,
    AVAILABILITY_CHECK: 0,
    LOGISTICS: 0,
    EQUIPMENT_QUESTION: 0,
    NEGOTIATION: 0,
    COMPLAINT: 0,
    GENERAL: 0,
  };
  const add = (k: DraftIntent, p: RegExp, w = 1) => {
    if (p.test(m)) scores[k] += w;
  };
  add("NEGOTIATION", /\b(discount|cheaper|too (expensive|much|pricey)|best price|deal|lower|knock off|any chance.*(off|less)|reduce|negotiat|haggl)\b/, 3);
  add("COMPLAINT", /\b(broken|faulty|not working|damaged|scratched|disappointed|unhappy|refund|complain|terrible|awful|unacceptable|poor|issue with|problem with)\b/, 3);
  add("PRICING_INQUIRY", /\b(price|cost|how much|per day|daily rate|£|quote|total|charge)\b/, 2);
  add("AVAILABILITY_CHECK", /\b(available|availability|free|in stock|can i (get|rent|book|hire)|do you have|is (it|this|the).*(free|available)|still got)\b/, 2);
  add("LOGISTICS", /\b(pickup|pick up|collect|collection|return|drop ?off|deliver|delivery|address|where|when can i|what time|location|meet)\b/, 2);
  add("EQUIPMENT_QUESTION", /\b(does it|can it|spec|specs|compatible|work with|mount|battery|card|resolution|autofocus|weight|include[ds]?|comes with|what'?s in)\b/, 2);
  add("GREETING", /^(hi|hey|hello|good (morning|afternoon|evening)|yo)\b/, 2);
  add("GOODBYE", /\b(thanks|thank you|cheers|bye|goodbye|see you|appreciate it|no worries|all good)\b/, 1);
  add("ACKNOWLEDGMENT", /^(ok|okay|sure|got it|yes|yep|yeah|cool|great|perfect|sounds good|will do|fine|alright)\b[.! ]*$/, 3);
  let best: DraftIntent = "GENERAL";
  let bestScore = 0;
  for (const k of Object.keys(scores) as DraftIntent[])
    if (scores[k] > bestScore) {
      best = k;
      bestScore = scores[k];
    }
  // Short pure-affirmations are acknowledgments even without a strong score.
  if (bestScore === 0 && m.length <= 15) return "ACKNOWLEDGMENT";
  return best;
}

// ── Contract enforcement (port of contract.ts) ────────────────────

interface PatternRule {
  pattern: RegExp;
  label: string;
}

const UPSELL_PATTERNS: PatternRule[] = [
  { pattern: /\b(also (consider|recommend|suggest|grab|need|want)|pair.*(with|nicely)|complement|upgrade to)\b/i, label: "upsell-language" },
  { pattern: /\bmost (people|filmmakers|shooters|videographers|clients|renters) (also|grab|add|pair|get|use|find|need)\b/i, label: "most-people-upsell" },
  { pattern: /\bhave you (thought|considered) about\b/i, label: "have-you-considered" },
  { pattern: /\bworth (adding|considering|grabbing|getting)\b/i, label: "worth-adding" },
  { pattern: /\byou might (want|need|like|also)\b/i, label: "you-might-want" },
  { pattern: /\bI can (?:suggest|recommend) (?:the right|some|any) gear\b/i, label: "suggest-gear-upsell" },
  { pattern: /\bthat way I can (?:suggest|recommend|help|advise)\b/i, label: "that-way-upsell" },
  { pattern: /\bneed (?:any(?:thing)?|gear|equipment|accessories) (?:else|alongside|to go with|with (?:it|that|the))\b/i, label: "need-anything-else" },
  { pattern: /\bcan (?:recommend|suggest) (?:the best|the right|some|any) (?:gear|equipment|kit|setup)\b/i, label: "recommend-gear" },
];

const QUESTION_PATTERNS: PatternRule[] = [
  ...QUALIFY_PATTERNS.map((p) => ({ pattern: p, label: "qualify-question" })),
  { pattern: SHOOT_QUESTION_PATTERN, label: "shoot-type-question" },
  { pattern: /\bwhat (?:are you|kind of|type of) (?:shoot|shooting|filming|working on|project|production)\b/i, label: "project-question" },
  { pattern: /\bwhat dates?\b/i, label: "dates-question" },
];

interface Contract {
  maxLength?: number;
  must?: PatternRule[];
  mustNot?: PatternRule[];
}

const CONTRACTS: Partial<Record<DraftIntent, Contract>> = {
  GOODBYE: { maxLength: 150, mustNot: [...UPSELL_PATTERNS, ...QUESTION_PATTERNS] },
  ACKNOWLEDGMENT: { maxLength: 200, mustNot: [...UPSELL_PATTERNS] },
  GREETING: { maxLength: 350, mustNot: [{ pattern: /£\d+[\s\S]*£\d+[\s\S]*£\d+/, label: "price-dump-on-greeting" }] },
  LOGISTICS: { maxLength: 300, mustNot: [...UPSELL_PATTERNS, ...QUESTION_PATTERNS] },
  PRICING_INQUIRY: { must: [{ pattern: /£\d+/, label: "price-figure" }], mustNot: [] },
  COMPLAINT: { mustNot: [...UPSELL_PATTERNS] },
  NEGOTIATION: { mustNot: [...UPSELL_PATTERNS.filter((p) => p.label !== "upsell-language"), ...QUESTION_PATTERNS] },
  GENERAL: { mustNot: [...QUESTION_PATTERNS] },
  AVAILABILITY_CHECK: { mustNot: [...UPSELL_PATTERNS, ...QUESTION_PATTERNS] },
  EQUIPMENT_QUESTION: { mustNot: [...QUESTION_PATTERNS] },
};

interface ContractOutcome {
  violations: { label: string; detail: string }[];
  blockPatterns: RegExp[];
}

function enforceContract(
  response: string,
  intent: DraftIntent,
  hasPricing: boolean,
): ContractOutcome {
  const violations: { label: string; detail: string }[] = [];
  const blockPatterns: RegExp[] = [];
  const c = CONTRACTS[intent];
  if (!c) return { violations, blockPatterns };

  if (c.maxLength && response.length > c.maxLength)
    violations.push({
      label: "maxLength",
      detail: `Reply is ${response.length} chars (max ${c.maxLength} for ${intent})`,
    });

  if (c.must)
    for (const { pattern, label } of c.must) {
      if (!pattern.test(response)) {
        if (label === "price-figure" && !hasPricing) continue;
        violations.push({ label, detail: `Missing ${label}` });
      }
    }

  if (c.mustNot)
    for (const { pattern, label } of c.mustNot) {
      const m = response.match(pattern);
      if (m) {
        violations.push({ label, detail: `Has "${label}": "${m[0].slice(0, 40)}"` });
        blockPatterns.push(pattern);
      }
    }

  return { violations, blockPatterns };
}

function surgicalContractFix(response: string, blockPatterns: RegExp[]): string | null {
  if (!blockPatterns.length) return null;
  const sentences = response.split(/(?<=[.!?])\s+/);
  if (sentences.length <= 1) return null;
  const clean = sentences.filter((s) => !blockPatterns.some((p) => p.test(s)));
  if (clean.length === 0 || clean.length === sentences.length) return null;
  const result = clean.join(" ").trim();
  if (result.length < 60) return null;
  return result;
}

// ── Chain-of-thought leak detection (port of filter.ts) ───────────

interface CotResult {
  stripped: boolean;
  cleanText: string;
  details: string[];
}

function detectAndStripChainOfThought(text: string): CotResult {
  const details: string[] = [];
  const lines = text.split("\n");
  const cotPatterns: { pattern: RegExp; weight: number }[] = [
    // NB: conversational openers that collide with normal replies ("Let me
    // check on that", "Hold on", "OK so") are deliberately NOT here — for a short
    // draft they'd nuke a legitimate message. Only high-signal reasoning/leak
    // markers score, and the full-fallback only fires on multi-line dumps.
    { pattern: /^(Wait\.|Actually wait|Actually,? (?:wait|let me))/i, weight: 3 },
    { pattern: /^(Let me (?:think|re-read|re-check|reason|consider|figure|work) )/i, weight: 3 },
    { pattern: /^(I need to (?:think|consider|figure|decline|address))/i, weight: 3 },
    { pattern: /^(So (?:I (?:need|should|can|cannot|must)|this|the|for|given))/i, weight: 2 },
    { pattern: /^(Given (?:it's|that|the|this))/i, weight: 2 },
    { pattern: /\b\d+\s*(?:units?|items?|sets?|pieces?)\s*(?:available|remaining|left|in stock|booked|out)\b/i, weight: 3 },
    // (?<![a-z0-9]): don't let model names like FX3 / A7x match "×3 available".
    { pattern: /(?<![a-z0-9])[×x]\s*\d+\b.*\b(?:available|booked|unavailable|in stock)\b/i, weight: 3 },
    { pattern: /\bALL\s+\d+\s+(?:are|were)\s+(?:booked|rented|out)\b/i, weight: 3 },
    { pattern: /\b(?:booked|rented)\s+(?:out\s+)?(?:to|by)\s+[A-Z][a-z]+\s+[A-Z]/, weight: 3 },
    { pattern: /\b(?:inventory|stock)\s+(?:shows?|says?|indicates?|has|level)/i, weight: 2 },
    { pattern: /\b[A-Z][a-z]+\s+[A-Z][a-z]+\s+(?:from|has|booked|rented|booking|rental)\b/, weight: 2 },
    { pattern: /\b(?:booked|reserved|rented)\s+(?:from\s+)?\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}\b/i, weight: 2 },
    { pattern: /\b(?:the\s+)?owner\s+is\s+(?:unavailable|away|busy|on vacation|not available)/i, weight: 3 },
    { pattern: /\bmanual\s+approval\b/i, weight: 2 },
    { pattern: /\bpending_review\b/i, weight: 3 },
    { pattern: /\bowner(?:'s)?\s+(?:schedule|availability|calendar)\b/i, weight: 2 },
    { pattern: /^\d+\.\s+(?:Tell|Let|Suggest|Decline|Address|Check|The |I (?:need|should|can|must))/i, weight: 2 },
    { pattern: /^(?:But|Also|And)\s+(?:wait|critically|importantly|the|I need)/i, weight: 2 },
    { pattern: /\bwhat (?:lighting|items?|gear|alternatives?) do I have\b/i, weight: 3 },
    { pattern: /\bI (?:cannot|can't) fulfill\b/i, weight: 2 },
    { pattern: /\blet me re-read\b/i, weight: 3 },
    { pattern: /\bI should suggest\b/i, weight: 2 },
  ];
  const lineScores = lines.map((line) => {
    const t = line.trim();
    if (!t) return 0;
    let s = 0;
    for (const { pattern, weight } of cotPatterns) if (pattern.test(t)) s += weight;
    return s;
  });
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const cotCount = lineScores.filter((s) => s >= 2).length;
  const ratio = nonEmpty.length ? cotCount / nonEmpty.length : 0;
  const FALLBACK = "Thanks for your patience — let me get back to you on this shortly.";

  if (ratio > 0.5 && nonEmpty.length >= 3) {
    details.push(`Full reasoning leak: ${cotCount}/${nonEmpty.length} lines were internal reasoning`);
    return { stripped: true, cleanText: FALLBACK, details };
  }

  // Only a genuine multi-line reasoning dump (>=3 non-empty lines) may be
  // replaced wholesale. A 1-2 line draft is a real reply, never a leak.
  const first = lines.findIndex((l) => l.trim().length > 0);
  if (nonEmpty.length >= 3 && first >= 0 && lineScores[first] >= 2) {
    let cotEnd = first;
    let inCot = true;
    let blankRun = 0;
    for (let i = first; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) {
        blankRun++;
        continue;
      }
      if (inCot) {
        if (lineScores[i] >= 2) {
          cotEnd = i;
          blankRun = 0;
        } else if (blankRun >= 1 && lineScores[i] === 0) {
          inCot = false;
        } else {
          cotEnd = i;
          blankRun = 0;
        }
      }
    }
    if (inCot) {
      details.push("Entire reply was internal reasoning");
      return { stripped: true, cleanText: FALLBACK, details };
    }
    const clean = lines.slice(cotEnd + 1).join("\n").replace(/^\n+/, "").trim();
    if (clean.length > 30) {
      details.push(`Stripped leading reasoning block (${cotEnd + 1} lines)`);
      return { stripped: true, cleanText: clean, details };
    }
    details.push("Leading reasoning stripped, remainder too short — using fallback");
    return { stripped: true, cleanText: FALLBACK, details };
  }

  if (cotCount > 0) {
    const clean = lines.filter((_, i) => lineScores[i] < 3).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (clean !== text.trim() && clean.length > 30) {
      details.push(`Stripped ${lines.length - clean.split("\n").length} scattered reasoning line(s)`);
      return { stripped: true, cleanText: clean, details };
    }
  }
  return { stripped: false, cleanText: text, details };
}
