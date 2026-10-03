import { datePriceEvidence } from "./renter-date-price-evidence";
import { inclusiveRentalDays } from "../../convex/lib/hygglo_pricing";
import type { PriceEvidence } from "../../convex/lib/price_claims";
import type { ToolReceipt } from "./renter-tool-evidence";
const number = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
const string = (s: unknown) => typeof s === "string" && s.trim() ? s : undefined;
/** Aliases from native owned listing context, never model arguments or title tokens. */
export type PriceListingIdentity = {account_slug:string;product_id:number;names:string[]};
/** Whitelisted actual tool results, excluding arguments, errors and arbitrary numeric keys. */
export function renterPriceEvidence(receipts: ToolReceipt[], listings: PriceListingIdentity[] = [], threadId?: string): PriceEvidence[] {
  const out: PriceEvidence[] = [];
  const quote = (r: Record<string,unknown>, names: string[], call: string, base?: unknown, role?: PriceEvidence["quote_role"]) => {
    const days=number(r.days), quantity=number(r.quantity);
    const source=string(r.source);
    if(!source || !["hygglo_tier","hygglo_listing","curated_catalog","lab_order_quote","owned_listing_one_day","native_lab_proposal"].includes(source))return;
    if (!names.length || !days || !Number.isInteger(days) || !quantity || !Number.isInteger(quantity)) return;
    out.push({names,kind:"rental",...(role ? {quote_role:role} : {}),daily_rate_gbp:r.multi_day_basis === "unknown_no_listing" && days !== 1 ? undefined : number(r.daily_rate_gbp),base_rate_gbp:number(base),total_gbp:number(r.listed_total_gbp),days,quantity,
      start_date:string(r.start_date),end_date:string(r.end_date),call_id:call,source,
      ...(Array.isArray(r.required_accessory_names) ? { required_accessory_names: r.required_accessory_names.filter((name): name is string => typeof name === "string" && !!name.trim()) } : {})});
  };
  const latestOrder=receipts.filter(r=>r.tool==="get_lab_order").at(-1);
  for (const receipt of receipts) {
    const {tool,call_id,result:r}=receipt;
    if(tool==="get_lab_order" && receipt!==latestOrder)continue;
    if (!call_id || r.error || r.ok===false || r.found===false) continue;
    if(tool==="quote_booking_dates")out.push(...datePriceEvidence(receipt,threadId));
    if (tool === "lookup_pricing" && r.found===true) {
      const aliases=listings.filter(l=>l.product_id===r.product_id && l.account_slug===r.account_slug).flatMap(l=>l.names);
      const names=[...new Set([r.matched_canonical,r.matched_listing,...aliases,...(Array.isArray(r.verified_price_names)?r.verified_price_names:[])].filter((n):n is string=>!!string(n)))];
      quote(r,names,call_id,r.one_day_rate_gbp??(r.days===1 || r.source==="curated_catalog" ? r.daily_rate_gbp:undefined));
    }
    if (tool === "find_owned_alternatives" && Array.isArray(r.alternatives)) for(const raw of r.alternatives) {
      if (!raw || typeof raw!=="object") continue;
      const a=raw as Record<string,unknown>; if(!string(a.name) || a.price_requires_owner_confirmation===true) continue;
      const names=[a.name,a.listing_name].filter((n):n is string=>!!string(n));
      if(a.quote && typeof a.quote==="object") quote(a.quote as Record<string,unknown>,names,`${call_id}:${a.name}`,a.daily_price_gbp);
      else if(number(a.daily_price_gbp)) quote({daily_rate_gbp:a.daily_price_gbp,listed_total_gbp:a.daily_price_gbp,days:1,quantity:1,source:"owned_listing_one_day"},names,`${call_id}:${a.name}`,a.daily_price_gbp);
    }
    if (tool === "quote_booking_addition" && !!threadId && r.thread_id===threadId && r.preview_only===true && r.source==="native_lab_proposal" && r.quote && typeof r.quote==="object") {
      const q=r.quote as Record<string,unknown>;
      const validMembers=(a:unknown):a is Array<{name:string;quantity:number}>=>Array.isArray(a)&&a.length>0&&a.every(i=>i&&typeof i==="object"&&string(i.name)&&number(i.quantity)&&Number.isInteger(i.quantity));
      if (validMembers(r.base_items)&&validMembers(r.added_items)&&r.added_items.length<=8&&Array.isArray(q.lines)&&q.lines.length>0&&number(q.total_gbp)&&number(q.days)&&string(q.start_date)&&string(q.end_date)&&q.lines.every(l=>l&&typeof l==="object"&&string(l.name)&&number(l.qty)&&Number.isInteger(l.qty)&&number(l.line_total_gbp))) {
        const members = (rows: Array<{name:string;quantity:number}>) => {
          const totals=new Map<string,number>();
          for(const row of rows) {const key=row.name.trim().toLowerCase();totals.set(key,(totals.get(key)??0)+row.quantity);}
          return totals;
        };
        const expected=members([...r.base_items,...r.added_items]);
        const actual=members(q.lines.map(l=>({name:l.name,quantity:l.qty})));
        if(inclusiveRentalDays(string(q.start_date),string(q.end_date))!==q.days ||
          expected.size!==actual.size || [...expected].some(([name,qty])=>actual.get(name)!==qty) ||
          Math.abs(q.lines.reduce((sum,l)=>sum+l.line_total_gbp,0)-(q.total_gbp as number))>0.011) continue;
        const proposal: NonNullable<PriceEvidence["proposal"]> = {base_items:r.base_items,added_items:r.added_items,
          ...(string(r.physical_identity_key)?{physical_identity_key:r.physical_identity_key as string}:{})};
        out.push({names:[],kind:"basket",items:q.lines.map(l=>({name:l.name,quantity:l.qty})),proposal,total_gbp:number(q.total_gbp),days:number(q.days),start_date:string(q.start_date),end_date:string(q.end_date),call_id,source:"native_lab_proposal"});
        // Keep the native per-line quote as well as the proposed grand total.
        // No echoed request name can supply the identity or the arithmetic.
        for(const l of q.lines) {
          const rate=number(l.effective_rate_gbp), base=number(l.daily_price_gbp);
          if ((!string(l.item_id) && !number(l.product_id)) || !rate || !base ||
            Math.abs(rate*(q.days as number)*l.qty-l.line_total_gbp)>0.011) continue;
          const aliases=listings.filter(i=>i.account_slug===r.account_slug && i.product_id===l.product_id).flatMap(i=>i.names);
          const names=[...new Set([l.name,...aliases])];
          quote({days:q.days,quantity:l.qty,daily_rate_gbp:rate,listed_total_gbp:l.line_total_gbp,start_date:q.start_date,end_date:q.end_date,source:"native_lab_proposal"},names,`${call_id}:line:${l.item_id??l.product_id}`,base,
            r.added_items.some(i=>i.name.trim().toLowerCase()===l.name.trim().toLowerCase()&&i.quantity===l.qty) &&
            !r.base_items.some(i=>i.name.trim().toLowerCase()===l.name.trim().toLowerCase()) ? "addition" : "proposed_line");
        }
        // Marginal amounts need their own native receipt. A combined line for
        // two cameras cannot prove what the one extra camera costs.
        const completeLines=q.lines;
        const baseQuote=r.base_quote as Record<string,unknown> | undefined;
        const additionQuote=r.addition_quote as Record<string,unknown> | undefined;
        const validPart=(part:Record<string,unknown>|undefined, expected:Array<{name:string;quantity:number}>) => {
          if (!part || part.days!==q.days || part.start_date!==q.start_date || part.end_date!==q.end_date ||
            !Array.isArray(part.lines) || !number(part.total_gbp) || !part.lines.length) return false;
          if (!part.lines.every(l=>l && string(l.name) && number(l.qty) && Number.isInteger(l.qty) &&
            number(l.line_total_gbp) && (string(l.item_id)||number(l.product_id)) && number(l.effective_rate_gbp) && number(l.daily_price_gbp) &&
            Math.abs(l.effective_rate_gbp*(q.days as number)*l.qty-l.line_total_gbp)<0.011 &&
            completeLines.some(full=>full.name===l.name && full.item_id===l.item_id && full.product_id===l.product_id &&
              full.effective_rate_gbp===l.effective_rate_gbp && full.daily_price_gbp===l.daily_price_gbp))) return false;
          const actual=members(part.lines.map(l=>({name:l.name,quantity:l.qty})));
          const required=members(expected);
          return actual.size===required.size && [...required].every(([name,qty])=>actual.get(name)===qty) &&
            Math.abs(part.lines.reduce((sum,l)=>sum+l.line_total_gbp,0)-(part.total_gbp as number))<0.011;
        };
        if (validPart(baseQuote,r.base_items) && validPart(additionQuote,r.added_items) &&
          number(r.additional_cost_gbp) &&
          Math.abs((q.total_gbp as number)-(baseQuote!.total_gbp as number)-(additionQuote!.total_gbp as number))<0.011 &&
          Math.abs((r.additional_cost_gbp as number)-(additionQuote!.total_gbp as number))<0.011) {
          const additionLines=additionQuote!.lines as Array<Record<string,unknown>>;
          if(additionLines.every(l=>Number.isInteger(l.product_id) && (l.product_id as number)>0)) {
            proposal.added_listings=additionLines.map(l=>({product_id:l.product_id as number,quantity:l.qty as number}));
            proposal.additional_cost_gbp=r.additional_cost_gbp as number;
          }
          if(r.added_items.length>1)out.push({names:[],kind:"basket",quote_role:"addition",items:r.added_items,
            proposal,total_gbp:number(additionQuote!.total_gbp),days:number(q.days),
            start_date:string(q.start_date),end_date:string(q.end_date),call_id:`${call_id}:addition-group`,source:"native_lab_proposal"});
          for(const l of additionQuote!.lines as Array<Record<string,unknown>>) {
            const name=string(l.name); if (!name) continue;
            const aliases=listings.filter(i=>i.account_slug===r.account_slug && i.product_id===l.product_id).flatMap(i=>i.names);
            quote({days:q.days,quantity:l.qty,daily_rate_gbp:l.effective_rate_gbp,listed_total_gbp:l.line_total_gbp,
              start_date:q.start_date,end_date:q.end_date,source:"native_lab_proposal"},[...new Set([name,...aliases])],
              `${call_id}:addition:${l.item_id??l.product_id}`,l.daily_price_gbp,"addition");
          }
        }
      }
    }
    if (tool === "get_lab_order" && Array.isArray(r.lines)) {
      for(const raw of r.lines) {
        if(!raw || typeof raw!=="object")continue;
        const l=raw as Record<string,unknown>; if(!string(l.name))continue;
        quote({days:r.days,quantity:l.qty,daily_rate_gbp:l.effective_rate_gbp,listed_total_gbp:l.line_total_gbp,start_date:r.start_date,end_date:r.end_date,source:"lab_order_quote"},[l.name as string],`${call_id}:${l.name}`,l.daily_price_gbp);
      }
      if(number(r.total_gbp) && r.lines.length && r.lines.every(l=>l && typeof l==="object" && string(l.name) && number(l.qty) && Number.isInteger(l.qty)))out.push({names:[],items:r.lines.map(l=>({name:(l as Record<string,unknown>).name as string,quantity:(l as Record<string,unknown>).qty as number})),kind:"basket",total_gbp:number(r.total_gbp),days:number(r.days),start_date:string(r.start_date),end_date:string(r.end_date),call_id,source:"lab_order_quote"});
    }
  }
  return out;
}
