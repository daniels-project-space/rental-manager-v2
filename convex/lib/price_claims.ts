import { bestMatch, isGenericItemQuery } from "./item_name_match";
import { inclusiveRentalDays } from "./hygglo_pricing";
import { claimDateScope } from "./claim_date_scope";
import { renterItemNames } from "./renter_item_names";
import { shortItemName } from "./item_display_name";
import type { StockRequest } from "./stock_claims";
import { lensClaimReferences, declaredLensReferences } from "./lens_claim_references";
import { claimedRentalDays, withoutDurationReference } from "./claim_duration";
import { amendmentMoneyClaims } from "./renter_amendment_money";

/** Server-returned quotes. A number alone is never a receipt. */
export type PriceEvidence = {
  names: string[]; kind: "rental" | "basket" | "replacement";
  quote_role?: "base" | "proposed_line" | "addition" | "inquiry";
  daily_rate_gbp?: number; base_rate_gbp?: number; total_gbp?: number;
  days?: number; quantity?: number; start_date?: string; end_date?: string;
  items?: Array<{name:string;quantity:number}>;
  proposal?: {base_physical_identity_key?:string;base_total_gbp?:number;removed_listings?:Array<{product_id:number;quantity:number}>;removed_items?:Array<{name:string;quantity:number}>;base_items:Array<{name:string;quantity:number}>;added_items:Array<{name:string;quantity:number}>;added_listings?:Array<{product_id:number;quantity:number}>;additional_cost_gbp?:number;physical_identity_key?:string};
  date_proposal?: import("./renter_date_proposal").DateProposalEvidence;
  call_id: string; source: string;
  required_accessory_names?: string[];
};
const norm = (s: string) => s.toLowerCase().replace(/’/g, "'").replace(/\b(pl|ef)\s*(?:to|→)\s*(sony\s+e|l|rf|ef|e)\s*(?:mount\s*)?(?:adapter)?\b/g,(_,from:string,to:string)=>`mountadapter ${from} ${to.replace(/^sony\s+/,"")}`).replace(/\bmount\s+adapter\b/g,"mountadapter").replace(/[^a-z0-9]+/g, " ").trim();
const aliases = (names: string[]) => [...new Set(names.flatMap(n => renterItemNames(n).flatMap(a => [norm(a), norm(shortItemName(a)), norm(a.replace(/^Sony\s+(?=(?:FX\d+|A7)\b)/i, ""))])))];

