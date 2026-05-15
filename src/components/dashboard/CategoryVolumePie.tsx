"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { EmptyState } from "@/components/ui/EmptyState";
import { useEffect, useState } from "react";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from "recharts";

type Metric = "count" | "revenue";
type Days = 30 | 90 | 365;

export type CatVolData = {
  days: number;
  periodStart: string;
  slices: Array<{ kind: string; label: string; count: number; revenue: number; color: string }>;
  totals: { count: number; revenue: number };
};

type KindBreakdown = {
  days: number;
  periodStart: string;
  kind: string;
  kindLabel: string;
  items: Array<{ itemId: string; name: string; count: number; revenue: number; color: string }>;
  totals: { count: number; revenue: number };
};

export function CategoryVolumePieBody({ accountSlug }: { accountSlug: string | null }) {
  const [days, setDays] = useState<Days>(30);
  const [metric, setMetric] = useState<Metric>("count");
  const [drillKind, setDrillKind] = useState<string | null>(null);

  // Reset drill state when period changes — different period = different slices.
  useEffect(() => { setDrillKind(null); }, [days]);

  const data = useQuery(api.dashboard.getRentalVolumeByCategory, { accountSlug, days }) as
    | CatVolData
    | undefined;

  const breakdown = useQuery(
    api.dashboard.getRentalVolumeKindBreakdown,
    drillKind ? { accountSlug, days, kind: drillKind } : "skip",
  ) as KindBreakdown | undefined;

  const periodOpts: { label: string; val: Days }[] = [
    { label: "30d", val: 30 }, { label: "90d", val: 90 }, { label: "1y", val: 365 },
  ];
  const metricOpts: { label: string; val: Metric }[] = [
    { label: "Count", val: "count" }, { label: "£", val: "revenue" },
  ];
  const periodLabel = days === 365 ? "Last year" : `Last ${days} days`;

  if (data === undefined) return <SkeletonBlock className="h-[220px] w-full" />;
  if (data.slices.length === 0)
    return <EmptyState message={`No rentals in ${periodLabel.toLowerCase()}`} icon="📊" />;

  const drillLabel = drillKind
    ? data.slices.find((s) => s.kind === drillKind)?.label ?? drillKind
    : null;

  return (
    <>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <span className="text-xs text-[#8b8fa3]">
          {drillKind ? (
            <button
              onClick={() => setDrillKind(null)}
              className="hover:text-white transition-colors"
              style={{ color: "#6ea8fe" }}
            >
              ← All categories
            </button>
          ) : (
            periodLabel
          )}
          {drillKind && <span className="ml-2 text-white/70">/ {drillLabel}</span>}
        </span>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {periodOpts.map((p) => (
              <button
                key={p.val}
                onClick={() => setDays(p.val)}
                className="px-2 py-0.5 text-xs rounded transition-colors"
                style={{
                  background: days === p.val ? "rgba(110,168,254,0.15)" : "transparent",
                  color: days === p.val ? "#6ea8fe" : "#8b8fa3",
                  border: days === p.val ? "1px solid rgba(110,168,254,0.3)" : "1px solid transparent",
                }}
              >{p.label}</button>
            ))}
          </div>
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
              >{m.label}</button>
            ))}
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={240}>
        <PieChart>
          <Pie
            data={data.slices}
            dataKey={metric}
            nameKey="label"
            innerRadius={60}
            outerRadius={90}
            paddingAngle={2}
            onClick={(_e, idx: number) => {
              const slice = data.slices[idx];
              if (slice) setDrillKind((prev) => (prev === slice.kind ? null : slice.kind));
            }}
            style={{ cursor: "pointer" }}
          >
            {data.slices.map((s) => (
              <Cell
                key={s.kind}
                fill={s.color}
                opacity={drillKind && drillKind !== s.kind ? 0.33 : 1}
              />
            ))}
          </Pie>
          {drillKind && breakdown && breakdown.items.length > 0 && (
            <Pie
              data={breakdown.items}
              dataKey={metric}
              nameKey="name"
              innerRadius={30}
              outerRadius={55}
              paddingAngle={1}
              legendType="none"
            >
              {breakdown.items.map((it, i) => (
                <Cell key={it.itemId ?? i} fill={it.color} />
              ))}
            </Pie>
          )}
          <Tooltip
            contentStyle={{
              background: "rgba(14,17,28,0.95)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value, _name, item) => {
              const n = Number(value) || 0;
              const p = (item as { payload?: { label?: string; name?: string } })?.payload;
              const tipLabel = p?.label ?? p?.name ?? "";
              return metric === "count"
                ? [`${n} rentals`, tipLabel]
                : [`£${n.toFixed(0)}`, tipLabel];
            }}
          />
          <Legend
            verticalAlign="bottom"
            align="center"
            wrapperStyle={{ fontSize: 11, color: "#9ca3af" }}
            formatter={(value, entry) => {
              // Only outer-ring (kind slices) carry label/count/revenue; for the
              // inner ring Recharts auto-emits its own legend entries which we
              // ignore in the formatter (return value as-is). To prevent inner
              // entries from polluting, we filter by presence of `label`.
              const p = (entry as { payload?: { label?: string; count?: number; revenue?: number } } | undefined)?.payload;
              if (!p || p.label === undefined) return value as string;
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
