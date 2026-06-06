"use client";
import { useMutation, useQuery } from "convex/react";
import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

type RenterTrust = {
  blacklisted: boolean;
  whitelisted: boolean;
  blacklist_reason: string | null;
  total_rentals: number | null;
  rating: number | null;
  note_count: number;
  notes: string | null;
};

type DueReturn = {
  reservationId: Id<"reservations">;
  renterName: string;
  itemNames: string[];
  endDate?: string;
  isOverdue: boolean;
  accountSlug?: string;
  orderStep?: string | null;
  imageUrl?: string | null;
  renter?: RenterTrust;
  returnTime?: string | null;
  memberIds?: Id<"reservations">[];
  memberCount?: number;
};

function Thumb({ url, name, size = 36 }: { url?: string | null; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={url}
        alt=""
        onError={() => setBroken(true)}
        className="flex-shrink-0 rounded-lg object-cover"
        style={{ width: size, height: size, background: "rgba(255,255,255,0.05)" }}
        loading="lazy"
      />
    );
  }
  return (
    <div
      className="flex-shrink-0 flex items-center justify-center rounded-lg text-xs font-bold"
      style={{ width: size, height: size, background: "rgba(255,255,255,0.06)", color: "#8b8fa3" }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function TrustBadge({ t }: { t?: RenterTrust }) {
  if (!t) return null;
  if (t.blacklisted)
    return (
      <span
        className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0"
        style={{ background: "rgba(239,68,68,0.18)", color: "#f87171", border: "1px solid rgba(239,68,68,0.4)" }}
        title={t.blacklist_reason ?? "blacklisted"}
      >
        ⛔ blacklisted
      </span>
    );
  if (t.whitelisted)
    return (
      <span
        className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0"
        style={{ background: "rgba(34,197,94,0.16)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.35)" }}
        title={t.notes ?? "trusted"}
      >
        ✓ trusted
      </span>
    );
  return null;
}

function ReturnModal({
  item,
  onClose,
  onConfirm,
}: {
  item: DueReturn;
  onClose: () => void;
  onConfirm: (condition: string, notes: string, blacklist: boolean, reason: string) => Promise<void>;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [condition, setCondition] = useState<"good" | "minor" | "major">("good");
  const [notes, setNotes] = useState("");
  const [blacklist, setBlacklist] = useState(false);
  const [reason, setReason] = useState("");

  function handleConfirm() {
    if (step === 1) setStep(2);
    else if (step === 2) {
      setStep(3);
      onConfirm(condition, notes, blacklist, reason).finally(() => setTimeout(onClose, 1600));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="glass-card p-6 w-full max-w-sm">
        <div className="flex gap-2 mb-5">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex-1 h-1 rounded-full" style={{ background: step >= s ? "#22c55e" : "rgba(255,255,255,0.1)" }} />
          ))}
        </div>

        {step === 1 && (
          <>
            <h3 className="text-base font-semibold text-[#e4e6eb] mb-3">Confirm Return</h3>
            <div className="flex items-center gap-3 mb-3">
              <Thumb url={item.imageUrl} name={item.renterName} size={44} />
              <div className="min-w-0">
                <div className="text-sm text-[#e4e6eb] flex items-center gap-2">
                  {item.renterName} <TrustBadge t={item.renter} />
                </div>
                <div className="text-xs text-[#8b8fa3] truncate">{item.itemNames.join(", ")}</div>
              </div>
            </div>
            {item.renter?.blacklisted && (
              <div className="text-xs mb-3 px-2 py-1.5 rounded" style={{ background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)" }}>
                ⛔ This renter is blacklisted{item.renter.blacklist_reason ? `: ${item.renter.blacklist_reason}` : ""}.
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={onClose} className="text-sm px-3 py-1.5 rounded text-[#8b8fa3] hover:text-[#e4e6eb] transition-colors">Cancel</button>
              <button onClick={handleConfirm} className="text-sm px-4 py-1.5 rounded transition-colors" style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" }}>Confirm</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h3 className="text-base font-semibold text-[#e4e6eb] mb-3">Condition Check</h3>
            <div className="space-y-2 mb-3">
              {(["good", "minor", "major"] as const).map((c) => (
                <label key={c} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="condition" value={c} checked={condition === c} onChange={() => setCondition(c)} className="accent-[#22c55e]" />
                  <span className="text-sm capitalize text-[#e4e6eb]">
                    {c === "good" ? "Good condition" : c === "minor" ? "Minor damage" : "Major damage"}
                  </span>
                </label>
              ))}
            </div>
            <textarea
              placeholder="Optional notes (saved to renter history)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full text-sm rounded-lg p-2 mb-3 resize-none h-14"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e6eb" }}
            />
            {condition !== "good" && !item.renter?.blacklisted && (
              <label className="flex items-start gap-2 mb-3 cursor-pointer">
                <input type="checkbox" checked={blacklist} onChange={(e) => setBlacklist(e.target.checked)} className="accent-[#ef4444] mt-0.5" />
                <span className="text-xs text-[#f87171]">
                  Blacklist {item.renterName}
                  {blacklist && (
                    <input
                      type="text"
                      placeholder="reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      onClick={(e) => e.preventDefault()}
                      className="block mt-1 w-full text-xs rounded p-1"
                      style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(239,68,68,0.3)", color: "#e4e6eb" }}
                    />
                  )}
                </span>
              </label>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={() => setStep(1)} className="text-sm px-3 py-1.5 rounded text-[#8b8fa3] hover:text-[#e4e6eb] transition-colors">Back</button>
              <button onClick={handleConfirm} className="text-sm px-4 py-1.5 rounded transition-colors" style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" }}>Mark Returned</button>
            </div>
          </>
        )}

        {step === 3 && (
          <div className="flex flex-col items-center py-4 gap-3">
            <div className="text-5xl animate-bounce" style={{ color: "#22c55e" }}>✓</div>
            <p className="text-base font-semibold" style={{ color: "#22c55e" }}>Returned!</p>
            {blacklist && <p className="text-xs" style={{ color: "#f87171" }}>Renter blacklisted</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function OpenCaseModal({
  item,
  onClose,
  onConfirm,
}: {
  item: DueReturn;
  onClose: () => void;
  onConfirm: (projected: number, description: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [desc, setDesc] = useState("");
  const [done, setDone] = useState(false);
  const projected = Math.max(0, Math.round(Number(value) || 0));
  function submit() {
    if (projected <= 0 || done) return;
    setDone(true);
    onConfirm(projected, desc).finally(() => setTimeout(onClose, 1400));
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="glass-card p-6 w-full max-w-sm">
        {done ? (
          <div className="flex flex-col items-center py-4 gap-2">
            <div className="text-5xl" style={{ color: "#f59e0b" }}>📂</div>
            <p className="text-base font-semibold" style={{ color: "#f59e0b" }}>Case opened</p>
            <p className="text-xs" style={{ color: "#f87171" }}>{item.renterName} flagged · moved to Cases</p>
          </div>
        ) : (
          <>
            <h3 className="text-base font-semibold text-[#e4e6eb] mb-3">Open case</h3>
            <div className="flex items-center gap-2 mb-3">
              <Thumb url={item.imageUrl} name={item.renterName} size={44} />
              <div className="min-w-0">
                <div className="text-sm text-[#e4e6eb] truncate">{item.renterName}</div>
                <div className="text-xs text-[#8b8fa3] truncate">{item.itemNames.join(", ")}</div>
              </div>
            </div>
            <div className="text-xs mb-3 px-2 py-1.5 rounded" style={{ background: "rgba(245,158,11,0.1)", color: "#fbbf24", border: "1px solid rgba(245,158,11,0.3)" }}>
              Flags (blacklists) {item.renterName} and moves this rental to the Cases pipeline at stage 1. It leaves the Return Hub.
            </div>
            <label className="block text-xs text-[#8b8fa3] mb-1">Projected case value (£)</label>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              className="w-full text-sm rounded-lg p-2 mb-3"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "#e4e6eb" }}
              placeholder="e.g. 450"
            />
            <textarea
              placeholder="What happened? (damage / loss details)"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              className="w-full text-sm rounded-lg p-2 mb-4 resize-none h-16"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e6eb" }}
            />
            <div className="flex gap-2 justify-end">
              <button onClick={onClose} className="text-sm px-3 py-1.5 rounded text-[#8b8fa3] hover:text-[#e4e6eb] transition-colors">Cancel</button>
              <button
                onClick={submit}
                disabled={projected <= 0}
                className="text-sm px-4 py-1.5 rounded transition-colors disabled:opacity-40"
                style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.4)" }}
              >
                Open case
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ReturnHub() {
  const { activeAccountSlug } = useAccount();
  const rows = useQuery(api.reservations.getDueReturns, { accountSlug: activeAccountSlug }) as DueReturn[] | undefined;
  const [active, setActive] = useState<DueReturn | null>(null);
  const [caseFor, setCaseFor] = useState<DueReturn | null>(null);
  const markReturned = useMutation(api.reservations.markReturned);
  const openCase = useMutation(api.insurance_claims.openCaseFromReservation);

  async function handleReturn(condition: string, notes: string, blacklist: boolean, reason: string) {
    if (!active) return;
    await markReturned({
      reservationId: active.reservationId,
      condition,
      notes: notes || undefined,
      blacklistRenter: blacklist || undefined,
      blacklistReason: blacklist ? reason || undefined : undefined,
      memberIds: active.memberIds && active.memberIds.length > 1 ? active.memberIds : undefined,
    });
  }

  async function handleOpenCase(projected: number, description: string) {
    if (!caseFor) return;
    await openCase({
      reservationId: caseFor.reservationId,
      memberIds: caseFor.memberIds && caseFor.memberIds.length > 1 ? caseFor.memberIds : undefined,
      projected_value_gbp: projected,
      description: description || undefined,
    });
  }

  const overdueCount = rows?.filter((r) => r.isOverdue).length ?? 0;
  const todayCount = rows?.filter((r) => !r.isOverdue).length ?? 0;

  return (
    <>
      <Card>
        <CardHeader
          title="Return Hub"
          badge={
            rows !== undefined && rows.length > 0 ? (
              <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444" }}>{rows.length}</span>
            ) : undefined
          }
        />
        {rows === undefined ? (
          <div className="space-y-2">{[1, 2, 3].map((i) => <SkeletonBlock key={i} className="h-14 w-full" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState message="No returns due — all gear is back" icon="checkmark" />
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-2 mb-3">
              {rows.map((r) => {
                const accColor = r.accountSlug === "dbcinema" ? "#6ea8fe" : "#22c55e";
                const accent = r.renter?.blacklisted ? "#ef4444" : r.isOverdue ? "#f59e0b" : accColor;
                return (
                  <div
                    key={String(r.reservationId)}
                    className="flex flex-col gap-1.5 p-2.5 rounded-lg"
                    style={{
                      border: "1px solid rgba(255,255,255,0.07)",
                      borderLeft: `3px solid ${accent}`,
                      background: r.renter?.blacklisted
                        ? "rgba(239,68,68,0.07)"
                        : r.isOverdue
                          ? "rgba(245,158,11,0.06)"
                          : "rgba(255,255,255,0.02)",
                    }}
                  >
                    <div className="flex gap-2">
                      <Thumb url={r.imageUrl} name={r.renterName} size={52} />
                      <div className="flex-1 min-w-0 flex flex-col">
                        <div className="text-[12px] text-[#e4e6eb] truncate flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: accColor }} />
                          <span className="truncate font-medium">{r.renterName}</span>
                        </div>
                        <div className="text-[10.5px] text-[#8b8fa3] line-clamp-2 leading-tight mt-0.5">{r.itemNames.join(", ")}</div>
                        <div className="flex items-center gap-1 flex-wrap mt-auto pt-1">
                          <TrustBadge t={r.renter} />
                          {(r.memberCount ?? 1) > 1 && (
                            <span className="text-[9px] font-semibold px-1 py-0.5 rounded" style={{ background: "rgba(110,168,254,0.15)", color: "#6ea8fe" }} title={`${r.memberCount} back-to-back bookings merged (extended)`}>⛓ ×{r.memberCount}</span>
                          )}
                          {!!r.renter?.note_count && (
                            <span className="text-[9px] text-[#8b8fa3]" title={r.renter?.notes ?? ""}>📝{r.renter.note_count}</span>
                          )}
                          <span className="text-[10px] ml-auto leading-tight whitespace-nowrap" style={{ color: r.isOverdue ? "#f59e0b" : "#8b8fa3" }}>
                            {r.isOverdue ? "OVERDUE " : ""}{r.endDate}{r.returnTime ? ` ${r.returnTime}` : ""}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => setActive(r)}
                        className="flex-1 text-[11px] px-2 py-1 rounded transition-colors hover:bg-white/[0.04]"
                        style={{ border: "1px solid rgba(34,197,94,0.4)", color: "#22c55e" }}
                      >
                        Return
                      </button>
                      <button
                        onClick={() => setCaseFor(r)}
                        className="flex-1 text-[11px] px-2 py-1 rounded transition-colors hover:bg-white/[0.04]"
                        style={{ border: "1px solid rgba(245,158,11,0.4)", color: "#f59e0b" }}
                        title="Open a damage/loss case — flags the renter and moves this to the Cases pipeline (stage 1)"
                      >
                        Open case
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-[#8b8fa3]">{todayCount} due · {overdueCount} overdue · shows only after return time · auto-closes when Hygglo confirms</p>
          </>
        )}
      </Card>
      {active && <ReturnModal item={active} onClose={() => setActive(null)} onConfirm={handleReturn} />}
      {caseFor && <OpenCaseModal item={caseFor} onClose={() => setCaseFor(null)} onConfirm={handleOpenCase} />}
    </>
  );
}
