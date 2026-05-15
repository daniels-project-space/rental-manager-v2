"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

type Row = {
  displayName: string;
  matchedItemId?: string;
  matchedItemName?: string;
  alreadyOwned: boolean;
  requestCount: number;
  lostGbp: number;
  estimatedAcquisitionGbp: number | null;
  monthlyOpportunityGbp: number | null;
  paybackMonths: number | null;
  recommendation: "buy_more" | "consider_buying" | "monitor" | "have_capacity";
  reason: string;
};

const REC_LABEL: Record<Row["recommendation"], string> = {
  buy_more: "Buy more",
  consider_buying: "Consider",
  monitor: "Monitor",
  have_capacity: "OK as-is",
};

const REC_TONE: Record<Row["recommendation"], { fg: string; bg: string }> = {
  buy_more:        { fg: "#ef4444", bg: "rgba(239,68,68,0.16)" },
  consider_buying: { fg: "#f59e0b", bg: "rgba(245,158,11,0.16)" },
  monitor:         { fg: "#6ea8fe", bg: "rgba(110,168,254,0.16)" },
  have_capacity:   { fg: "#22c55e", bg: "rgba(34,197,94,0.14)" },
};

function fmtGbp(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1000) return "£" + (n / 1000).toFixed(1) + "k";
  return "£" + Math.round(n);
}

export function LostRevenueBuyPanel() {
  const [days, setDays] = useState<number>(180);
  const [showAll, setShowAll] = useState(false);
  const raw = useQuery(api.intel.getSmartBuyRanking, { days, limit: 50 });
  const data: Row[] | undefined =
    raw === undefined
      ? undefined
      : ((raw as { rows?: Row[] }).rows ?? []);
  const visible = data ? (showAll ? data : data.slice(0, 10)) : [];

  const dayOpts = [
    { label: "90d", val: 90 },
    { label: "180d", val: 180 },
    { label: "365d", val: 365 },
  ];

  const totalLost = data ? data.reduce((s, r) => s + (r.lostGbp ?? 0), 0) : 0;

  return (
    <Card>
      <CardHeader
        title="Lost Revenue · Buy Recommendations"
        actions={
          <div className="flex gap-1 items-center">
            {dayOpts.map((d) => (
              <button
                key={d.val}
                onClick={() => setDays(d.val)}
                className="px-2 py-0.5 text-xs rounded transition-colors"
                style={{
                  background: days === d.val ? "rgba(110,168,254,0.15)" : "transparent",
                  color: days === d.val ? "#6ea8fe" : "#8b8fa3",
                  border: days === d.val ? "1px solid rgba(110,168,254,0.3)" : "1px solid transparent",
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
        }
      />

      {data === undefined ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => <SkeletonBlock key={i} className="h-12 w-full" />)}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState message="No denials in this window — nothing to buy" />
      ) : (
        <>
          <div className="text-[11px] text-slate-400 mb-2">
            <span className="text-rose-300 font-semibold">{fmtGbp(totalLost)}</span> in lost demand last {days} days · {data.length} items
          </div>
          <div className="space-y-1.5">
            {visible.map((r, i) => {
              const tone = REC_TONE[r.recommendation];
              return (
                <div
                  key={(r.matchedItemId ?? r.displayName) + i}
                  className="grid grid-cols-12 gap-2 items-center px-2.5 py-2 rounded-lg"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <div className="col-span-5 min-w-0">
                    <div className="text-sm text-slate-100 truncate">
                      {r.matchedItemName ?? r.displayName}
                    </div>
                    <div className="text-[10px] text-slate-500 truncate">
                      {r.alreadyOwned ? "in inventory" : "not owned"} · {r.requestCount} request{r.requestCount === 1 ? "" : "s"} declined
                    </div>
                  </div>
                  <div className="col-span-2 text-right text-xs text-rose-300 tabular-nums">
                    {fmtGbp(r.lostGbp)}
                    <div className="text-[10px] text-slate-500">lost</div>
                  </div>
                  <div className="col-span-2 text-right text-xs text-slate-300 tabular-nums">
                    {fmtGbp(r.estimatedAcquisitionGbp)}
                    <div className="text-[10px] text-slate-500">to buy</div>
                  </div>
                  <div className="col-span-3 text-right">
                    <span
                      className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider"
                      style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.fg}33` }}
                    >
                      {REC_LABEL[r.recommendation]}
                    </span>
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      {r.paybackMonths != null ? `${r.paybackMonths.toFixed(1)}mo payback` : "no payback data"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {data.length > 10 && (
            <button
              onClick={() => setShowAll((x) => !x)}
              className="mt-2 w-full text-xs text-slate-400 hover:text-slate-200 py-1"
            >
              {showAll ? "Show top 10" : `Show all ${data.length}`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}
