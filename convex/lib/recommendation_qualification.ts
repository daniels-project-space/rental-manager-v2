import { v, type Infer } from "convex/values";
import { cameraRequirementsValidator } from "./camera_requirement_validator";
import { lensRequirementsValidator } from "./owner_checks";
import { assessCameraRequirements, verifiedCameraCapabilities, type CameraSpec } from "./camera_requirements";
import { assessLensRequirements, verifiedLensCapabilities, type LensSpec } from "./lens_requirements";
import { sameMount } from "./item_name_match";
import { requiredMountAdapters } from "./required_mount_adapter";
import type { OwnerCheck } from "./owner_checks";
import type { Id } from "../_generated/dataModel";
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
/** Missing basket facts use the same source-backed specification workflow as searches.
 * Stock shortages and known mismatches are not unresolved specification facts. */
export function basketSpecificationOwnerChecks(requirements:RecommendationRequirement[],items:QualificationItem[],dates:{start_date:string;end_date:string}) {
 const checks:Array<Omit<Extract<OwnerCheck,{kind:"lens_recommendation"|"camera_recommendation"}>,"source_call_id">>=[];
 const paired=items.some(i=>["camera","camera_body"].includes(i.kind))&&items.some(i=>i.kind==="lens");
 for(const item of items){
  if(!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>20)continue;
  const candidates=requirements.filter(r=>r.kind==="lens"?item.kind==="lens":["camera","camera_body"].includes(item.kind));
  if(paired&&item.kind==="lens")candidates.push({kind:"lens",requirements:{coverage:"full_frame"},quantity:item.quantity});
  if(paired&&["camera","camera_body"].includes(item.kind))candidates.push({kind:"camera",requirements:{role:"interchangeable_lens"},native_mount:item.native_mount??undefined,quantity:item.quantity});
  for(const requirement of candidates){
   const assessment=requirement.kind==="lens"?assessLensRequirements(verifiedLensCapabilities(item.spec??undefined,item.name),requirement.requirements)
    :assessCameraRequirements(verifiedCameraCapabilities(item.spec,item.name),requirement.requirements,requirement.native_mount);
   if(assessment.status!=="unknown")continue;
   checks.push({kind:requirement.kind==="lens"?"lens_recommendation":"camera_recommendation",requirements:requirement.requirements,
    candidate_item_ids:[item.item_id as Id<"items">],lens_mount:requirement.native_mount??null,...dates,quantity:item.quantity});
  }
 }
 return checks;
}
/** Individual capabilities do not prove a usable camera/lens pair. Check the
 * selected physical set even when a search omitted mount or lens coverage. */
function qualifyCameraLensSetup(requirements:RecommendationRequirement[],items:QualificationItem[]) {
 const cameras=items.filter(i=>["camera","camera_body"].includes(i.kind)),lenses=items.filter(i=>i.kind==="lens");
 if(!cameras.length||!lenses.length)return {applied:false,status:"not_applicable" as const,unknown:[] as string[],mismatched:[] as string[]};
 const unknown:string[]=[],mismatched:string[]=[],caps=cameras.map(i=>verifiedCameraCapabilities(i.spec,i.name));
 cameras.forEach((camera,index)=>{
  const cap=caps[index];
  if(!cap?.role)unknown.push("camera_role");else if(cap.role!=="interchangeable_lens")mismatched.push("camera_role");
  if(!cap?.native_mount||!camera.native_mount)unknown.push("camera_mount");
  else if(!sameMount(cap.native_mount,camera.native_mount))mismatched.push("camera_mount_identity");
 });
 if(cameras.some(c=>!sameMount(c.native_mount,cameras[0].native_mount)))unknown.push("camera_lens_assignment");
 lenses.forEach(lens=>{if(!lens.native_mount)unknown.push("lens_mount");});
 const mountItems=items.map(i=>({id:i.item_id,name:i.name,kind:i.kind,mount:i.native_mount}));
 const units=items.map(i=>({item_id:i.item_id,quantity:i.quantity}));
 const mount=requiredMountAdapters(mountItems,units.filter(u=>!lenses.some(l=>l.item_id===u.item_id)),units.filter(u=>lenses.some(l=>l.item_id===u.item_id)));
 if(mount.status==="unknown")unknown.push("mount_adapter");
 if(mount.status==="required")mismatched.push("missing_mount_adapter");
 const adapted=lenses.some(l=>!sameMount(l.native_mount,cameras[0].native_mount));
 // A mechanical mount adapter does not establish electronic autofocus support.
 if(adapted&&requirements.some(r=>r.kind==="lens"&&r.requirements.focus_mode==="autofocus"))unknown.push("adapted_autofocus");
 // Current reviewed lens coverage records attest full-frame coverage only,
 // which also covers the smaller supported capture classes. Missing coverage
 // cannot attest any capture class; cropping is not proof of an image circle.
 for(const lens of lenses){
  const cap=verifiedLensCapabilities(lens.spec??undefined,lens.name);
  if(cap?.coverage!=="full_frame")unknown.push("lens_sensor_coverage");
 }
 return {applied:true,status:mismatched.length?"mismatch" as const:unknown.length?"unknown" as const:"match" as const,
  unknown:[...new Set(unknown)],mismatched:[...new Set(mismatched)]};
}
/** Requirements for one resolved request target describe the same requested item. A matching
 * item must meet all of them; different bodies cannot each satisfy one half.
 * Additional basket accessories do not become the qualifying primary item. */
export function qualifyRecommendationBasket(requirements:RecommendationRequirement[],items:QualificationItem[]) {
 const setup=qualifyCameraLensSetup(requirements,items);
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
 return {requirements_key:recommendationRequirementsKey(requirements),requirements_applied:groups.length>0,verified:groups.length||setup.applied?(!setup.applied||setup.status==="match")&&groups.every(g=>g.verified)&&allocated===groups.reduce((n,g)=>n+g.required_units,0):null,setup,groups,allocations};
}
