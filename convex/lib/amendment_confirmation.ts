import { inclusiveRentalDays, rentalQuote, type PriceTier } from "./hygglo_pricing";
import type { PriceEvidence } from "./price_claims";
import type { StockRequest } from "./stock_claims";
import { amendedDraftContext, type DraftContextTransition } from "./draft_review";

type Line = { product_id: number; name: string; qty: number; line_total_gbp: number };
type Snapshot = { account_slug: string; stage: string; start_date: string; end_date: string;
  total_gbp: number; lines: Line[]; changes: Array<{ request_key?: string }> };

function snapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Snapshot;
  if (typeof s.account_slug !== "string" || !["CONFIRMED_UPCOMING", "ACTIVE"].includes(s.stage)
    || typeof s.start_date !== "string" || typeof s.end_date !== "string"
    || !Number.isFinite(s.total_gbp) || s.total_gbp <= 0 || !Array.isArray(s.lines)
    || !s.lines.length || !Array.isArray(s.changes)
    || s.lines.some(l => !l || !Number.isInteger(l.product_id) || l.product_id <= 0
      || typeof l.name !== "string" || !l.name.trim() || /[\r\n]/.test(l.name)
      || !Number.isInteger(l.qty) || l.qty <= 0 || !Number.isFinite(l.line_total_gbp) || l.line_total_gbp <= 0)
    || new Set(s.lines.map(l => l.product_id)).size !== s.lines.length
    || Math.round(s.lines.reduce((n,l) => n+l.line_total_gbp,0)*100) !== Math.round(s.total_gbp*100)) return null;
  return s;
}

/** Stored Native orders and request keys prove the edit, never a model action flag.
 * Initially supports one atomic addition; other changes retain human review. */
export function committedAdditionConfirmation(input: {
  threadId: string; account: string; messageId: string; beforeKey: string; afterKey: string;
  transitions: DraftContextTransition[]; before: unknown; after: unknown;
}): string | null {
  const { threadId, account, messageId, beforeKey, afterKey, transitions } = input;
  if (!messageId || !threadId.startsWith("__probe__") || transitions.length !== 1
    || amendedDraftContext(beforeKey,threadId,transitions) !== afterKey) return null;
  const before = snapshot(input.before), after = snapshot(input.after);
  if (!before || !after || before.account_slug !== account || after.account_slug !== account
    || before.start_date !== after.start_date || before.end_date !== after.end_date
    || after.changes.length !== before.changes.length+1
    || transitions[0].before_revision !== before.changes.length
    || transitions[0].after_revision !== after.changes.length
    || JSON.stringify(after.changes.slice(0,-1)) !== JSON.stringify(before.changes)) return null;
  let request: unknown;
  try { request = JSON.parse(after.changes.at(-1)?.request_key ?? ""); } catch { return null; }
  if (!Array.isArray(request) || request.length !== 3 || request[0] !== messageId
    || request[1] !== "add_items" || !Array.isArray(request[2]) || !request[2].length) return null;
  const added: Array<{product_id:number;qty:number;name:string}> = [];
  for (const old of before.lines) {
    const current = after.lines.find(l => l.product_id === old.product_id);
    if (!current || current.name !== old.name || current.qty < old.qty
      || Math.round(current.line_total_gbp/current.qty*100) !== Math.round(old.line_total_gbp/old.qty*100)) return null;
  }
  for (const line of after.lines) {
    const qty = line.qty-(before.lines.find(l => l.product_id === line.product_id)?.qty ?? 0);
    if (qty > 0) added.push({product_id:line.product_id,qty,name:line.name});
  }
  added.sort((a,b) => a.product_id-b.product_id);
  if (!added.length || JSON.stringify(added.map(({product_id,qty}) => ({product_id,qty}))) !== JSON.stringify(request[2])) return null;
  const dates = [after.start_date,after.end_date].map(value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(value+"T00:00:00Z");
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value ? date : null;
  });
  if (!dates[0] || !dates[1] || dates[1] < dates[0]) return null;
  const format = (date: Date) => date.toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric",timeZone:"UTC"});
  const period = after.start_date === after.end_date ? format(dates[0]) : `${format(dates[0])} to ${format(dates[1])}`;
  const names = added.map(l => `${l.qty}x ${l.name}`).join(" and ");
  const total = Number(after.total_gbp.toFixed(2)).toString();
  return `I've added ${names} to your booking for ${period}. The updated booking total is £${total}.`;
}

/** Recover only one verifiable Native edit on the same inbound message.
 * The returned prices come from the stored order, not the failed model reply. */
