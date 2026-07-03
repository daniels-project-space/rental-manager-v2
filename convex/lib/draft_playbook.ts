/**
 * Draft playbook (2026-07-03) — the knowledge-retrieval layer the live AI draft
 * was missing.
 *
 * v1's bot pulled a RELEVANT slice of its 72-item knowledge base every turn
 * (DANIEL RULES + edge protocols + gear FAQs + templates) plus a delivery
 * framework. v2's `generateDraft` never read the `memories` table — it only saw
 * the 37-row `rules`. This module scores the `memories` corpus against the
 * renter's latest messages + detected intents + stage, and returns the handful
 * of rules / FAQs / templates the draft should follow, so the bot finally has
 * genuine gear + platform + policy understanding.
 *
 * Pure functions only (no Node / no ctx) so it runs inside the getThreadContext
 * V8 query. FACTS (price, kit, availability) still come from the live-listing
 * FactPack — this layer is BEHAVIOUR + POLICY + GEAR-KNOWLEDGE, never a price
 * source.
 */

export interface MemoryRow {
  scope: string; // "operational" | "faq" | "template"
  title?: string;
  content: string;
  tags?: string[];
  priority?: number;
}

export type Intent =
  | "complaint"
  | "damage"
  | "cancellation"
  | "delivery"
  | "sameday"
  | "compat"
  | "availability"
  | "pricing"
  | "negotiation"
  | "pricematch"
  | "location"
  | "extension"
  | "insurance"
  | "thirdparty"
  | "permit"
  | "general";

const RX: Record<Intent, RegExp> = {
  complaint:
    /\b(complain|not happy|unhappy|unacceptable|ruined|waste of|wasted|useless|disappointed|awful|terrible|angry|furious|refund|compensat|poor service|joke)\b/i,
  damage:
    /\b(broke|broken|damaged?|cracked|scratched|dropped|not working|won'?t turn on|stopped working|faulty|dead battery|malfunction|stuck|jammed)\b/i,
  cancellation: /\b(cancel|cancellation|call off|back out|no longer need|changed my mind about the booking)\b/i,
  delivery:
    /\b(deliver|delivery|courier|drop ?off|bring it|ship|send it to|come to me|postcode|post code|[a-z]{1,2}\d{1,2}[a-z]?\s*\d?[a-z]{0,2}\b|to my|transport)\b/i,
  sameday: /\b(today|tonight|right now|asap|same day|this afternoon|in an hour|within the hour)\b/i,
  compat:
    /\b(compatib|work with|fit|mount|adapter|ef lens|canon lens|e-?mount|l-?mount|pl mount|battery|batteries|np-?f|np-?fz|lp-?e6|card|sd|cfexpress|ssd|monitor|record|payload|anamorphic|nd filter|iphone|hdmi|sdi|cage)\b/i,
  availability: /\b(available|availability|free|in stock|booked|do you have|got any|is the .* free|this weekend|next week)\b/i,
  pricing: /\b(price|pricing|cost|how much|rate|quote|per day|daily|weekly|total|charge|£|pound)\b/i,
  negotiation:
    /\b(discount|deal|cheaper|too (?:expensive|much|pricey|steep)|best price|lower|budget|can you do|knock off|reduce|any off|student)\b/i,
  pricematch: /\b(competitor|cheaper elsewhere|somewhere else|match|seen it for|other place|another rental|fat ?llama)\b/i,
  location: /\b(where|located|location|address|pick ?up|collect|meet|far|based|which part of london)\b/i,
  extension: /\b(extend|extension|keep it (?:longer|another)|late return|overrun|running over|return late|extra day|more days)\b/i,
  insurance: /\b(insur|deposit|liable|liability|responsib|what if.*(?:damage|break|lost)|guarantee|cover)\b/i,
  thirdparty: /\b(someone else|my (?:friend|assistant|colleague|mate)|third party|on my behalf|pick(?: it)? up for me)\b/i,
  permit: /\b(permit|permission to film|filming permit|council|license to shoot)\b/i,
  general: /$^/, // never matches; used as a fallback marker
};

export function detectIntents(text: string): Intent[] {
  const out: Intent[] = [];
  for (const k of Object.keys(RX) as Intent[]) {
    if (k === "general") continue;
    if (RX[k].test(text)) out.push(k);
  }
  return out.length ? out : ["general"];
}

// Intent → memory titles that MUST be surfaced when that intent fires (matched
// by substring on the memory title, case-insensitive). Ported from v1's routing.
const INTENT_RULES: Partial<Record<Intent, string[]>> = {
  complaint: ["Angry Renter", "Conflicts", "General Exceptions"],
  damage: ["Item Breaks", "Damage During Rental", "Conflicts"],
  cancellation: ["Cancellation Requests", "Cancellation Policy"],
  delivery: ["Delivery Rules", "DJ + Speaker", "FAQ: Delivery", "Delivery Booking Form"],
  sameday: ["Same Day Rentals", "Same-Day Booking", "Off-Hours Pickup"],
  compat: ["Sets and Minimum Packages", "Availability Logic Detail"],
  availability: ["Availability Confirmation", "Availability Logic Detail", "Unavailable Item Alternatives", "Reservation Hold"],
  pricing: ["Minimum Rental Value", "Memory Cards"],
  negotiation: ["Discounts", "Minimum Rental Value", "Price Match", "First-Time"],
  pricematch: ["Price Match"],
  location: ["Fake Location", "Pickup Process", "Off-Hours Pickup", "Travel Discount"],
  extension: ["Extensions & Late Returns", "Extension Fishing", "Extending Rental"],
  insurance: ["Insurance", "Damage During Rental", "ID Requirements", "Cancellation Policy"],
  thirdparty: ["Shared Rental", "ID Requirements"],
  permit: ["Filming Permits"],
};

const STOP = new Set(
  "the a an is are was do does did will can could would have has had this that with from not but so if just about what how when where who which there here very also please thanks thank you your hi hello hey i me my we our of to in on at for it and or be as it's im i'm need want get got rent rental hire".split(
    /\s+/,
  ),
);

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? []).filter((w) => !STOP.has(w));
}

