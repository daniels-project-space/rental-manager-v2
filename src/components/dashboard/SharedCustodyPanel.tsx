"use client";
import { useEffect, useState } from "react";
import { useConvex, useConvexAuth, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";

/** Owner booking control: physical custody only; never alters a payment. */
export function SharedCustodyPanel({accountSlug,orderId,dryRun}:{accountSlug:string;orderId:string;dryRun:boolean}) {
  const [cursor,setCursor]=useState<string|undefined>();
  const [reference,setReference]=useState("");
  const [search,setSearch]=useState<string|undefined>();
  const [selected,setSelected]=useState<string|null>(null);
  const [note,setNote]=useState("");
  const [acknowledged,setAcknowledged]=useState(false);
  const [busy,setBusy]=useState(false);
  const [feedback,setFeedback]=useState<string|null>(null);
  const client=useConvex(),{isAuthenticated}=useConvexAuth();
  const [state,setState]=useState<FunctionReturnType<typeof api.reservation_custody.get>>();
  const [loadError,setLoadError]=useState<string|null>(null);
  useEffect(()=>{
    setState(undefined);setLoadError(null);
    if(!isAuthenticated)return;
    const watch=client.watchQuery(api.reservation_custody.get,{account_slug:accountSlug,order_id:orderId,...(cursor?{cursor}:{}),...(search?{original_order_id:search}:{})});
    const update=()=>{try{setState(watch.localQueryResult());setLoadError(null);}catch{setLoadError("Owner access is required, or the booking could not be loaded.");}};
    const stop=watch.onUpdate(update);update();return stop;
  },[client,isAuthenticated,accountSlug,orderId,cursor,search]);
  const confirm=useMutation(api.reservation_custody.confirm),undo=useMutation(api.reservation_custody.undo);
  const candidate=state?.candidates.find(r=>r.order_id===selected);
  const ready=!dryRun&&!busy&&note.trim().length>=10&&note.trim().length<=1000;
  async function save(remove:boolean) {
    if(!state||!ready||(!remove&&(!candidate||!acknowledged)))return;
    setBusy(true);setFeedback(null);
    try {
      if(remove)await undo({account_slug:accountSlug,order_id:orderId,basis:state.basis,note});
      else await confirm({account_slug:accountSlug,order_id:orderId,original_order_id:candidate!.order_id,basis:candidate!.basis,note,retained_equipment:true});
      setFeedback(remove?"Custody link removed. Separate orders now reserve their own units.":"Continuous custody recorded. Availability now shares this kit across the linked orders.");
      setSelected(null);setAcknowledged(false);setNote("");
    }catch(error){setFeedback(error instanceof Error?error.message:"Could not save the custody decision.");}
    finally{setBusy(false);}
  }
  return <section className="mx-3 mb-3 overflow-hidden rounded-2xl border border-[#b98768]/25 bg-[#181817] text-[#eeece8]">
    <header className="border-b border-white/[0.07] px-4 py-3">
      <div className="flex items-center justify-between gap-3"><h4 className="font-serif text-[17px]">Continuous kit custody</h4><span className={`rounded-full px-2 py-1 text-[10px] ${state?.linked?"bg-emerald-500/10 text-emerald-300":"bg-white/[0.05] text-[#b7b3ab]"}`}>{state?.linked?"Owner confirmed":state?.group_id?"Reconfirmation needed":"Separate orders"}</span></div>
      <p className="mt-1 text-[11px] leading-relaxed text-[#a29f98]">Use for an extension when the customer kept the same kit. Each order keeps its own payment and dates.</p>
    </header>
    <div className="space-y-3 px-4 py-3">
      {!isAuthenticated||loadError?<p className="text-xs leading-relaxed text-[#a29f98]">{loadError??"Sign in to the owner account to manage continuous custody."} <a href="/login" className="text-[#d3ad95] underline">Owner sign-in</a></p>:!state?<p className="text-xs text-[#a29f98]">Loading booking relationships…</p>:<>
        <div className="flex flex-wrap gap-1.5">{state.equipment.map(item=><span key={item.item_id} className="rounded-lg border border-white/[0.07] px-2 py-1 text-[11px]">{item.qty} × {item.name}</span>)}</div>
        {state.note&&<p className="border-l-2 border-[#b98768] pl-2 text-[11px] leading-relaxed text-[#bbb7af]">Last decision: {state.note}</p>}
        {state.can_link&&<>
          <form className="flex gap-2" onSubmit={event=>{event.preventDefault();setSearch(reference.trim()||undefined);setCursor(undefined);setSelected(null);setFeedback(null);}}>
            <input disabled={busy} value={reference} onChange={e=>setReference(e.target.value)} aria-label="Find original booking by reference" placeholder="Original booking reference" className="min-w-0 flex-1 rounded-lg border border-white/[0.1] bg-[#111110] px-2.5 py-2 text-xs outline-none focus:border-[#b98768]"/>
            <button type="submit" disabled={busy} className="rounded-lg border border-[#b98768]/30 px-3 text-xs text-[#d3ad95]">Find</button>
          </form>
          <div className="space-y-2" role="group" aria-label="Choose the original booking">
            {state.candidates.map(row=><button type="button" key={row.order_id} disabled={busy} onClick={()=>{setSelected(row.order_id);setAcknowledged(false);setFeedback(null);}} aria-pressed={selected===row.order_id} className={`w-full rounded-xl border p-3 text-left transition-colors ${selected===row.order_id?"border-[#b98768] bg-[#b98768]/10":"border-white/[0.08] bg-[#111110] hover:border-[#b98768]/40"}`}>
              <div className="flex justify-between gap-2 text-xs"><span className="font-medium">Booking {row.order_id}</span><span className="text-[#d3ad95]">{selected===row.order_id?"Selected":"Select"}</span></div>
              <div className="mt-1 text-[11px] text-[#a29f98]">{row.start_date} → {row.end_date}</div>
              <div className="mt-1 text-[11px] text-[#c9c4bb]">{row.equipment.map(i=>`${i.qty} × ${i.name}`).join(" · ")}</div>
            </button>)}
            {!state.candidates.length&&<p className="text-[11px] leading-relaxed text-[#a29f98]">No matching original booking on this page. Search its reference or check older bookings.</p>}
          </div>
          {state.has_more&&<button type="button" disabled={busy} onClick={()=>{setCursor(state.next_cursor);setSelected(null);}} className="text-xs text-[#d3ad95] hover:underline">Show older bookings</button>}
          {candidate&&<label className="flex gap-2 text-[11px] leading-relaxed text-[#c9c4bb]"><input disabled={busy} type="checkbox" checked={acknowledged} onChange={e=>setAcknowledged(e.target.checked)} className="mt-0.5 accent-[#b98768]"/>I confirm the customer retained this equipment continuously; this is not another kit issued separately.</label>}
        </>}
        {(state.can_link||state.group_id)&&<>
          <textarea disabled={busy} value={note} onChange={e=>setNote(e.target.value)} maxLength={1000} aria-label="Custody decision and evidence" placeholder="Record the agreement or the reason for removing this link…" rows={2} className="w-full resize-none rounded-xl border border-white/[0.1] bg-[#111110] p-2.5 text-xs outline-none focus:border-[#b98768]"/>
          <div className="flex flex-wrap gap-2">
            {state.can_link&&<button type="button" disabled={!ready||!candidate||!acknowledged} onClick={()=>void save(false)} className="rounded-lg bg-[#a97454] px-3 py-2 text-xs font-medium text-white disabled:opacity-35">{busy?"Saving…":"Confirm extension custody"}</button>}
            {state.group_id&&<button type="button" disabled={!ready} onClick={()=>void save(true)} className="rounded-lg border border-white/[0.1] px-3 py-2 text-xs text-[#c9c4bb] disabled:opacity-35">Undo custody link</button>}
          </div>
          {state.group_id===state.reservation_id&&<p className="text-[10px] leading-relaxed text-[#a29f98]">Removing the original booking’s link separates the whole custody chain.</p>}
          {dryRun&&<p className="text-[11px] text-amber-200">Test mode: custody decisions cannot be saved.</p>}
        </>}
      </>}
      {feedback&&<p role="status" className="text-[11px] leading-relaxed text-[#d3ad95]">{feedback}</p>}
    </div>
  </section>;
}
