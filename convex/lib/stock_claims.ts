import { normalizeApertureNotation, bestMatch } from "./item_name_match";
import { shortItemName } from "./item_display_name";
import { catalogueReadinessSubject } from "./catalogue_readiness";
import { claimDateScope } from "./claim_date_scope";
import { declaredLensReferences, lensClaimReferences } from "./lens_claim_references";
import { itemReferenceLabel, itemQuoteRow, itemQuoteTotalLine, itemQuoteGroups, itemQuoteDateScope } from "./renter_claim_structure";
import { requestedLensSets, resolveLensSet, lensSetSubjectFamily, lensSetFocalPattern, lensSetSuffixPattern } from "./lens_set_resolution";
export type StockReceipt = {
  item: string; start_date: string; end_date: string; quantity: number;
  available: boolean | null; free_units: number | null;
  checked_at: number; call_id: string;
  kind?: string;
  new_inquiry?:true;
  owned?: boolean;
  identity_names?: string[];
  basket?: {available:boolean|null;items:Array<{name:string;quantity:number}>};
};
export type StockRequest = {
  start_date?: string | null; end_date?: string | null;
  items: Array<{ name: string; quantity: number; aliases?: string[]; complete?: boolean; components?: Array<{ name: string; quantity: number }> }>;
};
/** A rendered single Native offer is the subject of an otherwise empty inquiry.
 * Unselected tool results and multiple alternatives cannot define that subject.
 * This is display/guard scope, never a basket write or a booking promise. */
export function stockRequestForInquiryQuote(request:StockRequest,quotes:Array<{start_date:string;end_date:string;new_inquiry?:true;items:Array<{name:string;quantity:number}>}>,_stage?:string) {
  if(quotes.length!==1 || !quotes[0].items.length || request.items.length && !quotes[0].new_inquiry)return request;
  const quote=quotes[0];
  return {start_date:quote.start_date,end_date:quote.end_date,items:quote.items.map(i=>({name:i.name,quantity:i.quantity}))};
}
/** Availability-only replies still need the independently checked hire's
 * scope. Multiple dated alternatives remain ambiguous until one is selected. */
export function stockRequestForSeparateCheck(request:StockRequest,checks:Array<{new_inquiry?:unknown;start_date?:unknown;end_date?:unknown;basket?:unknown}>) {
  const scopes=new Map<string,StockRequest>();
  for(const check of checks){
    if(check.new_inquiry!==true||typeof check.start_date!=="string"||typeof check.end_date!=="string"||!check.basket||typeof check.basket!=="object")continue;
    const basket=check.basket as {available?:unknown;items?:unknown};
    const dates=claimDateScope(`${check.start_date} to ${check.end_date}`);
    if(typeof basket.available!=="boolean"||!Array.isArray(basket.items)||!basket.items.length||
      !basket.items.every(i=>i&&typeof i.name==="string"&&Number.isInteger(i.quantity)&&i.quantity>0)||
      !dates.valid||dates.start_date!==check.start_date||dates.end_date!==check.end_date)continue;
    const items=basket.items.map(i=>({name:i.name as string,quantity:i.quantity as number}));
    const scope={start_date:check.start_date,end_date:check.end_date,items};
    scopes.set(JSON.stringify([scope.start_date,scope.end_date,[...items].sort((a,b)=>a.name.localeCompare(b.name))]),scope);
  }
  return scopes.size===1?[...scopes.values()][0]:request;
}

