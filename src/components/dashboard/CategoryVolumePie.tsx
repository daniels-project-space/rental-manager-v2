"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { EmptyState } from "@/components/ui/EmptyState";
import { useEffect, useState } from "react";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from "recharts";

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

type CategoryVolumePieBodyProps = {
  accountSlug: string | null;
  /** When true, renders without any wrapping card chrome — used by the always-open
   *  hero tile in StatsGrid. Currently informational only (no collapse UI exists). */
  alwaysOpen?: boolean;
};

function makeLeaderLabel(metric: Metric, textKey: "label" | "name", offset: number) {
  return function renderLeaderLabel(props: any) {
    const { cx, cy, midAngle, outerRadius, fill, payload, value } = props;
    const RAD = Math.PI / 180;
    const sin = Math.sin(-RAD * midAngle);
    const cos = Math.cos(-RAD * midAngle);
    const sx = cx + outerRadius * cos;
    const sy = cy + outerRadius * sin;
    const mx = cx + (outerRadius + offset) * cos;
    const my = cy + (outerRadius + offset) * sin;
    const ex = mx + (cos >= 0 ? 1 : -1) * 18;
    const textAnchor = cos >= 0 ? "start" : "end";
    const text = (payload?.[textKey] ?? "") as string;
    const valText = metric === "count"
      ? `${value} rentals`
      : `£${Number(value || 0).toFixed(0)}`;
    const tx = ex + (cos >= 0 ? 4 : -4);
    return (
      <g style={{ transition: "opacity 180ms ease" }}>
        <path d={`M${sx},${sy}L${mx},${my}L${ex},${my}`} stroke={fill} strokeWidth={1} fill="none" />
        <circle cx={ex} cy={my} r={2} fill={fill} />
        <text x={tx} y={my} textAnchor={textAnchor} dominantBaseline="middle" fill="#e4e6eb" fontSize={11}>{text}</text>
        <text x={tx} y={my + 12} textAnchor={textAnchor} dominantBaseline="middle" fill="#8b8fa3" fontSize={10}>{valText}</text>
      </g>
    );
  };
}

export function CategoryVolumePieBody({
  accountSlug,
  alwaysOpen: _alwaysOpen,
}: CategoryVolumePieBodyProps) {
  const [days, setDays] = useState<Days>(30);
  const [metric, setMetric] = useState<Metric>("count");
  const [drillKind, setDrillKind] = useState<string | null>(null);

  useEffect(() => { setDrillKind(null); }, [days]);

  const data = useQuery(api.dashboard.getRentalVolumeByCategory, { accountSlug, days }) as
    | CatVolData
    | undefined;

  const breakdown = useQuery(
    api.dashboard.getRentalVolumeKindBreakdown,
    drillKind ? { accountSlug, days, kind: drillKind } : "skip",
  ) as KindBreakdown | undefined;

  // Prefetch top-3 kind breakdowns so drill clicks hit the Convex cache.
  const top3 = (data?.slices ?? []).slice(0, 3).map((s) => s.kind);
  useQuery(
    api.dashboard.getRentalVolumeKindBreakdown,
    top3[0] ? { accountSlug, days, kind: top3[0] } : "skip",
  );
  useQuery(
    api.dashboard.getRentalVolumeKindBreakdown,
    top3[1] ? { accountSlug, days, kind: top3[1] } : "skip",
  );
  useQuery(
    api.dashboard.getRentalVolumeKindBreakdown,
    top3[2] ? { accountSlug, days, kind: top3[2] } : "skip",
  );

  const periodOpts: { label: string; val: Days }[] = [
    { label: "30d", val: 30 }, { label: "90d", val: 90 }, { label: "1y", val: 365 },
  ];
  const metricOpts: { label: string; val: Metric }[] = [
    { label: "Count", val: "count" }, { label: "£", val: "revenue" },
  ];
  const periodLabel = days === 365 ? "Last year" : `Last ${days} days`;

  const drillLabel = drillKind && data
    ? data.slices.find((s) => s.kind === drillKind)?.label ?? drillKind
    : null;

  const renderOuterLabel = makeLeaderLabel(metric, "label", 14);
  const renderInnerLabel = makeLeaderLabel(metric, "name", 28);

  return (
    <>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider">
            Category Mix
          </span>
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
        </div>
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

      {data === undefined ? (
        <SkeletonBlock className="h-[360px] w-full" />
      ) : data.slices.length === 0 ? (
        <EmptyState message={`No rentals in ${periodLabel.toLowerCase()}`} icon="📊" />
      ) : (
        <div className="px-16">
          <ResponsiveContainer width="100%" height={360}>
            <PieChart>
              <Pie
                data={data.slices}
                dataKey={metric}
                nameKey="label"
                cx="50%"
                cy="50%"
                innerRadius={78}
                outerRadius={108}
                paddingAngle={2}
                labelLine={false}
                label={drillKind ? false : renderOuterLabel}
                isAnimationActive={true}
                animationDuration={400}
                animationEasing="ease-out"
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
                    fillOpacity={drillKind ? 0.4 : 1}
                    style={{ transition: "fill-opacity 220ms ease" }}
                  />
                ))}
              </Pie>
              {drillKind && breakdown && breakdown.items.length > 0 && (
                <Pie
                  data={breakdown.items}
                  dataKey={metric}
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={35}
                  outerRadius={72}
                  paddingAngle={1}
                  labelLine={false}
                  label={renderInnerLabel}
                  legendType="none"
                  isAnimationActive={true}
                  animationDuration={400}
                  animationEasing="ease-out"
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
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      {data && data.slices.length > 0 && (
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
      )}
    </>
  );
}
