import {nativeInformationForText} from "./native_information_blocks";
import {nativeFinancialBlockPositions as occurrences} from "./native_financial_blocks";
import {inclusiveRentalDays} from "./hygglo_pricing";
import {shortItemName} from "./item_display_name";
import {bookingRecordText} from "./booking_record";
import {REFERRAL_RESTORE_OFFER} from "./referral_offer";
import type {DraftEvidence,StockQuoteEvidence} from "./renter_draft_evidence";

/** Financial prose belongs in Native blocks, including during human review. */
export const monetaryProse=/(?:[£$€]\s*\d|\b\d+(?:\.\d+)?\s*(?:GBP|pounds?|pence)\b|\b(?:price|costs?|total|rate|budget|charge)\b[^.!?\n]{0,24}\b\d+(?:\.\d+)?\b)/i;
const money=(value:number)=>`£${value.toFixed(2).replace(/\.00$/,"")}`;
const date=(iso:string)=>new Intl.DateTimeFormat("en-GB",{day:"numeric",month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(`${iso}T12:00:00Z`));

/** One serializer is used by the renderer and send-time evidence matching. */
export function inquiryQuoteText(quote:Pick<StockQuoteEvidence,"start_date"|"end_date"|"listing_quote">):string|null{
 const days=inclusiveRentalDays(quote.start_date,quote.end_date),priced=quote.listing_quote;
 if(!days||!priced||!priced.lines.length||!Number.isFinite(priced.total_gbp)||priced.lines.some(l=>!Number.isFinite(l.total_gbp)||!l.name||/[\r\n]/.test(l.name)||!Number.isInteger(l.quantity)||l.quantity<1))return null;
 const period=quote.start_date===quote.end_date?date(quote.start_date):`${date(quote.start_date)} to ${date(quote.end_date)}`;
 const rows=priced.lines.map(l=>`- ${l.quantity} × ${shortItemName(l.name)}: ${money(l.total_gbp)}`);
 return `For ${days} ${days===1?"day":"days"} (${period}):\n${rows.join("\n")}\nTotal: ${money(priced.total_gbp)}`;
}

/** A human may change surrounding text or remove an option. Each surviving
 * financial/action block must still be the exact server-rendered selection.
 * Legacy evidence without a rendered block remains on the old review path. */
export function inquiryOffersForText(evidence:DraftEvidence|undefined,savedText:string|undefined,text:string):{supported:boolean;ok:boolean;quotes:StockQuoteEvidence[]}{
 const quotes=evidence?.stock_quotes??[];
 const values=nativeInformationForText(evidence,savedText,text);
 const supported=quotes.some(q=>q.offer_text!==undefined)||!!evidence?.replacement_value_comparisons?.length||!!evidence?.budget_price_checks?.length;
 if(!values.ok)return {supported:true,ok:false,quotes:[]};
 if(!supported)return {supported:false,ok:!!savedText&&savedText.trim()===text.trim(),quotes};
 const canonical=quotes.every(q=>{
  const block=inquiryQuoteText(q);
  return !!block&&q.offer_text===(q.referral_code?`${block}\n\n${REFERRAL_RESTORE_OFFER}`:block);
 });
 if(!canonical||new Set(quotes.map(q=>q.offer_text)).size!==quotes.length)return {supported:true,ok:false,quotes:[]};
 let remainder=values.claim_text;const selected:Array<{quote:StockQuoteEvidence;at:number}>=[];
 for(const quote of quotes){
  const block=quote.offer_text!;
  if(!savedText||occurrences(savedText,block).length!==1)return {supported:true,ok:false,quotes:[]};
  const positions=occurrences(text,block),count=positions.length;
  if(count>1)return {supported:true,ok:false,quotes:[]};
  if(count===1){selected.push({quote,at:positions[0]});remainder=remainder.replace(block,"");}
 }
 if(evidence?.booking_record){
  const block=bookingRecordText(evidence.booking_record);
  if(savedText&&occurrences(savedText,block).length===1&&occurrences(text,block).length===1)remainder=remainder.replace(block,"");
 }
 if(monetaryProse.test(remainder))return {supported:true,ok:false,quotes:[]};
 return {supported:true,ok:true,quotes:selected.sort((a,b)=>a.at-b.at).map(s=>s.quote)};
}
