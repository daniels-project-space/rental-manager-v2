import {inquiryOffersForText,inquiryQuoteText,monetaryProse} from "../../convex/lib/native_inquiry_offer";
import type {RentalRequest} from "../../convex/lib/rental_request";
import { bookingRecordText, type BookingRecord } from "../../convex/lib/booking_record";
import { REFERRAL_RESTORE_OFFER } from "../../convex/lib/referral_offer";
import { FRIEND_BOOKING_NEXT_STEPS } from "../../convex/lib/verification_failure";
import {isClosedRentalStage} from "../../convex/lib/rental_stage";
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
import { renterAccountVoice } from "../../convex/lib/renter_account_voice";

export type NativeQuoteScope={bookingRecord?:NativeBookingRecord;referralContext?:{ok?:boolean;code?:string;already_linked?:boolean;items?:Array<{product_id:number}>};referralContextRevision?:number;threadId:string;accountSlug:string;requestMessageId?:string;rentalRequest?:RentalRequest;rentalStage?:string;minimumRentalThreshold?:number;queryRevision?:()=>number;queryReadRevision?:(value:unknown)=>number|undefined;recommendationRequirements?:RecommendationRequirement[]};
export type NativeBookingRecord={record_key:string;display_text:string;request_revision:number;record:BookingRecord};
export function nativeBookingRecord(record:BookingRecord|null|undefined,scope:NativeQuoteScope,readRevision=scope.queryRevision?.()):NativeBookingRecord|null {
 const revision=scope.queryRevision?.();
 if(readRevision===undefined||readRevision!==revision)return null;
 if(!record||!isClosedRentalStage(scope.rentalStage)||record.stage!==scope.rentalStage||record.thread_id!==scope.threadId||record.account_slug!==scope.accountSlug||revision===undefined||!Number.isInteger(revision))return null;
 const record_key=`record_${createHash("sha256").update(JSON.stringify([record,scope.requestMessageId??"",revision])).digest("hex").slice(0,32)}`;
 return {record_key,request_revision:revision,display_text:bookingRecordText(record),record};
}
export type NativeInquiryQuote={quote_key:string;display_text:string;request_revision:number;commercial_context?:MinimumRentalContext;commercial_guidance?:string};
const record=(value:unknown):Record<string,unknown>|null=>value && typeof value==="object" && !Array.isArray(value)?value as Record<string,unknown>:null;
const itemIdentity=(name:string)=>renterItemNames(name).map(n=>n.toLowerCase().replace(/[^a-z0-9]+/g," ").trim());

/** Identity and arithmetic come from the same Native joint check, not model
 * text or a model-supplied price. The key selects this request's receipt only. */
export function nativeInquiryQuote(value:unknown,scope:NativeQuoteScope,readRevision=scope.queryRevision?.()):NativeInquiryQuote|null {
  const result=record(value),q=record(result?.quote),basket=record(result?.basket);
  const separate=result?.booking_use==="separate"&&result.new_inquiry===true;
  if(separate&&result?.rental_stage!==scope.rentalStage)return null;
  if(scope.rentalStage!=="INQUIRY" && !isClosedRentalStage(scope.rentalStage) && !separate || !scope.queryRevision || readRevision===undefined || !Number.isInteger(readRevision) || readRevision!==scope.queryRevision())return null;
  if(isClosedRentalStage(scope.rentalStage) && (!separate&&result?.booking_use!=="standalone" || result?.rental_stage!==scope.rentalStage))return null;
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
  const quote_key=`inquiry_${createHash("sha256").update(JSON.stringify([scope.threadId,scope.accountSlug,scope.requestMessageId??"",scope.rentalRequest??null,readRevision,requirementsKey,result.physical_identity_key,total.start_date,total.end_date,
    lines.map(l=>[l!.product_id,l!.name,l!.qty,l!.line_total_gbp]),total.total_gbp])).digest("hex").slice(0,32)}`;
  const display_text=inquiryQuoteText({start_date:total.start_date,end_date:total.end_date,listing_quote:{total_gbp:total.total_gbp,
    lines:lines.map(l=>({product_id:l!.product_id as number,name:l!.name as string,quantity:l!.qty as number,total_gbp:l!.line_total_gbp as number}))}});
  if(!display_text)return null;
  const commercial_context=typeof scope.minimumRentalThreshold==="number"?minimumRentalContext("INQUIRY",scope.minimumRentalThreshold,[],{items:[]},[total]):undefined;
  return {quote_key,request_revision:readRevision,...(commercial_context?{commercial_context,commercial_guidance:minimumRentalPrompt(commercial_context)}:{}),display_text};
}

