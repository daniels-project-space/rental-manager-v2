import { datePriceEvidence } from "./renter-date-price-evidence";
import { inclusiveRentalDays, rentalQuote, type PriceTier } from "../../convex/lib/hygglo_pricing";
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
    if(!source || !["hygglo_tier","hygglo_listing","curated_catalog","lab_order_quote","owned_listing_one_day","native_lab_proposal","native_inquiry_basket"].includes(source))return;
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
    if(tool==="check_basket_availability" && r.available===true && r.booking_use==="standalone" && r.preview_only===true &&
      r.source==="shared_inventory_confirmed_rentals" && !!threadId && r.thread_id===threadId && string(r.account_slug) && string(r.physical_identity_key) &&
      r.quote && typeof r.quote==="object" && Array.isArray(r.offered_listings)) {
      const q=r.quote as Record<string,unknown>;
      const lines=Array.isArray(q.lines) ? q.lines as Array<Record<string,unknown>> : [];
      const days=number(q.days);
      const selected=r.offered_listings as Array<Record<string,unknown>>;
      if(q.source!=="native_inquiry_basket" || !days || days>366 || inclusiveRentalDays(string(q.start_date),string(q.end_date))!==days ||
        q.start_date!==r.start_date || q.end_date!==r.end_date || !number(q.total_gbp) || !lines.length || lines.length>8 || selected.length!==lines.length)continue;
      const remaining=[...selected];
      const valid=lines.every(l=>{
        const index=remaining.findIndex(s=>s.product_id===l.product_id && s.quantity===l.qty);
        if(index<0 || !Number.isInteger(l.product_id) || (l.product_id as number)<1 || !string(l.name) || !number(l.daily_price_gbp))return false;
        remaining.splice(index,1);
        const calculated=rentalQuote(Array.isArray(l.price_tiers)?l.price_tiers as PriceTier[]:[],l.daily_price_gbp as number,days,l.qty as number);
        return calculated!=null && calculated.listed_total_gbp===l.line_total_gbp && calculated.daily_rate_gbp===l.effective_rate_gbp;
      });
      if(!valid || Math.abs(lines.reduce((sum,l)=>sum+(l.line_total_gbp as number),0)-(q.total_gbp as number))>0.011)continue;
      out.push({names:[],kind:"basket",quote_role:"inquiry",items:lines.map(l=>({name:l.name as string,quantity:l.qty as number})),
        total_gbp:q.total_gbp as number,days,start_date:q.start_date as string,end_date:q.end_date as string,call_id,source:"native_inquiry_basket"});
      for(const l of lines)quote({days,quantity:l.qty,daily_rate_gbp:l.effective_rate_gbp,listed_total_gbp:l.line_total_gbp,
        start_date:q.start_date,end_date:q.end_date,source:"native_inquiry_basket"},
        [l.name as string,...(Array.isArray(l.verified_price_names)?l.verified_price_names.filter((n):n is string=>!!string(n)):[])],`${call_id}:line:${l.product_id}`,l.daily_price_gbp);
    }
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
    if (["quote_booking_addition","quote_booking_replacement"].includes(tool) && !!threadId && r.thread_id===threadId && r.preview_only===true && r.source==="native_lab_proposal" && r.quote && typeof r.quote==="object") {
      const q=r.quote as Record<string,unknown>;
      const validMembers=(a:unknown):a is Array<{name:string;quantity:number}>=>Array.isArray(a)&&a.length>0&&a.every(i=>i&&typeof i==="object"&&string(i.name)&&number(i.quantity)&&Number.isInteger(i.quantity));
      if (validMembers(r.base_items)&&validMembers(r.added_items)&&r.added_items.length<=8&&Array.isArray(q.lines)&&q.lines.length>0&&number(q.total_gbp)&&number(q.days)&&string(q.start_date)&&string(q.end_date)&&q.lines.every(l=>l&&typeof l==="object"&&string(l.name)&&number(l.qty)&&Number.isInteger(l.qty)&&number(l.line_total_gbp))) {
        const members = (rows: Array<{name:string;quantity:number}>) => {
          const totals=new Map<string,number>();
          for(const row of rows) {const key=row.name.trim().toLowerCase();totals.set(key,(totals.get(key)??0)+row.quantity);}
          return totals;
        };
        const replacement=tool==="quote_booking_replacement";
        if(replacement && (r.change_kind!=="replacement" || !validMembers(r.removed_items)))continue;
        if(!replacement && r.removed_items!=null)continue;
        const expected=members([...r.base_items]);
        if(replacement) {
          let invalid=false;
          for(const removed of r.removed_items as Array<{name:string;quantity:number}>) {
            const key=removed.name.trim().toLowerCase(),current=expected.get(key);
            if(current==null || removed.quantity>current){invalid=true;break;}
            if(current===removed.quantity)expected.delete(key);else expected.set(key,current-removed.quantity);
          }
          if(invalid)continue;
        }
        for(const added of r.added_items){const key=added.name.trim().toLowerCase();expected.set(key,(expected.get(key)??0)+added.quantity);}
        const actual=members(q.lines.map(l=>({name:l.name,quantity:l.qty})));
        if(inclusiveRentalDays(string(q.start_date),string(q.end_date))!==q.days ||
          expected.size!==actual.size || [...expected].some(([name,qty])=>actual.get(name)!==qty) ||
          Math.abs(q.lines.reduce((sum,l)=>sum+l.line_total_gbp,0)-(q.total_gbp as number))>0.011) continue;
        const proposal: NonNullable<PriceEvidence["proposal"]> = {base_items:r.base_items,added_items:r.added_items,
          ...(replacement?{removed_items:r.removed_items as Array<{name:string;quantity:number}>}:{}),
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
        const validPart=(part:Record<string,unknown>|undefined, expected:Array<{name:string;quantity:number}>,requireFullIdentity=true) => {
          if (!part || part.days!==q.days || part.start_date!==q.start_date || part.end_date!==q.end_date ||
            !Array.isArray(part.lines) || !number(part.total_gbp) || !part.lines.length) return false;
          if (!part.lines.every(l=>l && string(l.name) && number(l.qty) && Number.isInteger(l.qty) &&
            number(l.line_total_gbp) && (string(l.item_id)||number(l.product_id)) && number(l.effective_rate_gbp) && number(l.daily_price_gbp) &&
            Math.abs(l.effective_rate_gbp*(q.days as number)*l.qty-l.line_total_gbp)<0.011 &&
            (!requireFullIdentity || completeLines.some(full=>full.name===l.name && full.item_id===l.item_id && full.product_id===l.product_id &&
              full.effective_rate_gbp===l.effective_rate_gbp && full.daily_price_gbp===l.daily_price_gbp)))) return false;
          const actual=members(part.lines.map(l=>({name:l.name,quantity:l.qty})));
          const required=members(expected);
          return actual.size===required.size && [...required].every(([name,qty])=>actual.get(name)===qty) &&
            Math.abs(part.lines.reduce((sum,l)=>sum+l.line_total_gbp,0)-(part.total_gbp as number))<0.011;
        };
        if(replacement && validPart(baseQuote,r.base_items,false) && validPart(additionQuote,r.added_items,false) && string(r.base_physical_identity_key) && Array.isArray(r.removed_listings) && r.removed_listings.length===(r.removed_items as Array<{name:string;quantity:number}>).length) {
          const removed=r.removed_listings as Array<{product_id:number;quantity:number}>;
          const added=additionQuote!.lines as Array<Record<string,unknown>>;
          const base=baseQuote!.lines as Array<Record<string,unknown>>;
          if(removed.every(i=>Number.isInteger(i.product_id)&&i.product_id>0&&Number.isInteger(i.quantity)&&i.quantity>0&&base.some(l=>l.product_id===i.product_id&&(l.qty as number)>=i.quantity&&(r.removed_items as Array<{name:string;quantity:number}>).some((n:{name:string;quantity:number})=>n.name===l.name&&n.quantity===i.quantity))) && new Set(removed.map(i=>i.product_id)).size===removed.length && added.every(l=>Number.isInteger(l.product_id)&&(l.product_id as number)>0)) {
            proposal.removed_listings=removed;
            proposal.added_listings=added.map(l=>({product_id:l.product_id as number,quantity:l.qty as number}));
            proposal.base_total_gbp=baseQuote!.total_gbp as number;
            proposal.base_physical_identity_key=r.base_physical_identity_key as string;
          }
        }
        if (!replacement && validPart(baseQuote,r.base_items) && validPart(additionQuote,r.added_items) &&
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
