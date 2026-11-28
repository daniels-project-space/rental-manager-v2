import {v,type Infer} from "convex/values";
const issue=v.object({field:v.string(),code:v.string()});
const toolTraceEntry=v.object({name:v.string(),result:v.union(v.literal("ok"),v.literal("error"),v.literal("missing"))});
export const modelOutputDiagnosticsValidator=v.object({
 object_type:v.string(),text_status:v.string(),text_length:v.number(),object_issues:v.array(issue),text_issues:v.array(issue),
 finish_reason:v.optional(v.string()),step_count:v.number(),tool_call_count:v.number(),tool_trace:v.optional(v.array(toolTraceEntry)),
});
export type ModelOutputDiagnostics=Infer<typeof modelOutputDiagnosticsValidator>;
export type LabGenerationTrace = {
 token_usage?: { prompt: number | null; completion: number | null; cached: number | null; cost: number | null };
 tool_stats?: {
  steps: number; total: number; byName: Record<string, number>; duplicates: number; errors: number;
  queries?: string[];
  calls?: Array<{ call_id?: string; name: string; args: unknown; result?: unknown; error: boolean }>;
 };
};
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
 const toolTrace=Array.isArray(d.tool_trace)?d.tool_trace.slice(0,60).flatMap(entry=>{
  if(!entry||typeof entry!=="object")return [];
  const e=entry as Record<string,unknown>;
  return typeof e.name==="string"&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e.name)&&["ok","error","missing"].includes(String(e.result))
   ?[{name:e.name,result:e.result as "ok"|"error"|"missing"}]:[];
 }):undefined;
 return {object_type:d.object_type,text_status:d.text_status,text_length:length,step_count:steps,tool_call_count:calls,
  object_issues:issues(d.object_issues),text_issues:issues(d.text_issues),...(toolTrace?{tool_trace:toolTrace}:{}),...(typeof d.finish_reason==="string"&&finishes.includes(d.finish_reason)?{finish_reason:d.finish_reason}:{})};
}

const boundedCount=(value:unknown,max=10000):number|null=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0&&value<=max?value:null;
const boundedMoney=(value:unknown):number|null=>typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=100?value:null;
function boundedTraceValue(value:unknown,depth=0):unknown {
 if(depth>4)return "[depth-limited]";
 if(typeof value==="string")return value.replace(/Bearer\s+\S+/gi,"Bearer [redacted]").slice(0,1200);
 if(value===null||typeof value==="boolean")return value;
 if(typeof value==="number")return Number.isFinite(value)?value:null;
 if(Array.isArray(value))return value.slice(0,12).map(entry=>boundedTraceValue(entry,depth+1));
 if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).slice(0,40).map(([key,entry])=>[
  key.slice(0,120),/token|secret|password|authorization|credential|api.?key/i.test(key)?"[redacted]":boundedTraceValue(entry,depth+1),
 ]));
 return undefined;
}
function sanitizeLabGenerationTrace(value:unknown):LabGenerationTrace|undefined {
 if(!value||typeof value!=="object")return undefined;
 const raw=value as Record<string,unknown>;
 const tokenRaw=raw.token_usage&&typeof raw.token_usage==="object"?raw.token_usage as Record<string,unknown>:undefined;
 const tokenValue=(entry:unknown,max:number)=>entry===null?null:boundedCount(entry,max);
 const tokenUsage=tokenRaw?{
  prompt:tokenValue(tokenRaw.prompt,10000000),completion:tokenValue(tokenRaw.completion,10000000),
  cached:tokenValue(tokenRaw.cached,10000000),cost:tokenRaw.cost===null?null:boundedMoney(tokenRaw.cost),
 }:undefined;
 const statsRaw=raw.tool_stats&&typeof raw.tool_stats==="object"?raw.tool_stats as Record<string,unknown>:undefined;
 let toolStats:LabGenerationTrace["tool_stats"];
 if(statsRaw){
  const steps=boundedCount(statsRaw.steps,100),total=boundedCount(statsRaw.total,200),duplicates=boundedCount(statsRaw.duplicates,200),errors=boundedCount(statsRaw.errors,200);
  const byNameRaw=statsRaw.byName&&typeof statsRaw.byName==="object"?statsRaw.byName as Record<string,unknown>:{};
  const byName=Object.fromEntries(Object.entries(byNameRaw).slice(0,80).flatMap(([name,count])=>{
   const safeCount=boundedCount(count,200);return /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)&&safeCount!==null?[[name,safeCount]]:[];
  }));
  if(steps!==null&&total!==null&&duplicates!==null&&errors!==null){
   const queries=Array.isArray(statsRaw.queries)?statsRaw.queries.slice(0,60).filter((q):q is string=>typeof q==="string").map(q=>q.slice(0,240)):undefined;
   const calls=Array.isArray(statsRaw.calls)?statsRaw.calls.slice(0,60).flatMap(call=>{
    if(!call||typeof call!=="object")return [];
    const c=call as Record<string,unknown>,name=c.name;
    if(typeof name!=="string"||!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)||typeof c.error!=="boolean")return [];
    const callId=typeof c.call_id==="string"&&c.call_id.length<=180?c.call_id:undefined;
    return [{...(callId?{call_id:callId}:{}),name,args:boundedTraceValue(c.args),...(c.result!==undefined?{result:boundedTraceValue(c.result)}:{}),error:c.error}];
   }):undefined;
   toolStats={steps,total,byName,duplicates,errors,...(queries?{queries}:{}),...(calls?{calls}:{})};
  }
 }
 if(!tokenUsage&&!toolStats)return undefined;
 return {...(tokenUsage?{token_usage:tokenUsage}:{}),...(toolStats?{tool_stats:toolStats}:{})};
}
export function safeModelFailureMetadata(body:Record<string,unknown>) {
 const diagnostics=sanitizeModelOutputDiagnostics(body.output_diagnostics);
 const labTrace=sanitizeLabGenerationTrace(body.lab_trace);
 const model=typeof body.model_id==="string"&&/^(?:google|anthropic|openai|deepseek|x-ai|moonshotai|qwen|meta-llama|mistralai)\/[a-zA-Z0-9_.:/-]{1,100}$/.test(body.model_id)?body.model_id:undefined;
 const cost=typeof body.cost_usd==="number"&&Number.isFinite(body.cost_usd)&&body.cost_usd>=0&&body.cost_usd<=100?body.cost_usd:undefined;
 return {...(model?{model_id:model}:{}),...(cost!==undefined?{cost_usd:cost}:{}),...(diagnostics?{output_diagnostics:diagnostics}:{}),...(labTrace?{lab_trace:labTrace}:{})};
}
