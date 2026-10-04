import {v,type Infer} from 'convex/values';
import {stockQuoteEvidenceValidator,type DraftEvidence} from './renter_draft_evidence';
/** Historical offer proof only; not booking consent or current stock authority. */
export const sentInquiryOfferValidator=v.object({context_key:v.string(),epoch:v.number(),quoted_for_message_id:v.string(),quote:stockQuoteEvidenceValidator});
export type SentInquiryOffer=Infer<typeof sentInquiryOfferValidator>;
export function sentInquiryOffers(evidence:DraftEvidence,scope:{context_key:string;epoch:number;message_id:string}):SentInquiryOffer[] {
 const quotes=evidence.stock_quotes??[];
 if(!quotes.length||new Set(quotes.map(quote=>quote.quote_key)).size!==quotes.length)return [];
 for(const quote of quotes){
 const priced=quote.listing_quote;
 if(evidence.stage!=='INQUIRY'&&!quote.new_inquiry)return [];
 if(!quote.quote_key||!priced||!Number.isFinite(priced.total_gbp)||priced.total_gbp<=0||!priced.lines.length||!quote.items.length)return [];
 if(!/^\d{4}-\d{2}-\d{2}$/.test(quote.start_date)||!/^\d{4}-\d{2}-\d{2}$/.test(quote.end_date)||
   !Number.isFinite(Date.parse(quote.start_date))||!Number.isFinite(Date.parse(quote.end_date))||quote.end_date<quote.start_date)return [];
 if(priced.lines.some(line=>!Number.isInteger(line.product_id)||line.product_id<1||!line.name||!Number.isInteger(line.quantity)||line.quantity<1||!Number.isFinite(line.total_gbp)||line.total_gbp<0)||
   new Set(priced.lines.map(line=>line.product_id)).size!==priced.lines.length||
   Math.round(priced.lines.reduce((sum,line)=>sum+line.total_gbp,0)*100)!==Math.round(priced.total_gbp*100))return [];
 if(quote.items.some(item=>!item.item_id||!item.name||!Number.isInteger(item.quantity)||item.quantity<1)||new Set(quote.items.map(item=>item.item_id)).size!==quote.items.length)return [];
 }
 return quotes.map(quote=>({context_key:scope.context_key,epoch:scope.epoch,quoted_for_message_id:scope.message_id,quote}));
}
