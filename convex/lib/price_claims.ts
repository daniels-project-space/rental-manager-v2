import { inclusiveRentalDays } from "./hygglo_pricing";
import { claimDateScope } from "./claim_date_scope";
import { renterItemNames } from "./renter_item_names";
import { shortItemName } from "./item_display_name";
import type { StockRequest } from "./stock_claims";
import { lensClaimReferences, declaredLensReferences } from "./lens_claim_references";
import { claimedRentalDays, withoutDurationReference } from "./claim_duration";

/** Server-returned quotes. A number alone is never a receipt. */
export type PriceEvidence = {
  names: string[]; kind: "rental" | "basket" | "replacement";
  quote_role?: "base" | "proposed_line" | "addition";
  daily_rate_gbp?: number; base_rate_gbp?: number; total_gbp?: number;
  days?: number; quantity?: number; start_date?: string; end_date?: string;
  items?: Array<{name:string;quantity:number}>;
  proposal?: {base_items:Array<{name:string;quantity:number}>;added_items:Array<{name:string;quantity:number}>;added_listings?:Array<{product_id:number;quantity:number}>;additional_cost_gbp?:number};
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

/** Checks recognised currency claims against their subject, purpose and scope. */
export function unsupportedPriceClaims(text: string, evidence: PriceEvidence[], request: StockRequest) {
  const failures: string[] = [];
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
      const named=known.find(i=>same([label],i.names));
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
    const rawSegment = text.slice(consumed,pos).split(/;|\n|(?<=[.!?])\s+/).at(-1) ?? "";
    // After the prior currency amount, a rate suffix belongs to that amount:
    // "lens is £50 (£25/day) and the adapter is £20" names only the adapter
    // for £20. Never treat "day" as an unreceipted member of a combined kit.
    const segment = rawSegment.replace(/^\s*(?:(?:\/\s*day|per\s+day|a\s+day)\s*\)?|\))\s*(?:and|plus)\s+/i, "");
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
    const explicitSubject = /^\s*(?:(?:the|our|my|your|an?|this|that)\s+)?(.{1,90}?)\s+(?:is|are|costs?|would\s+be|will\s+be)\s*$/i.exec(priceSubjectSegment);
    let pairedItems: Array<{names:string[];quantity:number}> | undefined;
    let unresolvedPair = false;
    if (explicitSubject) {
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
      if (unsupportedQualifiedLens) { subject=[unsupportedQualifiedLens]; unresolvedPair=true; }
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
    const purpose = /\b(?:deposit|security\s+hold)\b/i.test(local) ? "deposit"
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
    const explicitBookingTotal = /\b(?:(?:your|our|my)\s+(?:(?:new|updated|revised|complete|full)\s+)?(?:(?:booking|order|rental|hire)\s+)?(?:(?:new|updated|revised)\s+)?total|(?:this|current|the)\s+(?:(?:new|updated|revised|complete|full)\s+)?(?:booking|order|rental|hire)\s+(?:(?:new|updated|revised)\s+)?total)\b/i.test(segment);
    const conditionalTotal = /\b(?:would|could)\s+(?:bring|take|make|increase|raise)\b[^£.!?]{0,90}\btotal\b/i.test(segment);
    // A prior amount ends the local currency segment, but does not end its
    // conditional sentence: "Adding both would be £70, bringing your total
    // to £194" still describes a proposal. Never carry this across sentences.
    const sentenceBeforeAmount=text.slice(0,pos).split(/;|\n|(?<=[.!?])\s+/).at(-1) ?? "";
    const continuedConditionalTotal=explicitBookingTotal &&
      /^\s*[,–—-]?\s*(?:which\s+)?(?:bringing|taking|making|increasing|raising)\b/i.test(segment) &&
      /\b(?:would|could)\b/i.test(sentenceBeforeAmount) && /£/.test(sentenceBeforeAmount);
    const baselineTotal = conditionalTotal && /\bfrom\s*$/i.test(segment);
    const proposalTotal = conditionalTotal && !baselineTotal || continuedConditionalTotal || pendingProposalTotal && /^\s*(?:up\s+)?to\s*$/i.test(segment);
    pendingProposalTotal = baselineTotal;
    const componentAddition = pricedComponents.length > 1 && /^\s*(?:\/\s*day|per\s+day|a\s+day)?\s*\)?\s*[,–—-]?\s*(?:which\s+)?(?:bringing|taking|making)\s+(?:the\s+)?(?:addition|additions|additional cost)\s+(?:to|of)\s*$/i.test(segment);
    const group=componentAddition || proposalTotal && pricedComponents.length > 1 ? pricedComponents : quotedGroup(pos);
    const groupAddition=componentAddition || !baselineTotal && !proposalTotal && group.length>1 && /\b(?:add|adding)\b[^£.!?]{0,80}\b(?:both|them|these|those|all)\b/i.test(segment);
    const basket = groupAddition || proposalTotal || explicitBookingTotal || !!pairedItems || bookingSubject && request.items.length > 1 || /\b(?:combined|altogether|all\s+(?:of\s+)?(?:them|items)|grand\s+total|whole\s+(?:order|booking))\b/i.test(local) || (request.items.length > 1 && /\b(?:the|booking|order)\s+(?:(?:new|updated|revised)\s+)?total\b/i.test(segment));
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
      if (purpose === "deposit" || purpose === "delivery") return false; // No verified fee source is held today.
      if (purpose === "replacement") return e.kind === "replacement" && e.total_gbp != null && cents(e.total_gbp) === cents(amount);
      if (e.kind === "replacement") return false;
      if (e.kind === "basket") {
        const requestedItems=request.items.map(i=>({names:[i.name,...(i.aliases??[])],quantity:i.quantity}));
        const membersMatch=(a:Array<{names:string[];quantity:number}>,b:Array<{name:string;quantity:number}>)=>{
          const remaining=[...b];
          return a.length===b.length && a.every(c=>{const index=remaining.findIndex(i=>same(c.names,[i.name])&&c.quantity===i.quantity);if(index<0)return false;remaining.splice(index,1);return true;});
        };
        if (e.proposal) {
          // A proposal never certifies an already-applied total or an unrelated basket.
          if ((!proposalTotal && !componentAddition && !/\b(?:would|could)\b/i.test(segment)) || !membersMatch(requestedItems,e.proposal.base_items)) return false;
          if(e.proposal.added_items.length>1) {
            if(!membersMatch(pairedItems??group,e.proposal.added_items) || !proposalTotal && !e.proposal.added_items.some(i=>same(subject,[i.name])))return false;
          } else if (!same(subject,[e.proposal.added_items[0].name]) ||
              (declaredQuantity??subjectQuantity??1)!==e.proposal.added_items[0].quantity) return false;
        }
        const claimed=pairedItems??(groupAddition ? group : e.proposal ? e.items?.map(i=>({names:[i.name],quantity:i.quantity}))??[] : requestedItems);
        if(!claimed.length || !e.items?.length || e.items.length!==claimed.length || !claimed.every(c=>e.items!.some(i=>same(c.names,[i.name])&&c.quantity===i.quantity)))return false;
      }
      const start = dateScope.start_date ?? (explicitDays !== null ? undefined : request.start_date);
      const end = dateScope.end_date ?? (explicitDays !== null ? undefined : request.end_date);
      if (!base && ((start && e.start_date && e.start_date !== start) || (end && e.end_date && e.end_date !== end))) return false;
      if (daily && base) return e.base_rate_gbp != null && cents(e.base_rate_gbp) === cents(amount);
      if (days != null && e.days !== days) return false;
      if ((declaredQuantity != null || !daily) && quantity != null && e.kind !== "basket" && e.quantity !== quantity) return false;
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