export function committedAmendmentConfirmation(input: Parameters<typeof committedAdditionConfirmation>[0]): {
  text:string; action:"add_items"|"set_dates"|"remove_item"; prices:PriceEvidence[]; request:StockRequest;
} | null {
  const {threadId,account,messageId,beforeKey,afterKey,transitions}=input;
  if(!messageId || !threadId.startsWith("__probe__") || transitions.length!==1
    || amendedDraftContext(beforeKey,threadId,transitions)!==afterKey)return null;
  const before=snapshot(input.before),after=snapshot(input.after);
  if(!before || !after || before.account_slug!==account || after.account_slug!==account
    || after.changes.length!==before.changes.length+1
    || transitions[0].before_revision!==before.changes.length || transitions[0].after_revision!==after.changes.length
    || JSON.stringify(after.changes.slice(0,-1))!==JSON.stringify(before.changes))return null;
  const days=inclusiveRentalDays(after.start_date,after.end_date),beforeDays=inclusiveRentalDays(before.start_date,before.end_date);
  if(days==null || beforeDays==null)return null;
  // Recompute totals from the captured raw tier terms. Displayed daily rates
  // may be approximate, so multiplying them cannot certify a Native total.
  const validPrices=(s:Snapshot,count:number)=>s.lines.every(line=>{
    const l=line as Line & {daily_price_gbp?:number;effective_rate_gbp?:number;price_tiers?:PriceTier[]};
    const quote=rentalQuote(l.price_tiers,l.daily_price_gbp,count,l.qty);
    return quote && quote.listed_total_gbp===l.line_total_gbp && quote.daily_rate_gbp===l.effective_rate_gbp;
  });
  if(!validPrices(before,beforeDays)||!validPrices(after,days))return null;
  let key:unknown;try{key=JSON.parse(after.changes.at(-1)?.request_key??"");}catch{return null;}
  if(!Array.isArray(key)||key[0]!==messageId)return null;
  const sameTerms=(a:Line,b:Line)=>{
    const x=a as Line & {daily_price_gbp?:number;price_tiers?:PriceTier[]},y=b as typeof x;
    return x.name===y.name&&x.daily_price_gbp===y.daily_price_gbp&&JSON.stringify(x.price_tiers??[])===JSON.stringify(y.price_tiers??[]);
  };
  const format=(value:string)=>new Date(value+"T00:00:00Z").toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric",timeZone:"UTC"});
  const period=after.start_date===after.end_date?format(after.start_date):`${format(after.start_date)} to ${format(after.end_date)}`;
  const total=Number(after.total_gbp.toFixed(2)).toString();
  let text:string,action:"add_items"|"set_dates"|"remove_item";
  if(key[1]==="add_items"){
    const addition=committedAdditionConfirmation(input);if(!addition)return null;
    if(!before.lines.every(old=>{const next=after.lines.find(l=>l.product_id===old.product_id);return next&&sameTerms(old,next);}))return null;
    text=addition;action="add_items";
  }else if(key[1]==="set_dates"){
    if(key.length!==4||key[2]!==after.start_date||key[3]!==after.end_date
      ||before.start_date===after.start_date&&before.end_date===after.end_date||before.lines.length!==after.lines.length
      ||!before.lines.every(old=>{const next=after.lines.find(l=>l.product_id===old.product_id);return next&&next.qty===old.qty&&sameTerms(old,next);}))return null;
    text=`I've updated your booking dates to ${period}. The updated booking total is £${total}.`;action="set_dates";
  }else if(key[1]==="remove_item"){
    if(key.length!==4||typeof key[2]!=="string"||!Number.isInteger(key[3])||key[3]<=0
      ||before.start_date!==after.start_date||before.end_date!==after.end_date)return null;
    const removed=before.lines.filter(old=>(after.lines.find(l=>l.product_id===old.product_id)?.qty??0)!==old.qty);
    if(removed.length!==1||key[2]!==`product:${removed[0].product_id}`
      ||removed[0].qty-(after.lines.find(l=>l.product_id===removed[0].product_id)?.qty??0)!==key[3]
      ||!after.lines.every(next=>{const old=before.lines.find(l=>l.product_id===next.product_id);return old&&sameTerms(old,next)&&next.qty===old.qty-(old===removed[0]?key[3]:0);}))return null;
    const receipt=(after.changes.at(-1) as {removed_item?:{product_id:number;qty:number}}).removed_item;
    if(!receipt||receipt.product_id!==removed[0].product_id||receipt.qty!==key[3])return null;
    text=`I've removed ${key[3]}x ${removed[0].name} from your booking for ${period}. The updated booking total is £${total}.`;action="remove_item";
  }else return null;
  const request:StockRequest={start_date:after.start_date,end_date:after.end_date,items:after.lines.map(l=>({name:l.name,quantity:l.qty}))};
  const prices:PriceEvidence[]=[{kind:"basket",names:[],items:request.items.map(i=>({name:i.name,quantity:i.quantity})),total_gbp:after.total_gbp,days,start_date:after.start_date,end_date:after.end_date,source:"lab_order_quote",call_id:`${threadId}:committed:${after.changes.length}`},
    ...after.lines.map(line=>{const l=line as Line & {daily_price_gbp:number;effective_rate_gbp:number};return {kind:"rental" as const,names:[l.name],quantity:l.qty,base_rate_gbp:l.daily_price_gbp,daily_rate_gbp:l.effective_rate_gbp,total_gbp:l.line_total_gbp,days,start_date:after.start_date,end_date:after.end_date,source:"lab_order_quote",call_id:`${threadId}:committed:${after.changes.length}:${l.product_id}`};})];
  return {text,action,prices,request};
}
