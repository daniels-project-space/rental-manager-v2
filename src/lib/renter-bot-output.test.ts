import { expect,it } from "vitest";
import { parseRenterBotOutput } from "./renter-bot-output";
import { canonicalGenerationError } from "../../convex/lib/canonical_generation_error";
const valid={draft:"The TTArtisan 11mm is manual focus. I can check the owned Sony options before quoting.",intent:"EQUIPMENT_QUESTION",conversation_stage:"CONFIRMED_UPCOMING",red_flags:[],factsClaimed:[],needs_human:false};
it("validates ordinary and fenced envelopes without turning facts into proof",()=>{
 expect(parseRenterBotOutput(JSON.stringify(valid))).toEqual(valid);
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
