"use client";
import { useAction } from "convex/react";
import { useState } from "react";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../../../../convex/_generated/dataModel";

export type WebsiteCaseInfo = {
  id: string; bookingId: string; customerAccountId: string | null;
  status: "open" | "closed"; resolution: string | null; closedAt: number | null;
};
const closeCaseRef = makeFunctionReference<"action", {claimId:Id<"insurance_claims">;resolution:string}, {ok:boolean;syncPending:boolean}>("websiteReturns:closeDamageCase");
export function WebsiteCaseControl({ claimId, info }: { claimId: string; info: WebsiteCaseInfo }) {
  const close = useAction(closeCaseRef);
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ syncPending: boolean } | null>(null);
  const [error, setError] = useState("");
  async function resolve() {
    if (busy || resolution.trim().length < 10) return;
    setBusy(true); setError("");
    try { setResult(await close({ claimId: claimId as Id<"insurance_claims">, resolution: resolution.trim() })); }
    catch (e: any) { setError(e?.message ?? "Case resolution failed. Retry after checking the source rental."); }
    finally { setBusy(false); }
  }
  const resolved = info.status === "closed" || !!result;
  return <section className="mt-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs">
    <div className="font-medium text-emerald-200">Website return case · {resolved ? "Resolved" : "Open"}</div>
    <p className="mt-1 text-slate-400">The customer’s verification archive stays retained while this source case is open. Resolve it only after any insurance work is finished. Claim estimates and recovered payouts are recorded separately in the pipeline.</p>
    <a className="mt-2 inline-block text-emerald-300 underline" href={`https://dbcinemarentals.com/admin?rental=${encodeURIComponent(info.bookingId)}#messages`} target="_blank" rel="noopener noreferrer">Open rental, customer and documents ↗</a>
    {resolved ? <p className="mt-2 text-slate-300">{info.resolution ?? resolution}{result?.syncPending ? " · Website resolved; manager refresh pending." : " · The normal retention window resumes when no other rental or case requires the documents."}</p> : <>
      <label className="mt-3 block text-slate-300">Case resolution
        <textarea className="mt-1 w-full rounded border border-white/15 bg-slate-950 p-2 text-slate-100" rows={3} maxLength={2000} disabled={busy} value={resolution} onChange={e => setResolution(e.target.value)} placeholder="Record the outcome, evidence and any remaining claim" />
      </label>
      <button type="button" className="mt-2 rounded border border-emerald-500/30 px-3 py-2 text-emerald-200 disabled:opacity-40" disabled={busy || resolution.trim().length < 10} onClick={resolve}>{busy ? "Resolving…" : "Resolve website case"}</button>
    </>}
    {error && <p role="alert" className="mt-2 text-rose-300">{error}</p>}
  </section>;
}
