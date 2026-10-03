import { bestMatch, tokenize, isGenericItemQuery } from "./item_name_match";
import { renterItemNames } from "./renter_item_names";
import type { SentAdditionProposal } from "./renter_sent_proposal";

export type AcceptedAdditionLine = {product_id:number;name:string;qty:number;line_total_gbp:number;daily_rate_gbp?:number;base_daily_rate_gbp?:number;aliases?:string[];identity_name?:string;primary_removal_aliases?:string[]};
export type AdditionAcceptanceQuote = {context_key:string;start_date:string;end_date:string;total_gbp:number;additional_cost_gbp:number;lines:AcceptedAdditionLine[]};
const money = (s:string) => [...s.matchAll(/£\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g)].map(m=>({amount:Number(m[1].replace(/,/g,"")),index:m.index!,length:m[0].length}));
const sameMoney = (a:number,b:number) => Number.isFinite(a) && Number.isFinite(b) && Math.round(a*100)===Math.round(b*100);
const numbers:Record<string,number>={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
const normal = (s:string) => s.replace(/[’‘]/g,"'").replace(/\s+/g," ").trim();
const keys=(items:Array<{product_id:number;qty:number}>)=>JSON.stringify(items.map(i=>({product_id:i.product_id,qty:i.qty})).sort((a,b)=>a.product_id-b.product_id));

function hasLineName(text:string,line:AcceptedAdditionLine){
  const words=tokenize(text);
  return [line.identity_name??line.name,...renterItemNames(line.identity_name??line.name),...(line.aliases??[])]
    .some(alias=>{const tokens=tokenize(alias);return tokens.size>1 && [...tokens].every(t=>words.has(t));});
}

function namedSelection(raw:string,lines:AcceptedAdditionLine[],action:"addition"|"removal"="addition") {
  let part=raw.trim().replace(/^(?:(?:the|my|our|your|a|an|extra|another)\s+)+/i,"");
  const scope=action==="removal" ? /^(all|both)(?: of)?(?: the)?\s+/i.exec(part) : null;
  if(scope)part=part.slice(scope[0].length);
  const count=/^(\d+)(?:x|\s*x)?\s+|^(one|two|three|four|five|six|seven|eight|nine|ten)\s+/i.exec(part);
  const qty=count?Number(count[1]??numbers[count[2].toLowerCase()]):1;
  if(count)part=part.slice(count[0].length).replace(/^(?:extra|more)\s+/i,"");
  part=part.replace(/\s+lens\b$/i,"").replace(/[.!?]+$/,"").trim();
  if(isGenericItemQuery(part))return null;
  const match=bestMatch(part,lines,l=>l.identity_name??l.name,l=>[...renterItemNames(l.identity_name??l.name),...(l.aliases??[]),...(action==="removal"?l.primary_removal_aliases??[]:[])]);
  if(!match.confident || !match.match)return null;
  // A request for the camera alone does not authorise a commercial bundle
  // containing an extra lens, even when it starts with the same camera name.
  const identity=match.match.identity_name??match.match.name;
  const complete=[identity,...(match.match.aliases??[])].some(alias=>[...tokenize(alias)].every(t=>tokenize(part).has(t)));
  const primary=action==="removal" && !/\b(?:only|body)\b/i.test(part) && (match.match.primary_removal_aliases??[]).some(alias=>[...tokenize(alias)].every(t=>tokenize(part).has(t)));
  if((/[+]/.test(identity) || /^\d+[x×]\s/.test(identity)) && !complete && !primary)return null;
  return {line:match.match,qty:scope ? scope[1].toLowerCase()==="all" ? match.match.qty : 2 : qty};
}

export function directItemSelection(text:string, lines:AcceptedAdditionLine[], action:"addition"|"removal"="addition"){
  const selected=new Map<number,number>();
  let found=false;
  const clauses=text.split(/[;\n]|(?<=[.!?])\s+|\bbut\b/i);
  for(const clause of clauses){
    // Reported speech, hypotheticals and conditions do not instruct an edit.
    if(/\b(?:if|unless|maybe|might|consider|thinking|suppose|example|said|says|told|don't|do not|not to|without)\b/i.test(clause))continue;
    const verb=action==="addition"?"(?:add|include|book|reserve)":"(?:remove|drop)";
    const request=new RegExp(`(?:^(?:(?:yes|yep|okay|ok|sure|please)[,\\s]+)*|\\b(?:please|go ahead(?: and)?|(?:can|could|would) you|(?:I|we)(?:'d| would) like (?:you )?to|(?:I|we) want (?:you )?to)\\s+)${verb}\\s+(.+)`,"i").exec(clause);
    if(!request)continue;
    let object=request[1].replace(/\b(?:at|for)\s*£\s*\d+(?:,\d{3})*(?:\.\d{1,2})?(?:\s+(?:extra|more|additional))?/gi,"").replace(/\b(?:to|on|in)\s+(?:(?:my|our|the|this)\s+)?(?:booking|basket|order)\b.*$/i,"")
      .replace(/\b(?:for|from|at|as quoted|together|only|just)\b.*$/i,"").trim();
    if(action==="removal")object=object.replace(/\s+(?:less|reduction)[.!?]*$/i,"");
    if(/\bor\b/i.test(object))return {named:true,matches:false,items:null};
    if(/^(?:it|them|both|these|those|that|this|the (?:quoted |complete )?setup|the quote)[.!?\s]*$/i.test(object))continue;
    found=true;
    const whole=namedSelection(object,lines,action);
    if(whole){selected.set(whole.line.product_id,(selected.get(whole.line.product_id)??0)+whole.qty);continue;}
    for(const raw of object.split(/\s+(?:and|plus)\s+|\s*[,+]\s*/i).filter(s=>s.trim())){
      const part=namedSelection(raw,lines,action);
      if(!part)return {named:true,matches:false,items:null};
      selected.set(part.line.product_id,(selected.get(part.line.product_id)??0)+part.qty);
    }
  }
  const items=[...selected].map(([product_id,qty])=>({product_id,qty}));
  return {named:found,matches:found && keys(items)===keys(lines),items:found?items:null};
}

function pricesMatch(text:string, quote:AdditionAcceptanceQuote, ownerQuote=false){
  const claims=money(text);
  if(!claims.length)return {present:false,matches:false};
  let complete=false;
  const priced=new Set<number>();
  for(const claim of claims){
    const before=text.slice(Math.max(0,claim.index-35),claim.index);
    const after=text.slice(claim.index+claim.length,claim.index+claim.length+30);
    const extra=/\b(?:extra|additional|more|adding|addition)\s*(?:cost|of|is|to|at|comes to|:)?\s*$/i.test(before) || /^\s*(?:extra|additional|more)\b/i.test(after);
    const total=/\b(?:total|booking|basket|order)\s*(?:of|is|to|at|comes to|:)??\s*$/i.test(before) || /^\s*(?:total|in total)\b/i.test(after);
    const current=/\b(?:current|existing|original|base)\b/i.test(before+after);
    if(current && sameMoney(claim.amount,quote.total_gbp-quote.additional_cost_gbp))continue;
    if(extra){if(!sameMoney(claim.amount,quote.additional_cost_gbp))return {present:true,matches:false};complete=true;continue;}
    if(total){if(!sameMoney(claim.amount,quote.total_gbp))return {present:true,matches:false};complete=true;continue;}
    if(claims.length===1 && sameMoney(claim.amount,quote.additional_cost_gbp)){complete=true;continue;}
    // Itemised prices must identify their actual Native commercial line.
    const clause=text.slice(Math.max(text.lastIndexOf('.',claim.index),text.lastIndexOf(';',claim.index),text.lastIndexOf(',',claim.index),(text.lastIndexOf(' and ',claim.index)<0?-1:text.lastIndexOf(' and ',claim.index)+4),(text.lastIndexOf(' plus ',claim.index)<0?-1:text.lastIndexOf(' plus ',claim.index)+5))+1,
      Math.min(...[text.indexOf('.',claim.index+claim.length),text.indexOf(';',claim.index+claim.length),text.indexOf(',',claim.index+claim.length),text.indexOf(' and ',claim.index+claim.length),text.indexOf(' plus ',claim.index+claim.length),text.length].filter(i=>i>=0)));
    const daily=/^\s*(?:\/\s*day|per day|a day|daily)\b/i.test(after) || /\bdaily (?:rate|price)\s*(?:is|of|:)?\s*$/i.test(before);
    const days=(Date.parse(quote.end_date)-Date.parse(quote.start_date))/86400000+1;
    const line=quote.lines.find(l=>hasLineName(clause,l) && sameMoney(claim.amount,daily?(l.daily_rate_gbp??l.line_total_gbp/(l.qty*days)):l.line_total_gbp));
    if(line){priced.add(line.product_id);continue;}
    if(ownerQuote && daily && quote.lines.some(l=>hasLineName(clause,l)&&l.base_daily_rate_gbp!=null&&sameMoney(claim.amount,l.base_daily_rate_gbp)))continue;
    return {present:true,matches:false};
  }
  return {present:true,matches:complete||priced.size===quote.lines.length};
}

export function matchesQuotedDates(text:string, quote:{start_date:string;end_date:string}){
  const iso=text.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  if(iso?.length && (iso[0]!==quote.start_date || (iso.length===1?iso[0]:iso.at(-1))!==quote.end_date))return false;
  // Relative dates require an independently resolved date request rather than
  // silently applying an addition to the existing period.
  if(/\b(?:today|tomorrow|next week|next month|next weekend)\b/i.test(text))return false;
  const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
  const dates=[...text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:(?:to|through|until|–|-)\s*(\d{1,2})(?:st|nd|rd|th)?\s*)?(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(20\d{2}))?\b/gi)];
  if(!dates.length)return true;
  const resolved=dates.flatMap(m=>[m[1],...(m[2]?[m[2]]:[])].map(d=>`${m[4]??quote.start_date.slice(0,4)}-${String(months.indexOf(m[3].toLowerCase())+1).padStart(2,'0')}-${d.padStart(2,'0')}`));
  return resolved[0]===quote.start_date && resolved.at(-1)===quote.end_date;
}

/** Decide against real selections and Native quote terms, never model-declared
 * permission. Archived quote evidence alone does not mean it was offered. */
export function acceptsAddition(text:string,quote:AdditionAcceptanceQuote,owner?:{body_text:string;quoted_additions?:SentAdditionProposal[]}){
  const message=normal(text.replace(/```[\s\S]*?```/g," ").replace(/["“][^"”]*\b(?:please|add|include|book|reserve|go ahead)\b[^"”]*["”]/gi," "));
  if(/\b(?:after|when|unless|later|wait|hold off|before I confirm)\b/i.test(message))return false;
  const direct=directItemSelection(message,quote.lines);
  const price=pricesMatch(message,quote);
  if(!matchesQuotedDates(message,quote) || (price.present&&!price.matches))return false;
  if(direct.named && !direct.matches)return false;
  if(direct.matches && price.matches)return true;
  if(!owner)return false;
  const candidates=(owner.quoted_additions??[]).filter(p=>p.context_key===quote.context_key &&
    p.start_date===quote.start_date && p.end_date===quote.end_date && keys(p.items)===keys(quote.lines) &&
    sameMoney(p.total_gbp,quote.total_gbp) && sameMoney(p.additional_cost_gbp,quote.additional_cost_gbp) &&
    quote.lines.every(line=>hasLineName(owner.body_text,line)) && pricesMatch(owner.body_text,quote,true).matches);
  if(candidates.length!==1)return false;
  if(direct.matches)return true;
  if(/\b(?:if|unless|maybe|might|not|don't|do not|two of|two each|double|triple|quantity|qty)\b/i.test(message))return false;
  const reference=/^(?:(?:yes|yep|yeah|okay|ok|sure|perfect)[,\s!]+)?(?:please\s+)?(?:go ahead(?: and (?:add|book|include) (?:it|them|both|that|those|these))?|(?:add|book|include) (?:it|them|both|that|those|these|the (?:quoted |complete )?setup))[.!\s]*(?:thanks|thank you)?[.!\s]*$/i.test(message);
  const bare=/^(?:yes|yep|yeah|okay|ok|sure)[,!\s]*(?:please)?[.!\s]*$/i.test(message);
  if(!reference&&!bare)return false;
  const unambiguous=(owner.quoted_additions??[]).length===1 && !/\b(?:or|alternatively|either|instead|options?)\b/i.test(owner.body_text);
  if(bare)return unambiguous;
  // "Both" is meaningful only for exactly two quoted lines; unnamed references
  // cannot choose between separate offers in the same owner message.
  if(/\bboth\b/i.test(message))return quote.lines.length===2 && unambiguous;
  return unambiguous;
}
