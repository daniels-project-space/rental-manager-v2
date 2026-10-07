"use client";
import { useAction } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useEffect, useRef, useState } from "react";
import type { Id } from "../../../convex/_generated/dataModel";
type Inspection={key:string;condition:"good"|"issue";details:string;openCase:boolean};
const previewRef=makeFunctionReference<"action",{reservationId:Id<"reservations">;actualReturnedAt?:number},any>("websiteReturns:preview");
const reviewRef=makeFunctionReference<"action",{reservationId:Id<"reservations">;actualReturnedAt:number;damageKept:number;damageNote?:string;chargeLate:boolean;lateWaiverReason?:string;inspection?:Inspection[]},any>("websiteReturns:review");
const settleRef=makeFunctionReference<"action",{reservationId:Id<"reservations">;actualReturnedAt:number;damageKept:number;damageNote?:string;chargeLate:boolean;lateWaiverReason?:string;inspection?:Inspection[]},any>("websiteReturns:settle");
const localDate=(at:number)=>new Date(at-new Date(at).getTimezoneOffset()*60000).toISOString().slice(0,16);
const money=(n:number)=>new Intl.NumberFormat("en-GB",{style:"currency",currency:"GBP"}).format(n);
const emailLabel=(status:string|null)=>({pending:"Queued for delivery",sending:"Sending",sent:"Sent",failed:"Delivery failed — automatic retry pending"}[status??""]??"Delivery status not yet available");
const holdLabel=(status:string|null)=>({requires_capture:"Held, not charged",held:"Held, not charged",authorized:"Held, not charged",released:"Released",captured:"Captured",pending:"Awaiting authorisation",failed:"Authorisation failed"}[status??""]??(status?.replaceAll("_"," ")||"Status unavailable"));
export function WebsiteReturnModal({reservationId,onClose}:{reservationId:Id<"reservations">;onClose:()=>void}) {
 const preview=useAction(previewRef),settle=useAction(settleRef),review=useAction(reviewRef),dialog=useRef<HTMLDialogElement>(null);
 const [data,setData]=useState<any>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[result,setResult]=useState<any>(null);
 const [items,setItems]=useState<Record<string,Inspection>>({}),[damage,setDamage]=useState("0"),[note,setNote]=useState(""),[chargeLate,setChargeLate]=useState(true),[waiver,setWaiver]=useState("");
 const [at,setAt]=useState(Date.now()),[date,setDate]=useState(()=>localDate(Date.now())),[loading,setLoading]=useState(false);
 const [reviewed,setReviewed]=useState<{key:string;data:any}|null>(null),[reviewBusy,setReviewBusy]=useState(false),[pdfUrl,setPdfUrl]=useState("");
 const generation=useRef(0),initialised=useRef(false);
 useEffect(()=>{dialog.current?.showModal();return()=>{generation.current++}},[]);
 useEffect(()=>{
  const sequence=++generation.current;let active=true;
  const timer=setTimeout(async()=>{setLoading(true);try{
   const context=await preview({reservationId,...(initialised.current?{actualReturnedAt:at}:{})});if(!active||sequence!==generation.current)return;
   setData(context);setError("");
   if(!initialised.current){initialised.current=true;const saved=context.returnDecision;
    if(saved){setAt(saved.actualReturnedAt);setDate(localDate(saved.actualReturnedAt));setDamage(String(saved.damageKept));setNote(saved.damageNote??"");setChargeLate(saved.chargeLate);setWaiver(saved.lateWaiverReason??"");setItems(Object.fromEntries((saved.inspection??[]).map((i:Inspection)=>[i.key,{key:i.key,condition:i.condition,details:i.details,openCase:i.openCase}])))}
   }
  }catch(e){if(active)setError(e instanceof Error?e.message:"Could not load the inspection")}finally{if(active)setLoading(false)}},initialised.current?300:0);
  return()=>{active=false;clearTimeout(timer)};
 },[reservationId,at,preview]);
 const frozen=!!data?.returnDecision,legacyResume=frozen&&!data.returnDecision.inspection;
 const amount=Number(damage),late=chargeLate?(data?.lateQuote?.amount??0):0;
 const security=(data?.depositAmount??0)+(data?.depositHoldAmount??0);
 const complete=legacyResume||!!data?.items.length&&data.items.every((i:any)=>{const v=items[i.key];return v&&(v.condition==="good"||v.details.trim().length>=10)});
 const valid=!!data&&["confirmed","active","returned"].includes(data.status)&&complete&&Number.isFinite(at)&&at<=Date.now()+60000&&Number.isFinite(amount)&&amount>=0&&amount<=security&&(!amount||note.trim().length>=10)&&(!amount||Object.values(items).some(i=>i.condition==="issue")||legacyResume)&&(chargeLate||!data?.lateQuote?.amount||waiver.trim().length>=5);
 useEffect(()=>{
  if(!result)return;
  let active=true;
  preview({reservationId}).then(context=>{if(active)setData(context)}).catch(()=>{});
  return()=>{active=false};
 },[result,reservationId,preview]);
 const selection={reservationId,actualReturnedAt:at,damageKept:amount,damageNote:note||undefined,chargeLate,lateWaiverReason:waiver||undefined,...(!legacyResume&&data?{inspection:data.items.map((i:any)=>{const v=items[i.key];return v?{key:v.key,condition:v.condition,details:v.details,openCase:v.openCase}:null})}:{})};
 const decisionKey=JSON.stringify(selection),reviewData=reviewed?.key===decisionKey?reviewed.data:null;
 useEffect(()=>{
  if(!reviewData?.pdf?.base64){setPdfUrl("");return;}
  const bytes=Uint8Array.from(atob(reviewData.pdf.base64),c=>c.charCodeAt(0));
  const url=URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}));setPdfUrl(url);
  return()=>URL.revokeObjectURL(url);
 },[reviewData]);
 async function inspectReview(){if(!valid||reviewBusy||busy)return;setReviewBusy(true);setError("");try{const current=await review(selection as any);setReviewed({key:decisionKey,data:current});}catch(e){setError(e instanceof Error?e.message:"Could not prepare the return statement. No settlement has been executed.");}finally{setReviewBusy(false)}}
 const update=(key:string,change:Partial<Inspection>)=>setItems(current=>({...current,[key]:{...(current[key]??{key,condition:"good" as const,details:"",openCase:false}),...change}}));
 async function finish(){if(!valid||busy||!data?.executionEnabled||!reviewData||reviewData.alreadySettled)return;setBusy(true);setError("");try{setResult(await settle(selection as any));}catch(e){setError(e instanceof Error?e.message:"Settlement failed. Reload before retrying.");try{const current=await preview({reservationId});setData(current);if(current.returnDecision){const saved=current.returnDecision;setAt(saved.actualReturnedAt);setDate(localDate(saved.actualReturnedAt));setDamage(String(saved.damageKept));setNote(saved.damageNote??"");setChargeLate(saved.chargeLate);setWaiver(saved.lateWaiverReason??"");setItems(Object.fromEntries((saved.inspection??[]).map((i:Inspection)=>[i.key,i])));}}catch{}}finally{setBusy(false)}}
 return <dialog ref={dialog} onCancel={e=>{if(busy)e.preventDefault();else onClose()}} className="m-auto w-[min(920px,calc(100vw-24px))] max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 bg-[#17191f] p-0 text-[#e9e9ef] backdrop:bg-black/70">
  <header className="flex items-start justify-between border-b border-white/10 p-6"><div><h2 className="text-xl font-semibold">Website return inspection &amp; settlement</h2><p className="mt-1 text-sm text-[#9296a6]">Inspect each item and confirm the security refund and card hold release.</p></div><button aria-label="Close inspection" disabled={busy} onClick={onClose} className="p-2">×</button></header>
  <div className="space-y-5 p-6">
   {error&&<p role="alert" className="rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{error}</p>}
   {!data&&<p>{loading?"Loading saved equipment and payment details…":"Inspection is unavailable. Close and reopen to retry."}</p>}
   {result?<div className="space-y-3"><h3 className="text-lg">Return settlement completed</h3><p>Refunded security: {money(result.released)} · Retained: {money(result.kept)} · Late rental assessed, not yet collected: {money(result.lateAmount)}</p><p className="text-sm text-[#9296a6]">Return statement email: {emailLabel(data?.settlementEmailStatus??null)}. {result.syncPending?"Rental Manager is awaiting the automatic status update.":"The rental is completed in Rental Manager."}</p><button onClick={onClose} className="rounded-lg bg-[#c29b76] px-5 py-3 text-black">Done</button></div>:data&&<>
    {!data.executionEnabled&&<p className="rounded-lg border border-amber-400/30 p-3 text-sm text-amber-200">Inspection preview is available. Website settlement is awaiting rollout approval.</p>}
    {data.status==="returned"&&<p className="text-sm text-emerald-300">This rental is already returned. Resume only if the saved security settlement still needs completion.</p>}
    {data.legacy&&<p className="text-xs text-[#9296a6]">This older rental uses booked listing items because it has no physical equipment ledger.</p>}
    {frozen&&<p className="text-sm text-amber-200">A saved settlement is in progress. Its decisions are fixed so a retry cannot charge different amounts.</p>}
    <div className="flex justify-between"><h3>Equipment condition · {data.items.length} items</h3><button disabled={busy||frozen} onClick={()=>setItems(Object.fromEntries(data.items.map((i:any)=>[i.key,{key:i.key,condition:"good",details:"",openCase:false}])))} className="text-sm text-[#c29b76] disabled:opacity-40">Mark all good</button></div>
    <div className="grid gap-3 md:grid-cols-2">{data.items.map((item:any)=>{const value=items[item.key];return <article key={item.key} className="rounded-xl border border-white/10 p-4"><h4 className="font-medium">{item.title}</h4>{item.sku&&<p className="text-xs text-[#9296a6]">{item.sku}</p>}<div className="mt-3 flex gap-2">{(["good","issue"] as const).map(condition=><button key={condition} disabled={busy||frozen} aria-pressed={value?.condition===condition} onClick={()=>update(item.key,{condition,...(condition==="good"?{details:"",openCase:false}:{})})} className={`rounded-lg border px-3 py-2 text-sm ${value?.condition===condition?"border-[#c29b76] bg-[#c29b76]/10":"border-white/15"}`}>{condition==="good"?"Good condition":"Issues found"}</button>)}</div>{value?.condition==="issue"&&<><label className="mt-3 block text-xs text-[#9296a6]">Issue details<textarea disabled={busy||frozen} maxLength={2000} value={value.details} onChange={e=>update(item.key,{details:e.target.value})} className="mt-1 w-full rounded-lg border border-white/15 bg-black/20 p-2 text-white" /></label><label className="mt-2 flex gap-2 text-sm"><input type="checkbox" disabled={busy||frozen} checked={value.openCase} onChange={e=>update(item.key,{openCase:e.target.checked})}/>Open a damage case for this item</label></>}</article>})}</div>
    <div className="grid gap-4 md:grid-cols-2"><section className="space-y-3 rounded-xl border border-white/10 p-4"><h3>Security paid and authorised</h3><p className="text-sm">Refundable deposit: {money(data.depositAmount)}</p><p className="text-sm">Card authorisation: {money(data.depositHoldAmount)} · {holdLabel(data.depositHoldStatus)}</p><label className="block text-sm">Amount to retain (£)<input type="number" min="0" max={security} step="0.01" disabled={busy||frozen} value={damage} onChange={e=>setDamage(e.target.value)} className="mt-1 w-full rounded-lg border border-white/15 bg-black/20 p-2"/></label><label className="block text-sm">Evidence and reason<textarea maxLength={2000} disabled={busy||frozen} value={note} onChange={e=>setNote(e.target.value)} className="mt-1 w-full rounded-lg border border-white/15 bg-black/20 p-2"/></label></section><section className="space-y-3 rounded-xl border border-white/10 p-4"><h3>Return and late rental time</h3><label className="block text-sm">Actual return time<input type="datetime-local" disabled={busy||frozen} value={date} onChange={e=>{setLoading(true);setDate(e.target.value);setAt(new Date(e.target.value).getTime())}} className="mt-1 w-full rounded-lg border border-white/15 bg-black/20 p-2"/></label><p className="text-sm">Calculated late rental: {money(data.lateQuote?.amount??0)} {loading&&"· updating…"}</p><label className="flex gap-2 text-sm"><input type="checkbox" disabled={busy||frozen} checked={chargeLate} onChange={e=>setChargeLate(e.target.checked)}/>Charge calculated late rental</label>{!chargeLate&&!!data.lateQuote?.amount&&<label className="block text-sm">Waiver reason<textarea disabled={busy||frozen} value={waiver} onChange={e=>setWaiver(e.target.value)} className="mt-1 w-full rounded-lg border border-white/15 bg-black/20 p-2"/></label>}<p className="text-xs text-[#9296a6]">Uncaptured authorisation is released separately from the deposit refund. Final amounts depend on the card’s current authorisation and any late rental charges.</p></section></div>
    <section className="space-y-4 rounded-xl border border-white/10 p-4">
     <div className="flex flex-wrap items-center justify-between gap-3"><div><h3>Settlement review</h3><p className="mt-1 text-xs text-[#9296a6]">Review the provider balance, itemised statement and email before confirming.</p></div><button disabled={!valid||busy||loading||reviewBusy} onClick={inspectReview} className="rounded-lg border border-[#c29b76]/60 px-4 py-2 text-sm text-[#c29b76] disabled:opacity-40">{reviewBusy?"Preparing statement…":reviewData?"Refresh review":"Review statement & email"}</button></div>
     {reviewData?<>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
       <div><dt className="text-[#9296a6]">{reviewData.securityAlreadySettled?"Cash deposit refunded":"Expected cash deposit refund"}</dt><dd className="mt-1 text-xl font-semibold">{money(reviewData.financial.depositRefund)}</dd></div>
       <div><dt className="text-[#9296a6]">Authorisation release in this step · not a cash refund</dt><dd className="mt-1 text-xl font-semibold">{money(reviewData.financial.holdRelease)}</dd></div>
       <div><dt className="text-[#9296a6]">Damage from card hold</dt><dd>{money(reviewData.financial.damageFromHold)}</dd></div>
       <div><dt className="text-[#9296a6]">Damage from cash deposit</dt><dd>{money(reviewData.financial.damageFromDeposit)}</dd></div>
       <div><dt className="text-[#9296a6]">Separate late rental assessed · not yet collected</dt><dd>{money(reviewData.financial.lateAssessed)}</dd></div>
       {reviewData.financial.lateWaived>0&&<div><dt className="text-[#9296a6]">Late rental waived</dt><dd>{money(reviewData.financial.lateWaived)}</dd></div>}
      </dl>
      {reviewData.financial.holdRetainedForLate>0&&<p className="text-sm text-amber-200">{money(reviewData.financial.holdRetainedForLate)} of authorisation remains held for the separate late-rental notice and dispute process. It is not charged now.</p>}
      <p className="text-xs text-[#9296a6]">{reviewData.draft?"Draft only. Current card balances are checked again at confirmation; previewing sends no email and moves no money.":"This is the issued return statement. Security has already been settled."}</p>
      {pdfUrl&&<a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="inline-flex rounded-lg border border-white/15 px-4 py-2 text-sm text-[#c29b76]">View {reviewData.draft?"draft ":""}return statement PDF ↗</a>}
      <details className="rounded-lg border border-white/10 p-3"><summary className="cursor-pointer text-sm">Renter email preview · {reviewData.email.to||"email address unavailable"}</summary><p className="mt-3 text-sm">Subject: {reviewData.email.subject}</p><iframe title="Return statement email preview" sandbox="" srcDoc={`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;background:#17191f;color:#e9e9ef;font:14px/1.6 Arial,sans-serif">${reviewData.email.html}</body></html>`} className="mt-3 h-80 w-full rounded-lg border border-white/10"/></details>
     </>:<p className="text-sm text-[#9296a6]">Complete the inspection to prepare the review. Editing any return decision requires a fresh review.</p>}
    </section>
    <button disabled={!valid||busy||loading||reviewBusy||!data.executionEnabled||!reviewData||reviewData.alreadySettled} onClick={finish} className="w-full rounded-lg bg-[#c29b76] px-5 py-3 font-medium text-black disabled:opacity-40">{busy?"Settling return…":`Confirm settlement${amount||late?` · ${money(amount+late)} assessed`:" and release security"}`}</button>
   </>}
  </div>
 </dialog>;
}
