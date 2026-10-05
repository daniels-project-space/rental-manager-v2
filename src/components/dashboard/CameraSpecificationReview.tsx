"use client";
import {useState} from "react";
import {useConvexAuth,useMutation,useQuery} from "convex/react";
import type {FunctionReturnType} from "convex/server";
import {api} from "../../../convex/_generated/api";
import type {Id} from "../../../convex/_generated/dataModel";
import type {CameraRole,SensorFormat,RecordingResolution} from "../../../convex/lib/camera_requirements";

type Review=Extract<FunctionReturnType<typeof api.renter_bot_camera_reviews.getReview>,{available:true}>;
const formats=["full_frame","super35","aps_c","small_sensor"] as const;
const fieldClass="mt-1 block w-full rounded bg-[#151923] p-2";
const label=(s:string)=>s.replaceAll("_"," ");
export function CameraSpecificationReview({taskId,itemId,onClose}:{taskId:Id<"renter_bot_owner_checks">;itemId:Id<"items">;onClose:()=>void}){
 const review=useQuery(api.renter_bot_camera_reviews.getReview,{task_id:taskId,item_id:itemId});
 return review===undefined?<p>Loading current camera record…</p>:review.available?<ReviewForms review={review} onClose={onClose}/>:<div role="alert"><p>{review.message}</p><button onClick={onClose}>Close review</button></div>;
}
function ReviewForms({review,onClose}:{review:Review;onClose:()=>void}){
 const {isAuthenticated}=useConvexAuth(),save=useMutation(api.renter_bot_camera_reviews.saveReview);
 const [original]=useState(review),[modeIndex,setModeIndex]=useState<number|null|undefined>(undefined);
 const [model,setModel]=useState(original.model??""),[url,setUrl]=useState(original.source_url??"");
 const [role,setRole]=useState<string>(original.profile?.role??""),[sensor,setSensor]=useState<string>(original.profile?.sensor_format??""),[mount,setMount]=useState(original.profile?.native_mount??"");
 const [internal4k,setInternal4k]=useState(String(original.profile?.internal_4k??"")),[nd,setNd]=useState(String(original.profile?.built_in_nd??""));
 const [resolution,setResolution]=useState<RecordingResolution|"">(""),[fps,setFps]=useState(""),[capture,setCapture]=useState(""),[fullWidth,setFullWidth]=useState(""),[internal,setInternal]=useState(""),[conditions,setConditions]=useState(""),[modeUrl,setModeUrl]=useState("");
 const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[saved,setSaved]=useState<string|null>(null);
 const changed=original.revision!==review.revision||original.request_message_id!==review.request_message_id;
 const modes=original.recording_reviews;
 const openMode=(index:number|null)=>{
  const mode=index===null?undefined:modes[index];setModeIndex(index);setResolution(mode?.resolution??"");setFps(mode?.nominal_fps.join(", ")??"");setCapture(mode?.capture_format??"");setFullWidth(String(mode?.full_width??""));setInternal(String(mode?.internal??""));setConditions(mode?.conditions.join("\n")??"");setModeUrl(mode?.source_url??"");setConfirmed(false);setError(null);
 };
 const select=(name:string,value:string,update:(value:string)=>void,values:readonly string[],required=false)=><label>{name}<select aria-label={name} required={required} value={value} onChange={e=>update(e.target.value)} className={fieldClass}><option value="">Unknown</option>{values.map(v=><option key={v} value={v}>{v==="true"?"Yes":v==="false"?"No":label(v)}</option>)}</select></label>;
 return <div role="region" aria-label="Camera specification review" className="mt-3 space-y-3 rounded-lg border border-amber-300/20 p-3">
  <p className="font-medium">Review {original.name}</p>
  <p className="text-[#a3aab8]">Camera properties and recording modes have separate references. A profile correction preserves reviewed modes for the same exact model. Changing the model requires fresh mode evidence.</p>
  <div className="flex flex-wrap gap-2"><button onClick={()=>{setModeIndex(undefined);setConfirmed(false);setError(null);}} className="rounded bg-white/10 px-3 py-2">Camera profile</button>{original.profile&&<button onClick={()=>openMode(null)} className="rounded bg-white/10 px-3 py-2">Add recording mode</button>}</div>
  {modes.length>0&&<div aria-label="Reviewed recording modes" className="space-y-2">{modes.map((mode,index)=><div key={index} className="rounded bg-black/20 p-2"><p>{label(mode.resolution)} · {mode.nominal_fps.join(", ")} fps · {mode.full_width?"full sensor width":"windowed"} · {mode.internal?"internal":"external"}{mode.capture_format?` · ${label(mode.capture_format)} capture`:" · capture area not reviewed"}</p>{mode.conditions.map((text,i)=><p key={i}>{text}</p>)}{mode.internal&&original.profile?.internal_4k===false&&<p className="text-amber-200">This mode conflicts with the current internal 4K profile and is excluded from recommendations.</p>}<a href={mode.source_url} target="_blank" rel="noreferrer" className="text-amber-200 underline">Recording reference</a><button onClick={()=>openMode(index)} className="ml-3 rounded bg-white/10 px-2 py-1">Review this mode</button></div>)}</div>}
  <form aria-label="Review camera specifications" className="space-y-3" onSubmit={async e=>{
   e.preventDefault();setBusy(true);setError(null);
   try{
    const change=modeIndex===undefined?{kind:"profile" as const,model,source_url:url,role:role as CameraRole,sensor_format:sensor as SensorFormat,native_mount:mount||undefined,internal_4k:internal4k==="true",built_in_nd:nd===""?undefined:nd==="true"}
     :{kind:"recording_mode" as const,mode_index:modeIndex??undefined,source_url:modeUrl,resolution:resolution as RecordingResolution,nominal_fps:fps.split(",").map(s=>Number(s.trim())),capture_format:capture?capture as SensorFormat:undefined,full_width:fullWidth==="true",internal:internal==="true",conditions:conditions.split("\n").map(s=>s.trim()).filter(Boolean)};
    const result=await save({task_id:original.task_id,item_id:original.item_id,expected_request_message_id:original.request_message_id,expected_revision:original.revision,confirmed_model:confirmed,change});
    setSaved(`Camera review saved. Requested properties: ${result.assessment.status}. Close and reopen to make another correction. The renter follow-up remains open.`);
   }catch(err){setError(err instanceof Error?err.message:"Could not save camera review");}finally{setBusy(false);}
  }}>
   {modeIndex===undefined?<>
    <p>Review the camera profile. Previous descriptive prose will be replaced by these reviewed properties. The native mount also updates its inventory record.</p>
    <label className="block">Exact camera model<input aria-label="Exact camera model" required minLength={3} maxLength={200} value={model} onChange={e=>setModel(e.target.value)} className={fieldClass}/></label>
    <label className="block">Camera profile reference<input aria-label="Camera profile reference" required type="url" value={url} onChange={e=>setUrl(e.target.value)} className={fieldClass}/></label>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{select("Camera type",role,setRole,["action","interchangeable_lens"],true)}{select("Physical sensor format",sensor,setSensor,formats,true)}{select("Supports internal 4K",internal4k,setInternal4k,["true","false"],true)}{select("Built-in ND",nd,setNd,["true","false"])}<label>Native mount<input aria-label="Native camera mount" placeholder="Unknown" value={mount} maxLength={80} onChange={e=>setMount(e.target.value)} className={fieldClass}/></label></div>
   </>:<>
    <p>{modeIndex===null?"Add":"Replace"} a recording review for {original.model}. Frame rates, sensor windowing and recording location must come from this mode’s reference. Unknown capture area stays unknown.</p>
    <label className="block">Recording mode reference<input aria-label="Recording mode reference" required type="url" value={modeUrl} onChange={e=>setModeUrl(e.target.value)} className={fieldClass}/></label>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{select("Recording resolution",resolution,v=>setResolution(v as RecordingResolution|""),["uhd_4k","dci_4k"],true)}<label>Nominal frame rates (comma separated)<input aria-label="Nominal frame rates" required placeholder="23.98, 24, 25, 50, 60" value={fps} onChange={e=>setFps(e.target.value)} className={fieldClass}/></label>{select("Capture sensor area",capture,setCapture,formats)}{select("Full sensor width",fullWidth,setFullWidth,["true","false"],true)}{select("Internal recording",internal,setInternal,["true","false"],true)}</div>
    <label className="block">Recording conditions (one per line)<textarea aria-label="Recording conditions" value={conditions} onChange={e=>setConditions(e.target.value)} className={fieldClass}/></label>
   </>}
   <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I checked the actual camera model and every property entered against its reference.</label>
   {!isAuthenticated&&<p><a href="/login" className="text-amber-200 underline">Sign in to save camera specifications</a></p>}
   {changed&&!saved&&<p role="alert" className="text-amber-200">The check or camera record changed. Close and reopen before saving.</p>}{error&&<p role="alert" className="text-red-300">{error}</p>}{saved&&<p role="status" className="text-emerald-200">{saved}</p>}
   <button disabled={busy||!isAuthenticated||!confirmed||changed||!!saved} className="rounded bg-amber-300/15 px-3 py-2 disabled:opacity-40">{busy?"Saving…":"Save camera review"}</button><button type="button" onClick={onClose} className="ml-3">Close</button>
  </form>
 </div>;
}
