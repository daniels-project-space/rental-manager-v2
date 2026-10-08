"use client";
import { useAction, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { websiteVerificationLabel } from "../../../convex/lib/websiteVerification";

/** Mounted only for the selected private rental; background tabs never poll. */
export default function WebsiteVerificationPanel({ reservationId }: { reservationId: string }) {
  const id = reservationId as Id<"reservations">;
  const data = useQuery(api.websiteVerification.context, { reservationId: id });
  const refresh = useAction(api.websiteVerification.refresh);
  const pending = useRef(false);
  const mounted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (pending.current || document.visibilityState !== "visible") return;
    pending.current = true; setBusy(true);
    try { await refresh({ reservationId: id }); if (mounted.current) setError(null); }
    catch { if (mounted.current) setError("Could not refresh. Check the website before collection."); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }, [id, refresh]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const timer = window.setInterval(() => void reload(), 15000);
    const visible = () => { if (document.visibilityState === "visible") void reload(); };
    document.addEventListener("visibilitychange", visible);
    return () => { mounted.current = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [reload]);
  if (!data) return <p className="mt-3 text-xs text-slate-400">Loading website verification…</p>;
  const v = data.verification;
  const collectible = data.bookingStatus === "confirmed" && !!v?.approved;
  const label = data.bookingStatus === "active" ? "Collected · rental active" : data.bookingStatus === "returned" ? "Returned" : data.bookingStatus === "cancelled" ? "Cancelled" : websiteVerificationLabel(v);
  const checks: Array<[string, string]> = [
    ["Identity", v?.checks.identity ?? "waiting"], ["Selfie", v?.checks.selfie ?? "waiting"], ["Proof of address", v?.checks.address ?? "waiting"],
    ["Account linked", v?.accountId ? "approved" : "waiting"], ["Security ready", v?.securityReady ? "approved" : "waiting"], ["Documents saved", v?.archiveReady ? "approved" : "waiting"],
    ...(v?.requiresDroneLicence ? [["Drone licence", v.droneLicenceStatus] as [string,string]] : []),
  ];
  return <section aria-label="Website verification progress" className="mt-3 rounded-lg border border-slate-700 bg-slate-950/70 p-3 text-xs" onClick={e => e.stopPropagation()}>
    <h4 className={`font-semibold ${collectible ? "text-emerald-300" : "text-amber-200"}`}>{label}</h4>
    <p className="mt-1 text-slate-400">{v ? `Verification: ${v.status.replaceAll("_", " ")}` : "Awaiting a verified website update."}</p>
    <div className="mt-3 space-y-1.5">{checks.map(([name,status]) => <div key={name} className="flex justify-between gap-3"><span className="text-slate-300">{name}</span><span className={status === "approved" ? "text-emerald-300" : "text-amber-200"}>{status.replaceAll("_", " ")}</span></div>)}</div>
    <p className="mt-3 text-[10px] text-slate-500">{data.syncedAt ? `Synced ${new Date(data.syncedAt).toLocaleTimeString("en-GB")}` : "Not yet refreshed"} · updates every 15 seconds while open</p>
    {error && <p role="alert" className="mt-2 text-rose-300">{error}</p>}
    <div className="mt-3 flex flex-wrap gap-3"><button type="button" disabled={busy} onClick={() => void reload()} className="text-slate-200 underline disabled:opacity-50">{busy ? "Refreshing…" : "Refresh"}</button><a href={data.websiteUrl} target="_blank" rel="noreferrer" className="text-amber-200 underline">Open website rental</a></div>
    <p className="mt-2 text-slate-400">Review documents and approve collection in the website admin.</p>
  </section>;
}
