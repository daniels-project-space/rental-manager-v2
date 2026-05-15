"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { EmptyState } from "@/components/ui/EmptyState";
import { useState } from "react";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from "recharts";

type Metric = "count" | "revenue";

export type CatVolData = {
  slices: Array<{ kind: string; label: string; count: number; revenue: number; color: string }>;
  totals: { count: number; revenue: number };
  month: string;
};

function formatMonth(ym: string): string {
  if (!ym || !ym.includes("-")) return ym || "";
  const [y, m] = ym.split("-");
  const year = parseInt(y);
  const monthIdx = parseInt(m) - 1;
  if (isNaN(year) || isNaN(monthIdx)) return ym;
  return new Date(year, monthIdx).toLocaleString("en", { month: "long", year: "numeric" });
}

export function CategoryVolumePieBody({ data }: { data: CatVolData | undefined }) {
  const [metric, setMetric] = useState<Metric>("count");

  const metricOpts: { label: string; val: Metric }[] = [
    { label: "Count", val: "count" },
    { label: "£", val: "revenue" },
  ];

  if (data === undefined) {
    return <SkeletonBlock className="h-[220px] w-full" />;
  }
  if (data.slices.length === 0) {
    return <EmptyState message="No rentals yet this month" icon="📊" />;
  }

  return (
    <>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-[#8b8fa3]">{formatMonth(data.month)}</span>
        <div className="flex gap-1">
          {metricOpts.map((m) => (
            <button
              key={m.val}
              onClick={() => setMetric(m.val)}
              className="px-2 py-0.5 text-xs rounded transition-colors"
              style={{
                background: metric === m.val ? "rgba(110,168,254,0.15)" : "transparent",
                color: metric === m.val ? "#6ea8fe" : "#8b8fa3",
                border: metric === m.val ? "1px solid rgba(110,168,254,0.3)" : "1px solid transparent",
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={240}>
        <PieChart>
          <Pie
            data={data.slices}
            dataKey={metric}
            nameKey="label"
            innerRadius={50}
            outerRadius={90}
            paddingAngle={2}
          >
            {data.slices.map((s) => (
              <Cell key={s.kind} fill={s.color} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: "rgba(14,17,28,0.95)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value, _name, item) => {
              const n = Number(value) || 0;
              const label = (item as { payload?: { label?: string } })?.payload?.label ?? "";
              return metric === "count"
                ? [`${n} rentals`, label]
                : [`£${n.toFixed(0)}`, label];
            }}
          />
          <Legend
            verticalAlign="bottom"
            align="center"
            wrapperStyle={{ fontSize: 11, color: "#9ca3af" }}
            formatter={(value, entry) => {
              const p = (entry as { payload?: { count?: number; revenue?: number } } | undefined)?.payload;
              if (!p) return value as string;
              return metric === "count"
                ? `${value} (${p.count ?? 0})`
                : `${value} (£${(p.revenue ?? 0).toFixed(0)})`;
            }}
          />
        </PieChart>
      </ResponsiveContainer>

      <div className="grid grid-cols-2 gap-3 pt-3 border-t border-white/5">
        <div>
          <div className="text-xs text-[#8b8fa3] uppercase tracking-wider">Total Rentals</div>
          <div className="text-lg font-bold" style={{ color: "#6ea8fe" }}>
            {data.totals.count}
          </div>
        </div>
        <div>
          <div className="text-xs text-[#8b8fa3] uppercase tracking-wider">Total Revenue</div>
          <div className="text-lg font-bold" style={{ color: "#22c55e" }}>
            £{data.totals.revenue.toFixed(0)}
          </div>
        </div>
      </div>
    </>
  );
}

export function CategoryVolumePie() {
  const { activeAccountSlug } = useAccount();
  const data = useQuery(api.dashboard.getRentalVolumeByCategory, {
    accountSlug: activeAccountSlug,
  });
  return (
    <Card>
      <CardHeader title="Category Volume" />
      <CategoryVolumePieBody data={data} />
    </Card>
  );
}
