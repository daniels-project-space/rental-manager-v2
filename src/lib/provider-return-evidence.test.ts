import{describe,it,expect}from"vitest";import{providerActiveStep,providerReturnCompleted}from"./provider-return-evidence";describe("explicit platform return evidence",()=>{
 it("requires a successful completed return, not active/elapsed state",()=>{expect(providerReturnCompleted({steps:[{key:"RETURNED",active:true,completed:false}]})).toBe(false);expect(providerReturnCompleted({steps:[{key:"RETURNED",completed:true,failure:true}]})).toBe(false);expect(providerReturnCompleted({endDate:"2026-01-01"})).toBe(false);});
 it("rejects contradictory or malformed return evidence",()=>{expect(providerReturnCompleted({steps:[{key:"RETURNED",completed:true,failure:false},{key:"RETURNED",completed:false,failure:true}]})).toBe(false);expect(providerReturnCompleted({steps:[{key:"RETURNED",completed:true},{key:"RETURNED",completed:true}]})).toBe(false);expect(providerReturnCompleted({steps:[{key:"RETURNED",completed:true,failure:"true"}]})).toBe(false);expect(providerReturnCompleted({steps:[{key:"RETURNED",completed:true,failure:null}]})).toBe(false);});
 for(const wrapper of ["steps","detail","_detail"]){it(`reads ${wrapper} while an active step remains`,()=>{const steps=[{key:"RETURNED",active:true,completed:true},{key:"REVIEWED",active:false}];expect(providerReturnCompleted(wrapper==="steps"?{steps}:{[wrapper]:{steps}})).toBe(true);});}
 it("does not infer return completion from duplicate or malformed evidence",()=>{
  for(const steps of [[{key:"RETURNED",completed:true},{key:"RETURNED",completed:false}],[{key:"RETURNED",completed:true,failure:"true"}],[{key:"RETURNED",completed:true,failure:null}],[{key:"REVIEWED",active:true},{key:"RETURNED",completed:false}]]) expect(providerActiveStep({steps})).toBeUndefined();
  expect(providerActiveStep({steps:[{key:"RETURNED",completed:true,failure:false}]})).toBe("REVIEWED");
  expect(providerActiveStep({steps:[{key:"RETURNED",active:true,completed:false}]})).toBe("RETURNED");
 });
});
