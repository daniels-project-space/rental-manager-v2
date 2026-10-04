import { v, type Infer } from "convex/values";
import { cameraRequirementsValidator } from "./camera_requirement_validator";
import { lensRequirementsValidator } from "./owner_checks";
import { assessCameraRequirements, verifiedCameraCapabilities, type CameraSpec } from "./camera_requirements";
import { assessLensRequirements, verifiedLensCapabilities, type LensSpec } from "./lens_requirements";
import { sameMount } from "./item_name_match";
export const recommendationRequirementValidator=v.union(
 v.object({kind:v.literal("camera"),requirements:cameraRequirementsValidator,native_mount:v.optional(v.string()),target_item_id:v.optional(v.string()),quantity:v.number()}),
 v.object({kind:v.literal("lens"),requirements:lensRequirementsValidator,native_mount:v.optional(v.string()),target_item_id:v.optional(v.string()),quantity:v.number()}));
export type RecommendationRequirement=Infer<typeof recommendationRequirementValidator>;
function canonical(value:unknown):unknown {
 if(Array.isArray(value))return value.map(canonical).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
 return value;
}
export const recommendationRequirementsKey=(requirements:RecommendationRequirement[])=>JSON.stringify(canonical(requirements));
export type QualificationItem={item_id:string;name:string;kind:string;quantity:number;native_mount?:string|null;spec:CameraSpec&LensSpec|null};
/** Requirements for one resolved request target describe the same requested item. A matching
 * item must meet all of them; different bodies cannot each satisfy one half.
 * Additional basket accessories do not become the qualifying primary item. */
export function qualifyRecommendationBasket(requirements:RecommendationRequirement[],items:QualificationItem[]) {
 const slots=[...new Set(requirements.map(r=>JSON.stringify([r.kind,r.target_item_id??null])))];
 const groups=slots.map(slot=>{
  const constraints=requirements.filter(r=>JSON.stringify([r.kind,r.target_item_id??null])===slot),kind=constraints[0].kind,required_units=Math.max(...constraints.map(r=>r.quantity));
  const candidates=items.filter(i=>kind==="camera"?["camera","camera_body"].includes(i.kind):i.kind==="lens").map(item=>{
   const assessments=constraints.map(c=>{
    if(c.kind==="camera")return assessCameraRequirements(verifiedCameraCapabilities(item.spec,item.name),c.requirements,c.native_mount);
    const assessment=assessLensRequirements(verifiedLensCapabilities(item.spec??undefined,item.name),c.requirements);
    if(c.native_mount&&!item.native_mount)return {...assessment,status:"unknown" as const,unknown:[...assessment.unknown,"native_mount"]};
    if(c.native_mount&&!sameMount(item.native_mount,c.native_mount))return {...assessment,status:"mismatch" as const,mismatched:[...assessment.mismatched,"native_mount"]};
    return assessment;
   });
   const status=assessments.some(a=>a.status==="mismatch")?"mismatch":assessments.some(a=>a.status==="unknown")?"unknown":"match";
   return {item_id:item.item_id,name:item.name,quantity:item.quantity,status,unknown:[...new Set(assessments.flatMap(a=>a.unknown))],mismatched:[...new Set(assessments.flatMap(a=>a.mismatched))]};
  });
  const qualified_units=candidates.filter(c=>c.status==="match").reduce((n,c)=>n+c.quantity,0);
  return {kind,target_item_id:constraints[0].target_item_id??null,required_units,qualified_units,verified:Number.isInteger(required_units)&&required_units>0&&qualified_units>=required_units,candidates};
 });
 // Allocate physical units to distinct requested slots. A single unit cannot
 // silently fulfil two separate requested replacements, even if it qualifies
 // for both. Use an integral flow rather than a model-chosen allocation.
 const count=groups.length+items.length+2,sink=count-1,capacity=Array.from({length:count},()=>Array<number>(count).fill(0));
 groups.forEach((g,i)=>{capacity[0][i+1]=g.verified?g.required_units:0;items.forEach((item,j)=>{if(g.candidates.some(c=>c.item_id===item.item_id&&c.status==="match"))capacity[i+1][groups.length+j+1]=g.required_units;});});
 items.forEach((item,j)=>{capacity[groups.length+j+1][sink]=item.quantity;});
 const residual=capacity.map(row=>row.slice());let allocated=0;
 while(true){
  const parent=Array<number>(count).fill(-1),queue=[0];parent[0]=0;
  for(let i=0;i<queue.length&&parent[sink]===-1;i++)for(let next=1;next<count;next++)if(parent[next]===-1&&residual[queue[i]][next]>0){parent[next]=queue[i];queue.push(next);}
  if(parent[sink]===-1)break;
  let units=Infinity;for(let n=sink;n!==0;n=parent[n])units=Math.min(units,residual[parent[n]][n]);
  for(let n=sink;n!==0;n=parent[n]){residual[parent[n]][n]-=units;residual[n][parent[n]]+=units;}
  allocated+=units;
 }
 const allocations=groups.flatMap((g,i)=>items.flatMap((item,j)=>{const units=capacity[i+1][groups.length+j+1]-residual[i+1][groups.length+j+1];return units>0?[{kind:g.kind,target_item_id:g.target_item_id,item_id:item.item_id,units}]:[];}));
 return {requirements_key:recommendationRequirementsKey(requirements),requirements_applied:groups.length>0,verified:groups.length?groups.every(g=>g.verified)&&allocated===groups.reduce((n,g)=>n+g.required_units,0):null,groups,allocations};
}
