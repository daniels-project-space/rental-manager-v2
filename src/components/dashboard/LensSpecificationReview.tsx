"use client";
import {useState} from "react";
import {useMutation,useQuery} from "convex/react";
import {api} from "../../../convex/_generated/api";
import type {Id} from "../../../convex/_generated/dataModel";
import type {LensFacts} from "../../../convex/lib/lens_variant_review";
import type {FunctionReturnType} from "convex/server";

type Review=Extract<FunctionReturnType<typeof api.renter_bot_owner_checks.getLensReview>,{available:true}>;
const choices:[keyof LensFacts,string,string[]][]=[
 ["focus_mode","Focus mode",["autofocus","manual_focus"]],["manual_focus_available","Manual focus available",["true","false"]],
 ["wide_angle","Wide angle",["true","false"]],["macro","Macro",["true","false"]],
 ["projection","Projection",["fisheye","anamorphic","rectilinear"]],["coverage","Sensor coverage",["full_frame"]],
];
const numbers:[keyof LensFacts,string][]=[["focal_min_mm","Minimum focal length (mm)"],["focal_max_mm","Maximum focal length (mm)"],["max_aperture_f","Maximum aperture (f-number)"],["max_aperture_t","Maximum aperture (T-stop)"]];
export function LensSpecificationReview({taskId,itemId,onClose}:{taskId:Id<"renter_bot_owner_checks">;itemId:Id<"items">;onClose:()=>void}) {
 const review=useQuery(api.renter_bot_owner_checks.getLensReview,{task_id:taskId,item_id:itemId});
 return review===undefined?<p>Loading current lens record…</p>:review.available?<ReviewForm review={review} onClose={onClose}/>:<div role="alert"><p>{review.message}</p><button onClick={onClose}>Close review</button></div>;
}
function ReviewForm({review,onClose}:{review:Review;onClose:()=>void}) {
 const [original]=useState(review);
 const [model,setModel]=useState(original.reviewed?.model_scope==="shared_variants"?"":original.reviewed?.model??"");
 const [url,setUrl]=useState(original.reviewed?.source_url??"");
 const [fields,setFields]=useState<Record<string,string>>(()=>Object.fromEntries([...choices,...numbers].map(([key])=>[key,String(original.reviewed?.[key]??"")])));
 const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[saved,setSaved]=useState<string|null>(null);
 const save=useMutation(api.renter_bot_owner_checks.reviewLensSpecification);
 const changed=review.revision!==original.revision||review.request_message_id!==original.request_message_id;
 return <form aria-label="Review lens specifications" className="mt-3 space-y-3 rounded-lg border border-amber-300/20 p-3" onSubmit={async e=>{
  e.preventDefault();setBusy(true);setError(null);
  try{
   const facts=Object.fromEntries(Object.entries(fields).filter(([,value])=>value!=="").map(([key,value])=>[key,value==="true"?true:value==="false"?false:numbers.some(([field])=>field===key)?Number(value):value])) as LensFacts;
   const result=await save({task_id:original.task_id,item_id:original.item_id,expected_request_message_id:original.request_message_id,expected_revision:original.revision,model,source_url:url,facts,confirmed_model:confirmed});
   setSaved(`Specifications saved. Requested properties: ${result.assessment.status}. The renter follow-up remains open.`);
  }catch(err){setError(err instanceof Error?err.message:"Could not save specifications");}finally{setBusy(false);}
 }}>
  <p className="font-medium">Review {original.name}{original.mount?` · ${original.mount} mount`:""}</p>
  <p className="text-[#a3aab8]">Check the physical lens model and its reference. This replaces its specification review. Leave unchecked properties unknown; previous prose and variant assumptions will not be retained.</p>
  <label className="block">Exact model<input aria-label="Exact lens model" required minLength={3} maxLength={200} value={model} onChange={e=>setModel(e.target.value)} className="mt-1 block w-full rounded bg-black/30 p-2"/></label>
  <label className="block">Reference URL<input aria-label="Lens specification reference" required type="url" value={url} onChange={e=>setUrl(e.target.value)} className="mt-1 block w-full rounded bg-black/30 p-2"/></label>
  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
   {choices.map(([key,label,values])=><label key={key}>{label}<select aria-label={label} value={fields[key]} onChange={e=>setFields({...fields,[key]:e.target.value})} className="mt-1 block w-full rounded bg-[#151923] p-2"><option value="">Unknown</option>{values.map(value=><option key={value} value={value}>{value==="true"?"Yes":value==="false"?"No":value.replaceAll("_"," ")}</option>)}</select></label>)}
   {numbers.map(([key,label])=><label key={key}>{label}<input aria-label={label} type="number" min="0.001" step="any" placeholder="Unknown" value={fields[key]} onChange={e=>setFields({...fields,[key]:e.target.value})} className="mt-1 block w-full rounded bg-black/30 p-2"/></label>)}
  </div>
  <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I checked the actual lens model and every property entered against the reference.</label>
  {changed&&!saved&&<p role="alert" className="text-amber-200">This record changed while you were reviewing it. Close and reopen the form.</p>}
  {error&&<p role="alert" className="text-red-300">{error}</p>}{saved&&<p role="status" className="text-emerald-200">{saved}</p>}
  <button disabled={busy||!confirmed||changed||!!saved} className="rounded bg-amber-300/15 px-3 py-2 disabled:opacity-40">{busy?"Saving…":"Save reviewed specifications"}</button>
  <button type="button" className="ml-3" onClick={onClose}>Close</button>
 </form>;
}
