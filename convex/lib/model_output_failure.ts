import {v,type Infer} from "convex/values";
const issue=v.object({field:v.string(),code:v.string()});
export const modelOutputDiagnosticsValidator=v.object({
 object_type:v.string(),text_status:v.string(),text_length:v.number(),object_issues:v.array(issue),text_issues:v.array(issue),
 finish_reason:v.optional(v.string()),step_count:v.number(),tool_call_count:v.number(),
});
export type ModelOutputDiagnostics=Infer<typeof modelOutputDiagnosticsValidator>;
const objectTypes=["missing","null","array","object","string","number","boolean","other"];
const textStates=["empty","no_json","invalid_json","schema_invalid","empty_reply","valid"];
const finishes=["stop","length","tool-calls","content-filter","error","other","unknown"];
const issueCodes=["invalid_type","invalid_value","invalid_enum_value","invalid_union","invalid_literal","invalid_string","invalid_format","too_small","too_big","custom","empty_reply"];
const count=(n:unknown)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0&&n<=10000000?n:null;
const issues=(value:unknown)=>Array.isArray(value)?value.slice(0,20).flatMap(i=>{
 if(!i||typeof i!=="object")return [];
 const {field,code}=i as Record<string,unknown>;
 return typeof field==="string"&&field.length<=120&&/^(?:\$|(?:draft|reply_parts|intent|conversation_stage|red_flags|factsClaimed|needs_human|needs_human_reason)(?:\.[a-zA-Z_]+|\.\d+)*)$/.test(field)&&typeof code==="string"&&issueCodes.includes(code)?[{field,code}]:[];
}):[];
/** Persist shape/termination data, never model prose, prompts or provider errors. */
export function sanitizeModelOutputDiagnostics(value:unknown):ModelOutputDiagnostics|undefined {
 if(!value||typeof value!=="object")return undefined;
 const d=value as Record<string,unknown>,length=count(d.text_length),steps=count(d.step_count),calls=count(d.tool_call_count);
 if(typeof d.object_type!=="string"||!objectTypes.includes(d.object_type)||typeof d.text_status!=="string"||!textStates.includes(d.text_status)||length===null||steps===null||calls===null)return undefined;
 return {object_type:d.object_type,text_status:d.text_status,text_length:length,step_count:steps,tool_call_count:calls,
  object_issues:issues(d.object_issues),text_issues:issues(d.text_issues),...(typeof d.finish_reason==="string"&&finishes.includes(d.finish_reason)?{finish_reason:d.finish_reason}:{})};
}
export function safeModelFailureMetadata(body:Record<string,unknown>) {
 const diagnostics=sanitizeModelOutputDiagnostics(body.output_diagnostics);
 const model=typeof body.model_id==="string"&&/^(?:google|anthropic|openai|deepseek|x-ai|moonshotai|qwen|meta-llama|mistralai)\/[a-zA-Z0-9_.:/-]{1,100}$/.test(body.model_id)?body.model_id:undefined;
 const cost=typeof body.cost_usd==="number"&&Number.isFinite(body.cost_usd)&&body.cost_usd>=0&&body.cost_usd<=100?body.cost_usd:undefined;
 return {...(model?{model_id:model}:{}),...(cost!==undefined?{cost_usd:cost}:{}),...(diagnostics?{output_diagnostics:diagnostics}:{})};
}
