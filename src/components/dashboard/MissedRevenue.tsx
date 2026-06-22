"use client";
import { useMutation } from "convex/react";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";
import { DenialRecordingModal } from "@/components/modals/DenialRecordingModal";
import { EditDenialModal } from "@/components/modals/EditDenialModal";
import type { DenialRow } from "@/components/modals/EditDenialModal";

type Days = 30 | 90;

export function MissedRevenue() {
  const { activeAccountSlug } = useAccount();
  const [days, setDays] = useState<Days>(30);
  const [showDenialModal, setShowDenialModal] = useState(false);
  const [denialsOpen, setDenialsOpen] = useState(false);
  const [editingDenial, setEditingDenial] = useState<DenialRow | null>(null);
  const deleteDenial = useMutation(api.denial_records.remove);

  const recentDenials = useStableQuery(api.denial_records.list, { limit: 10 });

  const data = useStableQuery(api.revenue.getMissedRevenue, {
    accountSlug: activeAccountSlug,
    days,
  });

  async function handleDeleteDenial(id: Id<"denial_records">) {
    if (!window.confirm("Delete this denial? This cannot be undone.")) return;
    await deleteDenial({ id });
  }

  const dayOpts: { label: string; val: Days }[] = [
    { label: "30d", val: 30 },
    { label: "90d", val: 90 },
  ];

  return (
    <>
    <Card>
      <CardHeader
        title="Missed Revenue"
        actions={
          <div className="flex items-center gap-1.5">
            <button onClick={() => setShowDenialModal(true)} style={{ fontSize: 11, padding: "2px 8px", borderRadius: "6px", background: "rgba(239,68,68,0.12)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.25)" }}>+ Denial</button>
            {dayOpts.map((d) => (
              <button
                key={d.val}
                onClick={() => setDays(d.val)}
                className="text-xs px-2 py-1 rounded transition-colors"
                style={{
                  background: days === d.val ? "rgba(239,68,68,0.2)" : "transparent",
                  color: days === d.val ? "#ef4444" : "#8b8fa3",
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
        }
      />

      {data === undefined && (
        <div className="space-y-3">
          <SkeletonBlock className="h-10 w-40 rounded" />
          <SkeletonBlock className="h-px w-full" />
          {[...Array(3)].map((_, i) => (
            <SkeletonBlock key={i} className="h-8 w-full rounded" />
          ))}
        </div>
      )}

      {data !== undefined && (
        <>
          {/* Summary */}
          <div className="mb-4 pb-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <p className="text-xs uppercase tracking-wider mb-1" style={{ color: "#8b8fa3" }}>
              Missed — idle capacity
            </p>
            <p className="text-3xl font-bold" style={{ color: "#ef4444" }}>
              £{data.totalMissed.toFixed(2)}
            </p>
            <p className="text-xs mt-1" style={{ color: "#8b8fa3" }}>
              Theoretical idle-capacity opportunity — last {days} days. Declined requests are counted separately under Denied Revenue.
            </p>
          </div>

          {/* Idle-capacity gap losses */}
          {data.gapLosses.length === 0 ? (
            <EmptyState message="No idle-capacity gaps this period" icon="✓" />
          ) : (
            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              <p className="text-xs font-medium mb-2" style={{ color: "#8b8fa3" }}>
                Top idle items
              </p>
              {data.gapLosses.slice(0, 12).map((g) => (
                <div
                  key={g.itemName}
                  className="flex items-center justify-between px-2.5 py-2 rounded-lg"
                  style={{ background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.1)" }}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate" style={{ color: "#e4e6eb" }}>
                      {g.itemName}
                    </p>
                    <p className="text-xs truncate" style={{ color: "#8b8fa3" }}>
                      {g.idleDays}d idle of {days}d
                    </p>
                  </div>
                  <span
                    className="text-xs font-semibold flex-shrink-0 ml-2"
                    style={{ color: g.estimatedGapLoss > 0 ? "#ef4444" : "#8b8fa3" }}
                  >
                    {g.estimatedGapLoss > 0 ? `−£${g.estimatedGapLoss.toFixed(2)}` : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Recent Denials */}
      <div className="mt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
        <button
          className="flex items-center gap-1.5 text-xs font-medium w-full text-left"
          style={{ color: "#8b8fa3" }}
          onClick={() => setDenialsOpen((o) => !o)}
        >
          <span style={{ transform: denialsOpen ? "rotate(90deg)" : "rotate(0deg)", display: "inline-block", fontSize: 10 }}>&#9658;</span>
          Recent Denials
          {recentDenials !== undefined && (
            <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px]" style={{ background: "rgba(255,255,255,0.08)", color: "#e4e6eb" }}>
              {recentDenials.length}
            </span>
          )}
        </button>
        {denialsOpen && (
          <div className="mt-2 space-y-1">
            {recentDenials === undefined && <SkeletonBlock className="h-8 w-full rounded" />}
            {recentDenials !== undefined && recentDenials.length === 0 && (
              <p className="text-xs text-[#8b8fa3] py-2">No denials recorded.</p>
            )}
            {(recentDenials ?? []).map((d) => (
              <div key={d.id as string} className="flex items-center gap-2 px-2 py-1.5 rounded-lg" style={{ background: "rgba(239,68,68,0.03)", border: "1px solid rgba(239,68,68,0.08)" }}>
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-[#e4e6eb] truncate block">{d.itemName ?? "no item"} · {d.reason}</span>
                  <span className="text-[10px]" style={{ color: "#8b8fa3" }}>{d.estimatedValue != null ? "-£" + d.estimatedValue.toFixed(2) : "no value"} · {new Date(d.createdAt).toLocaleDateString("en-GB")}</span>
                </div>
                <button onClick={() => setEditingDenial({ id: d.id, itemName: d.itemName, reason: d.reason, estimatedValue: d.estimatedValue, notes: d.notes })} className="text-[#8b8fa3] hover:text-[#e4e6eb] px-1 text-sm" title="Edit">&#9998;</button>
                <button onClick={() => handleDeleteDenial(d.id)} className="text-[#8b8fa3] hover:text-[#ef4444] px-1 text-sm" title="Delete">&#x2715;</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
    {showDenialModal && (
      <DenialRecordingModal onClose={() => setShowDenialModal(false)} />
    )}
    {editingDenial && (
      <EditDenialModal denial={editingDenial} onClose={() => setEditingDenial(null)} />
    )}
  </>
  );
}