// Preserve exact model variants. Never resolve a stock claim by fuzzy similarity.
function identity(name: string) {
  // Preserve both ends and their order in directional adapter identities,
  // including mentions embedded in a sentence.
  return normalizeApertureNotation(name).toLowerCase()
    .replace(/\b(pl|ef)\s*(?:to|→)\s*(sony\s+e|l|rf|ef|e)\s*(?:mount\s*)?(?:adapter)?\b/g,
      (_,from:string,to:string)=>`mountadapter ${from} ${to.replace(/^sony\s+/,"")}`)
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
/** Preserve the stated object of an equipment offer across all claim checks. */
export function rentalOfferAssertion(clause:string) {
  return /^\s*(?:(?:but|however|whereas|while)\s+)?(?:I|we)\s+(?:can|could|am able to|are able to)\s+(?:offer|supply|provide)\s+(.+?)\s*[.!]?$/i.exec(clause);
}
function subjectOf(prefix: string) {
  let s = prefix.trim().replace(/^(?:and|but|however|whereas|while|so|therefore)(?:\s+|$)/i, "").replace(/^(?:sorry[, ]*|unfortunately[, ]*|yes[, ]*|yeah[, ]*)/i, "");
  s = s.replace(/^(?:the|a|an|my|our|your|this|that)\s+/i, "");
  s = s.replace(/^(?:exact|specific|particular|requested|selected)\s+/i, "");
  const ordinal = /^(second|third|fourth|2nd|3rd|4th)\s+/i.exec(s);
  if (ordinal) return {name:s.slice(ordinal[0].length).trim(),quantity:({second:2,third:3,fourth:4,"2nd":2,"3rd":3,"4th":4} as Record<string,number>)[ordinal[1].toLowerCase()]};
  const count = /^(\d+|one|single|two|both|three|four)\s*(?:x|×)?\s+/i.exec(s);
  if (count) s = s.slice(count[0].length);
  return { name: s.trim(), quantity: count ? units[count[1].toLowerCase()] ?? Number(count[1]) : undefined };
}

/** Equipment refusals, excluding missing service information and conditions. */
export function rentalRefusalSubject(clause:string) {
  if (catalogueReadinessSubject(clause)) return null;
  const match=/^\s*(?:(?:sorry|unfortunately)[, ]+)?(?:I|we)\s+(?:currently\s+)?(?:don\'t|do not|can\'t|cannot|can not)\s+(?:currently\s+)?(have|get)\s+(.+?)\s*[.!]?$/i.exec(clause.replace(/’/g,"'"));
  if (!match || /^(?:(?:that|the|a|an|any|enough|your|verified|confirmed|accurate|current|complete)\s+)*(?:information|details|answer|price|pricing|rates?|quote|confirmation|address|refund|discount|support|advice|permission|access|time)\b/i.test(match[2])
    || /\b(?:if|once|when|after|unless|subject to)\b/i.test(match[2]))return null;
  return {verb:match[1].toLowerCase(),subject:match[2].replace(/\s+(?:to quote|to rent|for rental|in stock)\s*[.!]?$/i,"").replace(/[.!]$/,"")};
}

/** Server-supplied catalogue exclusions support a plain rental decline only.
 * They never attest calendar occupancy, stock depletion or a cause of refusal.
 * Resolve every subject independently; one excluded item cannot decline a basket. */
export function supportsRentalEligibilityDecline(clause: string, request: StockRequest, ineligibleItems: string[]) {
  if (!ineligibleItems.length) return false;
  const refusal=rentalRefusalSubject(clause);
  const normalized = refusal ? `${refusal.subject} is unavailable` : clause.replace(/’/g, "'");
  const match = /\b(?:(?:isn't|aren't|is not|are not|not)\s+available|unavailable)\b/i.exec(normalized);
  if (!match || /\b(?:because|due to|since|booked|booking|rented|stock|repair|maintenance|broken)\b/i.test(normalized.slice(match.index + match[0].length))) return false;
  const subject = subjectOf(normalized.slice(0, match.index).replace(/\s+(?:is|are)\s*$/i, ""));
  if (/\s+with\s+/i.test(subject.name)) return false;
  subject.name = subject.name.replace(/\s+(?:kit|set)\s*$/i, "");
  const generic = /^(?:it|it's|that|that's|this|they|they're|these|those|kit|camera|gear)?$/i.test(subject.name);
  const targets = generic ? request.items : [{ name: subject.name }];
  return targets.length > 0 && targets.every(target => ineligibleItems.some(name => sameItem(target.name, name)));
}

/** A class-wide tool-use boolean never proves stock for another item or span.
 * Unknown subjects remain unverified rather than being guessed from prose. */
export function unsupportedStockClaims(text: string, receipts: StockReceipt[], request: StockRequest, ineligibleItems: string[] = [], latestRenterMessage = "") {
  const failures: Array<{ negative: boolean; detail: string }> = [];
  let previousSubjects: StockRequest["items"] = [];
  let precedingNamedSubjects: StockRequest["items"] = [];
  let bulletSubjects: StockRequest["items"] = [];
  let invalidBullet = false;
  const knownSubjects:StockRequest["items"] = request.items.map(i=>({...i,aliases:[...(i.aliases??[])]}));
  const requestedCounts=[...new Set(request.items.map(i=>i.quantity))];
  for (const receipt of receipts)
    if (!knownSubjects.some(i => [i.name, ...(i.aliases ?? [])].some(n => sameItem(n, receipt.item))))
      knownSubjects.push({name:receipt.item,quantity:requestedCounts.length===1?requestedCounts[0]:request.items.length?NaN:1});
  for(const receipt of receipts) {
    const item=knownSubjects.find(i=>sameItem(i.name,receipt.item));
    if(item && receipt.identity_names?.length)item.aliases=[...new Set([...(item.aliases??[]),...receipt.identity_names])];
  }
  const lensSubject=(reference:string)=>{
    // These words describe a lens's capabilities/category, not its identity.
    // Stock evidence does not attest them; technical evidence remains separate.
    const label=itemReferenceLabel(reference,"lens");
    const focal=/\b\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\s*mm\b/i.exec(label)?.[0];
    if(!focal)return undefined;
    const declared=declaredLensReferences(identity(label));
    const candidates=knownSubjects.filter(i=>receipts.some(r=>r.kind==="lens"&&sameItem(r.item,i.name)) &&
      declared.every(key=>references.get(key)?.item===i) &&
      [i.name,...(i.aliases??[])].some(n=>{const range=/\b\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\s*mm\b/i.exec(n)?.[0];return range && identity(range)===identity(focal);}));
    const match=bestMatch(label,candidates,i=>i.name,i=>i.aliases??[]);
    return match.confident ? match.match ?? undefined : undefined;
  };
  const namedSubject=(reference:string)=>{
    const resolve=(label:string)=>{
      const exact=knownSubjects.filter(i=>[i.name,...(i.aliases??[])].some(n=>sameItem(label,n)));
      return exact.length===1 ? exact[0] : exact.length ? undefined : lensSubject(label);
    };
    // A source phrase qualifies where a named item came from, not its model.
    // Only an independently resolvable noun phrase may use this projection;
    // counts, included components and dates are still checked separately.
    return resolve(reference) ?? resolve(reference.split(/\s+from\s+/i)[0]);
  };
  const withQuantity=(item:StockRequest["items"][number],quantity:number)=>({...item,quantity,
    components:item.components?.map(c=>({...c,quantity:c.quantity*quantity/item.quantity})),
  });
  const references = lensClaimReferences(knownSubjects.map(item => ({names:[item.name,...(item.aliases??[])],item})),
    (a,b) => a.some(left => b.some(right => sameItem(left,right))));
  const lenses=[...new Map(receipts.filter(r=>r.kind==="lens").map(r=>[r.item,{_id:r.item,name_canonical:r.item,kind:"lens"}])).values()];
  const requestedSets=requestedLensSets(latestRenterMessage,lenses);
  const setSafeText=text.replace(new RegExp(`\\b${lensSetFocalPattern}${lensSetSuffixPattern}\\b`,"gi"),
    list=>list.replace(/,\s*(?:and|&)\s*/gi,"/").replace(/,/g,"/"));
  const scopedText=setSafeText.replace(/’/g, "'");
  const quoteGroups=itemQuoteGroups(scopedText);
  let clauseEnd=0;
  const clauses=scopedText.split(/(?<=[.!?])\s+|\n+|;\s*|,\s+|\s+(?:but|however|whereas|while)\s+/i);
  for (const [clauseIndex,rawClause] of clauses.entries()) {
    const clauseStart=scopedText.indexOf(rawClause,clauseEnd);
    clauseEnd=clauseStart+rawClause.length;
    const relativeSubjects=precedingNamedSubjects;
    precedingNamedSubjects=[];
    const bullet=itemQuoteRow(rawClause);
    const precedingBullets=bulletSubjects;
    const precedingInvalid=invalidBullet;
    if (bullet) {
      const parsed=subjectOf(bullet);
      const exact=knownSubjects.filter(i=>[i.name,...(i.aliases??[])].some(n=>sameItem(parsed.name,n)));
      const focal=references.get(identity(parsed.name.replace(/\s+lens(?:es)?$/i,"")));
      const resolved=exact.length===1 ? exact[0] : exact.length===0 ? focal?.item ?? lensSubject(parsed.name) : undefined;
      if (!resolved) invalidBullet=true;
      else bulletSubjects=[...bulletSubjects,withQuantity(resolved,parsed.quantity??resolved.quantity)];
      // A rendered quote establishes its exact basket, including quantities.
      // Do not replace this group with just the last name found in its prose.
      previousSubjects=invalidBullet ? [] : bulletSubjects;
    } else if(!itemQuoteTotalLine(rawClause) || bulletSubjects.length<2) {bulletSubjects=[];invalidBullet=false;}
    // An unconditional equipment offer is an availability promise. Keep the
    // object, counts and dates intact; service offers and conditional checks
    // do not assert that physical equipment is currently free.
    const offer = rentalOfferAssertion(rawClause);
    const service = offer && /^(?:(?:an?|the|your|some)\s+)?(?:refund|discount|delivery|pickup|collection|help|advice|guidance|support|quote|price|information|assistance)\b/i.test(offer[1]);
    const conditionalOffer = offer && /\b(?:if|once|when|after|subject to)\b/i.test(offer[1]);
    // A generic offer heading names the immediately following exact basket.
    // It cannot inherit an earlier declined item or borrow unrelated bullets.
    const heading=offer && /^(?:(?:our|my|the|a)\s+)?(?:(\w+)\s+)?setup\s*:\s*$/i.exec(offer[1]);
    const forwardTargets:StockRequest["items"]=[];
    let invalidHeading=false;
    if(heading)for(const following of clauses.slice(clauseIndex+1)) {
      if(!following.trim())continue;
      const row=/^\s*[-*•]\s+([^:]+):/.exec(following);
      if(!row)break;
      const parsed=subjectOf(row[1]);
      const resolved=knownSubjects.filter(i=>[i.name,...(i.aliases??[])].some(n=>sameItem(parsed.name.replace(/\s+lens$/i,""),n)));
      if(resolved.length!==1 || heading[1] && ![resolved[0].name,...(resolved[0].aliases??[])].some(n=>new RegExp(`\\b${heading[1]}\\b`,"i").test(n))) {invalidHeading=true;break;}
      forwardTargets.push(withQuantity(resolved[0],parsed.quantity??1));
    }
    const rentalRefusal=rentalRefusalSubject(rawClause);
    const refusalSubject=rentalRefusal?.subject ?? "";
    const clause = rentalRefusal
      ? `${refusalSubject.replace(/\s+(?=(?:for|from|on)\b)/i," is unavailable ")}${/\b(?:for|from|on)\b/i.test(refusalSubject) ? "" : " is unavailable"}`
      : offer && !service && !conditionalOffer
      ? `${offer[1].replace(/\s+(?=(?:for|from|on|at)\b)/i, " is available ")}${/\b(?:for|from|on|at)\b/i.test(offer[1]) ? "" : " is available"}`
      : rawClause;
    // Remember an exact native item reference even when that clause merely
    // describes kit contents. "A second one" still needs a two-unit receipt.
    const mentionText = ` ${identity(clause)} `;
    let latestMention = -1;
    let longestMention = 0;
    let mentioned: StockRequest["items"] = [];
    for (const candidate of knownSubjects) for (const name of [candidate.name, ...(candidate.aliases ?? [])]) {
      const key = identity(name);
      const at = key ? mentionText.lastIndexOf(` ${key} `) : -1;
      const end = at < 0 ? -1 : at + key.length;
      if (end > latestMention || end === latestMention && key.length > longestMention) {
        latestMention=end;longestMention=key.length;mentioned=at < 0 ? [] : [candidate];
      } else if (at >= 0 && end === latestMention && key.length === longestMention && !mentioned.includes(candidate)) mentioned.push(candidate);
    }
    if (mentioned.length && !bullet) {previousSubjects = mentioned;precedingNamedSubjects=mentioned;}
    if (/\b(?:check|verify|confirm|know|unsure|uncertain|not sure)\b[^.!?]{0,70}\b(?:whether|if)\b/i.test(clause)) continue;
    // "Your booked kit" is a booking reference, not a claim that stock is
    // unavailable. Keep character positions and continue scanning for any
    // actual availability verdict later in the same clause.
    const availabilityClause = clause.replace(/\b(?:already\s+)?booked\b/gi, (word, offset: number) => {
      const before = clause.slice(0, offset);
      const after = clause.slice(offset + word.length);
      const adjective = /\b(?:your|my|our|the|this|that|their)\s*$/i.test(before);
      // A request/order's booking state is a different subject from occupied
      // equipment. Negation/adverbs do not turn it into a stock refusal.
      const bookingState=/\b(?:booking|rental|request|order|enquiry|inquiry)\s+(?:is|are|was|were|isn't|aren't|has\s+(?:not\s+)?been|have\s+(?:not\s+)?been|hasn't been|haven't been)\s+(?:(?:not|yet|already|now|fully)\s+)*$/i.test(before);
      const ownerConfirmation = bookingState || /\byour\b[^.!?]{0,70}\b(?:is|are)\s*$/i.test(before)
        || /^\s+for\s+you\b/i.test(after);
      const inclusionReference = /\b(?:included|supplied)\s+(?:(?:exactly|already)\s+)?as\s*$/i.test(before);
      // First-person booking actions concern the enquiry, not occupied stock.
      // Mask only the verb so an independent availability verdict survives.
      const bookingAction = /\b(?:I|we)\s+(?:have|has|haven't|had|hadn't|have\s+not|had\s+not)\s+(?:(?:already|yet|just|now)\s+)?(?:(?:changed|modified|cancelled|canceled)\s+or\s+)?$/i.test(before)
        && /^\s+(?:anything|your\s+(?:booking|rental|request|order|enquiry|inquiry))\b/i.test(after);
      const passiveAction = /\bnothing\s+(?:has|had)\s+been\s+(?:(?:changed|modified|cancelled|canceled)\s+or\s+)?$/i.test(before)
        && /^\s+(?:on|in|for)\s+your\s+(?:booking|rental|request|order|enquiry|inquiry)\b/i.test(after);
      return (adjective || ownerConfirmation || inclusionReference || bookingAction || passiveAction) && !/^\s*(?:[-–—]\s*)?out\b/i.test(after) && !/\b(?:by|for)\s+(?:another|other|someone\s+else|a different)\b/i.test(after) ? " ".repeat(word.length) : word;
    });
    const match = /\b(?:(isn't|aren't|is not|are not|not)\s+(available|in stock|free)|(?:is|are|it's|that's|they're)\s+(available|in stock|free)|(?:unavailable|out of stock|booked out|fully booked|already booked|currently rented|all booked|booked|none (?:left|available)))\b/i.exec(availabilityClause);
    if (!match) continue;
    const prefix = availabilityClause.slice(0, match.index);
    if (/\b(?:once|when|after|if|until|as soon as)\b[^,;:]{0,100}$/i.test(prefix)) continue;
    // Recording capabilities and handoff slots aren't equipment-stock claims.
    if (/\b(?:4k(?:\s+recording)?|raw(?:\s+recording)?|autofocus|recording\s+mode|discounts?|payments?|verification)\s*$/i.test(prefix) || /\b(?:pickup|collection|delivery)(?:\s+(?:slot|time|window))?\b[^,;.!?]{0,40}$/i.test(prefix)) continue;
    const negative = !!match[1] || /^(?:unavailable|out of stock|booked out|fully booked|already booked|currently rented|all booked|booked|none (?:left|available))$/i.test(match[0]);
    const quoteHeader=quoteGroups.find(group=>clauseStart>=group.start&&clauseStart<=group.end || precedingBullets.length>0 && /^\s*(?:both|they|these|those|all)\b/i.test(prefix) && clauseStart>group.end && !scopedText.slice(group.end,clauseStart).trim())?.header??"";
    let dateScope = itemQuoteDateScope(clause, quoteHeader, request.start_date);
    const datedPrefix = dateScope.matched_text ? prefix.replace(dateScope.matched_text, "__stock_date__") : prefix;
    const extensionSubject = /^I\s+(?:can't|cannot|can not|am not able to)\s+extend\s+(.+?)\s+(?:through|until|to)\s+__stock_date__\s+(?:as|because)\s+(?:it's|it is)\s*$/i.exec(datedPrefix.trim());
    const subject = subjectOf(extensionSubject?.[1] ?? prefix.replace(/\s+(?:is|are)\s*$/i, ""));
    // "paired with" coordinates two offered items; it does not assert that
    // the lens is included inside each member's existing kit.
    const kitParts=/\bpaired\s+with\b/i.test(subject.name) ? [subject.name] : subject.name.split(/\s+with\s+/i);
    const modifiers=kitParts.slice(1).flatMap(p=>p.split(/\s+(?:and|plus)\s+/i));
    subject.name=kitParts[0];
    const namedKit = modifiers.length>0 || /(?:^|\s)(?:kit|sets?)\s*$/i.test(subject.name);
    subject.name = subject.name.replace(/\s+(?:kit|sets?)\s*$/i, "");
    const lensName=subject.name.replace(/\s+(?:(?:wide[ -]angle|standard|telephoto|anamorphic)\s+)?(?:zoom\s+)?lens(?:es)?$/i, "");
    if (receipts.some(r=>r.kind === "lens" && sameItem(lensName,r.item))) subject.name=lensName;
    const reference = references.get(identity(subject.name.replace(/\s+lens(?:es)?$/i,"")));
    const bodyOnly = !modifiers.length && /(?:^|\s)body$/i.test(subject.name);
    if(bodyOnly)subject.name=subject.name.replace(/\s+(?:camera\s+)?body$/i, "");
    const sourceSubject=subject.name.split(/\s+from\s+/i)[0];
    const generic = /^(?:one|body|it|it's|that|that's|this|they|they're|these|those|kit|camera|gear|which)?$/i.test(sourceSubject);
    const countedUnitReference = subject.quantity !== undefined && /^(?:cop(?:y|ies)|units?)$/i.test(subject.name);
    const lensReference = /^(?:units?\s+of\s+)?(?:(?:that|this|(?:the )?same)\s+)?(?:(?:exact|specific|particular)\s+)?lens(?:es)?$/i.test(subject.name);
    const namedItem=namedSubject(subject.name);
    let targets = reference ? [reference.item] : namedItem ? [namedItem] : request.items.filter(i => [i.name, ...(i.aliases ?? [])].some(n => sameItem(subject.name, n)));
    // Only the explicit latest requested members can define an abbreviated
    // set. Unrelated negative lens receipts cannot invent its contents.
    const statedSet=namedKit && !modifiers.length ? resolveLensSet(`${subject.name} set`,lenses) : null;
    const matchingSets=namedKit && !modifiers.length ? requestedSets.filter(s=>s.family===lensSetSubjectFamily(subject.name)
      || statedSet?.ok && JSON.stringify(s.items.map(i=>i._id).sort())===JSON.stringify(statedSet.items.map(i=>i._id).sort())) : [];
    const distinctSets=new Set(matchingSets.map(s=>JSON.stringify([s.items.map(i=>i._id).sort(),s.quantity])));
    const requestedSet=distinctSets.size===1 ? matchingSets[0] : undefined;
    const setQuantity=subject.quantity ?? requestedSet?.quantity ?? 1;
    if (requestedSet) targets=[{name:subject.name,quantity:setQuantity,complete:true,
      components:requestedSet.items.map(i=>({name:i.name_canonical,quantity:setQuantity}))}];
    if (subject.name.toLowerCase()==="which") targets=relativeSubjects.length===1 ? relativeSubjects : [];
    else if (generic) targets = /^(?:kit|gear)$/i.test(sourceSubject) ? request.items : previousSubjects.length ? previousSubjects : request.items;
    else if (countedUnitReference) targets = previousSubjects.length === 1 ? previousSubjects : [];
    else if (lensReference) {
      // A lens pronoun needs a preceding standalone lens identity, never a
      // camera bundle that happens to mention a focal length in its name.
      const lensOwners = new Set([...references.values()].map(r => r.item));
      const antecedents=previousSubjects.filter(item=>[...lensOwners].some(lens=>sameItem(lens.name,item.name)));
      targets = antecedents.length===1 ? antecedents : [];
    }
    else if (!targets.length) {
      const requestedCounts = [...new Set(request.items.map(i => i.quantity))];
      targets = [{ name: subject.name, quantity: subject.quantity ?? (requestedCounts.length === 1 ? requestedCounts[0] : NaN) }];
    }
    if(generic && /^(?:camera|body)$/i.test(sourceSubject))targets=targets.filter(t=>receipts.some(r=>sameItem(t.name,r.item)&&
      (r.kind===undefined || ["camera","camera_body"].includes(r.kind))));
    const pluralGroup=/^(?:both|both of them|these two|those two|all|all of them|they|these|those)$/i.test(prefix.replace(/\s+(?:is|are)\s*$/i,"").trim())
      || precedingBullets.length>0 && /^they\'re\s+/i.test(match[0]);
    const coordinatedPrefix=prefix.replace(/\s+(?:is|are)\s*$/i,"").trim();
    const coordinated=requestedSet ? [coordinatedPrefix] : coordinatedPrefix.replace(/^both\s+(?=.+\s+(?:and|plus|paired with)\s+)/i,"").split(/\s+(?:and|plus|paired with)\s+/i);
    // A setup is a basket reference, not an inventory model or a camera kit.
    // Resolve an introductory offer against the following explicit quote rows;
    // descriptions remain subject to the separate technical-claim guard.
    const setupReference=offer && !heading && modifiers.length>0 &&
      /^(?:(\w+)\s+)?(?:(?:full[ -]frame|\d+k|mirrorless|cinema)\s+)*setup$/i.exec(subject.name);
    const offeredGroup=setupReference ? quoteGroups.find(group=>group.start>clauseEnd) : undefined;
    if(offeredGroup && setupReference) {
      const rows=scopedText.slice(offeredGroup.start,offeredGroup.end).split("\n").map(itemQuoteRow).filter((row):row is string=>row!==null);
      const members=rows.map(row=>{
        const parsed=subjectOf(row);
        const matches=knownSubjects.filter(i=>[i.name,...(i.aliases??[])].some(n=>sameItem(parsed.name,n)));
        return matches.length===1 ? withQuantity(matches[0],parsed.quantity??1) : undefined;
      });
      const cameras=members.filter(i=>i && receipts.some(r=>sameItem(r.item,i.name)&&["camera","camera_body"].includes(r.kind??"")));
      const brand=setupReference[1]?.toLowerCase();
      const specified=modifiers.map(raw=>{
        const parsed=subjectOf(raw),lens=lensSubject(parsed.name);
        const matches=lens ? [lens] : knownSubjects.filter(i=>[i.name,...(i.aliases??[])].some(n=>sameItem(parsed.name,n)));
        return matches.length===1 ? withQuantity(matches[0],parsed.quantity??1) : undefined;
      });
      const unambiguous=members.length>=2 && members.every((i,index)=>i&&!members.slice(0,index).some(other=>other&&sameItem(i.name,other.name))) && cameras.length>0 &&
        (!brand || cameras.every(i=>[i!.name,...(i!.aliases??[])].some(n=>n.toLowerCase().split(/[^a-z0-9]+/).includes(brand)))) &&
        specified.every(i=>i&&members.some(member=>member&&sameItem(member.name,i.name)&&member.quantity===i.quantity));
      targets=unambiguous ? (members as StockRequest["items"]).map(i=>withQuantity(i,i.quantity*(subject.quantity??1))) : [];
      subject.quantity=undefined;
      if(unambiguous)modifiers.splice(0); // explicitly quoted members, not kit-inclusion modifiers
      dateScope=itemQuoteDateScope(clause,offeredGroup.header,request.start_date);
    }
    const jointClaim=!!heading || !!offeredGroup || pluralGroup || coordinated.length>1 || !!requestedSet || generic && targets.length>1;
    if(heading) {
      targets=!invalidHeading && forwardTargets.length>=2 && forwardTargets.every((i,index)=>!forwardTargets.slice(0,index).some(previous=>sameItem(i.name,previous.name))) ? forwardTargets : [];
      subject.quantity=undefined;
    }
    if (pluralGroup) {
      targets=!precedingInvalid && precedingBullets.length>=2 && (!/^both|^(?:these|those) two/i.test(prefix.trim()) || precedingBullets.length===2) && precedingBullets.every((i,index)=>!precedingBullets.slice(0,index).some(other=>sameItem(i.name,other.name))) ? precedingBullets : [];
      subject.quantity=undefined;
    } else if(coordinated.length>1) {
      targets=coordinated.flatMap(part=>{
        const parsed=subjectOf(part);
        parsed.name=itemReferenceLabel(parsed.name,/\b\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\s*mm\b/i.test(parsed.name)?"lens":"camera");
        const lens=parsed.name.replace(/\s+(?:anamorphic\s+)?lens(?:es)?$/i,"");
        const exact=knownSubjects.filter(i=>[i.name,...(i.aliases??[])].some(n=>sameItem(parsed.name,n))
          || receipts.some(r=>r.kind==="lens" && sameItem(r.item,i.name)) && sameItem(lens,i.name));
        const focal=references.get(identity(lens));
        const resolved=exact.length===1 ? exact[0] : exact.length===0 ? focal?.item ?? lensSubject(parsed.name) : undefined;
        return resolved ? [withQuantity(resolved,parsed.quantity??resolved.quantity)] : [];
      });
      if(targets.length!==coordinated.length)targets=[];
      subject.quantity=undefined;
    }
    if (!generic) previousSubjects = targets;
    // An empty inquiry has no booking year. Infer omitted years only from
    // unambiguous Native checks for these exact members, never the wall clock
    // or unrelated inventory. The full resulting span must still match.
    if(!request.start_date && dateScope.explicit && !dateScope.valid) {
      const relevant=receipts.filter(r=>targets.some(t=>[t.name,...(t.aliases??[])].some(n=>sameItem(n,r.item))));
      const years=new Set(relevant.map(r=>r.start_date.slice(0,4)));
      if(years.size===1)dateScope=itemQuoteDateScope(clause,quoteHeader,relevant[0].start_date);
    }
    const start = dateScope.start_date ?? request.start_date;
    const end = dateScope.end_date ?? request.end_date;
    if (negative && supportsRentalEligibilityDecline(clause, { ...request, items: targets }, ineligibleItems)) continue;
    const requiredJoint:Array<{name:string;quantity:number}>=[];
    for(const component of targets.flatMap(t=>t.components?.length ? t.components : [{name:t.name,quantity:t.quantity}])) {
      const previous=requiredJoint.find(i=>sameItem(i.name,component.name));
      if(previous)previous.quantity+=component.quantity;
      else requiredJoint.push({...component});
    }
    const jointProof=!jointClaim || negative || receipts.some(r=>r.call_id && Number.isFinite(r.checked_at) && r.basket?.available===true
      && (!start || r.start_date===start) && (!end || r.end_date===end)
      && requiredJoint.every(c=>Number.isInteger(c.quantity)&&c.quantity>0&&r.basket!.items.some(i=>sameItem(i.name,c.name)&&i.quantity>=c.quantity)));
    const proven = jointProof && targets.length > 0 && targets.every(target => {
      if (!dateScope.valid) return false;
      if(modifiers.some(raw=>{
        if(/^built[ -]?in\s+ND(?:s|\s+filters?)?$/i.test(raw.trim()))return false; // reviewed separately as an intrinsic camera feature
        const modifier=subjectOf(raw);
        modifier.name=modifier.name.replace(/\s+lens(?:es)?$/i, "").trim();
        const matching=(target.components??[]).filter(c=>sameItem(modifier.name,c.name) ||
          /^\d+(?:[-–]\d+)?\s*mm$/i.test(modifier.name) && identity(c.name).replace(/^\w+\s+/, "")===identity(modifier.name));
        return matching.length!==1 || modifier.quantity!==undefined && modifier.quantity!==matching[0].quantity;
      }))return false;
      if (!negative && target.complete === false) return false;
      const required = !bodyOnly && target.components?.length && (!negative || generic || namedKit)
        ? target.components : [target];
      const qualifies = (component: { name: string; quantity: number }) => {
        const quantity = subject.quantity === undefined ? component.quantity
          : component.quantity * subject.quantity / target.quantity;
        if (!Number.isInteger(quantity) || quantity <= 0) return false;
        return receipts.some(r => {
          const names = component === target ? [target.name, ...(bodyOnly ? [] : target.aliases ?? [])] : [component.name];
          if (!r.call_id || !Number.isFinite(r.checked_at) || typeof r.available !== "boolean" ||
            !names.some(n => sameItem(n, r.item)) ||
            (start && r.start_date !== start) || (end && r.end_date !== end)) return false;
          // A physically free body does not promise that its failed/unknown
          // rental proposal can be supplied with all shared kit components.
          if (!negative && r.basket && r.basket.available!==true) return false;
          // A calendar refusal does not prove the catalogue lacks that gear.
          // Undated don't-have claims need current Native rental eligibility.
          if (rentalRefusal && rentalRefusal.verb==="have" && !dateScope.matched_text && r.owned!==false) return false;
          if (r.quantity === quantity) return r.available === !negative;
          if (jointClaim && !negative && r.available===true && r.basket?.available===true && r.quantity>=quantity
            && requiredJoint.every(c=>r.basket!.items.some(i=>sameItem(i.name,c.name)&&i.quantity>=c.quantity))) return true;
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
