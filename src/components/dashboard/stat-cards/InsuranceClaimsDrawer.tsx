"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ClaimsRecordingModal } from "@/components/modals/ClaimsRecordingModal";
import { EditClaimModal } from "@/components/modals/EditClaimModal";
import type { ClaimRow } from "@/components/modals/EditClaimModal";

type Stage =
  | "case_opened"
  | "in_for_repair"
  | "quote_received"
  | "payout_confirmation"
  | "added_to_revenue"
  | "denied";

interface Claim {
  id: string;
  accountSlug: string | null;
  itemNameCanonical: string | null;
  amountGbp: number;
  claimDate: string;
  description: string | null;
  status: string;
  stage: Stage | null;
  payoutAmountGbp: number | null;
  creditedToMonth: string | null;
  creditedAt: number | null;
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

// ── Pipeline ordering (must match convex/insurance_claims.ts STAGES) ──
const PIPELINE: Stage[] = [
  "case_opened",
  "in_for_repair",
  "quote_received",
  "payout_confirmation",
  "added_to_revenue",
];

const STAGE_LABEL: Record<Stage, string> = {
  case_opened: "Case opened",
  in_for_repair: "In for repair",
  quote_received: "Quote received",
  payout_confirmation: "Payout confirmation",
  added_to_revenue: "Credited to month",
  denied: "Denied",
};

const STAGE_SHORT: Record<Stage, string> = {
  case_opened: "Opened",
  in_for_repair: "Repair",
  quote_received: "Quote",
  payout_confirmation: "Payout",
  added_to_revenue: "Credited",
  denied: "Denied",
};

const ACCOUNT_PILL: Record<string, { bg: string; text: string }> = {
  dbcinema: { bg: "bg-blue-900/60 border border-blue-500/30", text: "text-blue-200" },
  leo:      { bg: "bg-amber-900/40 border border-amber-500/30", text: "text-amber-200" },
  diogo:    { bg: "bg-pink-900/60 border border-pink-500/30", text: "text-pink-200" },
};

const fmtDate = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric", year: "numeric" }).format(new Date(d));

const fmtGbp = (n: number) =>
  "£" + Math.round(n).toLocaleString("en-GB");

const fmtGbpDecimal = (n: number) =>
  "£" + n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtMonth(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-");
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(new Date(parseInt(y), parseInt(m) - 1, 1));
}

function currentMonthIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

type Filter = "active" | "all" | "credited";

export default function InsuranceClaimsDrawer({ data }: Props) {
  const [filter, setFilter] = useState<Filter>("active");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<ClaimRow | null>(null);
  const [creditingId, setCreditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Per-claim action error — surfaces silent mutation failures in the card
  // (mirrors the red banner added to OpenCaseModal in a542c57). Without this,
  // a thrown/rejected advance/revert/deny/credit just vanished and the button
  // appeared to "do nothing".
  const [errorId, setErrorId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const errMsg = (e: unknown) =>
    e instanceof Error ? e.message : typeof e === "string" ? e : "Action failed — please try again.";

  const advance = useMutation(api.insurance_claims.advanceStage);
  const revert = useMutation(api.insurance_claims.revertStage);
  const markDenied = useMutation(api.insurance_claims.markDenied);
  const creditToRevenue = useMutation(api.insurance_claims.creditToRevenue);
  const removeClaim = useMutation(api.insurance_claims.remove);

  const visible = data.claims.filter((c) => {
    if (filter === "credited") return c.stage === "added_to_revenue";
    if (filter === "all") return true;
    return c.stage !== "added_to_revenue" && c.stage !== "denied"; // active
  });

  function clearError(id: string) {
    if (errorId === id) { setErrorId(null); setErrorMsg(null); }
  }
  function showError(id: string, e: unknown) {
    setErrorId(id);
    setErrorMsg(errMsg(e));
  }

  async function onAdvance(id: string) {
    clearError(id);
    setBusyId(id);
    try { await advance({ id: id as Id<"insurance_claims"> }); }
    catch (e) { showError(id, e); }
    finally { setBusyId(null); }
  }
  async function onRevert(id: string) {
    clearError(id);
    setBusyId(id);
    try { await revert({ id: id as Id<"insurance_claims"> }); }
    catch (e) { showError(id, e); }
    finally { setBusyId(null); }
  }
  async function onDeny(id: string) {
    if (!window.confirm("Mark this claim as denied (terminal)?")) return;
    clearError(id);
    setBusyId(id);
    try { await markDenied({ id: id as Id<"insurance_claims"> }); }
    catch (e) { showError(id, e); }
    finally { setBusyId(null); }
  }
  async function onDelete(id: string) {
    if (!window.confirm("Delete this claim? This cannot be undone.")) return;
    clearError(id);
    try { await removeClaim({ id: id as Id<"insurance_claims"> }); }
    catch (e) { showError(id, e); }
  }

  return (
    <>
      <div className="space-y-3 max-h-[540px] overflow-y-auto pr-1">
        {/* Summary strip */}
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <div className="rounded-lg px-2.5 py-2" style={{ background: "rgba(245,158,11,0.14)", border: "1px solid rgba(245,158,11,0.25)" }}>
            <div className="uppercase tracking-wider text-[9px] text-amber-300">Active</div>
            <div className="text-base font-semibold mt-0.5 text-amber-300">{data.open_count}</div>
            <div className="text-[10px] text-slate-400">{fmtGbp(data.open_amount_gbp)} at risk</div>
          </div>
          <div className="rounded-lg px-2.5 py-2" style={{ background: "rgba(34,197,94,0.14)", border: "1px solid rgba(34,197,94,0.25)" }}>
            <div className="uppercase tracking-wider text-[9px] text-emerald-300">Credited YTD</div>
            <div className="text-base font-semibold mt-0.5 text-emerald-300">{data.settled_count_ytd}</div>
            <div className="text-[10px] text-slate-400">{fmtGbp(data.settled_amount_ytd_gbp)} recovered</div>
          </div>
          <div className="rounded-lg px-2.5 py-2" style={{ background: "rgba(239,68,68,0.14)", border: "1px solid rgba(239,68,68,0.25)" }}>
            <div className="uppercase tracking-wider text-[9px] text-rose-300">Denied YTD</div>
            <div className="text-base font-semibold mt-0.5 text-rose-300">{data.denied_count_ytd}</div>
            <div className="text-[10px] text-slate-400">closed unfavorably</div>
          </div>
        </div>

        {/* Filter + add */}
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex rounded-full overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.1)" }}>
            <FilterTab label={`Active (${data.open_count})`} active={filter === "active"} onClick={() => setFilter("active")} color="#fbbf24" />
            <FilterTab label={`Credited (${data.settled_count_ytd})`} active={filter === "credited"} onClick={() => setFilter("credited")} color="#4ade80" />
            <FilterTab label={`All (${data.total_count})`} active={filter === "all"} onClick={() => setFilter("all")} color="#e4e6eb" />
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="text-[11px] px-2.5 py-1 rounded-full"
            style={{ background: "rgba(110,168,254,0.15)", color: "#6ea8fe", border: "1px solid rgba(110,168,254,0.35)" }}
          >
            + Add Claim
          </button>
        </div>

        {/* List */}
        {visible.length === 0 ? (
          <div className="text-[11px] text-slate-500 italic py-6 text-center">
            {filter === "active" ? "No active claims — all clear." : filter === "credited" ? "No claims credited yet this year." : "No claims recorded."}
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map((c) => (
              <ClaimCard
                key={c.id}
                claim={c}
                isBusy={busyId === c.id}
                isCrediting={creditingId === c.id}
                error={errorId === c.id ? errorMsg : null}
                onAdvance={() => onAdvance(c.id)}
                onRevert={() => onRevert(c.id)}
                onDeny={() => onDeny(c.id)}
                onDelete={() => onDelete(c.id)}
                onEdit={() => setEditing({
                  id: c.id as Id<"insurance_claims">,
                  accountSlug: c.accountSlug ?? undefined,
                  itemNameCanonical: c.itemNameCanonical ?? undefined,
                  amountGbp: c.amountGbp,
                  claimDate: c.claimDate,
                  description: c.description ?? undefined,
                  status: c.status,
                })}
                onCreditStart={() => setCreditingId(c.id)}
                onCreditCancel={() => setCreditingId(null)}
                onCreditConfirm={async (month, payout) => {
                  clearError(c.id);
                  setBusyId(c.id);
                  try {
                    await creditToRevenue({
                      id: c.id as Id<"insurance_claims">,
                      credited_to_month: month,
                      payout_amount_gbp: payout,
                    });
                    setCreditingId(null);
                  } catch (e) { showError(c.id, e); }
                  finally { setBusyId(null); }
                }}
              />
            ))}
          </div>
        )}
      </div>

      {showAdd && <ClaimsRecordingModal onClose={() => setShowAdd(false)} />}
      {editing && <EditClaimModal claim={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

// ── helpers ────────────────────────────────────────────────────────

function FilterTab({ label, active, onClick, color }: { label: string; active: boolean; onClick: () => void; color: string }) {
  return (
    <button
      onClick={onClick}
      className="px-2.5 py-1 text-[11px]"
      style={{ background: active ? `${color}29` : "transparent", color: active ? color : "#8b8fa3" }}
    >
      {label}
    </button>
  );
}

function ClaimCard({
  claim,
  isBusy,
  isCrediting,
  error,
  onAdvance,
  onRevert,
  onDeny,
  onDelete,
  onEdit,
  onCreditStart,
  onCreditCancel,
  onCreditConfirm,
}: {
  claim: Claim;
  isBusy: boolean;
  isCrediting: boolean;
  error: string | null;
  onAdvance: () => void;
  onRevert: () => void;
  onDeny: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onCreditStart: () => void;
  onCreditCancel: () => void;
  onCreditConfirm: (month: string, payout: number) => Promise<void> | void;
}) {
  const stage = (claim.stage ?? "case_opened") as Stage;
  const terminal = stage === "added_to_revenue" || stage === "denied";
  const accPill = claim.accountSlug ? (ACCOUNT_PILL[claim.accountSlug] ?? { bg: "bg-slate-800 border border-slate-700", text: "text-slate-300" }) : null;

  return (
    <div
      className="px-3 py-2.5 rounded-lg"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
    >
      {/* Header row */}
      <div className="flex items-start gap-2 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold text-slate-100 truncate">
              {claim.itemNameCanonical ?? "Unknown item"}
            </span>
            <span className="text-[11px] text-slate-400">{fmtDate(claim.claimDate)}</span>
            {accPill && (
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${accPill.bg} ${accPill.text}`}>
                {claim.accountSlug}
              </span>
            )}
          </div>
          {claim.description && (
            <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-2">{claim.description}</div>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-sm font-semibold text-slate-100">{fmtGbpDecimal(claim.amountGbp)}</div>
          <div className="text-[10px] text-slate-500">claimed</div>
          {claim.payoutAmountGbp != null && (
            <>
              <div className="text-xs font-semibold text-emerald-300 mt-1">{fmtGbpDecimal(claim.payoutAmountGbp)}</div>
              <div className="text-[10px] text-slate-500">payout</div>
            </>
          )}
        </div>
      </div>

      {/* Pipeline */}
      <PipelineBar stage={stage} />

      {/* Action error — mirrors the OpenCaseModal red banner (a542c57) */}
      {error && (
        <div
          className="text-[11px] mt-2 px-2 py-1.5 rounded"
          style={{ background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)" }}
        >
          ⚠ {error}
        </div>
      )}

      {/* Credited info */}
      {claim.creditedToMonth && (
        <div className="mt-2 text-[11px] text-emerald-300">
          Credited {fmtGbp(claim.payoutAmountGbp ?? 0)} to {fmtMonth(claim.creditedToMonth)}
          {claim.creditedAt && (
            <span className="text-slate-500"> · {new Date(claim.creditedAt).toLocaleDateString("en-GB")}</span>
          )}
        </div>
      )}

      {/* Action row */}
      {!terminal && !isCrediting && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {stage === "payout_confirmation" ? (
            <button
              onClick={onCreditStart}
              disabled={isBusy}
              className="text-[11px] px-2.5 py-1 rounded-md font-medium disabled:opacity-40"
              style={{ background: "rgba(34,197,94,0.18)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.4)" }}
            >
              Credit to month →
            </button>
          ) : (
            <button
              onClick={onAdvance}
              disabled={isBusy}
              className="text-[11px] px-2.5 py-1 rounded-md font-medium disabled:opacity-40"
              style={{ background: "rgba(110,168,254,0.18)", color: "#6ea8fe", border: "1px solid rgba(110,168,254,0.4)" }}
            >
              Advance →
            </button>
          )}
          {stage !== "case_opened" && (
            <button
              onClick={onRevert}
              disabled={isBusy}
              className="text-[11px] px-2 py-1 rounded-md text-slate-400 hover:text-slate-200 disabled:opacity-40"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
            >
              ← Back
            </button>
          )}
          <button
            onClick={onDeny}
            disabled={isBusy}
            className="text-[11px] px-2 py-1 rounded-md text-rose-300 hover:text-rose-200 disabled:opacity-40"
            style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)" }}
          >
            Deny
          </button>
          <div className="flex-1" />
          <button onClick={onEdit} className="text-[#8b8fa3] hover:text-[#e4e6eb] text-xs px-1" title="Edit fields">✎</button>
          <button onClick={onDelete} className="text-[#8b8fa3] hover:text-[#ef4444] text-xs px-1" title="Delete">✕</button>
        </div>
      )}

      {/* Credit form */}
      {isCrediting && (
        <CreditForm
          claim={claim}
          onCancel={onCreditCancel}
          onConfirm={onCreditConfirm}
          isBusy={isBusy}
        />
      )}

      {/* Terminal — slim footer */}
      {terminal && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px]">
          <button
            onClick={onRevert}
            disabled={isBusy}
            className="text-slate-400 hover:text-slate-200 underline-offset-2 hover:underline disabled:opacity-40"
          >
            Reopen
          </button>
          <div className="flex-1" />
          <button onClick={onEdit} className="text-[#8b8fa3] hover:text-[#e4e6eb] text-xs px-1" title="Edit fields">✎</button>
          <button onClick={onDelete} className="text-[#8b8fa3] hover:text-[#ef4444] text-xs px-1" title="Delete">✕</button>
        </div>
      )}
    </div>
  );
}

function PipelineBar({ stage }: { stage: Stage }) {
  if (stage === "denied") {
    return (
      <div className="flex items-center gap-1.5 text-[10px]" style={{ color: "#fca5a5" }}>
        <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 9999, background: "#ef4444" }} />
        Denied — case closed
      </div>
    );
  }
  const idx = PIPELINE.indexOf(stage);
  return (
    <div className="flex items-center gap-1">
      {PIPELINE.map((s, i) => {
        const done = i < idx;
        const current = i === idx;
        const upcoming = i > idx;
        const bar = done
          ? { bg: "#22c55e", op: 1 }
          : current
            ? { bg: "#6ea8fe", op: 1 }
            : { bg: "#475569", op: 0.4 };
        return (
          <div key={s} className="flex-1 flex flex-col items-stretch gap-0.5">
            <div
              style={{
                height: 4,
                borderRadius: 2,
                background: bar.bg,
                opacity: bar.op,
                transition: "background 0.2s, opacity 0.2s",
              }}
            />
            <div
              className="text-[9px] uppercase tracking-wide text-center"
              style={{
                color: done ? "#22c55e" : current ? "#6ea8fe" : upcoming ? "#64748b" : "#64748b",
                fontWeight: current ? 600 : 400,
              }}
            >
              {STAGE_SHORT[s]}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CreditForm({
  claim,
  onCancel,
  onConfirm,
  isBusy,
}: {
  claim: Claim;
  onCancel: () => void;
  onConfirm: (month: string, payout: number) => Promise<void> | void;
  isBusy: boolean;
}) {
  const [month, setMonth] = useState<string>(currentMonthIso());
  const [payout, setPayout] = useState<string>(String(claim.payoutAmountGbp ?? claim.amountGbp));

  const valid = /^\d{4}-\d{2}$/.test(month) && parseFloat(payout) > 0;

  async function submit() {
    if (!valid) return;
    await onConfirm(month, parseFloat(payout));
  }

  return (
    <div
      className="mt-2 px-2.5 py-2 rounded-md space-y-2"
      style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.25)" }}
    >
      <div className="text-[11px] text-emerald-300 font-semibold">
        Credit payout to a month — adds to lifetime revenue chart
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[10px] text-slate-400">
          Month
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="mt-0.5 block w-full px-2 py-1 rounded text-xs"
            style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.12)", color: "#e4e6eb" }}
          />
        </label>
        <label className="text-[10px] text-slate-400">
          Payout £
          <input
            type="number"
            min="0"
            step="0.01"
            value={payout}
            onChange={(e) => setPayout(e.target.value)}
            className="mt-0.5 block w-full px-2 py-1 rounded text-xs"
            style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.12)", color: "#e4e6eb" }}
          />
        </label>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={submit}
          disabled={!valid || isBusy}
          className="text-[11px] px-2.5 py-1 rounded-md font-medium disabled:opacity-40"
          style={{ background: "#22c55e", color: "#0a0f0a", border: "1px solid #16a34a" }}
        >
          {isBusy ? "Crediting…" : "Confirm credit"}
        </button>
        <button
          onClick={onCancel}
          disabled={isBusy}
          className="text-[11px] px-2 py-1 rounded-md text-slate-400 hover:text-slate-200 disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