/** Keep unresolved Native kit facts with the equipment being discussed.
 * Stock mapping and a valid price cannot settle supplied storage contents. */
function kitReviewNotices(draft:string,receipts:ToolReceipt[],scope:NativeQuoteScope) {
 const latest=new Map<string,{name:string;review:boolean}>();
 const setups=new Map<string,{name:string;review:boolean;pairing:boolean}>();
 for(const receipt of receipts) {
  const r=receipt.result;
  if(!receipt.call_id||r.error||r.ok===false||r.account_slug!==scope.accountSlug||r.thread_id!==scope.threadId)continue;
  const revision=scope.queryReadRevision?.(r);
  if(revision!==undefined&&scope.queryRevision&&revision!==scope.queryRevision())continue;
  if(receipt.tool==="check_basket_availability"&&r.available===true&&r.preview_only===true&&Array.isArray(r.components)) {
   const technical=record(r.technical_qualification),setup=record(technical?.setup);
   const review=technical?.verified===false&&Array.isArray(r.owner_checks)&&r.owner_checks.some(c=>["lens_recommendation","camera_recommendation"].includes(String(record(c)?.kind)));
   for(const value of r.components) {
    const item=record(value);
    if(!item||!["camera","camera_body"].includes(String(item.kind))||typeof item.item_name!=="string")continue;
    setups.set(itemIdentity(item.item_name)[0],{name:item.item_name,review,pairing:setup?.status==="unknown"});
   }
  }
  const recommendations=receipt.tool==="find_owned_alternatives";
  const rows=recommendations?r.alternatives:receipt.tool==="get_listing_context"?r.items:null;
  if(!Array.isArray(rows))continue;
  const check=record(r.owner_check);
  for(const value of rows) {
   const item=record(value);if(!item||typeof item.storage_contents_verification_required!=="boolean")continue;
   const name=recommendations?item.name:item.inventory_name;
   if(typeof name!=="string"||!name.trim())continue;
   const eligible=recommendations?item.mapping_complete===true&&check?.kind==="kit_recommendation"&&
    Array.isArray(check.candidate_product_ids)&&check.candidate_product_ids.includes(item.product_id):
    item.owned!==false&&Array.isArray(r.owner_checks)&&r.owner_checks.some(c=>record(c)?.kind==="listing_mapping"&&record(c)?.product_id===item.product_id);
   latest.set(itemIdentity(name)[0],{name,review:item.storage_contents_verification_required&&eligible});
  }
 }
 const text=` ${draft.toLowerCase().replace(/[^a-z0-9]+/g," ").trim()} `;
 const mentioned=(name:string)=>itemIdentity(name).some(label=>text.includes(` ${label} `));
 const speaker=renterAccountVoice(scope.accountSlug).firstPerson?"I":"We";
 return [...[...latest.values()].filter(item=>item.review&&mentioned(item.name))
  .map(item=>`The supplied storage for ${shortItemName(item.name)} still needs owner confirmation of its type, capacity and quantity.`),
  ...[...setups.values()].filter(item=>item.review&&mentioned(item.name))
   .map(item=>`${speaker} need to confirm ${item.pairing?"the camera and lens pairing":"the required specifications"} for the ${shortItemName(item.name)} kit before ${speaker.toLowerCase()==="i"?"I":"we"} can give you the full quote.`)]
  .filter(notice=>!draft.includes(notice));
}
/** Render before any guard or persistence. Unknown references, hand-written
 * money in structured prose, and receipts from before a write fail closed. */
