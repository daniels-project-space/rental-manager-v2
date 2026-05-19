"use client";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { EmptyState } from "@/components/ui/EmptyState";

function fmtGbp(n: number): string {
  if (n >= 1000) return "£" + (n / 1000).toFixed(1) + "k";
  return "£" + Math.round(n).toString();
}

export function ItemUtilizationRanking({ accountSlug }: { accountSlug: string | null }) {
  const data = useQuery(api.dashboard_insights.getItemUtilizationRanking, {
    accountSlug,
    weeks: 4,
  });

  return (
    <div
      className="stat-card"
      style={{
        background: "rgba(14,17,28,0.35)",
        backdropFilter: "blur(24px) saturate(1.5)",
        borderRadius: 16,
        padding: 14,
        borderLeft: "3px solid #6ea8fe",
        minHeight: 150,
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-400">
            Idle Inventory
          </div>
          <div className="text-[10px] text-slate-500">4-wk avg · top idle by £</div>
        </div>
      </div>
      {data === undefined ? (
        <SkeletonBlock className="h-24 w-full" />
      ) : data.length === 0 ? (
        <EmptyState message="No utilization data" />
      ) : (
        <ul className="space-y-1">
          {data.map((row) => (
            <li
              key={row.item_id}
              className="flex items-center justify-between text-[11px] py-0.5"
            >
              <span className="truncate text-slate-200" title={row.name} style={{ maxWidth: "55%" }}>
                {row.name}
              </span>
              <span className="flex items-center gap-2 tabular-nums">
                <span className="text-slate-500">{Math.round(row.utilization * 100)}%</span>
                <span className="text-sky-400 font-semibold">{fmtGbp(row.idle_cost_per_week)}/wk</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default ItemUtilizationRanking;
