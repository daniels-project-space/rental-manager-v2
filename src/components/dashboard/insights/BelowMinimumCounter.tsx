"use client";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

function fmtGbp(n: number): string {
  if (n >= 1000) return "£" + (n / 1000).toFixed(1) + "k";
  return "£" + Math.round(n).toString();
}

export function BelowMinimumCounter({ accountSlug }: { accountSlug: string | null }) {
  const data = useQuery(api.dashboard_insights.getBelowMinimumCounter, {
    accountSlug,
    days: 90,
  });

  return (
    <div
      className="stat-card"
      style={{
        background: "rgba(14,17,28,0.35)",
        backdropFilter: "blur(24px) saturate(1.5)",
        borderRadius: 16,
        padding: 14,
        borderLeft: "3px solid #8b8fa3",
        minHeight: 150,
      }}
    >
      <div className="mb-2">
        <div className="text-[11px] uppercase tracking-wide text-slate-400">Below Min £</div>
        <div className="text-[10px] text-slate-500">Declined for being &lt; £39 gross (~£25 net)</div>
      </div>
      {data === undefined ? (
        <SkeletonBlock className="h-24 w-full" />
      ) : (
        <div className="flex flex-col gap-1.5 pt-2">
          <div className="flex items-baseline gap-2">
            <span className="text-[28px] font-semibold text-slate-200 tabular-nums leading-none">
              {data.count}
            </span>
            <span className="text-[10px] text-slate-500">rentals declined</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-medium text-slate-300 tabular-nums leading-none">
              {fmtGbp(data.gbp)}
            </span>
            <span className="text-[10px] text-slate-500">in lost gross</span>
          </div>
          {data.count > 5 && (
            <div className="text-[10px] text-amber-400 mt-1">
              Raise minimum?
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default BelowMinimumCounter;
