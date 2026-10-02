import { inclusiveRentalDays } from "./hygglo_pricing";
import { renterItemNames } from "./renter_item_names";
import { shortItemName } from "./item_display_name";
import type { StockRequest } from "./stock_claims";

/** Server-returned quotes. A number alone is never a receipt. */
export type PriceEvidence = {
  names: string[]; kind: "rental" | "basket" | "replacement";
  daily_rate_gbp?: number; base_rate_gbp?: number; total_gbp?: number;
  days?: number; quantity?: number; start_date?: string; end_date?: string;
  items?: Array<{name:string;quantity:number}>;
  call_id: string; source: string;
};
const norm = (s: string) => s.toLowerCase().replace(/’/g, "'").replace(/[^a-z0-9]+/g, " ").trim();
const aliases = (names: string[]) => [...new Set(names.flatMap(n => renterItemNames(n).flatMap(a => [norm(a), norm(shortItemName(a)), norm(a.replace(/^Sony\s+(?=(?:FX\d+|A7)\b)/i, ""))])))];
export const samePriceNames = (a: string[], b: string[]) => aliases(a).some(n => aliases(b).includes(n));
const cents = (n: number) => Math.round(n * 100);

/** Checks recognised currency claims against their subject, purpose and scope. */
export function unsupportedPriceClaims(text: string, evidence: PriceEvidence[], request: StockRequest) {
  const failures: string[] = [];
  const known = [...request.items.map(i => ({ names: [i.name, ...(i.aliases ?? [])], quantity: i.quantity })),
    ...evidence.filter(e => e.kind !== "basket").map(e => ({ names: e.names, quantity: undefined }))];
  const names = [...new Set(known.flatMap(k => aliases(k.names)))].filter(Boolean).sort((a,b) => b.length-a.length);
  const same = samePriceNames;
  const duration = inclusiveRentalDays(request.start_date, request.end_date);
  let subject: string[] = request.items.length === 1 ? [request.items[0].name, ...(request.items[0].aliases ?? [])] : [];
  let consumed = 0;
  for (const m of text.matchAll(/£\s*(\d+(?:,\d{3})*(?:\.\d+)?)/g)) {
    const pos = m.index!;
    const before = norm(text.slice(consumed, pos));
    let lastName = "", lastAt = -1;
    for (const n of names) {
      const at = (` ${before} `).lastIndexOf(` ${n} `);
      if (at > lastAt || (at === lastAt && n.length > lastName.length)) { lastAt = at; lastName = n; }
    }
    if (lastAt >= 0) subject = [lastName];
    // Explicit unknown camera identities must not inherit the previous quote.
    const models = [...before.matchAll(/\b(?:pyxis(?:\s+\d+k)?|fx\s*\d+[a-z]*|a7\s*(?:iii|ii|iv|v|\d+)|(?:canon\s+)?(?:r5c?|r6|c70)|(?:blackmagic|bmpcc)\s+[^£.!?]{0,55})\b/g)];
    const unknown = models.at(-1);
    if (unknown && unknown.index! > Math.max(-1, lastAt) && !names.some(n => (` ${n} `).includes(` ${unknown[0].trim()} `))) subject = [norm(unknown[0])];
    const segment = text.slice(consumed,pos).split(/;|\n|(?<=[.!?])\s+/).at(-1) ?? "";
    const explicitSubject = /^\s*(?:(?:the|our|my|your|an?|this|that)\s+)?(.{1,90}?)\s+(?:is|are|costs?|would\s+be|will\s+be)\s*$/i.exec(segment);
    let pairedItems: Array<{names:string[];quantity:number}> | undefined;
    let unresolvedPair = false;
    if (explicitSubject) {
      const named = norm(explicitSubject[1].replace(/\+/g," plus "));
      const generic = /^(?:it|that|this|they|these|those|(?:the\s+)?(?:total|price|rate|daily rate|rental|hire|booking|order|kit|camera|body|set)(?:\s+for\s+(?:(?:the\s+)?\d+\s+days?(?:\s+(?:hire|rental|booking))?|(?:these|those|the requested)\s+dates|this\s+(?:hire|rental|booking)))?)$/i.test(named);
      if (!generic && !names.some(n => (` ${named} `).includes(` ${n} `))) subject=[named];
      if (/\b(?:and|with|plus)\b/.test(named) && !names.includes(named)) {
        pairedItems=[];
        for(const part of named.split(/\b(?:and|with|plus)\b/)) {
          const match=known.find(k=>aliases(k.names).some(n=>(` ${part} `).includes(` ${n} `)));
          if(!match){unresolvedPair=true;continue;}
          const count=/^\s*(\d+|one|two|both|three|four)\s*(?:x\s*)?/.exec(part);
          const qty=count?({one:1,two:2,both:2,three:3,four:4} as Record<string,number>)[count[1]]??Number(count[1]):match.quantity??1;
          const existing=pairedItems.find(i=>same(i.names,match.names));
          if(existing)existing.quantity+=qty;else pairedItems.push({names:match.names,quantity:qty});
        }
      }
    }
    const end = pos + m[0].length;
    const nextMoney = text.slice(end).search(/£/);
    const following = text.slice(end, nextMoney < 0 ? undefined : end + nextMoney);
    const after = following.split(/(?<=[.!?])\s+|\n/)[0];
    // Support ordinary "£40/day for the FX3" ordering, without borrowing a later offer.
    const post = norm(after);
    if (/^\s*(?:\/day|per\s+day|a\s+day)?\s+for\s+(?:the\s+)?/i.test(after)) {
      const named = names.find(n => (` ${post} `).includes(` ${n} `));
      if (named) subject = [named];
    }
    const local = text.slice(Math.max(consumed, text.lastIndexOf("\n", pos)+1), pos) + m[0] + after;
    const daily = /^\s*(?:\/\s*day|per\s+day|a\s+day|daily)\b/i.test(following) || /\b(?:daily\s+(?:rate|price)|per\s+day)\s*(?:is|of|:)\s*$/i.test(text.slice(consumed,pos));
    const base = /\b(?:one[ -]day|1[ -]day|base|usual|normally|standard)\b/i.test(local);
    const purpose = /\b(?:deposit|security\s+hold)\b/i.test(local) ? "deposit"
      : /\b(?:replacement\s+(?:cost|value)|insured\s+value)\b/i.test(local) ? "replacement"
      : /\b(?:delivery|courier|postage)\b/i.test(local) ? "delivery" : "rental";
    const explicitDays = /\b(?:for|across|over|total\s+for)\s+(?:the\s+)?(\d+)[ -]+days?\b/i.exec(local);
    const days = explicitDays ? Number(explicitDays[1]) : duration;
    const requested = request.items.find(i => same(subject, [i.name, ...(i.aliases ?? [])]));
    const count = lastAt >= 0 ? /\b(\d+|one|two|both|three|four)\s*(?:x\s*)?$/.exec(before.slice(0,Math.max(0,lastAt-1)).trim()) : null;
    const declaredQuantity = count ? ({one:1,two:2,both:2,three:3,four:4} as Record<string,number>)[count[1]] ?? Number(count[1]) : undefined;
    const quantity = declaredQuantity ?? requested?.quantity ?? (request.items.length && new Set(request.items.map(i=>i.quantity)).size===1 ? request.items[0].quantity : undefined);
    const dates = local.match(/\b\d{4}-\d{2}-\d{2}\b/g);
    const amount = Number(m[1].replace(/,/g, ""));
    const basket = !!pairedItems || /\b(?:combined|altogether|all\s+(?:of\s+)?(?:them|items)|grand\s+total|whole\s+(?:order|booking)|your\s+total)\b/i.test(local) || (request.items.length > 1 && /\b(?:the|booking|order)\s+total\b/i.test(local));
    const candidates = evidence.filter(e => !unresolvedPair && e.call_id && e.source && (basket ? e.kind === "basket" : e.kind !== "basket" && same(subject,e.names)));
    const proven = candidates.some(e => {
      if (purpose === "deposit" || purpose === "delivery") return false; // No verified fee source is held today.
      if (purpose === "replacement") return e.kind === "replacement" && e.total_gbp != null && cents(e.total_gbp) === cents(amount);
      if (e.kind === "replacement") return false;
      if (e.kind === "basket") {
        const claimed=pairedItems??request.items.map(i=>({names:[i.name,...(i.aliases??[])],quantity:i.quantity}));
        if(!claimed.length || !e.items?.length || e.items.length!==claimed.length || !claimed.every(c=>e.items!.some(i=>same(c.names,[i.name])&&c.quantity===i.quantity)))return false;
      }
      if (dates?.[0] && e.start_date && dates[0] !== e.start_date || dates?.[1] && e.end_date && dates[1] !== e.end_date) return false;
      if (!base && ((request.start_date && e.start_date && e.start_date !== request.start_date) || (request.end_date && e.end_date && e.end_date !== request.end_date))) return false;
      if (daily && base) return e.base_rate_gbp != null && cents(e.base_rate_gbp) === cents(amount);
      if (days != null && e.days !== days) return false;
      if ((declaredQuantity != null || !daily) && quantity != null && e.kind !== "basket" && e.quantity !== quantity) return false;
      const perUnit = /\b(?:each|per\s+(?:unit|camera|item))\b/i.test(local);
      const groupDaily = daily && !perUnit && (declaredQuantity != null || /\b(?:both|all\s+(?:cameras|items))\b/i.test(local));
      const expected = daily ? (e.daily_rate_gbp != null ? e.daily_rate_gbp * (groupDaily ? quantity ?? 1 : 1) : undefined)
        : (perUnit && e.kind === "rental" && e.quantity && e.total_gbp != null ? e.total_gbp/e.quantity : e.total_gbp);
      return expected != null && cents(expected) === cents(amount);
    });
    if (!proven) failures.push(`No matching ${purpose} ${daily ? "daily rate" : "total"} receipt for £${m[1]} (${subject.join(" / ") || "unresolved item"}; duration and quantity must agree)`);
    consumed = end;
  }
  return failures;
}
