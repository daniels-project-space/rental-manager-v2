"use client";
import {useRef,useState} from "react";
import {useAction} from "convex/react";
import {makeFunctionReference} from "convex/server";
import styles from "./DbCinemaDepositEditor.module.css";
const resumeRef=makeFunctionReference<"action">("dbcinema_chat:resumeDepositRefund"),retryRef=makeFunctionReference<"action">("dbcinema_chat:retryDepositRefund");
export type DepositSettlement={state:string;amount:number;snapshot:string;receipts:Array<{refundId:string|null;amount:number;status:string;approvalUrl:string|null}>};
export function DbCinemaRefundStatus({bookingId,settlement,onUpdated}:{bookingId:string;settlement:DepositSettlement;onUpdated:()=>Promise<void>}){
 const resume=useAction(resumeRef),retry=useAction(retryRef);const [review,setReview]=useState<{refundId:string;amount:number;requestId:string;snapshot:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");const lock=useRef(false);
 const money=(n:number)=>new Intl.NumberFormat("en-GB",{style:"currency",currency:"GBP"}).format(n);
 const labels:Record<string,string>={not_started:"Deposit refund not finished",processing:"Deposit refund needs review",awaiting_approval:"Refund awaiting Stripe approval",pending:"Refund processing",succeeded:settlement.amount?"Deposit refund confirmed":"Deposit decision complete",failed:"Deposit refund failed"};
 async function run(fn:()=>Promise<unknown>){if(lock.current)return;lock.current=true;setBusy(true);setError("");try{await fn();setReview(null);await onUpdated()}catch(e:any){setError(e?.data?.message??"Refund needs provider review. Refresh its status before retrying.");await onUpdated().catch(()=>{})}finally{lock.current=false;setBusy(false)}}
 return <section className={styles.refundStatus} aria-label="Deposit refund status" data-state={settlement.state}><header><strong>{labels[settlement.state]??"Refund needs review"}</strong><b>{money(settlement.amount)}</b></header>{settlement.receipts.map((r,index)=><div key={r.refundId??index} className={styles.refundRow}><span>{money(r.amount)} · {r.status.replaceAll("_"," ")}</span>{r.status==="awaiting_approval"&&r.approvalUrl&&<a href={r.approvalUrl} target="_blank" rel="noopener noreferrer">Open Stripe approval ↗</a>}{r.status==="failed"&&r.refundId&&<button type="button" disabled={busy} onClick={()=>setReview({refundId:r.refundId!,amount:r.amount,requestId:crypto.randomUUID(),snapshot:settlement.snapshot})}>Review retry</button>}</div>)}
 {["not_started","processing","awaiting_approval"].includes(settlement.state)&&<button type="button" disabled={busy} onClick={()=>void run(()=>resume({booking_id:bookingId,confirmed:true}))}>Resume saved decision</button>}
 {settlement.state==="pending"&&<p>Issued to the original card; bank settlement is still processing.</p>}
 {review&&<div className={styles.refundReview} role="region" aria-label="Review deposit refund retry"><p>Retry {money(review.amount)} to the original card. The previous refund must be confirmed failed by the provider.</p><div><button type="button" disabled={busy} onClick={()=>void run(()=>retry({booking_id:bookingId,refund_id:review.refundId,request_id:review.requestId,reviewed_snapshot:review.snapshot,confirmed:true}))}>Confirm refund retry</button><button type="button" disabled={busy} onClick={()=>setReview(null)}>Cancel</button></div></div>}{error&&<p role="alert">{error}</p>}
 </section>;
}
