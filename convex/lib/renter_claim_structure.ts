import { claimDateScope } from "./claim_date_scope";
/** Currency syntax only. Identity, quantities and prices are validated by the
 * caller against Native receipts; these spans never constitute evidence. */
export type PriceBreakdownPart={index:number;amount:number;reference:string};
export type PriceBreakdown={start:number;end:number;parts:PriceBreakdownPart[];valid:boolean};
const currency=/£\s*(\d+(?:,\d{3})*(?:\.\d+)?)/g;
export function parenthesizedPriceBreakdowns(text:string):Map<number,PriceBreakdown> {
  const spans=new Map<number,number>(),stack:number[]=[];
  for(let index=0;index<text.length;index++) {
    if(text[index]==="(")stack.push(index);
    else if(text[index]===")" && stack.length)spans.set(stack.pop()!,index);
  }
  const groups=new Map<number,PriceBreakdown>();
  for(const total of text.matchAll(currency)) {
    let start=total.index!+total[0].length;
    while(/\s/.test(text[start]??"") && start<text.length)start++;
    const end=spans.get(start);
    if(end===undefined)continue;
    const body=text.slice(start+1,end),amounts=[...body.matchAll(currency)];
    if(amounts.length<2)continue; // contents, dates and a single daily rate are not a breakdown
    const parts:PriceBreakdownPart[]=[];
    let valid=amounts.length>=2 && !body.slice(0,amounts[0].index).trim();
    for(let index=0;index<amounts.length;index++) {
      const amount=amounts[index],next=amounts[index+1];
      const suffix=body.slice(amount.index!+amount[0].length,next?.index??body.length);
      const reference=/^\s+for\s+(?:(?:the|our|your|my)\s+)?(.+?)\s*$/i.exec(suffix.replace(/\s*(?:,\s*)?(?:and|plus)\s*$/i,""))?.[1];
      // No nested currency scope, fee labels or unassigned punctuation is guessed.
      if(!reference || /[()£]/.test(reference))valid=false;
      parts.push({index:start+1+amount.index!,amount:Number(amount[1].replace(/,/g,"")),reference:reference??""});
    }
    groups.set(total.index!,{start,end,parts,valid});
  }
  return groups;
}

/** Presentation categories are separate from model tokens. This is only an
 * identity projection, not proof of the described technical capabilities. */
export function itemReferenceLabel(label:string,category:"camera"|"lens") {
  const reference=label.trim().replace(/^(?:(?:the|my|our|your|an?)\s+)+/i,"");
  return category==="camera" ? reference
    .replace(/^(?:(?:full[ -]frame|\d+k|mirrorless|cinema)\s+)+/i,"")
    .replace(/(?:\s+(?:camera\s+body|body|camera))+$/i,"").trim()
    : reference.replace(/(?:\s+(?:wide[ -]angle|autofocus|manual[ -]focus|zoom|lens))+$/i,"").trim();
}

/** Explicit list syntax anchors the following summary to its immediate rows.
 * The caller still resolves every row and validates the complete Native basket. */
export function itemQuoteRow(line:string):string|null {
  return /^\s*[-*•]\s+([^:]+):/.exec(line)?.[1]??null;
}
export function itemQuoteTotalPrefix(prefix:string):boolean {
  return /^\s*(?:combined\s+)?total\s*:\s*$/i.test(prefix);
}
export function itemQuoteTotalLine(line:string):boolean {
  const amount=/£\s*\d+(?:,\d{3})*(?:\.\d+)?\s*[.!]?\s*$/.exec(line);
  return !!amount && itemQuoteTotalPrefix(line.slice(0,amount.index));
}

export type ItemQuoteGroup={start:number;end:number;header:string};
/** Bound a consecutive list and its optional total to the immediately preceding
 * heading. Unrelated prose ends the group instead of inheriting its scope. */
export function itemQuoteGroups(text:string):ItemQuoteGroup[] {
  let offset=0;
  const lines=text.split("\n").map(line=>{const row={text:line,start:offset,end:offset+line.length};offset+=line.length+1;return row;});
  const groups:ItemQuoteGroup[]=[];
  for(let index=0;index<lines.length;index++) {
    if(!itemQuoteRow(lines[index].text))continue;
    const first=index;
    while(index+1<lines.length && itemQuoteRow(lines[index+1].text))index++;
    let before=first-1;
    while(before>=0&&!lines[before].text.trim())before--;
    const header=before>=0 && /:\s*$/.test(lines[before].text) && !itemQuoteRow(lines[before].text) ? lines[before].text : "";
    let after=index+1;
    while(after<lines.length&&!lines[after].text.trim())after++;
    if(after<lines.length&&itemQuoteTotalLine(lines[after].text))index=after;
    groups.push({start:lines[first].start,end:lines[index].end,header});
  }
  return groups;
}
/** A row may repeat the heading's dates, but cannot silently override them. */
export function itemQuoteDateScope(claim:string,header:string,contextStart?:string|null) {
  const local=claimDateScope(claim,contextStart),parent=claimDateScope(header,contextStart);
  if(!parent.explicit)return local;
  if(!parent.valid || local.explicit && (!local.valid || local.start_date!==parent.start_date || local.end_date!==parent.end_date))return {...parent,valid:false};
  return local.explicit?local:parent;
}
