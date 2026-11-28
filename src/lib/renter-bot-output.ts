import {sanitizeModelOutputDiagnostics,type ModelOutputDiagnostics} from "../../convex/lib/model_output_failure";
import { z } from "zod";
import { RENTER_BOT_INTENTS, CONVERSATION_STAGES } from "../../convex/lib/renter_bot_intents";

export const RENTER_BOT_OUTPUT_SCHEMA = z.object({
  draft: z.string().describe("The complete renter-facing reply for ordinary conversation. Empty only when server-rendered reply_parts are used or needs_human=true."),
  reply_parts: z.array(z.discriminatedUnion("type",[
    z.object({type:z.literal("text"),text:z.string()}),
    z.object({type:z.literal("quote"),quote_key:z.string().regex(/^inquiry_[a-f0-9]{32}$/),offer_action:z.literal("restore_referral").optional()}),
    z.object({type:z.literal("budget_check"),budget_key:z.string().regex(/^budget_[a-f0-9]{32}$/)}),
    z.object({type:z.literal("replacement_value"),value_key:z.string().regex(/^value_[a-f0-9]{32}$/)}),
    z.object({type:z.literal("booking_record"),record_key:z.string().regex(/^record_[a-f0-9]{32}$/)}),
  ])).min(1).max(12).optional().describe("Use only when selecting server-rendered Native quote, budget, replacement-value, or historical-booking blocks. Use concise text parts around those blocks only when needed, without repeating facts. For ordinary conversation, put the complete reply in draft and omit reply_parts; never split plain prose across multiple text parts. Text parts cannot contain financial amounts."),
  intent: z.enum(RENTER_BOT_INTENTS),
  conversation_stage: z.enum(CONVERSATION_STAGES),
  red_flags: z.array(z.string()),
  factsClaimed: z
    .array(
      z.object({
        kind: z.enum(["price", "availability", "date", "item_included", "technical_spec", "catalogue_match", "quote_readiness", "rule"]),
        value: z.string(),
        sourceTool: z.string(),
        sourceCallId: z.string(),
      }),
    )
    .describe("Every load-bearing factual claim in the draft, with the tool call that produced it."),
  needs_human: z.boolean(),
  needs_human_reason: z.string().optional(),
});

export type RenterBotOutput = z.infer<typeof RENTER_BOT_OUTPUT_SCHEMA>;

export function validateRenterBotOutput(value: unknown): RenterBotOutput | null {
 const parsed=RENTER_BOT_OUTPUT_SCHEMA.safeParse(value);
 if(!parsed.success||!parsed.data.needs_human&&!parsed.data.draft.trim()&&!parsed.data.reply_parts?.some(p=>p.type!=="text"||p.text.trim()))return null;
 return parsed.data;
}

/** Validate the model envelope, not just JSON syntax. No text-only approval:
 * malformed output retains no attested stage, intent or escalation decision. */
export function parseRenterBotOutput(text: string): RenterBotOutput | null {
 try {
  let json=text.trim();
  const fence=json.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fence)json=fence[1].trim();
  const first=json.indexOf("{"),last=json.lastIndexOf("}");
  if(first<0||last<=first)return null;
  return validateRenterBotOutput(JSON.parse(json.slice(first,last+1)));
 }catch{return null;}
}


/** Explain a rejected envelope without retaining private text or tool payloads. */
export function renterBotOutputDiagnostics(value:unknown,text:string,termination:{finishReason?:unknown;steps?:unknown}={}):ModelOutputDiagnostics {
 const schemaIssues=(candidate:unknown)=>{
  const parsed=RENTER_BOT_OUTPUT_SCHEMA.safeParse(candidate);
  if(!parsed.success)return parsed.error.issues.map(i=>({field:i.path.length?i.path.join("."):"$",code:i.code}));
  return validateRenterBotOutput(candidate)?[]:[{field:"draft",code:"empty_reply"}];
 };
 let textStatus="empty",textIssues:Array<{field:string;code:string}>=[];
 if(text.trim()){
  let json=text.trim();const fence=json.match(/```(?:json)?\s*([\s\S]*?)```/i);if(fence)json=fence[1].trim();
  const first=json.indexOf("{"),last=json.lastIndexOf("}");textStatus="no_json";
  if(first>=0){textStatus="invalid_json";if(last>first)try{
   const candidate:unknown=JSON.parse(json.slice(first,last+1));textIssues=schemaIssues(candidate);textStatus=validateRenterBotOutput(candidate)?"valid":textIssues.some(i=>i.code==="empty_reply")?"empty_reply":"schema_invalid";
  }catch{/* Content stays private. */}}
 }
 const steps=Array.isArray(termination.steps)?termination.steps:[];
 const resultStatusByCallId=new Map<string,"ok"|"error">();
 for(const step of steps){
  const results=step&&typeof step==="object"&&Array.isArray((step as {toolResults?:unknown}).toolResults)?(step as {toolResults:Array<Record<string,unknown>>}).toolResults:[];
  for(const toolResult of results){
   const payload=(toolResult?.payload??toolResult) as Record<string,unknown>;
   const callId=payload?.toolCallId??payload?.tool_call_id;
   if(callId==null)continue;
   const output=payload?.result??payload?.output;
   resultStatusByCallId.set(String(callId),output&&typeof output==="object"&&"error" in output?"error":"ok");
  }
 }
 const toolTrace=steps.flatMap(step=>{
  const calls=step&&typeof step==="object"&&Array.isArray((step as {toolCalls?:unknown}).toolCalls)?(step as {toolCalls:Array<Record<string,unknown>>}).toolCalls:[];
  return calls.map(toolCall=>{
   const payload=(toolCall?.payload??toolCall) as Record<string,unknown>;
   const rawName=payload?.toolName??payload?.tool_name;
   const rawId=payload?.toolCallId??payload?.tool_call_id;
   const name=typeof rawName==="string"&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(rawName)?rawName:"unknownTool";
   return {name,result:rawId==null?"missing" as const:resultStatusByCallId.get(String(rawId))??"missing" as const};
  });
 });
 return sanitizeModelOutputDiagnostics({object_type:value===undefined?"missing":value===null?"null":Array.isArray(value)?"array":["object","string","number","boolean"].includes(typeof value)?typeof value:"other",
  text_status:textStatus,text_length:text.length,object_issues:schemaIssues(value),text_issues:textIssues,finish_reason:termination.finishReason,step_count:steps.length,
  tool_call_count:toolTrace.length,tool_trace:toolTrace})!;
}
