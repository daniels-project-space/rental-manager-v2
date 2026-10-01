import { shortItemName } from "./item_display_name";
export type StockReceipt = {
  item: string; start_date: string; end_date: string; quantity: number;
  available: boolean | null; free_units: number | null;
  checked_at: number; call_id: string;
};
export type StockRequest = {
  start_date?: string | null; end_date?: string | null;
  items: Array<{ name: string; quantity: number; aliases?: string[]; complete?: boolean; components?: Array<{ name: string; quantity: number }> }>;
};

// Preserve exact model variants. Never resolve a stock claim by fuzzy similarity.
function identity(name: string) {
  return name.toLowerCase()
    .replace(/\ba7\s*(iii|ii|iv|v)\b/g, (_, n: string) => `a7${({ ii: 2, iii: 3, iv: 4, v: 5 } as Record<string, number>)[n]}`)
    .replace(/^\s*sony\s+(?=(?:fx\d+|a7\d+)\b)/, "")
    .replace(/^\s*(?:blackmagic(?:\s+(?:pocket\s+cinema\s+camera|cinema\s+camera))?|bmpcc)\s+/, "")
    .replace(/\b(?:camera|cameras|body|bodies)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
function sameItem(a: string, b: string) {
  const left = [identity(a), identity(shortItemName(a))].filter(Boolean);
  const right = [identity(b), identity(shortItemName(b))].filter(Boolean);
  return left.some(n => right.includes(n));
}
const units: Record<string, number> = { one: 1, single: 1, two: 2, both: 2, three: 3, four: 4 };
function subjectOf(prefix: string) {
  let s = prefix.trim().replace(/^(?:but|however|whereas|while)\s+/i, "").replace(/^(?:sorry[, ]*|unfortunately[, ]*|yes[, ]*|yeah[, ]*)/i, "");
  s = s.replace(/^(?:the|a|an|my|our|your|this|that)\s+/i, "");
  s = s.replace(/^(?:exact|specific|particular|requested|selected)\s+/i, "");
  const count = /^(\d+|one|single|two|both|three|four)\s*(?:x|×)?\s+/i.exec(s);
  if (count) s = s.slice(count[0].length);
  return { name: s.trim(), quantity: count ? units[count[1].toLowerCase()] ?? Number(count[1]) : undefined };
}

/** A class-wide tool-use boolean never proves stock for another item or span.
 * Unknown subjects remain unverified rather than being guessed from prose. */
export function unsupportedStockClaims(text: string, receipts: StockReceipt[], request: StockRequest) {
  const failures: Array<{ negative: boolean; detail: string }> = [];
  let previousSubjects: StockRequest["items"] = [];
  for (const clause of text.replace(/’/g, "'").split(/(?<=[.!?])\s+|\n+|;\s*|,\s+|\s+(?:but|however|whereas|while)\s+/i)) {
    if (/\b(?:check|verify|confirm|know|unsure|uncertain|not sure)\b[^.!?]{0,70}\b(?:whether|if)\b/i.test(clause)) continue;
    const match = /\b(?:(isn't|aren't|is not|are not|not)\s+(available|in stock|free)|(?:is|are|it's|that's|they're)\s+(available|in stock|free)|(?:unavailable|out of stock|booked out|fully booked|already booked|currently rented|all booked|booked|none (?:left|available)))\b/i.exec(clause);
    if (!match) continue;
    const prefix = clause.slice(0, match.index);
    if (/\b(?:once|when|after|if|until|as soon as)\b[^,;:]{0,100}$/i.test(prefix)) continue;
    // Recording capabilities and handoff slots aren't equipment-stock claims.
    if (/\b(?:4k(?:\s+recording)?|raw(?:\s+recording)?|autofocus|recording\s+mode|discounts?|payments?|verification)\s*$/i.test(prefix) || /\b(?:pickup|collection|delivery)(?:\s+(?:slot|time|window))?\b[^,;.!?]{0,40}$/i.test(prefix)) continue;
    const negative = !!match[1] || /^(?:unavailable|out of stock|booked out|fully booked|already booked|currently rented|all booked|booked|none (?:left|available))$/i.test(match[0]);
    const subject = subjectOf(prefix.replace(/\s+(?:is|are)\s*$/i, ""));
    const namedKit = /\s+(?:kit|set)\s*$/i.test(subject.name);
    if (namedKit) subject.name = subject.name.replace(/\s+(?:kit|set)\s*$/i, "");
    const generic = /^(?:it|it's|that|that's|this|they|they're|these|those|kit|camera|gear)?$/i.test(subject.name);
    let targets = request.items.filter(i => [i.name, ...(i.aliases ?? [])].some(n => sameItem(subject.name, n)));
    if (generic) targets = previousSubjects.length ? previousSubjects : request.items;
    else if (!targets.length) {
      const requestedCounts = [...new Set(request.items.map(i => i.quantity))];
      targets = [{ name: subject.name, quantity: subject.quantity ?? (requestedCounts.length === 1 ? requestedCounts[0] : NaN) }];
    }
    if (!generic) previousSubjects = targets;
    const explicitDates = clause.match(/\b\d{4}-\d{2}-\d{2}\b/g);
    const start = explicitDates?.[0] ?? request.start_date;
    const end = explicitDates?.[1] ?? request.end_date;
    const proven = targets.length > 0 && targets.every(target => {
      if (!negative && target.complete === false) return false;
      const required = target.components?.length && (!negative || generic || namedKit)
        ? target.components : [target];
      const qualifies = (component: { name: string; quantity: number }) => {
        const quantity = subject.quantity === undefined ? component.quantity
          : component.quantity * subject.quantity / target.quantity;
        if (!Number.isInteger(quantity) || quantity <= 0) return false;
        return receipts.some(r => {
          const names = component === target ? [target.name, ...(target.aliases ?? [])] : [component.name];
          if (!r.call_id || !Number.isFinite(r.checked_at) || typeof r.available !== "boolean" ||
            !names.some(n => sameItem(n, r.item)) ||
            (start && r.start_date !== start) || (end && r.end_date !== end)) return false;
          if (r.quantity === quantity) return r.available === !negative;
          // Explicit smaller offers can use capacity from the same stock check.
          return subject.quantity !== undefined && typeof r.free_units === "number" &&
            (negative ? r.free_units < quantity : r.free_units >= quantity);
        });
      };
      // A whole kit needs every physical component; one unavailable component
      // can explain a negative kit verdict without inventing other negatives.
      return negative ? required.some(qualifies) : required.every(qualifies);
    });
    if (!proven) failures.push({ negative, detail: `No matching ${negative ? "negative" : "positive"} stock receipt for "${clause.trim().slice(0, 150)}" (item, dates and quantity must agree)` });
  }
  return failures;
}
