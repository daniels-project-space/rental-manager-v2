import { describe, expect, it } from "vitest";
import { renterOwnerCheckContextSchema, renterContextOutputSchema } from "./renter-owner-check-context";
import fixture from "./fixtures/renter-owner-check-context.json";
import fullContext from "./fixtures/renter-owner-full-context.json";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

describe("Native owner state crossing the Mastra tool contract",()=>{
  it("preserves the same response through Mastra's standard-schema wrapper",async()=>{
    const tool=createTool({id:"renter-context-contract-probe",description:"Validate captured Native context",inputSchema:z.object({}),outputSchema:renterContextOutputSchema,execute:async()=>renterContextOutputSchema.parse(fullContext)});
    const result=await tool.outputSchema!["~standard"].validate(fullContext);
    expect(result).not.toHaveProperty("issues");
    if(!("value" in result))throw new Error("Mastra rejected the Native response");
    expect(result.value.owner_checks).toEqual(fullContext.owner_checks);
    expect(result.value.rental_requests).toEqual(fullContext.rental_requests);
  });
  it("preserves managed request, camera and review state in the actual Mastra output schema",()=>{
    const parsed=renterContextOutputSchema.parse(fullContext);
    expect(parsed.owner_checks).toEqual(fullContext.owner_checks);
    expect(parsed.rental_request).toEqual(fullContext.rental_request);
    expect(parsed.rental_requests).toEqual(fullContext.rental_requests);
    expect(parsed.renter_camera_identities).toEqual(fullContext.renter_camera_identities);
  });
  it("preserves the actual served candidate assessments and retry identity",()=>{
    expect(renterOwnerCheckContextSchema.parse(fixture.check)).toEqual(fixture.check);
  });
  it("accepts corrected results separately from whether a task is handled",()=>{
    for(const status of ["pending","handled_by_owner"]){
      const current={...fixture.check,status,specification_result_verified:true,
        current_specification_reviews:[{name:"Sony FX3",status:"match",unknown:[],mismatched:[]}]};
      expect(renterOwnerCheckContextSchema.parse(current)).toEqual(current);
    }
  });
  it("accepts kit review identity without turning it into specification proof",()=>{
    const kit={...fixture.check,kind:"kit_recommendation",candidate_product_ids:[1172895],requirements:null,current_specification_reviews:null,specification_guidance:null};
    expect(renterOwnerCheckContextSchema.parse(kit)).toEqual(kit);
  });
  it("rejects malformed evidence, workflow status and requests for renter input",()=>{
    for(const changed of [{kind:"approved_booking"},{customer_input_required:true},{specification_result_verified:"true"},{status:"approved"},
      {current_specification_reviews:[{name:"Sony FX3",status:"available",unknown:[],mismatched:[]}]}])
      expect(renterOwnerCheckContextSchema.safeParse({...fixture.check,...changed}).success).toBe(false);
  });
});
