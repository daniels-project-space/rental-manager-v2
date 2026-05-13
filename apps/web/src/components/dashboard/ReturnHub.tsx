"use client";
import { useMutation, useQuery } from "convex/react";
import type { Id } from "@convex/_generated/dataModel";
import { api } from "@convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

type DueReturn = {
  reservationId: Id<"reservations">;
  renterName: string;
  itemNames: string[];
  endDate?: string;
  isOverdue: boolean;
  accountSlug?: string;
};

function ReturnModal({
  item,
  onClose,
  onConfirm,
}: {
  item: DueReturn;
  onClose: () => void;
  onConfirm: (condition: string, notes: string) => Promise<void>;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [condition, setCondition] = useState<"good" | "minor" | "major">("good");
  const [notes, setNotes] = useState("");

  function handleConfirm() {
    if (step === 1) setStep(2);
    else if (step === 2) {
      setStep(3);
      onConfirm(condition, notes).finally(() => setTimeout(onClose, 2000));
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
            <div
              key={s}
              className="flex-1 h-1 rounded-full"
              style={{ background: step >= s ? "#22c55e" : "rgba(255,255,255,0.1)" }}
            />
          ))}
        </div>

        {step === 1 && (
          <>
            <h3 className="text-base font-semibold text-[#e4e6eb] mb-3">Confirm Return</h3>
            <p className="text-sm text-[#8b8fa3] mb-1">Renter: <span className="text-[#e4e6eb]">{item.renterName}</span></p>
            <p className="text-sm text-[#8b8fa3] mb-4">Items: <span className="text-[#e4e6eb]">{item.itemNames.join(", ")}</span></p>
            <div className="flex gap-2 justify-end">
              <button onClick={onClose} className="text-sm px-3 py-1.5 rounded text-[#8b8fa3] hover:text-[#e4e6eb] transition-colors">Cancel</button>
              <button onClick={handleConfirm} className="text-sm px-4 py-1.5 rounded transition-colors" style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" }}>Confirm</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h3 className="text-base font-semibold text-[#e4e6eb] mb-3">Condition Check</h3>
            <div className="space-y-2 mb-4">
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
              placeholder="Optional notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full text-sm rounded-lg p-2 mb-4 resize-none h-16"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e6eb" }}
            />
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
            <p className="text-xs text-[#8b8fa3]">Closing automatically…</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function ReturnHub() {
  const { activeAccountSlug } = useAccount();
  const rows = useQuery(api.reservations.getDueReturns, {
    accountSlug: activeAccountSlug,
  });
  const [active, setActive] = useState<DueReturn | null>(null);
  const markReturned = useMutation(api.reservations.markReturned);

  async function handleReturn(condition: string, notes: string) {
    if (!active) return;
    await markReturned({
      reservationId: active.reservationId,
      condition,
      notes: notes || undefined,
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
              <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444" }}>
                {rows.length}
              </span>
            ) : undefined
          }
        />
        {rows === undefined ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <SkeletonBlock key={i} className="h-12 w-full" />)}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState message="No returns due today" icon="checkmark" />
        ) : (
          <>
            <div className="space-y-1 mb-3">
              {rows.map((r) => {
                const dotColor = r.accountSlug === "dbcinema" ? "#6ea8fe" : "#22c55e";
                return (
                  <div
                    key={String(r.reservationId)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg"
                    style={{
                      borderLeft: r.isOverdue ? "2px solid #ef4444" : "2px solid rgba(255,255,255,0.1)",
                      background: r.isOverdue ? "rgba(239,68,68,0.05)" : "transparent",
                    }}
                  >
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dotColor }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-[#e4e6eb] truncate">{r.renterName}</div>
                      <div className="text-xs text-[#8b8fa3] truncate">{r.itemNames.join(", ")}</div>
                    </div>
                    <span className="text-xs flex-shrink-0" style={{ color: r.isOverdue ? "#ef4444" : "#f59e0b" }}>
                      {r.isOverdue ? "OVERDUE" : r.endDate}
                    </span>
                    <button
                      onClick={() => setActive(r as DueReturn)}
                      className="text-xs px-2 py-1 rounded flex-shrink-0 transition-colors"
                      style={{ border: "1px solid rgba(34,197,94,0.4)", color: "#22c55e" }}
                    >
                      Return
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-[#8b8fa3]">
              {todayCount} due today · {overdueCount} overdue
            </p>
          </>
        )}
      </Card>
      {active && <ReturnModal item={active} onClose={() => setActive(null)} onConfirm={handleReturn} />}
    </>
  );
}
