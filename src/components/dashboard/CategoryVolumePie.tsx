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

type OtherSubKinds = {
  days: number;
  periodStart: string;
  slices: Array<{ kind: string; label: string; count: number; revenue: number; color: string }>;
  totals: { count: number; revenue: number };
};

type CategoryVolumePieBodyProps = {
  accountSlug: string | null;
  alwaysOpen?: boolean;
};

const LEADER_KEYFRAMES = `@keyframes leaderFadeIn {
  from { opacity: 0; transform: translateX(-2px); }
  to   { opacity: 1; transform: translateX(0); }
}`;

function makeLeaderLabel(
  metric: Metric,
  textKey: "label" | "name",
  offset: number,
  opts?: { dimmed?: boolean; primaryFs?: number; secondaryFs?: number },
) {
  const dimmed = opts?.dimmed ?? false;
  const primaryFs = opts?.primaryFs ?? 12;
  const secondaryFs = opts?.secondaryFs ?? 11;
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
      <g style={{
        animation: "leaderFadeIn 360ms ease-out both",
        opacity: dimmed ? 0.4 : 1,
        transition: "opacity 180ms ease",
      }}>
        <path d={`M${sx},${sy}L${mx},${my}L${ex},${my}`} stroke={fill} strokeWidth={1} fill="none" />
        <circle cx={ex} cy={my} r={2} fill={fill} />
        <text x={tx} y={my} textAnchor={textAnchor} dominantBaseline="middle" fill="#e4e6eb" fontSize={primaryFs} fontWeight={600} style={{ letterSpacing: "0.02em" }}>{text}</text>
        <text x={tx} y={my + 12} textAnchor={textAnchor} dominantBaseline="middle" fill="#cbd5e1" fontSize={secondaryFs}>{valText}</text>
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
  const [subDrillKind, setSubDrillKind] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<boolean>(true);

  useEffect(() => { setDrillKind(null); setSubDrillKind(null); }, [days]);
  useEffect(() => { setSubDrillKind(null); }, [drillKind]);

  const data = useQuery(api.dashboard.getRentalVolumeByCategory, { accountSlug, days }) as
    | CatVolData
    | undefined;

  const breakdown = useQuery(
    api.dashboard.getRentalVolumeKindBreakdown,
    drillKind && drillKind !== "other" && !subDrillKind
      ? { accountSlug, days, kind: drillKind }
      : "skip",
  ) as KindBreakdown | undefined;

  const otherSubKinds = useQuery(
    api.dashboard.getRentalVolumeOtherSubKinds,
    drillKind === "other" ? { accountSlug, days } : "skip",
  ) as OtherSubKinds | undefined;

  const subBreakdown = useQuery(
    api.dashboard.getRentalVolumeKindBreakdown,
    drillKind === "other" && subDrillKind
      ? { accountSlug, days, kind: subDrillKind }
      : "skip",
  ) as KindBreakdown | undefined;

  // Prefetch top-3 kind breakdowns for snappy drills.
  const top3 = (data?.slices ?? []).slice(0, 3).map((s) => s.kind);
  useQuery(
    api.dashboard.getRentalVolumeKindBreakdown,
    top3[0] && top3[0] !== "other" ? { accountSlug, days, kind: top3[0] } : "skip",
  );
  useQuery(
    api.dashboard.getRentalVolumeKindBreakdown,
    top3[1] && top3[1] !== "other" ? { accountSlug, days, kind: top3[1] } : "skip",
  );
  useQuery(
    api.dashboard.getRentalVolumeKindBreakdown,
    top3[2] && top3[2] !== "other" ? { accountSlug, days, kind: top3[2] } : "skip",
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
  const subDrillLabel = subDrillKind && otherSubKinds
    ? otherSubKinds.slices.find((s) => s.kind === subDrillKind)?.label ?? subDrillKind
    : null;

  // Compact summary line for collapsed view.
  const topSlice = data?.slices?.[0];
  const compactSummary = data
    ? `£${data.totals.revenue.toFixed(0)} · ${data.totals.count} rentals · ${days}d${topSlice ? ` · top: ${topSlice.label} £${topSlice.revenue.toFixed(0)}` : ""}`
    : "Loading…";

  // Geometry
  const OUTER_INNER = 78, OUTER_OUTER = 108;
  const MIDDLE_INNER = 40, MIDDLE_OUTER = 80;
  const INNERMOST_INNER = 8, INNERMOST_OUTER = 34;
  const INNER_LEADER_OFFSET = 42;
  const INNERMOST_LEADER_OFFSET = 80;
  const CHART_HEIGHT = 400;

  // Middle ring data: items for non-other drill, sub-kinds for "other" drill.
  const middleData =
    drillKind === "other"
      ? otherSubKinds?.slices ?? []
      : breakdown?.items ?? [];
  const middleDataKey: "count" | "revenue" = metric;
  const middleNameKey: "name" | "label" = drillKind === "other" ? "label" : "name";
  const middleDimmed = !!subDrillKind;

  const renderOuterLabel = makeLeaderLabel(metric, "label", 14);
  const renderMiddleLabel = makeLeaderLabel(metric, middleNameKey, INNER_LEADER_OFFSET, {
    dimmed: middleDimmed,
  });
  const renderInnermostLabel = makeLeaderLabel(metric, "name", INNERMOST_LEADER_OFFSET);

  const chevron = (
    <button
      onClick={() => setExpanded((v) => !v)}
      className="text-slate-400 hover:text-white transition-colors text-sm leading-none px-1.5 py-0.5 rounded"
      aria-label={expanded ? "Collapse" : "Expand"}
      style={{ background: "transparent" }}
    >
      {expanded ? "▾" : "▸"}
    </button>
  );

  // Collapsed view — compact summary only.
  if (!expanded) {
    return (
      <>
        <style>{LEADER_KEYFRAMES}</style>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider">
              Category Mix
            </span>
            <span className="text-xs text-[#e4e6eb] truncate">{compactSummary}</span>
          </div>
          {chevron}
        </div>
      </>
    );
  }

  return (
    <>
      <style>{LEADER_KEYFRAMES}</style>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider">
            Category Mix
          </span>
          <span className="text-xs text-[#8b8fa3]">
            {subDrillKind ? (
              <>
                <button
                  onClick={() => setSubDrillKind(null)}
                  className="hover:text-white transition-colors"
                  style={{ color: "#6ea8fe" }}
                >
                  ← Other
                </button>
                <span className="ml-2 text-white/70">/ {subDrillLabel}</span>
              </>
            ) : drillKind ? (
              <>
                <button
                  onClick={() => { setDrillKind(null); setSubDrillKind(null); }}
                  className="hover:text-white transition-colors"
                  style={{ color: "#6ea8fe" }}
                >
                  ← All categories
                </button>
                <span className="ml-2 text-white/70">/ {drillLabel}</span>
              </>
            ) : (
              periodLabel
            )}
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
          {chevron}
        </div>
      </div>

      {data === undefined ? (
        <SkeletonBlock className={`h-[${CHART_HEIGHT}px] w-full`} />
      ) : data.slices.length === 0 ? (
        <EmptyState message={`No rentals in ${periodLabel.toLowerCase()}`} icon="📊" />
      ) : (
        <div
          className="px-16"
          style={{
            background: "radial-gradient(circle at 50% 50%, rgba(96,165,250,0.06) 0%, transparent 60%)",
          }}
        >
          <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
            <PieChart>
              <Pie
                data={data.slices}
                dataKey={metric}
                nameKey="label"
                cx="50%"
                cy="50%"
                innerRadius={OUTER_INNER}
                outerRadius={OUTER_OUTER}
                paddingAngle={4}
                cornerRadius={6}
                labelLine={false}
                label={drillKind ? false : renderOuterLabel}
                isAnimationActive={true}
                animationDuration={400}
                animationEasing="ease-out"
                onClick={(_e, idx: number) => {
                  const slice = data.slices[idx];
                  if (slice) {
                    setDrillKind((prev) => (prev === slice.kind ? null : slice.kind));
                    setSubDrillKind(null);
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                {data.slices.map((s) => (
                  <Cell
                    key={s.kind}
                    fill={s.color}
                    fillOpacity={drillKind ? 0.4 : 1}
                    style={{
                      filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.25))",
                      transition: "fill-opacity 220ms ease",
                    }}
                  />
                ))}
              </Pie>
              {drillKind && middleData.length > 0 && (
                <Pie
                  data={middleData}
                  dataKey={middleDataKey}
                  nameKey={middleNameKey}
                  cx="50%"
                  cy="50%"
                  innerRadius={MIDDLE_INNER}
                  outerRadius={MIDDLE_OUTER}
                  paddingAngle={3}
                  cornerRadius={6}
                  labelLine={false}
                  label={renderMiddleLabel}
                  legendType="none"
                  isAnimationActive={true}
                  animationDuration={400}
                  animationEasing="ease-out"
                  onClick={(_e, idx: number) => {
                    if (drillKind !== "other") return;
                    const slice = (otherSubKinds?.slices ?? [])[idx];
                    if (slice) {
                      setSubDrillKind((prev) => (prev === slice.kind ? null : slice.kind));
                    }
                  }}
                  style={{ cursor: drillKind === "other" ? "pointer" : "default" }}
                >
                  {middleData.map((it: any, i: number) => (
                    <Cell
                      key={(it.itemId ?? it.kind ?? i) as string}
                      fill={it.color}
                      fillOpacity={middleDimmed ? 0.4 : 1}
                      style={{
                        filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.25))",
                        transition: "fill-opacity 220ms ease",
                      }}
                    />
                  ))}
                </Pie>
              )}
              {drillKind === "other" && subDrillKind && subBreakdown && subBreakdown.items.length > 0 && (
                <Pie
                  data={subBreakdown.items}
                  dataKey={metric}
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={INNERMOST_INNER}
                  outerRadius={INNERMOST_OUTER}
                  paddingAngle={2}
                  cornerRadius={6}
                  labelLine={false}
                  label={renderInnermostLabel}
                  legendType="none"
                  isAnimationActive={true}
                  animationDuration={400}
                  animationEasing="ease-out"
                >
                  {subBreakdown.items.map((it, i) => (
                    <Cell
                      key={it.itemId ?? i}
                      fill={it.color}
                      style={{
                        filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.25))",
                        transition: "fill-opacity 220ms ease",
                      }}
                    />
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
