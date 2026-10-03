"use client";
import { useState } from "react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { LensRequirements } from "../../../convex/lib/lens_requirements";
import { shortItemName } from "../../../convex/lib/item_display_name";
function criteria(r:LensRequirements) {
  return [r.focus_mode==="autofocus"?"Autofocus":r.focus_mode==="manual_focus"?"Manual focus":null,
    r.wide_angle===true?"Wide-angle":r.wide_angle===false?"Not wide-angle":null,
    r.macro===true?"Macro":r.macro===false?"Not macro":null,r.projection,r.coverage?"Full-frame coverage":null,
    ...(r.excluded_projections??[]).map(p=>`No ${p}`),r.focal_mm?`${r.focal_mm}mm coverage`:null,
    r.max_wide_focal_mm?`${r.max_wide_focal_mm}mm or wider`:null,r.max_aperture_f?`f/${r.max_aperture_f} or faster`:null,
    r.max_aperture_t?`T${r.max_aperture_t} or faster`:null].filter(Boolean).join(" · ");
}
export function OwnerChecksPanel({accountSlug,onOpen,labOnly=false}:{accountSlug?:string;labOnly?:boolean;onOpen:(thread:string)=>void}) {
  const {results,status,loadMore}=usePaginatedQuery(api.renter_bot_owner_checks.list,{account_slug:accountSlug,lab_only:labOnly},{initialNumItems:10});
  const handle=useMutation(api.renter_bot_owner_checks.handle);
  const [editing,setEditing]=useState<Id<"renter_bot_owner_checks">|null>(null),[note,setNote]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  if(!results.length)return null;
  return <section aria-label="Owner checks" className="mb-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.04] p-3">
    <div className="text-sm font-semibold text-amber-200">Owner checks · {results.length}{status!=="Exhausted"?"+":""}</div>
    <p className="mt-1 text-xs text-[#a3aab8]">These follow-ups stay open after a reply. Confirm a suitable lens, availability and price, or handle the question yourself.</p>
    <div className="mt-3 space-y-3">{results.map(task=><div key={task._id} className="rounded-lg bg-black/20 p-3 text-xs">
      <div className="font-medium text-[#e5e7eb]">{criteria(task.check.requirements)} · {task.check.lens_mount??"Confirm mount"} · {task.account_slug}{task.is_lab?" · Lab":""}</div>
      <div className="mt-1 text-[#a3aab8]">{task.check.quantity} lens{task.check.quantity!==1?"es":""} · {task.check.start_date??"Start date needed"} to {task.check.end_date??"Return date needed"}</div>
      <div className="mt-2 text-[#cbd5e1]">Owned candidates to check: {task.candidate_names.map(shortItemName).join(", ")}</div>
      <blockquote className="mt-2 text-[#a3aab8] line-clamp-3">“{task.source_question}”</blockquote>
      {(task.context_changed||task.newer_renter_message)&&<p className="mt-2 text-amber-200">The booking or renter message has changed. Review the current conversation before handling this check.</p>}
      <div className="mt-3 flex gap-2"><button className="rounded bg-white/10 px-3 py-1.5" onClick={()=>onOpen(task.thread_id)}>Open conversation</button>
        <button className="rounded bg-white/10 px-3 py-1.5" onClick={()=>{setEditing(task._id);setNote("");setError(null);}}>Handled by me</button></div>
      {editing===task._id&&<form className="mt-3 space-y-2" onSubmit={async e=>{e.preventDefault();setBusy(true);setError(null);try{await handle({id:task._id,note});setEditing(null);}catch(err){setError(err instanceof Error?err.message:"Could not save handling note");}finally{setBusy(false);}}}>
        <label className="block">What did you confirm or how did you handle the question?<textarea aria-label="Handling note" required minLength={4} maxLength={2000} value={note} onChange={e=>setNote(e.target.value)} className="mt-1 block w-full rounded bg-black/30 p-2"/></label>
        <p className="text-[#a3aab8]">This records your handling note. It does not send a message, change the rental or verify inventory specifications.</p>
        {error&&<p role="alert" className="text-red-300">{error}</p>}
        <button disabled={busy||note.trim().length<4} className="rounded bg-amber-300/15 px-3 py-1.5 disabled:opacity-40">{busy?"Saving…":"Save handling note"}</button>
        <button type="button" className="ml-2" onClick={()=>setEditing(null)}>Cancel</button>
      </form>}
    </div>)}</div>
    {status==="CanLoadMore"&&<button className="mt-3 text-xs text-amber-200" onClick={()=>loadMore(10)}>Load more checks</button>}
  </section>;
}
