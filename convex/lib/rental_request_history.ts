import {sameRentalRequest,type RentalRequest} from "./rental_request";
import type {SentInquiryOffer} from "./sent_inquiry_offer";

type Message={message_id:string;sender:string;body_text:string;hygglo_sent_at?:number;fetched_at?:number;rental_request?:RentalRequest;quoted_inquiries?:SentInquiryOffer[]};
/** Called after Native request validation; the supplied thread history is
 * already scoped. Returning the full origin adds no separate history read. */
export function rentalRequestContext(messages:Message[],request:RentalRequest) {
  if(request.kind!=="inquiry")return null;
  const origin=messages.find(m=>m.message_id===request.origin_message_id&&m.sender==="renter");
  return origin?{context_only:true as const,original_request_message_id:origin.message_id,
    original_request_text:origin.body_text,original_request_at:origin.hygglo_sent_at??origin.fetched_at??null}:null;
}

export type RentalRequestHistory=Extract<RentalRequest,{kind:"inquiry"}> & {history:{
  context_only:true;
  original_request_text:string;
  original_request_text_truncated:boolean;
  original_request_at:number|null;
  latest_offered_options:Array<{start_date:string;end_date:string;items:Array<{product_id:number;name:string;quantity:number}>}>;
}};

/** Describe explicitly served Native hires from the already loaded history.
 * Renter text is historical context, never current consent or verified specs.
 * Offer descriptions deliberately carry no price, stock or approval proof. */
export function rentalRequestHistory(messages:Message[]):RentalRequestHistory[] {
  const requests=new Map<string,RentalRequestHistory>();
  for(const message of messages){
    const request=message.rental_request;
    if(message.sender!=="renter" || request?.kind!=="inquiry" || message.message_id!==request.origin_message_id)continue;
    requests.set(request.origin_message_id,{...request,history:{context_only:true,
      original_request_text:message.body_text.slice(0,512),original_request_text_truncated:message.body_text.length>512,
      original_request_at:message.hygglo_sent_at??message.fetched_at??null,latest_offered_options:[]}});
  }
  for(const message of messages){
    const request=message.rental_request;
    if(message.sender!=="owner" || request?.kind!=="inquiry" || !message.quoted_inquiries?.length)continue;
    const summary=requests.get(request.origin_message_id);
    if(!summary || message.quoted_inquiries.some(o=>o.quote.rental_request&&!sameRentalRequest(o.quote.rental_request,request)))continue;
    summary.history.latest_offered_options=message.quoted_inquiries.flatMap(({quote})=>{
      if(!quote.listing_quote?.lines.length)return [];
      return [{start_date:quote.start_date,end_date:quote.end_date,
        items:quote.listing_quote.lines.map(({product_id,name,quantity})=>({product_id,name,quantity}))}];
    });
  }
  return [...requests.values()];
}
