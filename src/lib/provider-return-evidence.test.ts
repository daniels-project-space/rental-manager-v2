import{describe,it,expect}from"vitest";import{providerReturnCompleted}from"./provider-return-evidence";describe("explicit platform return evidence",()=>{
 it("requires a successful completed return, not active/elapsed state",()=>{expect(providerReturnCompleted({steps:[{key:"RETURNED",active:true,completed:false}]})).toBe(false);expect(providerReturnCompleted({steps:[{key:"RETURNED",completed:true,failure:true}]})).toBe(false);expect(providerReturnCompleted({endDate:"2026-01-01"})).toBe(false);});
 for(const wrapper of ["steps","detail","_detail"]){it(`reads ${wrapper} while an active step remains`,()=>{const steps=[{key:"RETURNED",active:true,completed:true},{key:"REVIEWED",active:false}];expect(providerReturnCompleted(wrapper==="steps"?{steps}:{[wrapper]:{steps}})).toBe(true);});}
});
