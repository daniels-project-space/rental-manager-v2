import { amendmentMoneyClaims } from "./renter_amendment_money";
import type { SentDateProposal } from "./renter_date_proposal";
type Terms={context_key:string;from_start_date:string;from_end_date:string;start_date:string;end_date:string;total_gbp:number;base_total_gbp:number;today:string;physical_identity_key?:string};
const sameMoney=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.round(a*100)===Math.round(b*100);
const months=["january","february","march","april","may","june","july","august","september","october","november","december"];
const normal=(s:string)=>s.replace(/[’‘]/g,"'").replace(/```[\s\S]*?```/g," ").replace(/["“][^"”]*\b(?:move|extend|change|set|update|reschedule)\b[^"”]*["”]/gi," ");
const valid=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
type Dates={start?:string;end?:string;index:number};
/** Resolve explicit dates against the actual London calendar, never the model's proposed year. */
function dateReferences(text:string,today:string):Dates[] {
  const out:Dates[]=[];
  for(const m of text.matchAll(/\b(\d{4}-\d{2}-\d{2})(?:\s*(?:to|through|–|-)\s*(\d{4}-\d{2}-\d{2}))?\b/g))
    out.push({start:m[1],end:m[2],index:m.index!});
  const pattern=/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:(?:to|through|–|-)\s*(\d{1,2})(?:st|nd|rd|th)?\s*)?(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+(20\d{2}))?\b/gi;
  for(const m of text.matchAll(pattern)){
    const month=months.findIndex(name=>name.startsWith(m[3].toLowerCase().slice(0,3)))+1;
    const year=m[4]??today.slice(0,4),date=(day:string)=>`${year}-${String(month).padStart(2,'0')}-${day.padStart(2,'0')}`;
    out.push({start:date(m[1]),end:m[2]?date(m[2]):undefined,index:m.index!});
  }
  // Join two fully spelled single dates: "20 October to 2 November".
  out.sort((a,b)=>a.index-b.index);
  for(let i=0;i<out.length-1;i++)if(!out[i].end&&!out[i+1].end){
    const between=text.slice(out[i].index,out[i+1].index);
    if(/\b(?:to|through|until)\s*$/i.test(between))out[i]={...out[i],end:out[i+1].start};
  }
  return out;
}
function targetMatches(text:string,terms:Terms,offer=false){
  const refs=dateReferences(text,terms.today);
  if(!refs.length || refs.some(r=>!r.start||!valid(r.start)||(r.end&&!valid(r.end))))return false;
  const ranges=refs.filter(r=>r.end);
  if(ranges.length){const r=ranges.at(-1)!;
    // "Move from one date to another" is not a complete new rental period.
    if(!offer && /\bfrom\s*$/i.test(text.slice(0,r.index)))return false;
    return r.start===terms.start_date&&r.end===terms.end_date;
  }
  if(refs.length!==1)return false;
  const before=text.slice(0,refs[0].index);
  if(/\b(?:extend|extending|return|until|through)\b/i.test(before))return terms.start_date===terms.from_start_date&&refs[0].start===terms.end_date;
  if(/\b(?:pickup|pick up|collection|collect)\b/i.test(before))return terms.end_date===terms.from_end_date&&refs[0].start===terms.start_date;
  return false;
}
function priceMatches(text:string,terms:Terms){
  const claims=amendmentMoneyClaims(text);
  if(!claims.length)return {present:false,matches:false};
  let complete=false;
  for(const claim of claims){
    if(claim.role==="unsupported"||claim.role==="daily")return {present:true,matches:false};
    const expected=claim.role==="base"?terms.base_total_gbp:claim.role==="increase"?terms.total_gbp-terms.base_total_gbp
      :claim.role==="reduction"?terms.base_total_gbp-terms.total_gbp:terms.total_gbp;
    if(expected<0 || !sameMoney(claim.amount,expected))return {present:true,matches:false};
    if(claim.role!=="base")complete=true;
  }
  return {present:true,matches:complete};
}
export function acceptsDateChange(text:string,terms:Terms,owner?:{body_text:string;quoted_dates?:SentDateProposal[]}){
  const message=normal(text);
  if(/\b(?:don't|do not|never|unless|later|wait|hold off|after I confirm|before I confirm)\b/i.test(message))return false;
  const price=priceMatches(message,terms);if(price.present&&!price.matches)return false;
  let requested=false;
  for(const clause of message.split(/[;\n]|(?<=[.!?])\s+|\bbut\b/i)){
    if(/\b(?:if|maybe|might|consider|thinking|suppose|said|says|told|example)\b/i.test(clause))continue;
    const action=/(?:^(?:(?:yes|okay|ok|sure|please)[,\s]+)*|\b(?:please|go ahead(?: and)?|(?:can|could|would) you|I(?:'d| would) like (?:you )?to)\s+)(?:move|change|extend|reschedule|shift|set|update)\s+(.+)/i.exec(clause);
    if(!action)continue;
    if(!dateReferences(action[0],terms.today).length && /^(?:it|them|the dates)(?:[.!\s]|$)/i.test(action[1]))continue;
    requested=true;if(!targetMatches(action[0],terms))return false;
  }
  if(requested&&(price.matches||terms.total_gbp<=terms.base_total_gbp))return true;
  if(!owner)return false;
  const offers=(owner.quoted_dates??[]).filter(p=>p.context_key===terms.context_key&&p.from_start_date===terms.from_start_date&&p.from_end_date===terms.from_end_date
    &&(!terms.physical_identity_key||p.physical_identity_key===terms.physical_identity_key)
    &&p.start_date===terms.start_date&&p.end_date===terms.end_date&&sameMoney(p.total_gbp,terms.total_gbp)&&sameMoney(p.base_total_gbp,terms.base_total_gbp));
  if(offers.length!==1||(owner.quoted_dates??[]).length!==1||/\b(?:alternatively|either|instead|options?)\b|\bor\b/i.test(owner.body_text))return false;
  if(/\bunavailable\b|(?:not|aren't|isn't|can't|cannot|unavailable).{0,25}(?:available|extend|change|move|possible)|\b(?:don't|do not)\s+(?:extend|change|move)/i.test(owner.body_text))return false;
  if(!targetMatches(owner.body_text,terms,true)||!priceMatches(owner.body_text,terms).matches)return false;
  const bare=/^(?:yes|yep|yeah|okay|ok|sure)[,!\s]*(?:please)?[.!\s]*$/i.test(message.trim());
  return requested||bare||/^(?:(?:yes|yep|yeah|okay|ok|sure|perfect)[,!\s]*)?(?:please\s*)?(?:go ahead(?: and (?:change|extend|move|update) (?:it|them|the dates))?|(?:change|extend|move|update) (?:it|them|the dates)|yes|yep|yeah|okay|ok|sure)[.!\s]*(?:thanks|thank you)?[.!\s]*$/i.test(message.trim());
}
