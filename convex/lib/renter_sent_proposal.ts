import {replacementProposalsFromEvidence,type SentReplacementProposal} from "./renter_replacement_proposal";
import type { SentDateProposal } from "./renter_date_proposal";
import { summarise } from "./renter_order_quote";
import { v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { PriceEvidence } from "./price_claims";
import { currentDraftApproval, draftContextKey } from "./draft_review";
import { getBotBooking, getLabOrder } from "./renter_booking";
import { recentThreadMessages } from "./thread_messages";

export const sentAdditionProposalValidator = v.object({
  context_key: v.string(), epoch: v.number(), quoted_for_message_id: v.string(),
  physical_identity_key:v.optional(v.string()),
  items: v.array(v.object({ product_id: v.number(), qty: v.number() })),
  base_items: v.array(v.object({ name: v.string(), quantity: v.number() })),
  added_items: v.array(v.object({ name: v.string(), quantity: v.number() })),
  start_date: v.string(), end_date: v.string(),
  total_gbp: v.number(), additional_cost_gbp: v.number(),
});
export type SentAdditionProposal = Infer<typeof sentAdditionProposalValidator>;

/** Preserve quote evidence, not consent. The next renter message still has to
 * accept an offer actually expressed in the owner text and matching this quote. */
export function additionProposalsFromEvidence(prices: PriceEvidence[], scope: {
  context_key: string; epoch: number; message_id: string;
}): SentAdditionProposal[] {
  const proposals = new Map<string, SentAdditionProposal>();
  for (const price of prices) {
    const selections = price.proposal?.added_listings;
    const additional = price.proposal?.additional_cost_gbp;
    if (price.source !== "native_lab_proposal" || price.kind !== "basket" || price.quote_role ||
      price.proposal?.removed_items?.length || !selections?.length || selections.length > 8 ||
      selections.some(i => !Number.isInteger(i.product_id) || i.product_id < 1 || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 20) ||
      !price.start_date || !price.end_date || !Number.isFinite(price.total_gbp) || (price.total_gbp ?? 0) <= 0 ||
      !Number.isFinite(additional) || (additional ?? 0) <= 0 || additional! > price.total_gbp! ||
      !price.proposal?.added_items.length) continue;
    const items = selections.map(i => ({ product_id: i.product_id, qty: i.quantity })).sort((a,b) => a.product_id-b.product_id);
    if (new Set(items.map(i=>i.product_id)).size !== items.length) continue;
    const proposal: SentAdditionProposal = { context_key:scope.context_key, epoch:scope.epoch,
      ...(price.proposal.physical_identity_key?{physical_identity_key:price.proposal.physical_identity_key}:{}),
      quoted_for_message_id:scope.message_id, items, base_items:price.proposal.base_items, added_items:price.proposal.added_items,
      start_date:price.start_date, end_date:price.end_date, total_gbp:price.total_gbp!, additional_cost_gbp:additional! };
    proposals.set(JSON.stringify(proposal), proposal);
  }
  return [...proposals.values()];
}

/** Called when an owner message is recorded, before its draft is cleared. */
export async function sentBookingProposals(ctx: QueryCtx, conversation: Doc<"conversations"> | null, text: string): Promise<{additions:SentAdditionProposal[];dates:SentDateProposal[];replacements:SentReplacementProposal[]}> {
  if (!conversation?.ai_draft_text || text.trim() !== conversation.ai_draft_text.trim() ||
    !conversation.ai_draft_evidence?.prices?.length) return {additions:[],dates:[],replacements:[]};
  const [latest] = await recentThreadMessages(ctx, conversation.thread_id, 1);
  if (latest?.sender !== "renter") return {additions:[],dates:[],replacements:[]};
  const settings = await ctx.db.query("settings").first();
  const order = await getLabOrder(ctx, conversation.thread_id);
  if (!order) return {additions:[],dates:[],replacements:[]};
  const context_key = draftContextKey(await getBotBooking(ctx, conversation.thread_id), conversation.inquiry_items, order);
  const epoch = settings?.draft_epoch ?? 0;
  const approval = currentDraftApproval(conversation, {message_id:latest.message_id, context_key, epoch});
  const members = (rows:Array<{name:string;quantity:number}>) => {
    const totals=new Map<string,number>();
    for(const row of rows)totals.set(row.name,(totals.get(row.name)??0)+row.quantity);
    return JSON.stringify([...totals].sort((a,b)=>a[0].localeCompare(b[0])));
  };
  const currentMembers=members(order.items.map(i=>({name:i.name,quantity:i.qty})));
  const pendingPrices=conversation.ai_draft_evidence.prices.filter(p=>p.proposal && members(p.proposal.base_items)===currentMembers);
  if(!approval)return {additions:[],dates:[],replacements:[]};
  const total=summarise(order.items,order.start_date,order.end_date).total_gbp;
  const dates:SentDateProposal[]=[];
  for(const price of conversation.ai_draft_evidence.prices){const p=price.date_proposal;
    if(!p||price.kind!=="basket"||price.source!=="native_lab_date_proposal"||p.before_context_key!==context_key
      ||p.from_start_date!==order.start_date||p.from_end_date!==order.end_date||total==null||Math.round(total*100)!==Math.round(p.base_total_gbp*100)
      ||!price.start_date||!price.end_date||!price.total_gbp||!Number.isFinite(price.total_gbp)||!price.items||members(price.items)!==currentMembers)continue;
    const proposal:SentDateProposal={context_key,epoch,quoted_for_message_id:approval.message_id,from_start_date:p.from_start_date,from_end_date:p.from_end_date,
      ...(p.physical_identity_key?{physical_identity_key:p.physical_identity_key}:{}),
      start_date:price.start_date,end_date:price.end_date,total_gbp:price.total_gbp,base_total_gbp:p.base_total_gbp,items:price.items};
    if(!dates.some(d=>JSON.stringify(d)===JSON.stringify(proposal)))dates.push(proposal);
  }
  return {additions:additionProposalsFromEvidence(pendingPrices,{message_id:approval.message_id,context_key,epoch}),dates,replacements:replacementProposalsFromEvidence(pendingPrices,{message_id:approval.message_id,context_key,epoch})};
}

export async function sentAdditionProposals(ctx:QueryCtx,conversation:Doc<"conversations">|null,text:string){return (await sentBookingProposals(ctx,conversation,text)).additions;}
