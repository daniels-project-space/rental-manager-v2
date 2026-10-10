import {nativeInformationForText} from "./native_information_blocks";
import {nativeFinancialBlockPositions as occurrences} from "./native_financial_blocks";
import {inclusiveRentalDays} from "./hygglo_pricing";
import {shortItemName} from "./item_display_name";
import {bookingRecordText} from "./booking_record";
import {REFERRAL_RESTORE_OFFER} from "./referral_offer";
import type {DraftEvidence,StockQuoteEvidence} from "./renter_draft_evidence";

/** Financial prose belongs in Native blocks, including during human review.
 * Currency is unambiguous. A bare amount needs a nearby financial term, but
 * calendar dates and measured values (fps, days, capacity, etc.) are not money. */
const explicitMoney=/(?:[£$€]\s*\d|\b\d+(?:\.\d+)?\s*(?:GBP|pounds?|pence)\b)/i;
const financialTerm=/\b(?:price|costs?|total|rate|budget|charge)\b/gi;
const monthName="(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const calendarDate=new RegExp(`\\b(?:(${monthName})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*[–—-]\\s*(\\d{1,2})(?:st|nd|rd|th)?)?(?:,?\\s+(\\d{4}))?|(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*[–—-]\\s*(\\d{1,2})(?:st|nd|rd|th)?)?\\s+(?:of\\s+)?(${monthName})\\.?(?:,?\\s+(\\d{4}))?|\\b(\\d{4})-(\\d{1,2})-(\\d{1,2})|\\b(\\d{1,2})/(\\d{1,2})/(\\d{4}))\\b`,"gi");
function validCalendarDay(year:number,month:number,day:number){
 const d=new Date(Date.UTC(year,month-1,day));
 return d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day;
}
function calendarDateSpans(text:string){
 const spans:Array<[number,number]>=[];
 for(const m of text.matchAll(calendarDate)){
  const v=m;
  const i=v.index??0,s=v[0];let valid=false;
  const monthNumber=(name:string)=>new Date(Date.parse(`${name} 1, 2000 UTC`)).getUTCMonth()+1;
  if(v[1]&&v[2]){const month=monthNumber(v[1]),year=Number(v[4]??2000);valid=validCalendarDay(year,month,Number(v[2]))&&(!v[3]||validCalendarDay(year,month,Number(v[3])));}
  else if(v[5]&&v[7]){const month=monthNumber(v[7]),year=Number(v[8]??2000);valid=validCalendarDay(year,month,Number(v[5]))&&(!v[6]||validCalendarDay(year,month,Number(v[6])));}
  else if(v[9])valid=validCalendarDay(Number(v[9]),Number(v[10]),Number(v[11]));
  else if(v[12])valid=validCalendarDay(Number(v[14]),Number(v[13]),Number(v[12]));
  if(valid)spans.push([i,i+s.length]);
 }
 return spans;
}
function hasCalendarDateAt(index:number,spans: [number,number][]) {
 return spans.some(([start,end])=>index>=start&&index<end);
}
function hasClockTimeAt(index:number,text:string){
 for(const time of text.matchAll(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g)){
  const start=time.index??0;
  if(index>=start&&index<start+time[0].indexOf(":"))return true;
 }
 return false;
}
export function monetaryProse(text:string):boolean{
 if(explicitMoney.test(text))return true;
 const dates=calendarDateSpans(text);
 for(const term of text.matchAll(financialTerm)){
  const start=(term.index??0)+term[0].length;
  const tail=text.slice(start,start+24).split(/[.!?\n]/,1)[0]??"";
  const amount=/\b\d+(?:\.\d+)?\b/.exec(tail);
  if(!amount)continue;
  const absolute=start+(amount.index??0);
  if(hasCalendarDateAt(absolute,dates)||hasClockTimeAt(absolute,text))continue;
  const after=tail.slice((amount.index??0)+amount[0].length);
  if(/^\s*(?:fps|frames?\s+per\s+second|days?|nights?|hours?|minutes?|seconds?|mm|cm|m|kg|g|wh|w|gb|tb|%|units?|items?)\b/i.test(after))continue;
  return true;
 }
 return false;
}
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
 if(monetaryProse(remainder))return {supported:true,ok:false,quotes:[]};
 return {supported:true,ok:true,quotes:selected.sort((a,b)=>a.at-b.at).map(s=>s.quote)};
}
