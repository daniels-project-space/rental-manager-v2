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
