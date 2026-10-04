import { minimumRentalContext, minimumRentalPrompt, type MinimumRentalContext } from "../../convex/lib/minimum_rental";
import type { PriceEvidence } from "../../convex/lib/price_claims";
import type { RecommendationQuoteEvidence, StockQuoteEvidence } from "../../convex/lib/renter_draft_evidence";
import { recommendationRequirementsKey, type RecommendationRequirement } from "../../convex/lib/recommendation_qualification";
import { createHash } from "node:crypto";
import { renterPriceEvidence } from "./renter-price-evidence";
import type { ToolReceipt } from "./renter-tool-evidence";
import type { RenterBotOutput } from "./renter-bot-output";
import { renterItemNames } from "../../convex/lib/renter_item_names";
import { shortItemName } from "../../convex/lib/item_display_name";

export type NativeQuoteScope={threadId:string;accountSlug:string;requestMessageId?:string;rentalStage?:string;minimumRentalThreshold?:number;queryRevision?:()=>number;recommendationRequirements?:RecommendationRequirement[]};
export type NativeInquiryQuote={quote_key:string;display_text:string;request_revision:number;commercial_context?:MinimumRentalContext;commercial_guidance?:string};
const record=(value:unknown):Record<string,unknown>|null=>value && typeof value==="object" && !Array.isArray(value)?value as Record<string,unknown>:null;
const money=(value:number)=>`£${value.toFixed(2).replace(/\.00$/,"")}`;
const date=(iso:string)=>new Intl.DateTimeFormat("en-GB",{day:"numeric",month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(`${iso}T12:00:00Z`));
const itemIdentity=(name:string)=>renterItemNames(name).map(n=>n.toLowerCase().replace(/[^a-z0-9]+/g," ").trim());
const monetaryProse=/(?:[£$€]\s*\d|\b\d+(?:\.\d+)?\s*(?:GBP|pounds?|pence)\b|\b(?:price|costs?|total|rate|budget|charge)\b[^.!?\n]{0,24}\b\d+(?:\.\d+)?\b)/i;

/** Identity and arithmetic come from the same Native joint check, not model
 * text or a model-supplied price. The key selects this request's receipt only. */
export function nativeInquiryQuote(value:unknown,scope:NativeQuoteScope,readRevision=scope.queryRevision?.()):NativeInquiryQuote|null {
  if(scope.rentalStage!=="INQUIRY" || !scope.queryRevision || readRevision===undefined || !Number.isInteger(readRevision) || readRevision!==scope.queryRevision())return null;
  const result=record(value),q=record(result?.quote),basket=record(result?.basket);
  if(!result || !q || result.account_slug!==scope.accountSlug || basket?.available!==true ||
    !Array.isArray(q.unpriced) || q.unpriced.length || !Array.isArray(result.components) || !result.components.length)return null;
  if(result.rental_stage!==undefined && result.rental_stage!==scope.rentalStage)return null;
  const requirementsKey=recommendationRequirementsKey(scope.recommendationRequirements??[]),qualification=record(result.technical_qualification);
  if(scope.recommendationRequirements?.length && (qualification?.verified!==true||qualification.requirements_key!==requirementsKey))return null;
  const physical=result.components.map(record);
  if(physical.some(c=>!c || c.owned!==true || c.is_marketing_only!==false || c.available!==true ||
    c.start_date!==result.start_date || c.end_date!==result.end_date || typeof c.item_id!=="string" || typeof c.item_name!=="string" ||
    !Number.isInteger(c.requested_units) || (c.requested_units as number)<1 || typeof c.free_units!=="number" || c.free_units<(c.requested_units as number)))return null;
  if(new Set(physical.map(c=>c!.item_id)).size!==physical.length)return null;
  const paired=physical.some(c=>["camera","camera_body"].includes(String(c!.kind)))&&physical.some(c=>c!.kind==="lens");
  if(paired && (record(qualification?.setup)?.status!=="match" || qualification?.verified!==true))return null;
  const identity=physical.map(c=>[c!.item_id,c!.item_name,c!.requested_units]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  if(JSON.stringify(identity)!==result.physical_identity_key)return null;
  const prices=renterPriceEvidence([{tool:"check_basket_availability",call_id:"native-render",result}],[],scope.threadId);
  const total=prices.find(p=>p.kind==="basket"&&p.quote_role==="inquiry");
  if(!total?.items?.length || !total.start_date || !total.end_date || total.total_gbp==null || !total.days || !Array.isArray(q.lines))return null;
  const lines=q.lines.map(record);
  if(lines.some(l=>!l || typeof l.name!=="string" || /[\r\n]/.test(l.name) || !Number.isInteger(l.qty) || (l.qty as number)<1 || (l.qty as number)>20 ||
    !physical.some(c=>c!.requested_units===l.qty&&itemIdentity(c!.item_name as string).some(n=>itemIdentity(l.name as string).includes(n))) ||
    !prices.some(p=>p.kind==="rental"&&p.call_id===`native-render:line:${l.product_id}`&&p.quantity===l.qty&&p.total_gbp===l.line_total_gbp)))return null;
  const quote_key=`inquiry_${createHash("sha256").update(JSON.stringify([scope.threadId,scope.accountSlug,scope.requestMessageId??"",readRevision,requirementsKey,result.physical_identity_key,total.start_date,total.end_date,
    lines.map(l=>[l!.product_id,l!.name,l!.qty,l!.line_total_gbp]),total.total_gbp])).digest("hex").slice(0,32)}`;
  const period=total.start_date===total.end_date?date(total.start_date):`${date(total.start_date)} to ${date(total.end_date)}`;
  const rows=lines.map(l=>`- ${l!.qty} × ${shortItemName(l!.name as string)}: ${money(l!.line_total_gbp as number)}`);
  const commercial_context=typeof scope.minimumRentalThreshold==="number"?minimumRentalContext("INQUIRY",scope.minimumRentalThreshold,[],{items:[]},[total]):undefined;
  return {quote_key,request_revision:readRevision,...(commercial_context?{commercial_context,commercial_guidance:minimumRentalPrompt(commercial_context)}:{}),display_text:`For ${total.days} ${total.days===1?"day":"days"} (${period}):\n${rows.join("\n")}\nTotal: ${money(total.total_gbp)}`};
}

/** Render before any guard or persistence. Unknown references, hand-written
 * money in structured prose, and receipts from before a write fail closed. */
export function renderNativeQuoteReply(output:RenterBotOutput,receipts:ToolReceipt[],scope:NativeQuoteScope):
  {ok:true;draft:string;quote_keys:string[];recommendation_quotes:RecommendationQuoteEvidence[];stock_quotes:StockQuoteEvidence[];commercial_quotes:PriceEvidence[]}|{ok:false;reason:string} {
  if(output.needs_human)return {ok:true,draft:"",quote_keys:[],recommendation_quotes:[],stock_quotes:[],commercial_quotes:[]};
  const quotes=new Map<string,NativeInquiryQuote>();
  const stock=new Map<string,StockQuoteEvidence>();
  const qualified=new Map<string,RecommendationQuoteEvidence>();
  const commercial=new Map<string,PriceEvidence>();
  for(const receipt of receipts)if(receipt.tool==="check_basket_availability") {
    const descriptor=record(receipt.result.renter_quote);
    if(typeof descriptor?.request_revision!=="number")continue;
    const quote=nativeInquiryQuote(receipt.result,scope,descriptor.request_revision);
    if(quote && descriptor.quote_key===quote.quote_key){
      quotes.set(quote.quote_key,quote);
      stock.set(quote.quote_key,{quote_key:quote.quote_key,start_date:receipt.result.start_date as string,end_date:receipt.result.end_date as string,
        items:(receipt.result.components as Array<{item_id:string;item_name:string;requested_units:number}>).map(c=>({item_id:c.item_id,name:c.item_name,quantity:c.requested_units}))});
      const basket=renterPriceEvidence([receipt],[],scope.threadId).find(p=>p.kind==="basket"&&p.source==="native_inquiry_basket"&&p.quote_role==="inquiry");
      if(basket)commercial.set(quote.quote_key,basket);
      if(scope.recommendationRequirements?.length || record(record(receipt.result.technical_qualification)?.setup)?.applied===true)qualified.set(quote.quote_key,{quote_key:quote.quote_key,
        requirements:structuredClone(scope.recommendationRequirements??[]),
        items:(receipt.result.components as Array<{item_id:string;item_name:string;requested_units:number}>).map(c=>({item_id:c.item_id,name:c.item_name,quantity:c.requested_units}))});
    }
  }
  if(!output.reply_parts?.length) {
    if(scope.rentalStage==="INQUIRY" && receipts.some(r=>r.tool==="check_basket_availability"&&record(r.result.quote)?.source==="native_inquiry_basket") && monetaryProse.test(output.draft))return {ok:false,reason:"Use the Native quote selection for inquiry prices"};
    return {ok:true,draft:output.draft,quote_keys:[],recommendation_quotes:[],stock_quotes:[],commercial_quotes:[]};
  }
  if(output.draft.trim())return {ok:false,reason:"Structured reply parts cannot be mixed with a second draft"};
  const used=new Set<string>(),parts:string[]=[];
  for(const part of output.reply_parts) {
    if(part.type==="text") {
      if(monetaryProse.test(part.text))return {ok:false,reason:"Financial amounts must come from Native quote parts"};
      if(part.text.trim())parts.push(part.text.trim());
    } else {
      const quote=quotes.get(part.quote_key);
      if(!quote || used.has(part.quote_key))return {ok:false,reason:"Quote selection is missing, stale or duplicated"};
      used.add(part.quote_key);parts.push(quote.display_text);
    }
  }
  if(!parts.length)return {ok:false,reason:"The rendered reply is empty"};
  return {ok:true,draft:parts.join("\n\n"),quote_keys:[...used],stock_quotes:[...used].map(key=>stock.get(key)!),commercial_quotes:[...used].flatMap(key=>commercial.has(key)?[commercial.get(key)!]:[]),recommendation_quotes:[...used].flatMap(key=>qualified.has(key)?[qualified.get(key)!]:[])};
}
