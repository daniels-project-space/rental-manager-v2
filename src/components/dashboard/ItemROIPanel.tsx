"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

type Row = {
  itemId: string;
  name: string;
  kind?: string;
  qty: number;
  lifetimeNet: number;
  lifetimeGross: number;
  cost: number | null;
  monthsOwned: number;
  roiPct: number | null;
  annualizedROIPct: number | null;
  rentalCount: number;
};

function fmtGbp(n: number): string {
  if (n >= 1000) return "£" + (n / 1000).toFixed(1) + "k";
  return "£" + Math.round(n);
}

function tone(roi: number | null): { color: string; bg: string } {
  if (roi === null) return { color: "#8b8fa3", bg: "rgba(139,143,163,0.10)" };
  if (roi >= 100) return { color: "#22c55e", bg: "rgba(34,197,94,0.14)" };
  if (roi >= 25) return { color: "#84cc16", bg: "rgba(132,204,22,0.14)" };
  if (roi >= 0) return { color: "#eab308", bg: "rgba(234,179,8,0.14)" };
  return { color: "#ef4444", bg: "rgba(239,68,68,0.14)" };
}

export function ItemROIPanel() {
  const [showAll, setShowAll] = useState(false);
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const raw = useQuery(api.intel.getItemROIRanking, {
    limit: 100,
    include_unknown_cost: includeUnknown,
  });
  const data: Row[] | undefined = raw as Row[] | undefined;
  const visible = data ? (showAll ? data : data.slice(0, 12)) : [];

  return (
    <Card>
      <CardHeader
        title="Item ROI"
        actions={
          <div className="flex gap-1 items-center">
            <button
              onClick={() => setIncludeUnknown((x) => !x)}
              className="px-2 py-0.5 text-xs rounded transition-colors"
              style={{
                background: includeUnknown ? "rgba(110,168,254,0.15)" : "transparent",
                color: includeUnknown ? "#6ea8fe" : "#8b8fa3",
                border: includeUnknown ? "1px solid rgba(110,168,254,0.3)" : "1px solid rgba(255,255,255,0.08)",
              }}
              title="Include items with no acquisition_cost recorded"
            >
              + unknown
            </button>
          </div>
        }
      />

      {data === undefined ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => <SkeletonBlock key={i} className="h-12 w-full" />)}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState message="No items with acquisition cost recorded yet" />
      ) : (
        <>
          <div className="space-y-1.5">
            {visible.map((r) => {
              const t = tone(r.roiPct);
              const payback =
                r.cost && r.lifetimeNet > 0 && r.monthsOwned > 0
                  ? r.cost / (r.lifetimeNet / r.monthsOwned)
                  : null;
              return (
                <div
                  key={r.itemId}
                  className="grid grid-cols-12 gap-2 items-center px-2.5 py-1.5 rounded-lg"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <div className="col-span-5 min-w-0">
                    <div className="text-sm text-slate-100 truncate">{r.name}</div>
                    <div className="text-[10px] text-slate-500">
                      {r.kind ? `${r.kind} · ` : ""}{r.rentalCount} rentals · {Math.round(r.monthsOwned)}mo
                    </div>
                  </div>
                  <div className="col-span-2 text-right text-xs text-slate-300 tabular-nums">
                    {r.cost ? fmtGbp(r.cost) : <span className="text-slate-600">—</span>}
                    <div className="text-[10px] text-slate-500">cost</div>
                  </div>
                  <div className="col-span-2 text-right text-xs text-emerald-300 tabular-nums">
                    {fmtGbp(r.lifetimeNet)}
                    <div className="text-[10px] text-slate-500">net</div>
                  </div>
                  <div className="col-span-3 text-right">
                    <span
                      className="inline-block px-2 py-0.5 rounded-full text-xs font-bold tabular-nums"
                      style={{ background: t.bg, color: t.color, border: `1px solid ${t.color}33` }}
                    >
                      {r.roiPct === null ? "—" : (r.roiPct >= 0 ? "+" : "") + Math.round(r.roiPct) + "%"}
                    </span>
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      {payback ? `${payback.toFixed(1)}mo payback` : "no payback data"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {data.length > 12 && (
            <button
              onClick={() => setShowAll((x) => !x)}
              className="mt-2 w-full text-xs text-slate-400 hover:text-slate-200 py-1"
            >
              {showAll ? "Show top 12" : `Show all ${data.length}`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}
