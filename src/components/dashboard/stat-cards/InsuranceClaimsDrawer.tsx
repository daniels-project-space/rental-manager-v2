"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ClaimsRecordingModal } from "@/components/modals/ClaimsRecordingModal";
import { EditClaimModal } from "@/components/modals/EditClaimModal";
import type { ClaimRow } from "@/components/modals/EditClaimModal";

type Status = "open" | "settled" | "denied" | string;

interface Claim {
  id: string;
  accountSlug: string | null;
  itemNameCanonical: string | null;
  amountGbp: number;
  claimDate: string;
  description: string | null;
  status: Status;
  createdAt: number;
}

interface Props {
  data: {
    open_count: number;
    open_amount_gbp: number;
    settled_count_ytd: number;
    settled_amount_ytd_gbp: number;
    denied_count_ytd: number;
    total_count: number;
    claims: Claim[];
  };
}

const STATUS_STYLE: Record<string, { bg: string; text: string; dot: string }> = {
  open:    { bg: "rgba(245,158,11,0.14)", text: "#fbbf24", dot: "#f59e0b" },
  settled: { bg: "rgba(34,197,94,0.14)",  text: "#4ade80", dot: "#22c55e" },
  denied:  { bg: "rgba(239,68,68,0.14)",  text: "#fca5a5", dot: "#ef4444" },
};

const ACCOUNT_PILL: Record<string, { bg: string; text: string }> = {
  dbcinema: { bg: "bg-blue-900/60 border border-blue-500/30", text: "text-blue-200" },
  leo:      { bg: "bg-amber-900/40 border border-amber-500/30", text: "text-amber-200" },
};

const fmtDate = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric", year: "numeric" }).format(new Date(d));

const fmtGbp = (n: number) =>
  "£" + Math.round(n).toLocaleString("en-GB");

type Filter = "open" | "all";

export default function InsuranceClaimsDrawer({ data }: Props) {
  const [filter, setFilter] = useState<Filter>("open");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<ClaimRow | null>(null);
  const removeClaim = useMutation(api.insurance_claims.remove);

  const visible = data.claims.filter((c) => (filter === "open" ? c.status === "open" : true));

  async function onDelete(id: string) {
    if (!window.confirm("Delete this claim? This cannot be undone.")) return;
    await removeClaim({ id: id as Id<"insurance_claims"> });
  }

  return (
    <>
      <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1">
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <div className="rounded-lg px-2.5 py-2" style={{ background: STATUS_STYLE.open.bg, border: "1px solid rgba(245,158,11,0.25)" }}>
            <div className="uppercase tracking-wider text-[9px]" style={{ color: STATUS_STYLE.open.text }}>Open</div>
            <div className="text-base font-semibold mt-0.5" style={{ color: STATUS_STYLE.open.text }}>{data.open_count}</div>
            <div className="text-[10px] text-slate-400">{fmtGbp(data.open_amount_gbp)} at risk</div>
          </div>
          <div className="rounded-lg px-2.5 py-2" style={{ background: STATUS_STYLE.settled.bg, border: "1px solid rgba(34,197,94,0.25)" }}>
            <div className="uppercase tracking-wider text-[9px]" style={{ color: STATUS_STYLE.settled.text }}>Settled YTD</div>
            <div className="text-base font-semibold mt-0.5" style={{ color: STATUS_STYLE.settled.text }}>{data.settled_count_ytd}</div>
            <div className="text-[10px] text-slate-400">{fmtGbp(data.settled_amount_ytd_gbp)} recovered</div>
          </div>
          <div className="rounded-lg px-2.5 py-2" style={{ background: STATUS_STYLE.denied.bg, border: "1px solid rgba(239,68,68,0.25)" }}>
            <div className="uppercase tracking-wider text-[9px]" style={{ color: STATUS_STYLE.denied.text }}>Denied YTD</div>
            <div className="text-base font-semibold mt-0.5" style={{ color: STATUS_STYLE.denied.text }}>{data.denied_count_ytd}</div>
            <div className="text-[10px] text-slate-400">closed unfavorably</div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex rounded-full overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.1)" }}>
            <button
              onClick={() => setFilter("open")}
              className="px-2.5 py-1 text-[11px]"
              style={{ background: filter === "open" ? "rgba(245,158,11,0.18)" : "transparent", color: filter === "open" ? "#fbbf24" : "#8b8fa3" }}
            >
              Open ({data.open_count})
            </button>
            <button
              onClick={() => setFilter("all")}
              className="px-2.5 py-1 text-[11px]"
              style={{ background: filter === "all" ? "rgba(255,255,255,0.08)" : "transparent", color: filter === "all" ? "#e4e6eb" : "#8b8fa3" }}
            >
              All ({data.total_count})
            </button>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="text-[11px] px-2.5 py-1 rounded-full"
            style={{ background: "rgba(110,168,254,0.15)", color: "#6ea8fe", border: "1px solid rgba(110,168,254,0.35)" }}
          >
            + Add Claim
          </button>
        </div>

        {visible.length === 0 ? (
          <div className="text-[11px] text-slate-500 italic py-6 text-center">
            {filter === "open" ? "No open claims - you are clear." : "No claims recorded."}
          </div>
        ) : (
          <div className="space-y-1.5">
            {visible.map((c) => {
              const s = STATUS_STYLE[c.status] ?? STATUS_STYLE.open;
              const accPill = c.accountSlug ? (ACCOUNT_PILL[c.accountSlug] ?? { bg: "bg-slate-800 border border-slate-700", text: "text-slate-300" }) : null;
              return (
                <div
                  key={c.id}
                  className="flex items-start gap-2 px-2.5 py-2 rounded-lg"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-semibold text-slate-100 truncate">
                        {c.itemNameCanonical ?? "Unknown item"}
                      </span>
                      <span className="text-[11px] text-slate-400">{fmtDate(c.claimDate)}</span>
                      {accPill && (
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${accPill.bg} ${accPill.text}`}>
                          {c.accountSlug}
                        </span>
                      )}
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium"
                        style={{ background: s.bg, color: s.text }}
                      >
                        <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 9999, background: s.dot }} />
                        {c.status}
                      </span>
                    </div>
                    {c.description && (
                      <div className="text-[11px] text-slate-400 mt-0.5 truncate">{c.description}</div>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-sm font-semibold text-slate-100">{fmtGbp(c.amountGbp)}</div>
                    <div className="flex justify-end gap-1 mt-0.5">
                      <button
                        onClick={() => setEditing({
                          id: c.id as Id<"insurance_claims">,
                          accountSlug: c.accountSlug ?? undefined,
                          itemNameCanonical: c.itemNameCanonical ?? undefined,
                          amountGbp: c.amountGbp,
                          claimDate: c.claimDate,
                          description: c.description ?? undefined,
                          status: c.status,
                        })}
                        className="text-[#8b8fa3] hover:text-[#e4e6eb] text-xs px-1"
                        title="Edit"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => onDelete(c.id)}
                        className="text-[#8b8fa3] hover:text-[#ef4444] text-xs px-1"
                        title="Delete"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showAdd && <ClaimsRecordingModal onClose={() => setShowAdd(false)} />}
      {editing && <EditClaimModal claim={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
