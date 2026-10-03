import { directItemSelection, matchesQuotedDates, type AcceptedAdditionLine } from "./renter_addition_acceptance";

/** Reconcile an explicit removal against the whole Native booked basket. A
 * question, unrelated edit or unnamed reference cannot choose a line or qty. */
export function acceptsRemoval(text: string, booked: AcceptedAdditionLine[], selected: {product_id:number;qty:number}, period?:{start_date:string;end_date:string}) {
  const message=text.replace(/[’‘]/g,"'").replace(/```[\s\S]*?```/g," ")
    .replace(/["“][^"”]*\b(?:please|remove|drop|go ahead)\b[^"”]*["”]/gi," ");
  if (/\b(?:after|when|unless|later|wait|hold off|before I confirm)\b/i.test(message)) return false;
  if(period && (!/^\d{4}-\d{2}-\d{2}$/.test(period.start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(period.end_date)
    || !matchesQuotedDates(message,period)))return false;
  const request=directItemSelection(message,booked,"removal");
  // The legacy endpoint changes one line. A multi-line request must not be
  // silently reduced to whichever one the tool selected.
  if (!request.items || request.items.length!==1 || request.items[0].product_id!==selected.product_id
    || request.items[0].qty!==selected.qty) return false;
  const line=booked.find(l=>l.product_id===selected.product_id);
  if (!line || selected.qty<1 || selected.qty>line.qty) return false;
  const total=booked.reduce((sum,l)=>sum+l.line_total_gbp,0);
  const reduction=line.line_total_gbp*selected.qty/line.qty;
  const money=[...message.matchAll(/£\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g)].map(m=>Number(m[1].replace(/,/g,"")));
  return Number.isFinite(total) && Number.isFinite(reduction) && reduction>0
    && money.every(amount=>[total-reduction,reduction].some(actual=>Math.round(actual*100)===Math.round(amount*100)));
}