/** A supported lens price does not price the adapter needed to use it. */
export function incompleteSetupQuotes(text: string, evidence: PriceEvidence[]): string[] {
  const amounts = (part: string) => [...part.matchAll(/£\s*(\d+(?:\.\d{1,2})?)/g)].map(match => Number(match[1]));
  const mentions = (part: string, names: string[]) => aliases(names).some(name => name && ` ${norm(part)} `.includes(` ${name} `));
  const details = new Set<string>();
  const contexts = [...evidence];
  for (const basket of evidence) {
    if (basket.kind !== "basket" || basket.source !== "native_lab_proposal" || !basket.proposal?.added_items) continue;
    const adapterNames = basket.proposal.added_items.map(item => item.name).filter(name => /\bmountadapter\b/.test(norm(name)));
    const primaryNames = basket.proposal.added_items.map(item => item.name).filter(name => !adapterNames.includes(name));
    if (adapterNames.length && primaryNames.length) contexts.push({ ...basket, names: primaryNames, required_accessory_names: adapterNames });
  }
  for (const primary of contexts) {
    if (!primary.required_accessory_names?.length) continue;
    const quoted = text.split(/(?<=[.!?])\s+|\n+/).some(part => mentions(part, primary.names) && amounts(part).length && !/\b(?:unavailable|not available|can't offer|cannot offer)\b/i.test(part));
    if (!quoted) continue;
    for (const accessory of primary.required_accessory_names) {
      const componentPrices = evidence.filter(item => item.kind === "rental" && samePriceNames(item.names, [accessory]));
      const pricedSeparately = text.split(/(?<=[.!?])\s+|\n+|[,;]|\b(?:and|plus|with)\b/i).some(part => mentions(part, [accessory]) && amounts(part).some(amount => componentPrices.some(price => amount === price.daily_rate_gbp || amount === price.total_gbp)));
      const pricedTogether = evidence.some(item => item.kind === "basket" && item.proposal?.added_items && item.total_gbp != null &&
        item.proposal.added_items.some(line => samePriceNames([line.name], primary.names)) &&
        item.proposal.added_items.some(line => samePriceNames([line.name], [accessory])) &&
        amounts(text).includes(item.total_gbp) && /\b(?:total|extra|additional|together|combined|both)\b/i.test(text));
      if (!pricedSeparately && !pricedTogether) details.add(`The quoted setup requires ${accessory}, but its cost is omitted. Quote every required component or the verified complete additional/basket total; the lens-only price is not the usable setup price.`);
    }
  }
  return [...details];
}
export const samePriceNames = (a: string[], b: string[]) => aliases(a).some(n => aliases(b).includes(n));
const cents = (n: number) => Math.round(n * 100);
/** Presentation nouns do not change a fully identified model. Only strip a
 * trailing category caption here, never variant, kit, mount or feature words. */
function priceReference<T extends {names:string[]}>(label:string,known:T[]) {
  const direct=bestMatch(label,known,item=>item.names[0],item=>item.names);
  if(direct.confident)return direct;
  return bestMatch(label.replace(/\s+(?:camera\s+body|body|camera|lens)$/i,""),known,item=>item.names[0],item=>item.names);
}
/** A completed contents parenthesis belongs to the preceding amount. Its
 * internal conjunctions cannot turn the next item's price into a basket. */
function priceClauseAfterAmount(segment:string) {
  const trimmed=segment.trimStart();
  if(!trimmed.startsWith("("))return segment;
  let depth=0;
  for(let index=0;index<trimmed.length;index++) {
    if(trimmed[index]==="£")return segment;
    if(trimmed[index]==="(")depth++;
    else if(trimmed[index]===")" && --depth===0) {
      const rest=trimmed.slice(index+1);
      return /^\s*(?:and|plus)\s+/i.test(rest) ? rest.replace(/^\s*(?:and|plus)\s+/i,"") : segment;
    }
  }
  return segment;
}

/** Checks recognised currency claims against their subject, purpose and scope. */
export function unsupportedPriceClaims(text: string, evidence: PriceEvidence[], request: StockRequest, latestRenterMessage="") {
  const failures: string[] = [];
  const moneyRoles = new Map(amendmentMoneyClaims(text).map(claim => [claim.index, claim.role]));
  const known = [...request.items.map(i => ({ names: [i.name, ...(i.aliases ?? [])], quantity: i.quantity })),
    ...evidence.filter(e => e.kind !== "basket").map(e => ({ names: e.names, quantity: undefined })),
    ...evidence.flatMap(e=>(e.proposal?.added_items??[]).map(i=>({names:[i.name],quantity:undefined})))];
  const same = samePriceNames;
  // Ordinary replies shorten a receipted "Canon EF 16-35mm f2.8" to
  // "16-35mm". Resolve that shorthand only when every matching native name
  // identifies the same item; two brands/mounts with that range remain ambiguous.
  const focalSubjects = new Map([...lensClaimReferences(known, same)].map(([key, entry]) => [key, entry.names]));
  const names = [...new Set([...known.flatMap(k => aliases(k.names)), ...focalSubjects.keys()])].filter(Boolean).sort((a,b) => b.length-a.length);
  const duration = inclusiveRentalDays(request.start_date, request.end_date);
  let subject: string[] = request.items.length === 1 ? [request.items[0].name, ...(request.items[0].aliases ?? [])] : [];
  let subjectQuantity: number | undefined;
  let pendingProposalTotal = false;
  const quotedGroup=(pos:number)=>{
    const rows=text.slice(0,pos).split(/\n/);rows.pop();
    while(rows.length&&!rows.at(-1)!.trim())rows.pop();
    const group:Array<{names:string[];quantity:number}>=[];
    while(rows.length) {
      const bullet=/^\s*[-*•]\s+([^:]+):/.exec(rows.at(-1)!);
      if(!bullet)break;
      rows.pop();
      const count=/^(\d+|one|two|three|four)(?:\s+[x×]?\s*|[x×]\s*)/i.exec(bullet[1]);
      const label=bullet[1].slice(count?.[0].length??0).trim();
      const distinct=known.filter((item,index)=>!known.slice(0,index).some(previous=>same(previous.names,item.names)));
      const match=priceReference(label,distinct);
      const named=match.confident ? match.match : null;
      if(!named)return [];
      group.unshift({names:named.names,quantity:count ? ({one:1,two:2,three:3,four:4} as Record<string,number>)[count[1].toLowerCase()]??Number(count[1]) : 1});
    }
    return group;
  };
  let consumed = 0;
  let pricedComponents: Array<{names:string[];quantity:number}> = [];
  for (const m of text.matchAll(/£\s*(\d+(?:,\d{3})*(?:\.\d+)?)/g)) {
    const pos = m.index!;
    if (/\n\s*\n/.test(text.slice(consumed, pos))) pricedComponents = [];
    // Normalise identities within clauses, retaining boundaries so a camera
    // mention cannot absorb a later pronoun from another sentence.
    const before = text.slice(consumed, pos).split(/;|\n|(?<=[.!?])\s+/).map(norm).join(". ");
    let lastName = "", lastAt = -1, lastEnd = -1;
    for (const n of names) {
      const at = (` ${before} `).lastIndexOf(` ${n} `);
      if (at >= 0 && (at+n.length > lastEnd || (at+n.length === lastEnd && n.length > lastName.length))) { lastAt = at; lastEnd = at+n.length; lastName = n; }
    }
    if (lastAt >= 0) subject = focalSubjects.get(lastName) ?? [lastName];
    // Explicit unknown camera identities must not inherit the previous quote.
    const models = [...before.matchAll(/\b(?:pyxis(?:\s+\d+k)?|fx\s*\d+[a-z]*|a7\s*(?:iii|ii|iv|v|\d+)|(?:canon\s+)?(?:r5c?|r6|c70)|(?:blackmagic|bmpcc)\s+(?!(?:kit|set|booking)\b)[^£.!?]{0,55})\b/g)];
    const unknown = models.at(-1);
    if (unknown && unknown.index! > Math.max(-1, lastAt) && !names.some(n => (` ${n} `).includes(` ${unknown[0].trim()} `))) subject = [norm(unknown[0])];
    // The last qualified lens can occur in an earlier offer sentence. A
    // shared focal range must not erase its explicit brand or mount.
    const declaredLens = declaredLensReferences(before).at(-1);
    if (declaredLens && !focalSubjects.has(declaredLens) && before.lastIndexOf(declaredLens)+declaredLens.length >= lastEnd-1) subject=[declaredLens];
    const rawSegment = text.slice(consumed,pos).split(/;|\n|(?<=[.!?])\s+/).at(-1) ?? "";
    // After the prior currency amount, a rate suffix belongs to that amount:
    // "lens is £50 (£25/day) and the adapter is £20" names only the adapter
    // for £20. Never treat "day" as an unreceipted member of a combined kit.
    const segment = priceClauseAfterAmount(rawSegment.replace(/^\s*(?:(?:\/\s*day|per\s+day|a\s+day)\s*\)?|\))\s*(?:and|plus)\s+/i, ""));
    // A label attached directly to a parenthesized amount owns that amount.
    // Resolve a shortened label only against distinct established identities;
    // unknown model tokens and ambiguous labels must not inherit the prior item.
    if(/\(\s*$/.test(segment) && claimedRentalDays(segment)===null && !/^\s*(?:\/\s*day|per\s+day|a\s+day)\s*\(/i.test(segment)) {
      const label=segment.replace(/\(\s*$/,"").split(/\b(?:the|your|our|my|an?)\s+/i).at(-1)?.trim()??"";
      const distinct=known.filter((item,index)=>!known.slice(0,index).some(previous=>same(previous.names,item.names)));
      const match=priceReference(label,distinct);
      if(label && match.confident && match.match)subject=match.match.names;
      else if(label && !isGenericItemQuery(label))subject=[norm(label)];
    }
    const segmentDates = claimDateScope(segment, request.start_date);
    // An unchanged booking amount belongs to the current order, even when a
    // preceding paragraph discussed another item or the trailing text lists
    // supplied components. It still needs the current order's exact receipt.
    let bookingSubject = /^\s*(?:(?:your|our|my|the|this|current|confirmed)\s+)*(?:booking|order|rental|hire)(?:\s+(?:total|price|cost))?\s+(?:remains|stays|is\s+still)(?:\s+(?:unchanged|the\s+same|set|confirmed|agreed))?(?:\s+(?:at|priced\s+at))?\s*$/i.test(segment);
    const currentBookingReference = /\b(?:current|existing|confirmed)\s+([^£.!?()]{0,70}?)\s+(?:booking|order)\s*\(\s*$/i.exec(segment);
    if (currentBookingReference && request.items.length === 1 && aliases([request.items[0].name, ...(request.items[0].aliases ?? [])]).some(name => ` ${name} `.includes(` ${norm(currentBookingReference[1])} `))) bookingSubject = true;
    // In “the lens pairs with the adapter, which is £10/day”, only the
    // adapter owns the amount. “with” is compatibility, not a joint price.
    const relativePriceSubject = /\b(?:pairs|paired|works|used)\s+with\s+([^£.!?]{1,90}?),?\s+which\s+(is|are|costs?)\s*$/i.exec(segment);
    const priceSubjectSegment = relativePriceSubject ? `${relativePriceSubject[1].replace(/,\s*$/, "")} ${relativePriceSubject[2]}` : segment;
    const explicitSubject = /^\s*(?:(?:the|our|my|your|an?|this|that)\s+)?(.{1,90}?)\s+(?:is|are|(?:(?:would|will)\s+)?costs?|(?:would|will)\s+be)\s*$/i.exec(priceSubjectSegment);
    let pairedItems: Array<{names:string[];quantity:number}> | undefined;
    let unresolvedPair = false;
    // Booking-total labels are a monetary scope, not an equipment identity.
    // Preserve the actual named equipment from the preceding offer sentence.
    const totalReference = explicitSubject && /^(?:(?:your|our|my|the|this|current|existing|new|updated|revised|complete|full)\s+)*(?:(?:booking|basket|order|rental|hire)\s+)?total$/i.test(explicitSubject[1]);
    if (explicitSubject && !totalReference) {
      const named = norm(explicitSubject[1].replace(/\+/g," plus "));
      const exactOffering = known.find(k => aliases(k.names).includes(norm(explicitSubject[1])));
      if (exactOffering) subject = exactOffering.names;
      // A duration-first adverb scopes the amount, not its item identity.
      // Duration validation below still reads the original text.
      const scopedNamed=named.replace(/^for\s+(?:the\s+)?\d+\s+days?\s+(?:the\s+)?/i, "");
      const datedSubject = segmentDates.matched_text ? scopedNamed.replace(norm(segmentDates.matched_text), "dates") : scopedNamed;
      bookingSubject ||= /^(?:booking|order|rental|hire)\s+(?:remains(?:\s+set)?|stays(?:\s+set)?|is\s+still\s+set)\s+(?:for|on|from)\s+dates(?:\s+as\s+(?:confirmed|agreed))?(?:\s+which)?$/i.test(datedSubject);
      const genericNamed = withoutDurationReference(named, segmentDates.matched_text ? norm(segmentDates.matched_text) : undefined)
        .replace(/^(?:new|updated|revised)\s+(?=(?:total|price|rate|daily rate)\b)/i, "")
        .replace(/^adding\s+(?=(?:it|this|that|them|these|those)\b)/i, "");
      const generic = /^(?:it|that|this|they|these|those|(?:the\s+)?(?:total|price|rate|daily rate|rental|hire|booking|order|kit|camera|body|set)(?:\s+for\s+(?:(?:the\s+)?\d+\s+days?(?:\s+(?:hire|rental|booking))?|(?:these|those|the requested)\s+dates|this\s+(?:hire|rental|booking)))?)$/i.test(genericNamed);
      const unsupportedQualifiedLens = !exactOffering && declaredLensReferences(genericNamed).find(reference=>!focalSubjects.has(reference));
      const referenceLabel=withoutDurationReference(explicitSubject[1],segmentDates.matched_text)
        .replace(/^(?:(?:one|two|three|four|\d+)\s+)?(?:extra|additional)\s+/i,"");
      const namedLensStarts=declaredLensReferences(norm(referenceLabel)).some(reference=>norm(referenceLabel).startsWith(reference)) ||
        /^\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\s*mm\b/i.test(referenceLabel) ||
        names.some(name=>norm(referenceLabel).startsWith(`${name} `));
      if (unsupportedQualifiedLens) { subject=[unsupportedQualifiedLens]; unresolvedPair=true; }
      else if(!exactOffering && namedLensStarts && /\b\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\s*mm\b/i.test(explicitSubject[1]) &&
        !/\b(?:and|with|plus)\b/i.test(explicitSubject[1])) {
        const label=referenceLabel;
        const lensKnown=known.filter(item=>[...focalSubjects.values()].some(names=>same(names,item.names)));
        const distinct=lensKnown.filter((item,index)=>!lensKnown.slice(0,index).some(previous=>same(previous.names,item.names)));
        const reference=priceReference(label,distinct);
        subject=reference.confident && reference.match ? reference.match.names : [norm(label)];
        unresolvedPair=!reference.confident;
      }
      else if (!generic && !bookingSubject && !exactOffering && !names.some(n => (` ${named} `).includes(` ${n} `))) subject=[named];
      if (/\b(?:and|with|plus)\b/.test(named) && !exactOffering && !names.includes(named)) {
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
    if (bookingSubject && request.items.length === 1) {
      subject = [request.items[0].name, ...(request.items[0].aliases ?? [])];
      subjectQuantity = request.items[0].quantity;
    }
    const end = pos + m[0].length;
    const nextMoney = text.slice(end).search(/£/);
    const following = text.slice(end, nextMoney < 0 ? undefined : end + nextMoney);
    const after = following.split(/(?<=[.!?])\s+|\n/)[0];
    // Support ordinary "£40/day for the FX3" ordering, without borrowing a later offer.
    const postReference = /^\s*(?:\/day|per\s+day|a\s+day)?\s+for\s+(?:the\s+)?([^,;()]+)/i.exec(after)?.[1];
    if (!bookingSubject && postReference && !/^(?:\d+[ -]+days?|(?:these|those|the requested)\s+dates)\b/i.test(postReference)) {
      const post = norm(postReference.split(/\s+(?:with|and|plus)\s+/i)[0]);
      const named = names.find(n => (` ${post} `).includes(` ${n} `));
      if (named) subject = [named];
    }
    const local = text.slice(Math.max(consumed, text.lastIndexOf("\n", pos)+1), pos) + m[0] + after;
    const daily = /^\s*(?:\/\s*day|per\s+day|a\s+day|daily)\b/i.test(following) || /\b(?:daily\s+(?:rate|price)|per\s+day)\s*(?:is|of|:)\s*$/i.test(text.slice(consumed,pos));
    const base = /\b(?:one[ -]day|1[ -]day|base|usual|normally|standard)\b/i.test(local);
    const purpose = /\b(?:discount|refund)\b/i.test(local) ? "adjustment"
      : /\b(?:deposit|security\s+hold)\b/i.test(local) ? "deposit"
      : /\b(?:replacement\s+(?:cost|value)|insured\s+value)\b/i.test(local) ? "replacement"
      : /\b(?:delivery|courier|postage)\b/i.test(local) ? "delivery" : "rental";
    const dateScope = claimDateScope(segment + m[0] + after, request.start_date);
    const explicitDays = claimedRentalDays(local);
    const scopedDuration = dateScope.explicit && dateScope.valid ? inclusiveRentalDays(dateScope.start_date, dateScope.end_date) : null;
    const days = explicitDays !== null ? explicitDays : scopedDuration ?? duration;
    const requested = request.items.find(i => same(subject, [i.name, ...(i.aliases ?? [])]));
    const count = lastAt >= 0 ? /\b(\d+|one|two|both|three|four)\s*(?:(?:extra|additional)\s*)?(?:x\s*)?$/.exec(before.slice(0,Math.max(0,lastAt-1)).trim()) : null;
    const declaredQuantity = count ? ({one:1,two:2,both:2,three:3,four:4} as Record<string,number>)[count[1]] ?? Number(count[1]) : undefined;
    if (lastAt >= 0) subjectQuantity = declaredQuantity ?? requested?.quantity ?? 1;
    const quantity = declaredQuantity ?? requested?.quantity ?? (request.items.length && new Set(request.items.map(i=>i.quantity)).size===1 ? request.items[0].quantity : undefined);
    const amount = Number(m[1].replace(/,/g, ""));
    // This is the renter's spending limit, not a rental price. Ground the
    // exact number to their current message; a budget word cannot hide a quote.
    const budgetReference=/\b(?:within|inside|under|below)\s+(?:your|the stated)\s*$/i.test(segment) && /^\s*budget\b(?!\s+(?:price|rate|option|kit))/i.test(following);
    const renterBudget=[...latestRenterMessage.matchAll(/\bbudget\s*(?:(?:is|of|:|=)\s*)?£\s*(\d+(?:,\d{3})*(?:\.\d+)?)/gi)]
      .some(b=>cents(Number(b[1].replace(/,/g,"")))===cents(amount));
    if(budgetReference && renterBudget){consumed=end;continue;}
    const moneyRole = moneyRoles.get(pos);
    // A saving is never the price of an item. It needs a complete Native
    // change quote, even when a coincidental line price equals the difference.
    const replacementAdjustment = moneyRole === "reduction" || moneyRole === "increase" &&
      evidence.some(e => e.kind === "basket" && !!e.proposal?.removed_items?.length);
    const explicitBookingTotal = /\b(?:(?:your|our|my)\s+(?:(?:new|updated|revised|complete|full)\s+)?(?:(?:booking|order|rental|hire)\s+)?(?:(?:new|updated|revised)\s+)?total|(?:this|current|the)\s+(?:(?:new|updated|revised|complete|full)\s+)?(?:booking|order|rental|hire)\s+(?:(?:new|updated|revised)\s+)?total)\b/i.test(segment);
    const conditionalTotal = /\b(?:would|could)\s+(?:bring|take|make|increase|raise)\b[^£.!?]{0,90}\btotal\b/i.test(segment);
    // A prior amount ends the local currency segment, but does not end its
    // conditional sentence: "Adding both would be £70, bringing your total
    // to £194" still describes a proposal. Never carry this across sentences.
    const sentenceBeforeAmount=text.slice(0,pos).split(/;|\n|(?<=[.!?])\s+/).at(-1) ?? "";
    const continuedConditionalTotal=explicitBookingTotal &&
      /^\s*(?:(?:extra|additional|more|less|off)\s*)?[,–—-]?\s*(?:which\s+)?(?:bringing|taking|making|increasing|raising)\b/i.test(segment) &&
      /\b(?:would|could)\b/i.test(sentenceBeforeAmount) && /£/.test(sentenceBeforeAmount);
    const baselineTotal = conditionalTotal && /\bfrom\s*$/i.test(segment);
    const proposalTotal = explicitBookingTotal && !baselineTotal && /\b(?:would|could)\b/i.test(segment) || conditionalTotal && !baselineTotal || continuedConditionalTotal || pendingProposalTotal && /^\s*(?:up\s+)?to\s*$/i.test(segment);
    pendingProposalTotal = baselineTotal;
    const componentAddition = pricedComponents.length > 1 && /^\s*(?:\/\s*day|per\s+day|a\s+day)?\s*\)?\s*[,–—-]?\s*(?:which\s+)?(?:bringing|taking|making)\s+(?:the\s+)?(?:addition|additions|additional cost)\s+(?:to|of)\s*$/i.test(segment);
    const group=componentAddition || proposalTotal && pricedComponents.length > 1 ? pricedComponents : quotedGroup(pos);
    // A single sentence can price a camera in parentheses and then name its
    // lens before the combined total. Resolve only explicit Native identities.
    const inlineGroup:Array<{names:string[];quantity:number}>=[];
    if(/\b(?:paired with|and|plus|with)\b/i.test(sentenceBeforeAmount) &&
      !declaredLensReferences(norm(sentenceBeforeAmount)).some(reference=>!focalSubjects.has(reference))) {
      const inline=` ${norm(sentenceBeforeAmount)} `;
      for(const item of known) if(aliases(item.names).some(name=>inline.includes(` ${name} `)) ||
        [...focalSubjects].some(([reference,native])=>inline.includes(` ${reference} `)&&same(native,item.names))) {
        if(!inlineGroup.some(previous=>same(previous.names,item.names))) {
          const nativeAlias=aliases(item.names).find(name=>inline.includes(` ${name} `));
          const count=nativeAlias ? /\b(\d+|one|two|three|four)\s*(?:x\s*)?$/.exec(inline.slice(0,inline.lastIndexOf(` ${nativeAlias} `)).trim()) : null;
          inlineGroup.push({names:item.names,quantity:count ? ({one:1,two:2,three:3,four:4} as Record<string,number>)[count[1]]??Number(count[1]):1});
        }
      }
    }
    const groupAddition=componentAddition || !baselineTotal && !proposalTotal && group.length>1 && /\b(?:add|adding)\b[^£.!?]{0,80}\b(?:both|them|these|those|all)\b/i.test(segment);
    const inlineBasket=inlineGroup.length>1 && /^\s*total\b/i.test(following);
    const basket = inlineBasket || replacementAdjustment || groupAddition || proposalTotal || explicitBookingTotal || !!pairedItems || bookingSubject && request.items.length > 1 || /\b(?:combined|altogether|all\s+(?:of\s+)?(?:them|items)|grand\s+total|whole\s+(?:order|booking))\b/i.test(local) || (request.items.length > 1 && /\b(?:the|booking|order)\s+(?:(?:new|updated|revised)\s+)?total\b/i.test(segment));
    const currentBookedPrice = /\b(?:current|existing|confirmed|booked|already|remains|stays)\b/i.test(segment) &&
      !/\b(?:would|could|add|adding)\b/i.test(segment);
    const additionPrice = !bookingSubject && !currentBookedPrice && /\b(?:extra|additional|another|second|third|fourth|2nd|3rd|4th)\b/i.test(segment);
    const dateAdjustment = /\b(?:extend|extending|extension|date change|shorten|shortening)\b/i.test(segment) && /\b(?:extra|additional|less|reduction)\b/i.test(segment+text.slice(pos+m[0].length,pos+m[0].length+24));
    const candidates = evidence.filter(e => (!additionPrice || basket ||
      e.source !== "lab_order_quote" && e.quote_role !== "base" && e.quote_role !== "proposed_line") && !unresolvedPair && e.call_id && e.source && (dateAdjustment ? e.kind === "basket" && !!e.date_proposal : basket ? e.kind === "basket" && (!proposalTotal || !!e.proposal || !!e.date_proposal) && (groupAddition ? e.quote_role==="addition" : e.quote_role!=="addition") : e.kind !== "basket" && same(subject,e.names)));
    const proven = candidates.some(e => {
      if(dateAdjustment){
        const p=e.date_proposal;
        if(purpose!=="rental")return false;
        if(declaredQuantity!=null && !request.items.every(i=>i.quantity===declaredQuantity))return false;
        if(!p || e.total_gbp==null || daily || !dateScope.valid || !e.items || e.items.length!==request.items.length)return false;
        if(!request.items.every(i=>e.items!.some(q=>same([i.name,...(i.aliases??[])],[q.name])&&q.quantity===i.quantity)))return false;
        if(request.start_date && request.start_date!==p.from_start_date && request.start_date!==e.start_date || request.end_date && request.end_date!==p.from_end_date && request.end_date!==e.end_date)return false;
        if(dateScope.start_date && dateScope.start_date!==e.start_date || dateScope.end_date && dateScope.end_date!==e.end_date || explicitDays!==null && explicitDays!==e.days)return false;
        const reduction=/\b(?:less|reduction)\b/i.test(segment+text.slice(pos+m[0].length,pos+m[0].length+24));
        const delta=reduction?p.base_total_gbp-e.total_gbp:e.total_gbp-p.base_total_gbp;
        return delta>=0&&cents(delta)===cents(amount);
      }
      if (Number.isNaN(days) || !dateScope.valid || explicitDays !== null && scopedDuration != null && days !== scopedDuration) return false;
      if (purpose === "deposit" || purpose === "delivery" || purpose === "adjustment") return false; // No verified fee/discount/refund source is held today.
      if (purpose === "replacement") return e.kind === "replacement" && e.total_gbp != null && cents(e.total_gbp) === cents(amount);
      if (e.kind === "replacement") return false;
      if (e.kind === "basket") {
        const requestedItems=request.items.map(i=>({names:[i.name,...(i.aliases??[])],quantity:i.quantity}));
        const membersMatch=(a:Array<{names:string[];quantity:number}>,b:Array<{name:string;quantity:number}>)=>{
          const remaining=[...b];
          return a.length===b.length && a.every(c=>{const index=remaining.findIndex(i=>same(c.names,[i.name])&&c.quantity===i.quantity);if(index<0)return false;remaining.splice(index,1);return true;});
        };
        if (e.proposal) {
          if(e.proposal.removed_items?.length) {
            const proposed=e.proposal.base_items.map(i=>({names:[i.name],quantity:i.quantity}));
            for(const removed of e.proposal.removed_items) {
              const index=proposed.findIndex(i=>same(i.names,[removed.name]));
              if(index<0 || !Number.isInteger(removed.quantity) || removed.quantity<1 || removed.quantity>proposed[index].quantity)return false;
              proposed[index].quantity-=removed.quantity;
              if(!proposed[index].quantity)proposed.splice(index,1);
            }
            for(const added of e.proposal.added_items) {
              const existing=proposed.find(i=>same(i.names,[added.name]));
              if(existing)existing.quantity+=added.quantity;else proposed.push({names:[added.name],quantity:added.quantity});
            }
            if(!e.items || !membersMatch(proposed,e.items))return false;
          }
          // A proposal never certifies an already-applied total or an unrelated basket.
          const currentScopeMatches=membersMatch(requestedItems,e.proposal.base_items) ||
            replacementAdjustment && !!e.items && membersMatch(requestedItems,e.items);
          if ((!replacementAdjustment && !proposalTotal && !componentAddition && !/\b(?:would|could)\b/i.test(segment)) || !currentScopeMatches) return false;
          if(e.proposal.added_items.length>1) {
            if(!membersMatch(pairedItems??group,e.proposal.added_items) || !proposalTotal && !e.proposal.added_items.some(i=>same(subject,[i.name])))return false;
          } else {
            const added=e.proposal.added_items[0];
            if(!added)return false;
            const directlyNamed=same(subject,[added.name]) && (declaredQuantity??subjectQuantity??1)===added.quantity;
            const previouslyQuoted=pricedComponents.some(c=>same(c.names,[added.name]) && c.quantity===added.quantity);
            if(e.proposal.removed_items?.length && (proposalTotal || replacementAdjustment) ? !directlyNamed && !previouslyQuoted : !directlyNamed)return false;
          }
        }
        // A new inquiry quote proves its explicitly named alternative basket,
        // never the current booking, a confirmed amendment or an implied set.
        if(e.quote_role==="inquiry" && (bookingSubject || explicitBookingTotal || proposalTotal || replacementAdjustment || groupAddition))return false;
        const claimed=pairedItems??(e.quote_role==="inquiry" ? inlineBasket ? inlineGroup : group : groupAddition ? group : e.proposal ? e.items?.map(i=>({names:[i.name],quantity:i.quantity}))??[] : requestedItems);
        if(!claimed.length || !e.items?.length || e.items.length!==claimed.length || !claimed.every(c=>e.items!.some(i=>same(c.names,[i.name])&&c.quantity===i.quantity)))return false;
      }
      // An extension's full total may follow its marginal price within the
      // same conditional sentence. Carry that sentence's explicit period,
      // never a date from an unrelated earlier sentence or quote.
      const effectiveScope=e.date_proposal && continuedConditionalTotal ? claimDateScope(sentenceBeforeAmount,request.start_date) : dateScope;
      if(!effectiveScope.valid)return false;
      const start = effectiveScope.start_date ?? (explicitDays !== null ? undefined : request.start_date);
      const end = effectiveScope.end_date ?? (explicitDays !== null ? undefined : request.end_date);
      if (!base && ((start && e.start_date && e.start_date !== start) || (end && e.end_date && e.end_date !== end))) return false;
      if (daily && base) return e.base_rate_gbp != null && cents(e.base_rate_gbp) === cents(amount);
      const effectiveDays=effectiveScope.explicit ? inclusiveRentalDays(effectiveScope.start_date,effectiveScope.end_date) : days;
      if(explicitDays!==null && effectiveDays!=null && explicitDays!==effectiveDays)return false;
      if (effectiveDays != null && e.days !== effectiveDays) return false;
      if ((declaredQuantity != null || !daily) && quantity != null && e.kind !== "basket" && e.quantity !== quantity) return false;
      if (replacementAdjustment) {
        if (daily || purpose !== "rental" || !e.proposal?.removed_items?.length ||
          !Number.isFinite(e.proposal.base_total_gbp) || !Number.isFinite(e.total_gbp)) return false;
        const delta = moneyRole === "reduction" ? e.proposal.base_total_gbp! - e.total_gbp! : e.total_gbp! - e.proposal.base_total_gbp!;
        return delta >= 0 && cents(delta) === cents(amount);
      }
      const perUnit = /\b(?:each|per\s+(?:unit|camera|item))\b/i.test(local);
      const groupDaily = daily && !perUnit && (declaredQuantity != null || /\b(?:both|all\s+(?:cameras|items))\b/i.test(local));
      const expected = daily ? (e.daily_rate_gbp != null ? e.daily_rate_gbp * (groupDaily ? quantity ?? 1 : 1) : undefined)
        : (perUnit && e.kind === "rental" && e.quantity && e.total_gbp != null ? e.total_gbp/e.quantity : e.total_gbp);
      return expected != null && cents(expected) === cents(amount);
    });
    if (proven && !bookingSubject && !basket && !daily && purpose === "rental") {
      const component = { names: [...subject], quantity: declaredQuantity ?? subjectQuantity ?? quantity ?? 1 };
      if (!pricedComponents.some(item => same(item.names, component.names))) pricedComponents.push(component);
    }
    if (!proven) failures.push(`No matching ${purpose} ${daily ? "daily rate" : "total"} receipt for £${m[1]} (${subject.join(" / ") || "unresolved item"}; duration and quantity must agree)`);
    consumed = end;
  }
  return failures;
}