/** DELIVERY framework ported verbatim-in-spirit from v1 (delivery-specs + delivery_domain). */
export const DELIVERY_FRAMEWORK =
  "DELIVERY (only quote when the renter asks; ask for their postcode first, then quote): " +
  "We deliver within London only, up to ~30km from Central London — beyond that suggest pickup. " +
  "Courier is Addison Lee. Vehicle by gear size/weight: small light kit (a camera/lens/mic) goes by motorcycle; " +
  "medium or several items, or anything heavy/large (big lights, C-stand, power stations) needs a car; a DJ deck AND speakers together, " +
  "or 3+ large items, needs a van. A DJ deck + speakers ALWAYS require delivery (no self-pickup). " +
  "Rough one-way price bands by distance — motorcycle ~£15 (central) up to ~£55 (far); car about 40% more (~£21 to ~£75); van ~£45 up to ~£130. " +
  "Round-trip (delivery + collection) is about 1.8x the one-way price. Add roughly a 10% buffer and say it's an estimate until the courier is booked. " +
  "Never promise exact courier timing (third-party, traffic). Give the estimate directly, don't force a booking request first.";

export interface Playbook {
  rules: string[]; // "TITLE — content" operational rules + edge protocols
  faqs: string[]; // "TITLE — content"
  templates: Array<{ title: string; content: string }>;
  frameworks: string[]; // static framework blocks (e.g. delivery)
  intents: Intent[];
}

/**
 * Select the relevant playbook for this turn. `memories` is the whole corpus
 * (small — ~72 rows). We combine intent-routing (guaranteed includes) with
 * keyword scoring, capped to keep the prompt tight.
 */
export function selectPlaybook(args: {
  memories: MemoryRow[];
  renterText: string; // last few renter messages concatenated
  stage?: string | null;
  account?: string | null;
  itemNames?: string[];
}): Playbook {
  const { memories, renterText, stage, account, itemNames = [] } = args;
  const intents = detectIntents(renterText);
  const kw = new Set([...tokens(renterText), ...itemNames.flatMap(tokens)]);

  // Titles guaranteed by intent routing.
  const forcedTitles = new Set<string>();
  for (const it of intents)
    for (const t of INTENT_RULES[it] ?? []) forcedTitles.add(t.toLowerCase());

  const acct = (account ?? "").toLowerCase();

  function score(m: MemoryRow): number {
    const hay = `${m.title ?? ""} ${(m.tags ?? []).join(" ")} ${m.content}`.toLowerCase();
    let s = 0;
    // Intent-forced title match = strong.
    if (m.title && [...forcedTitles].some((t) => m.title!.toLowerCase().includes(t))) s += 50;
    // Keyword overlap.
    for (const w of kw) if (hay.includes(w)) s += 3;
    // Tag ∩ intents.
    for (const tag of m.tags ?? []) if (intents.includes(tag as Intent)) s += 8;
    s += (m.priority ?? 0) * 0.2;
    return s;
  }

  const scored = memories
    .map((m) => ({ m, s: score(m) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const rules: string[] = [];
  const faqs: string[] = [];
  const templates: Array<{ title: string; content: string }> = [];
  const fmt = (m: MemoryRow) => `${m.title ? m.title + " — " : ""}${m.content}`.replace(/\s+/g, " ").trim();

  for (const { m } of scored) {
    if (m.scope === "template") {
      // Only surface an account-appropriate template (skip the other account's).
      const tags = (m.tags ?? []).map((t) => t.toLowerCase());
      const otherAcct = acct === "leo" ? "dbcinema" : "leo";
      if (tags.includes(otherAcct)) continue;
      if (templates.length < 2) templates.push({ title: m.title ?? "Template", content: m.content });
    } else if (m.scope === "faq") {
      if (faqs.length < 4) faqs.push(fmt(m));
    } else {
      if (rules.length < 7) rules.push(fmt(m));
    }
  }

  const frameworks: string[] = [];
  if (intents.includes("delivery")) frameworks.push(DELIVERY_FRAMEWORK);

  return { rules, faqs, templates, frameworks, intents };
}
