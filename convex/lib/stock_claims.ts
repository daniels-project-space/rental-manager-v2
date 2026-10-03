import { shortItemName } from "./item_display_name";
import { claimDateScope } from "./claim_date_scope";
import { lensClaimReferences } from "./lens_claim_references";
export type StockReceipt = {
  item: string; start_date: string; end_date: string; quantity: number;
  available: boolean | null; free_units: number | null;
  checked_at: number; call_id: string;
  kind?: string;
  basket?: {available:boolean|null;items:Array<{name:string;quantity:number}>};
};
export type StockRequest = {
  start_date?: string | null; end_date?: string | null;
  items: Array<{ name: string; quantity: number; aliases?: string[]; complete?: boolean; components?: Array<{ name: string; quantity: number }> }>;
};

// Preserve exact model variants. Never resolve a stock claim by fuzzy similarity.
function identity(name: string) {
  // Canonical inventory uses "PL to L mount"; renter prose adds "adapter".
  // Match only an entire directional mount identity, preserving both ends.
  const adapter=/^\s*(pl|ef)\s*(?:to|→)\s*(sony\s+e|l|rf|ef|e)\s*(?:mount\s*)?(?:adapter)?\s*$/i.exec(name);
  if(adapter)return `adapter ${adapter[1].toLowerCase()} ${adapter[2].toLowerCase().replace(/^sony\s+/,"")}`;
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
  let s = prefix.trim().replace(/^(?:but|however|whereas|while|so|therefore)\s+/i, "").replace(/^(?:sorry[, ]*|unfortunately[, ]*|yes[, ]*|yeah[, ]*)/i, "");
  s = s.replace(/^(?:the|a|an|my|our|your|this|that)\s+/i, "");
  s = s.replace(/^(?:exact|specific|particular|requested|selected)\s+/i, "");
  const ordinal = /^(second|third|fourth|2nd|3rd|4th)\s+/i.exec(s);
  if (ordinal) return {name:s.slice(ordinal[0].length).trim(),quantity:({second:2,third:3,fourth:4,"2nd":2,"3rd":3,"4th":4} as Record<string,number>)[ordinal[1].toLowerCase()]};
  const count = /^(\d+|one|single|two|both|three|four)\s*(?:x|×)?\s+/i.exec(s);
  if (count) s = s.slice(count[0].length);
  return { name: s.trim(), quantity: count ? units[count[1].toLowerCase()] ?? Number(count[1]) : undefined };
}

/** Server-supplied catalogue exclusions support a plain rental decline only.
 * They never attest calendar occupancy, stock depletion or a cause of refusal.
 * Resolve every subject independently; one excluded item cannot decline a basket. */
