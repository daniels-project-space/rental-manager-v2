import { v, type Infer } from "convex/values";
export const sentDateProposalValidator=v.object({context_key:v.string(),epoch:v.number(),quoted_for_message_id:v.string(),
  from_start_date:v.string(),from_end_date:v.string(),start_date:v.string(),end_date:v.string(),
  total_gbp:v.number(),base_total_gbp:v.number(),items:v.array(v.object({name:v.string(),quantity:v.number()}))});
export type SentDateProposal=Infer<typeof sentDateProposalValidator>;
export type DateProposalEvidence={before_context_key:string;from_start_date:string;from_end_date:string;base_total_gbp:number};
