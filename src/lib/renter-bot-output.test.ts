import { expect,it } from "vitest";
import { parseRenterBotOutput, validateRenterBotOutput,renterBotOutputDiagnostics } from "./renter-bot-output";
import { canonicalGenerationError } from "../../convex/lib/canonical_generation_error";
const valid={draft:"The TTArtisan 11mm is manual focus. I can check the owned Sony options before quoting.",intent:"EQUIPMENT_QUESTION",conversation_stage:"CONFIRMED_UPCOMING",red_flags:[],factsClaimed:[],needs_human:false};
it("validates ordinary and fenced envelopes without turning facts into proof",()=>{
 expect(parseRenterBotOutput(JSON.stringify(valid))).toEqual(valid);
 expect(validateRenterBotOutput(valid)).toEqual(valid);
 expect(validateRenterBotOutput({...valid,needs_human:"false"})).toBeNull();
 expect(parseRenterBotOutput("```json\n"+JSON.stringify(valid)+"\n```" )).toEqual(valid);
 const technical={...valid,factsClaimed:[{kind:"technical_spec",value:"manual focus",sourceTool:"prompt",sourceCallId:"prompt"}]};
 expect(parseRenterBotOutput(JSON.stringify(technical))).toEqual(technical);
});
it.each([
 {needs_human:"false"},{needs_human:0},{needs_human:null},{draft:42},{draft:[]},{draft:" "},{intent:"INVENTED_INTENT"},{conversation_stage:"INVENTED_STAGE"},
 {factsClaimed:{}},{factsClaimed:[{kind:"technical_spec",value:"autofocus"}]},{red_flags:"none"},
])("rejects a syntactically valid but malformed decision: %j",patch=>{
 expect(parseRenterBotOutput(JSON.stringify({...valid,...patch}))).toBeNull();
});
it("does not approve prose or incomplete JSON as an envelope",()=>{
 for(const text of [valid.draft,"",JSON.stringify({draft:valid.draft}),"{bad json}","null","[]"])
  expect(parseRenterBotOutput(text)).toBeNull();
});
it("retains a valid explicit human handoff",()=>{
 const handoff={...valid,draft:"",needs_human:true,needs_human_reason:"Owner must review the damage report"};
 expect(parseRenterBotOutput(JSON.stringify(handoff))).toEqual(handoff);
});
it("preserves only the bounded output failure code across the API boundary",async()=>{
 expect(await canonicalGenerationError(Response.json({error_code:"invalid_model_output",transient:false,raw_output:"private"},{status:502})))
  .toEqual({http_status:502,error_code:"invalid_model_output",transient:false,upstream_status:undefined,request_id:undefined});
});


it("diagnoses output shape and schema paths without copying private prose or provider payloads",()=>{
 const privateText="Private renter text and secret header";
 const d=renterBotOutputDiagnostics(undefined,privateText,{finishReason:"tool-calls",steps:[{toolCalls:[{args:{secret:privateText}}]}]});
 expect(d).toMatchObject({object_type:"missing",text_status:"no_json",finish_reason:"tool-calls",step_count:1,tool_call_count:1,text_length:privateText.length});
 expect(JSON.stringify(d)).not.toContain(privateText);expect(JSON.stringify(d)).not.toContain("secret");
 const invalid={...valid,intent:"SECRET INVALID VALUE"};
 const shape=renterBotOutputDiagnostics(invalid,JSON.stringify(invalid));expect(shape.text_status).toBe("schema_invalid");expect(shape.object_issues.some(i=>i.field==="intent")).toBe(true);expect(JSON.stringify(shape)).not.toContain("SECRET");
 expect(renterBotOutputDiagnostics(undefined,'{"draft":',{}).text_status).toBe("invalid_json");
 expect(renterBotOutputDiagnostics(undefined,"",{}).text_status).toBe("empty");
 expect(renterBotOutputDiagnostics({...valid,draft:" "},JSON.stringify({...valid,draft:" "})).text_status).toBe("empty_reply");
 expect(renterBotOutputDiagnostics(valid,JSON.stringify(valid)).text_status).toBe("valid");
});
it("retains bounded failure telemetry while discarding arbitrary upstream fields",async()=>{
 const diagnostics=renterBotOutputDiagnostics(undefined,"",{finishReason:"length",steps:[]});
 const failure=await canonicalGenerationError(Response.json({error_code:"invalid_model_output",transient:false,model_id:"google/gemini-3.7-flash",cost_usd:0.0125,output_diagnostics:{...diagnostics,raw_output:"private",object_issues:[{field:"intent",code:"invalid_value"},{field:"Authorization: Bearer private",code:"private"}]},headers:{authorization:"private"}},{status:502,headers:{'x-vercel-id':'native-request-123'}}));
 expect(failure).toMatchObject({model_id:"google/gemini-3.7-flash",cost_usd:0.0125,request_id:"native-request-123",output_diagnostics:{object_type:"missing",finish_reason:"length",object_issues:[{field:"intent",code:"invalid_value"}]}});expect(JSON.stringify(failure)).not.toContain("private");
 const invalid=await canonicalGenerationError(Response.json({error_code:"invalid_model_output",model_id:"sk-private",cost_usd:-1,output_diagnostics:{...diagnostics,step_count:Infinity}},{status:502}));
 expect(invalid.model_id).toBeUndefined();expect(invalid.cost_usd).toBeUndefined();expect(invalid.output_diagnostics).toBeUndefined();
});