export function supportsRentalEligibilityDecline(clause: string, request: StockRequest, ineligibleItems: string[]) {
  if (!ineligibleItems.length) return false;
  const normalized = clause.replace(/’/g, "'");
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
export function unsupportedStockClaims(text: string, receipts: StockReceipt[], request: StockRequest, ineligibleItems: string[] = []) {
  const failures: Array<{ negative: boolean; detail: string }> = [];
  let previousSubjects: StockRequest["items"] = [];
  let bulletSubjects: StockRequest["items"] = [];
  let invalidBullet = false;
  const knownSubjects = [...request.items];
  for (const receipt of receipts)
    if (!knownSubjects.some(i => [i.name, ...(i.aliases ?? [])].some(n => sameItem(n, receipt.item))))
      knownSubjects.push({name:receipt.item,quantity:1});
  const withQuantity=(item:StockRequest["items"][number],quantity:number)=>({...item,quantity,
    components:item.components?.map(c=>({...c,quantity:c.quantity*quantity/item.quantity})),
  });
  const references = lensClaimReferences(knownSubjects.map(item => ({names:[item.name,...(item.aliases??[])],item})),
    (a,b) => a.some(left => b.some(right => sameItem(left,right))));
  for (const rawClause of text.replace(/’/g, "'").split(/(?<=[.!?])\s+|\n+|;\s*|,\s+|\s+(?:but|however|whereas|while)\s+/i)) {
    const bullet=/^\s*[-*•]\s+([^:]+):/.exec(rawClause);
    const precedingBullets=bulletSubjects;
    const precedingInvalid=invalidBullet;
    if (bullet) {
      const parsed=subjectOf(bullet[1]);
      const exact=knownSubjects.filter(i=>[i.name,...(i.aliases??[])].some(n=>sameItem(parsed.name,n)));
      const focal=references.get(identity(parsed.name.replace(/\s+lens(?:es)?$/i,"")));
      const resolved=exact.length===1 ? exact[0] : exact.length===0 ? focal?.item : undefined;
      if (!resolved) invalidBullet=true;
      else bulletSubjects=[...bulletSubjects,withQuantity(resolved,parsed.quantity??resolved.quantity)];
    } else {bulletSubjects=[];invalidBullet=false;}
    // An unconditional equipment offer is an availability promise. Keep the
    // object, counts and dates intact; service offers and conditional checks
    // do not assert that physical equipment is currently free.
    const offer = /^\s*(?:I|we)\s+(?:can|could|am able to|are able to)\s+(?:offer|supply|provide)\s+(.+?)\s*[.!]?$/i.exec(rawClause);
    const service = offer && /^(?:(?:an?|the|your|some)\s+)?(?:refund|discount|delivery|pickup|collection|help|advice|guidance|support|quote|price|information|assistance)\b/i.test(offer[1]);
    const conditionalOffer = offer && /\b(?:if|once|when|after|subject to)\b/i.test(offer[1]);
    const clause = offer && !service && !conditionalOffer
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
    if (mentioned.length) previousSubjects = mentioned;
    if (/\b(?:check|verify|confirm|know|unsure|uncertain|not sure)\b[^.!?]{0,70}\b(?:whether|if)\b/i.test(clause)) continue;
    // "Your booked kit" is a booking reference, not a claim that stock is
    // unavailable. Keep character positions and continue scanning for any
    // actual availability verdict later in the same clause.
    const availabilityClause = clause.replace(/\b(?:already\s+)?booked\b/gi, (word, offset: number) => {
      const before = clause.slice(0, offset);
      const after = clause.slice(offset + word.length);
      const adjective = /\b(?:your|my|our|the|this|that|their)\s*$/i.test(before);
      const ownerConfirmation = /\byour\b[^.!?]{0,70}\b(?:is|are)\s*$/i.test(before)
        || /^\s+for\s+you\b/i.test(after);
      const inclusionReference = /\b(?:included|supplied)\s+(?:(?:exactly|already)\s+)?as\s*$/i.test(before);
      return (adjective || ownerConfirmation || inclusionReference) && !/^\s*(?:[-–—]\s*)?out\b/i.test(after) && !/\b(?:by|for)\s+(?:another|other|someone\s+else|a different)\b/i.test(after) ? " ".repeat(word.length) : word;
    });
    const match = /\b(?:(isn't|aren't|is not|are not|not)\s+(available|in stock|free)|(?:is|are|it's|that's|they're)\s+(available|in stock|free)|(?:unavailable|out of stock|booked out|fully booked|already booked|currently rented|all booked|booked|none (?:left|available)))\b/i.exec(availabilityClause);
    if (!match) continue;
    const prefix = availabilityClause.slice(0, match.index);
    if (/\b(?:once|when|after|if|until|as soon as)\b[^,;:]{0,100}$/i.test(prefix)) continue;
    // Recording capabilities and handoff slots aren't equipment-stock claims.
    if (/\b(?:4k(?:\s+recording)?|raw(?:\s+recording)?|autofocus|recording\s+mode|discounts?|payments?|verification)\s*$/i.test(prefix) || /\b(?:pickup|collection|delivery)(?:\s+(?:slot|time|window))?\b[^,;.!?]{0,40}$/i.test(prefix)) continue;
    const negative = !!match[1] || /^(?:unavailable|out of stock|booked out|fully booked|already booked|currently rented|all booked|booked|none (?:left|available))$/i.test(match[0]);
    const dateScope = claimDateScope(clause, request.start_date);
    const datedPrefix = dateScope.matched_text ? prefix.replace(dateScope.matched_text, "__stock_date__") : prefix;
    const extensionSubject = /^I\s+(?:can't|cannot|can not|am not able to)\s+extend\s+(.+?)\s+(?:through|until|to)\s+__stock_date__\s+(?:as|because)\s+(?:it's|it is)\s*$/i.exec(datedPrefix.trim());
    const subject = subjectOf(extensionSubject?.[1] ?? prefix.replace(/\s+(?:is|are)\s*$/i, ""));
    const kitParts=subject.name.split(/\s+with\s+/i);
    const modifiers=kitParts.slice(1).flatMap(p=>p.split(/\s+(?:and|plus)\s+/i));
    subject.name=kitParts[0];
    const namedKit = modifiers.length>0 || /(?:^|\s)(?:kit|set)\s*$/i.test(subject.name);
    subject.name = subject.name.replace(/\s+(?:kit|set)\s*$/i, "");
    const lensName=subject.name.replace(/\s+(?:(?:wide[ -]angle|standard|telephoto)\s+)?(?:zoom\s+)?lens(?:es)?$/i, "");
    if (receipts.some(r=>r.kind === "lens" && sameItem(lensName,r.item))) subject.name=lensName;
    const reference = references.get(identity(subject.name.replace(/\s+lens(?:es)?$/i,"")));
    const bodyOnly = !modifiers.length && /(?:^|\s)body$/i.test(subject.name);
    if(bodyOnly)subject.name=subject.name.replace(/\s+(?:camera\s+)?body$/i, "");
    const generic = /^(?:one|body|it|it's|that|that's|this|they|they're|these|those|kit|camera|gear)?$/i.test(subject.name);
    const countedUnitReference = subject.quantity !== undefined && /^(?:cop(?:y|ies)|units?)$/i.test(subject.name);
    const lensReference = /^(?:units?\s+of\s+)?(?:that|this|the same)\s+(?:(?:exact|specific|particular)\s+)?lens(?:es)?$/i.test(subject.name);
    let targets = reference ? [reference.item] : request.items.filter(i => [i.name, ...(i.aliases ?? [])].some(n => sameItem(subject.name, n)));
    if (generic) targets = /^(?:kit|gear)$/i.test(subject.name) ? request.items : previousSubjects.length ? previousSubjects : request.items;
    else if (countedUnitReference) targets = previousSubjects.length === 1 ? previousSubjects : [];
    else if (lensReference) {
      // A lens pronoun needs a preceding standalone lens identity, never a
      // camera bundle that happens to mention a focal length in its name.
      const lensOwners = new Set([...references.values()].map(r => r.item));
      targets = previousSubjects.length === 1 && lensOwners.has(previousSubjects[0]) ? previousSubjects : [];
    }
    else if (!targets.length) {
      const requestedCounts = [...new Set(request.items.map(i => i.quantity))];
      targets = [{ name: subject.name, quantity: subject.quantity ?? (requestedCounts.length === 1 ? requestedCounts[0] : NaN) }];
    }
    const pluralGroup=/^(?:both|both of them|these two|those two|all|all of them|they|these|those)$/i.test(prefix.replace(/\s+(?:is|are)\s*$/i,"").trim())
      || precedingBullets.length>0 && /^they\'re\s+/i.test(match[0]);
    const coordinated=prefix.replace(/\s+(?:is|are)\s*$/i,"").trim().split(/\s+(?:and|plus|paired with)\s+/i);
    const jointClaim=pluralGroup || coordinated.length>1;
    if (pluralGroup) {
      targets=!precedingInvalid && precedingBullets.length>=2 && (!/^both|^(?:these|those) two/i.test(prefix.trim()) || precedingBullets.length===2) && precedingBullets.every((i,index)=>!precedingBullets.slice(0,index).some(other=>sameItem(i.name,other.name))) ? precedingBullets : [];
      subject.quantity=undefined;
    } else if(coordinated.length>1) {
      targets=coordinated.flatMap(part=>{
        const parsed=subjectOf(part);
        const exact=knownSubjects.filter(i=>[i.name,...(i.aliases??[])].some(n=>sameItem(parsed.name,n)));
        return exact.length===1 ? [withQuantity(exact[0],parsed.quantity??exact[0].quantity)] : [];
      });
      if(targets.length!==coordinated.length)targets=[];
      subject.quantity=undefined;
    }
    if (!generic) previousSubjects = targets;
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
