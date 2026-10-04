import { describe, it, expect } from "vitest";
import { bindRenterToolArgs, withRenterToolScope } from "./renter-tool-scope";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { RENTER_MODEL_RETRIES } from "./renter-model-policy";
import { APICallError } from "ai";
describe("trusted tool request scope", () => {
  it("does not let the model switch accounts or query another conversation", () => {
    const result = withRenterToolScope({ threadId: "thread-one", accountSlug: "leo" }, () => bindRenterToolArgs("renter_bot_tools:check_availability", { thread_id: "someone-else", account_slug: "diogo", item_name: "Sony FX3" }));
    expect(result).toMatchObject({ thread_id: "thread-one", account_slug: "leo", item_name: "Sony FX3" });
  });
  it("fills omitted pricing account and stock exclusion thread", () => {
    const scope = { threadId: "one", accountSlug: "leo" };
    expect(bindRenterToolArgs("renter_bot_tools:lookup_pricing", {}, scope)).toEqual({ account_slug: "leo" });
    expect(bindRenterToolArgs("renter_bot_tools:check_availability", {}, scope)).toEqual({ thread_id: "one" });
    expect(bindRenterToolArgs("renter_bot_tools:check_basket_availability", {account_slug:"diogo"}, scope)).toEqual({account_slug:"leo",thread_id:"one"});
    expect(bindRenterToolArgs("renter_bot_tools:find_owned_alternatives", {account_slug:"diogo",kind:"camera",camera_requirements:{sensor_format:"full_frame",internal_4k:true}}, scope)).toEqual({account_slug:"leo",thread_id:"one",kind:"camera",camera_requirements:{sensor_format:"full_frame",internal_4k:true}});
    expect(bindRenterToolArgs("settings:get", {}, scope)).toEqual({});
  });
  it("keeps concurrent threads isolated across async tool calls", async () => {
    const run = (threadId: string, accountSlug: string) => withRenterToolScope({ threadId, accountSlug }, async () => { await new Promise((resolve) => setTimeout(resolve, 1)); return bindRenterToolArgs("renter_bot_tools:lookup_pricing", { thread_id: "untrusted" }); });
    expect(await Promise.all([run("one", "leo"), run("two", "diogo")])).toEqual([{ account_slug: "leo", thread_id: "one" }, { account_slug: "diogo", thread_id: "two" }]);
  });
});
it("retries a failed model step without replaying a completed booking tool",async()=>{
 let modelCalls=0;let toolCalls=0;
 const model:any={specificationVersion:"v2",provider:"test",modelId:"same-model",supportedUrls:{},
  doGenerate:async()=>{
   modelCalls++;
   if(modelCalls===2 || modelCalls===3)throw new APICallError({message:"provider aborted",url:"https://test.invalid",requestBodyValues:{},statusCode:504,isRetryable:true});
   return {content:modelCalls===1?[{type:"tool-call",toolCallId:"write-once",toolName:"simulatedWrite",input:"{}"}]:[{type:"text",text:"Ready"}],
    finishReason:modelCalls===1?"tool-calls":"stop",usage:{inputTokens:1,outputTokens:1},warnings:[]};
  }};
 const simulatedWrite=createTool({id:"simulatedWrite",description:"Simulate one authorized write",inputSchema:z.object({}),execute:async()=>{toolCalls++;return {ok:true};}});
 const agent=new Agent({id:"retry-contract-test",name:"Retry contract",instructions:"Test retry scope",model,tools:{simulatedWrite},maxRetries:RENTER_MODEL_RETRIES});
 const result=await agent.generate("Run once",{maxSteps:3});
 expect(result.text).toBe("Ready");expect(modelCalls).toBe(4);expect(toolCalls).toBe(1);
},15000);

it("binds booking changes to the server's inbound message and rejects a fabricated snapshot",()=>{
 expect(bindRenterToolArgs("renter_bot_lab_order:applyChange",{thread_id:"other",request_message_id:"model-choice",action:"add_item"},{threadId:"one",accountSlug:"leo",requestMessageId:"renter-1"})).toMatchObject({thread_id:"one",request_message_id:"renter-1"});
 expect(bindRenterToolArgs("renter_bot_lab_order:applyChange",{request_message_id:"model-choice"},{threadId:"one",accountSlug:"leo"})).toMatchObject({request_message_id:""});
});

it("blocks booking tools in a read-only diagnostic while preserving scoped reads", () => {
 const scope = { threadId: "__probe__comparison", accountSlug: "leo", bookingWritesAllowed: false };
 expect(() => bindRenterToolArgs("renter_bot_lab_order:applyChange", { action: "add_item" }, scope)).toThrow("disabled");
 expect(bindRenterToolArgs("renter_bot_tools:lookup_pricing", { account_slug: "diogo" }, scope)).toEqual({ account_slug: "leo" });
});

it("binds and disables atomic setup acceptance just like other booking writes",()=>{
 for(const name of ["renter_bot_lab_order:applyAdditionBasket","renter_bot_lab_order:applyReplacementBasket"]){
 expect(bindRenterToolArgs(name,{thread_id:"other",request_message_id:"fabricated",items:[{product_id:1,qty:1}]},{threadId:"__probe__one",accountSlug:"leo",requestMessageId:"current"})).toMatchObject({thread_id:"__probe__one",request_message_id:"current"});
 expect(()=>bindRenterToolArgs(name,{items:[]},{threadId:"__probe__one",accountSlug:"leo",bookingWritesAllowed:false})).toThrow("disabled");
}
 expect(bindRenterToolArgs("order_edit:getOrderState",{hygglo_order_id:"foreign",account_slug:"diogo"},{threadId:"__probe__one",accountSlug:"leo"})).toEqual({hygglo_order_id:"__probe__one",account_slug:"leo"});
});