export function renderNativeQuoteReply(output:RenterBotOutput,receipts:ToolReceipt[],scope:NativeQuoteScope):
  {ok:true;draft:string;booking_record?:BookingRecord;quote_keys:string[];recommendation_quotes:RecommendationQuoteEvidence[];stock_quotes:StockQuoteEvidence[];commercial_quotes:PriceEvidence[]}|{ok:false;reason:string} {
  if(output.needs_human)return {ok:true,draft:"",quote_keys:[],recommendation_quotes:[],stock_quotes:[],commercial_quotes:[]};
  // A completed referral action carries its own next steps. Keep these with
  // the Native transaction rather than relying on the model to repeat them.
  const restoredReferral=receipts.some(({tool,result})=>{
    if(tool!=="restore_referral_basket" || result.ok!==true || result.action_performed!==true ||
      result.source!=="native_lab_amendment" || result.thread_id!==scope.threadId || result.account_slug!==scope.accountSlug ||
      record(result.context_transition)?.source!=="native_lab_amendment")return false;
    const quote=record(result.verified_inquiry_quote),descriptor=record(quote?.renter_quote);
    return typeof descriptor?.request_revision==="number" && typeof descriptor.quote_key==="string" &&
      nativeInquiryQuote(quote,scope,descriptor.request_revision)?.quote_key===descriptor.quote_key;
  });
  const withNativeContext=(draft:string)=>[draft,...kitReviewNotices(draft,receipts,scope),...(restoredReferral?[FRIEND_BOOKING_NEXT_STEPS]:[])].filter(Boolean).join("\n\n");
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
      stock.set(quote.quote_key,{quote_key:quote.quote_key,offer_text:quote.display_text,...(scope.rentalRequest?{rental_request:structuredClone(scope.rentalRequest)}:{}),start_date:receipt.result.start_date as string,end_date:receipt.result.end_date as string,
        ...(isClosedRentalStage(scope.rentalStage)||receipt.result.new_inquiry===true?{new_inquiry:true as const}:{}),
        listing_quote:{total_gbp:(receipt.result.quote as {total_gbp:number}).total_gbp,
          lines:(receipt.result.quote as {lines:Array<{product_id:number;name:string;qty:number;line_total_gbp:number}>}).lines.map(l=>({product_id:l.product_id,name:l.name,quantity:l.qty,total_gbp:l.line_total_gbp}))},
        items:(receipt.result.components as Array<{item_id:string;item_name:string;requested_units:number}>).map(c=>({item_id:c.item_id,name:c.item_name,quantity:c.requested_units}))});
      const basket=renterPriceEvidence([receipt],[],scope.threadId).find(p=>p.kind==="basket"&&p.source==="native_inquiry_basket"&&p.quote_role==="inquiry");
      if(basket)commercial.set(quote.quote_key,basket);
      if(scope.recommendationRequirements?.length || record(record(receipt.result.technical_qualification)?.setup)?.applied===true)qualified.set(quote.quote_key,{quote_key:quote.quote_key,
        requirements:structuredClone(scope.recommendationRequirements??[]),
        items:(receipt.result.components as Array<{item_id:string;item_name:string;requested_units:number}>).map(c=>({item_id:c.item_id,name:c.item_name,quantity:c.requested_units}))});
    }
  }
  if(!output.reply_parts?.length) {
    if(receipts.some(r=>r.result.new_inquiry===true||r.tool==="check_basket_availability"&&(record(r.result.quote)?.source==="native_inquiry_basket"||scope.rentalStage==="INQUIRY")) && monetaryProse.test(output.draft))return {ok:false,reason:"Use the Native quote selection for inquiry prices"};
    return {ok:true,draft:withNativeContext(output.draft),quote_keys:[],recommendation_quotes:[],stock_quotes:[],commercial_quotes:[]};
  }
  if(output.draft.trim())return {ok:false,reason:"Structured reply parts cannot be mixed with a second draft"};
  const used=new Set<string>(),parts:string[]=[];
  let selectedRecord:BookingRecord|undefined;
  for(const part of output.reply_parts) {
    if(part.type==="text") {
      if(monetaryProse.test(part.text))return {ok:false,reason:"Financial amounts must come from Native quote parts"};
      if(part.text.trim())parts.push(part.text.trim());
    } else if(part.type==="booking_record") {
      const descriptor=scope.bookingRecord;
      if(selectedRecord||!descriptor||descriptor.record_key!==part.record_key||descriptor.request_revision!==scope.queryRevision?.()||
        nativeBookingRecord(descriptor.record,scope)?.record_key!==part.record_key)return {ok:false,reason:"Booking record selection is missing, stale or duplicated"};
      selectedRecord=descriptor.record;parts.push(bookingRecordText(descriptor.record));
    } else {
      const quote=quotes.get(part.quote_key);
      if(!quote || used.has(part.quote_key))return {ok:false,reason:"Quote selection is missing, stale or duplicated"};
      if(part.offer_action) {
        const referral=scope.referralContext,selected=stock.get(part.quote_key)!;
        // A fresh quote cannot make a pre-write context snapshot current.
        // Use the same request revision boundary as every Native quote.
        if(!scope.queryRevision || !Number.isInteger(scope.referralContextRevision) || scope.referralContextRevision!==scope.queryRevision() ||
          !referral?.ok || !referral.code || referral.already_linked || !referral.items?.length ||
          output.reply_parts.filter(p=>p.type==="quote").length!==1 ||
          selected.listing_quote!.lines.some(l=>!referral.items!.some(i=>i.product_id===l.product_id)))
          return {ok:false,reason:"Referral offers require one verified original basket selection"};
        stock.set(part.quote_key,{...selected,referral_code:referral.code,offer_text:`${quote.display_text}\n\n${REFERRAL_RESTORE_OFFER}`});
      }
      used.add(part.quote_key);parts.push(quote.display_text);
      if(part.offer_action)parts.push(REFERRAL_RESTORE_OFFER);
    }
  }
  if(!parts.length)return {ok:false,reason:"The rendered reply is empty"};
  const draft=withNativeContext(parts.join("\n\n")),stock_quotes=[...used].map(key=>stock.get(key)!);
  const selection=inquiryOffersForText({model_id:"native-render",stage:scope.rentalStage??"INQUIRY",stock:[],stock_quotes,booking_record:selectedRecord},draft,draft);
  if(selection.supported&&!selection.ok)return {ok:false,reason:"Rendered Native quote blocks are inconsistent or ambiguous"};
  return {ok:true,draft,...(selectedRecord?{booking_record:selectedRecord}:{}),quote_keys:[...used],stock_quotes,commercial_quotes:[...used].flatMap(key=>commercial.has(key)?[commercial.get(key)!]:[]),recommendation_quotes:[...used].flatMap(key=>qualified.has(key)?[qualified.get(key)!]:[])};
}

/** A valid decision with an invalid quote is an owner review, not a broken
 * model envelope. Keep the normal receipt/cost/task path while approving no reply. */
export function reviewNativeQuoteReply(output:RenterBotOutput,receipts:ToolReceipt[],scope:NativeQuoteScope) {
 const rendered=renderNativeQuoteReply(output,receipts,scope);
 if(rendered.ok)return {renderedReply:rendered,needs_human_reason:null,diagnostic_candidate:rendered.draft};
 const renderedReply:Extract<ReturnType<typeof renderNativeQuoteReply>,{ok:true}>={ok:true,draft:"",quote_keys:[],stock_quotes:[],commercial_quotes:[],recommendation_quotes:[]};
 return {renderedReply,needs_human_reason:"native_quote_selection",diagnostic_candidate:output.draft};
}
