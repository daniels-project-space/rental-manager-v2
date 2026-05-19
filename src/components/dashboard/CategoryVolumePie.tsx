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

type MissedData = {
  days: number;
  periodStart: string;
  missed: {
    slices: Array<{ kind: string; label: string; missed: number; denied: number; gap: number; demandLost: number; revenue: number; color: string }>;
    totals: { missed: number; denied: number; gap: number; demandLost: number };
  };
  denied: {
    slices: Array<{ kind: string; label: string; denied: number; revenue: number; count: number; color: string }>;
    totals: { denied: number; count: number };
  };
  unmatchedDenials: { revenue: number; count: number };
};

// Phase 7.5 — per-item drill-down within a kind in Missed mode.
type MissedKindBreakdown = {
  days: number;
  periodStart: string;
  kind: string;
  kindLabel: string;
  view: "all" | "denied" | "gap" | "demand";
  items: Array<{ itemId: string; name: string; count: number; revenue: number; color: string }>;
  totals: { count: number; revenue: number };
};

type View = "earned" | "missed";
// Phase 10.6 — component filter for Missed mode. "all" = legacy behavior.
type MissedComponent = "all" | "denied" | "gap" | "demand";

type CategoryVolumePieBodyProps = {
  accountSlug: string | null;
  expanded: boolean;
  onToggle: () => void;
};

const LEADER_KEYFRAMES = `@keyframes leaderFadeIn {
  from { opacity: 0; transform: translateX(-2px); }
  to   { opacity: 1; transform: translateX(0); }
}`;

// Phase 7.7 — prettify raw kind strings for display (camera_body → Cameras, etc.)
const KIND_LABEL_PRETTY: Record<string, string> = {
  camera_body: "Cameras",
  action_cam: "Action cam",
  nd_filter: "ND filter",
  media_av: "DJ/AV",
  accessory_consumable: "Accessory",
  storage_card: "Storage",
  power: "Power",
  media: "Media",
  audio: "Audio",
  lens: "Lenses",
  lighting: "Lighting",
  support: "Support",
  monitor: "Monitors",
  transmitter: "Transmitters",
  other: "Other",
  unknown: "Unresolved",
};
function prettyLabel(s: string): string {
  if (!s) return "";
  // Case-insensitive lookup against the override map (backend sometimes returns
  // capitalized strings like "Action_cam", "Accessory_consumable").
  const key = s.toLowerCase();
  if (KIND_LABEL_PRETTY[key]) return KIND_LABEL_PRETTY[key];
  // Fallback: replace underscores with spaces + capitalize first letter
  return s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// Phase 7.7 — truncate overlong labels so leader-label text stays inside the
// widget's visible bounding box.
function truncateLabel(s: string, max = 14): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function makeLeaderLabel(
  metric: Metric,
  textKey: "label" | "name",
  offset: number,
  opts?: { dimmed?: boolean; primaryFs?: number; secondaryFs?: number; exExtension?: number; maxChars?: number },
) {
  const dimmed = opts?.dimmed ?? false;
  const primaryFs = opts?.primaryFs ?? 12;
  const secondaryFs = opts?.secondaryFs ?? 11;
  const exExtension = opts?.exExtension ?? 4;
  const maxChars = opts?.maxChars ?? 14;
  return function renderLeaderLabel(props: any) {
    const { cx, cy, midAngle, outerRadius, fill, payload, value, percent } = props;
    // Phase 7.7b — hide labels for tiny slices (<4%) so labels don't stack
    if (typeof percent === "number" && percent < 0.04) return null;
    const RAD = Math.PI / 180;
    const sin = Math.sin(-RAD * midAngle);
    const cos = Math.cos(-RAD * midAngle);
    const sx = cx + outerRadius * cos;
    const sy = cy + outerRadius * sin;
    const mx = cx + (outerRadius + offset) * cos;
    const my = cy + (outerRadius + offset) * sin;
    const dir = cos >= 0 ? 1 : -1;
    const textAnchor = cos >= 0 ? "start" : "end";
    const rawText = (payload?.[textKey] ?? "") as string;
    const text = truncateLabel(prettyLabel(rawText), maxChars);
    const valText = metric === "count"
      ? `${value} rentals`
      : `£${Number(value || 0).toFixed(0)}`;
    // Phase 7.7b — two-line layout when single line would be wide
    const useTwoLines = (text.length + valText.length + 3) > 16;
    const widest = useTwoLines ? Math.max(text.length, valText.length) : text.length + valText.length + 3;
    const estTextWidth = widest * primaryFs * 0.58;
    const chartHalfWidth = cx; // 50% center
    const GUTTER = 6;
    let ex = mx + dir * exExtension;
    let tx = ex + dir * 4;
    // Clamp: text must fit between [GUTTER, 2*cx - GUTTER]
    if (dir > 0) {
      // text extends rightward from tx
      const maxTx = 2 * cx - GUTTER - estTextWidth;
      if (tx > maxTx) {
        tx = maxTx;
        ex = tx - dir * 4;
      }
    } else {
      // text extends leftward (textAnchor=end means tx is the right edge of text)
      const minTx = GUTTER + estTextWidth;
      if (tx < minTx) {
        tx = minTx;
        ex = tx - dir * 4;
      }
    }
    // Recompute mx so the leader line elbow stays consistent with the shifted ex.
    const mxAdj = ex - dir * exExtension;
    return (
      <g style={{
        animation: "leaderFadeIn 360ms ease-out both",
        opacity: dimmed ? 0.4 : 1,
        transition: "opacity 180ms ease",
      }}>
        <path d={`M${sx},${sy}L${mxAdj},${my}L${ex},${my}`} stroke={fill} strokeWidth={1} fill="none" />
        <circle cx={ex} cy={my} r={2} fill={fill} />
        {useTwoLines ? (
          <text x={tx} y={my - 7} textAnchor={textAnchor} dominantBaseline="middle" fill="#e4e6eb" fontSize={primaryFs} fontWeight={600} style={{ letterSpacing: "0.02em" }}>
            <tspan x={tx} dy={0}>{text}</tspan>
            <tspan x={tx} dy={primaryFs + 2} fill="#8b8fa3" fontWeight={400} fontSize={secondaryFs}>{valText}</tspan>
          </text>
        ) : (
          <text x={tx} y={my} textAnchor={textAnchor} dominantBaseline="middle" fill="#e4e6eb" fontSize={primaryFs} fontWeight={600} style={{ letterSpacing: "0.02em" }}>
            <tspan>{text}</tspan>
            <tspan fill="#8b8fa3" fontWeight={400} dx={6}>· {valText}</tspan>
          </text>
        )}
      </g>
    );
  };
}

export function CategoryVolumePieBody({
  accountSlug,
  expanded,
  onToggle,
}: CategoryVolumePieBodyProps) {
  const [days, setDays] = useState<Days>(30);
  const [metric, setMetric] = useState<Metric>("count");
  const [view, setView] = useState<View>("earned");
  const [drillKind, setDrillKind] = useState<string | null>(null);
  const [subDrillKind, setSubDrillKind] = useState<string | null>(null);
  // Phase 10.6 — component filter for Missed mode (All/Denials/Gaps/Demand).
  const [missedComponent, setMissedComponent] = useState<MissedComponent>("denied");

  useEffect(() => { setDrillKind(null); setSubDrillKind(null); }, [days]);
  useEffect(() => { setSubDrillKind(null); }, [drillKind]);
  // Reset filter when switching out of Missed mode.
  useEffect(() => { if (view !== "missed") setMissedComponent("denied"); }, [view]);
  // Reset Missed drill when toggling components (kind set may change).
  useEffect(() => { setDrillKind(null); setSubDrillKind(null); }, [missedComponent]);
  // Reset drill when switching Earned↔Missed.
  useEffect(() => { setDrillKind(null); setSubDrillKind(null); }, [view]);

  const isMissed = view === "missed";
  // Force £ in missed mode (count is meaningless for missed-revenue).
  const effectiveMetric: Metric = isMissed ? "revenue" : metric;

  const data = useQuery(api.dashboard.getRentalVolumeByCategory, { accountSlug, days }) as
    | CatVolData
    | undefined;

  // Always-subscribe so toggling Earned↔Missed is instant (no skeleton flash).
  const missedData = useQuery(
    api.revenue.getMissedAndDeniedByCategory,
    { accountSlug, days },
  ) as MissedData | undefined;

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

  // Phase 7.5 — Missed-mode drill-down. Fetch per-item breakdown within the
  // clicked kind, scoped to the current `missedComponent` filter.
  const missedBreakdown = useQuery(
    api.revenue.getMissedKindBreakdown,
    isMissed && drillKind
      ? {
          accountSlug,
          days,
          kind: drillKind,
          view: missedComponent,
        }
      : "skip",
  ) as MissedKindBreakdown | undefined;

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

  // Geometry — Phase 7.6: reduced OUTER_OUTER 108→95 to give labels more
  // horizontal room. MIDDLE_OUTER stays at 80 (no collision with outer at 95).
  const OUTER_INNER = 60, OUTER_OUTER = 82;
  const MIDDLE_INNER = 36, MIDDLE_OUTER = 56;
  const INNERMOST_INNER = 8, INNERMOST_OUTER = 34;
  // Phase 7.7 — all leader labels exit OUTSIDE the outermost ring (radius 82)
  // so inner-ring labels never overlap any ring. Outer ring labels live at
  // radius 82+6=88; middle at 56+30=86; innermost at 34+54=88. All ~same band.
  const OUTER_LEADER_OFFSET = 6;
  const INNER_LEADER_OFFSET = 30;
  const INNERMOST_LEADER_OFFSET = 54;
  const CHART_HEIGHT = 400;

  // Middle ring data: items for non-other drill, sub-kinds for "other" drill.
  const middleData =
    drillKind === "other"
      ? otherSubKinds?.slices ?? []
      : breakdown?.items ?? [];
  const middleDataKey: "count" | "revenue" = metric;
  const middleNameKey: "name" | "label" = drillKind === "other" ? "label" : "name";
  const middleDimmed = !!subDrillKind;

  const renderOuterLabel = makeLeaderLabel(metric, "label", OUTER_LEADER_OFFSET);
  const renderMiddleLabel = makeLeaderLabel(metric, middleNameKey, INNER_LEADER_OFFSET, {
    dimmed: middleDimmed,
  });
  // Phase 7.6 — innermost ring labels stack and overlap when many slices exist;
  // hide them and let the tooltip serve. (kept variable for backward-compat in
  // case we re-enable later, but unused for now.)
  const renderInnermostLabel = makeLeaderLabel(metric, "name", INNERMOST_LEADER_OFFSET);

  const chevron = (
    <button
      onClick={() => onToggle()}
      className="text-slate-400 hover:text-white transition-colors text-sm leading-none px-1.5 py-0.5 rounded"
      aria-label={expanded ? "Collapse" : "Expand"}
      style={{ background: "transparent" }}
    >
      {expanded ? "▾" : "▸"}
    </button>
  );

  // Collapsed view — mini ring + compact stats.
  if (!expanded) {
    const slices = data?.slices ?? [];
    const hasData = !!data;
    const hasSlices = hasData && slices.length > 0;
    const topPct = hasSlices && data!.totals.revenue > 0
      ? Math.round((slices[0].revenue / data!.totals.revenue) * 100)
      : 0;
    return (
      <>
        <style>{LEADER_KEYFRAMES}</style>
        <div className="flex items-center gap-3">
          {!hasData ? (
            <SkeletonBlock className="w-[44px] h-[44px] rounded-full" />
          ) : !hasSlices ? (
            <div className="w-[44px] h-[44px] rounded-full bg-slate-700/40" />
          ) : (
            <div style={{ width: 44, height: 44 }}>
              <PieChart width={44} height={44}>
                <Pie
                  data={slices}
                  dataKey="revenue"
                  innerRadius={14}
                  outerRadius={20}
                  paddingAngle={2}
                  labelLine={false}
                  label={false}
                  isAnimationActive={false}
                >
                  {slices.map((s) => (
                    <Cell key={s.kind} fill={s.color} />
                  ))}
                </Pie>
              </PieChart>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider">Category Mix</span>
            <div className="text-xs text-[#e4e6eb]">
              {!hasData
                ? "—"
                : !hasSlices
                  ? `No rentals · ${days}d`
                  : `£${data!.totals.revenue.toFixed(0)} · ${data!.totals.count} rentals`}
            </div>
            {hasSlices && (
              <div className="text-[11px] text-[#8b8fa3] truncate">
                top: {slices[0].label} {topPct}%
              </div>
            )}
          </div>
          {chevron}
        </div>
      </>
    );
  }

  return (
    <>
      <style>{LEADER_KEYFRAMES}</style>
      <div className="mb-2 flex flex-col gap-1.5">
        {/* Row 1: title + breadcrumb + chevron */}
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider shrink-0">
              {isMissed ? "Missed" : "Category Mix"}
            </span>
            <span className="text-xs text-[#8b8fa3] truncate">
              {isMissed && drillKind ? (
                <>
                  <button
                    onClick={() => { setDrillKind(null); setSubDrillKind(null); }}
                    className="text-sm font-medium px-2 py-1 -my-1 rounded hover:bg-white/5 hover:text-white transition-colors"
                    style={{ color: "#fbbf24" }}
                    aria-label="Back to all missed kinds"
                  >
                    ← All kinds
                  </button>
                  <span className="ml-2 text-white/70 truncate">
                    / {missedData?.missed.slices.find((s) => s.kind === drillKind)?.label ?? drillKind}
                  </span>
                </>
              ) : isMissed ? (
                missedData
                  ? (() => {
                      const total = missedData.missed.totals.missed;
                      const fmt = (n: number) => n >= 1000 ? `£${(n / 1000).toFixed(1)}k` : `£${Math.round(n)}`;
                      return `${fmt(total)} · ${days}d`;
                    })()
                  : periodLabel
              ) : subDrillKind || drillKind ? (
                <>
                  <button
                    onClick={() => { setDrillKind(null); setSubDrillKind(null); }}
                    className="text-sm font-medium px-2 py-1 -my-1 rounded hover:bg-white/5 hover:text-white transition-colors"
                    style={{ color: "#6ea8fe" }}
                    aria-label="Back to all categories"
                  >
                    ← All categories
                  </button>
                  <span className="ml-2 text-white/70 truncate">
                    / {subDrillKind ? `${drillLabel} / ${subDrillLabel}` : drillLabel}
                  </span>
                </>
              ) : (
                periodLabel
              )}
            </span>
          </div>
          {chevron}
        </div>
        {/* Row 2: control pills, wrap on overflow */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <div className="flex gap-1">
            {(["earned", "missed"] as const).map((vw) => (
              <button
                key={vw}
                onClick={() => {
                  setView(vw);
                  setDrillKind(null);
                  setSubDrillKind(null);
                }}
                className="text-[11px] px-1.5 py-0.5 rounded transition-colors"
                style={{
                  background: view === vw
                    ? (vw === "earned" ? "rgba(96,165,250,0.15)" : "rgba(245,158,11,0.18)")
                    : "transparent",
                  color: view === vw
                    ? (vw === "earned" ? "#60a5fa" : "#f59e0b")
                    : "#8b8fa3",
                  border: view === vw
                    ? `1px solid ${vw === "earned" ? "rgba(96,165,250,0.3)" : "rgba(245,158,11,0.35)"}`
                    : "1px solid transparent",
                }}
              >
                {vw === "earned" ? "Earned" : "Missed"}
              </button>
            ))}
          </div>
          {/* Phase 10.6 — component filter pill (Missed mode only). */}
          {isMissed && (
            <div className="flex gap-1">
              {(
                [
                  { val: "denied", label: "Denials", tip: "You actively cancelled the rental in Hygglo." },
                  { val: "gap", label: "Gaps", tip: "You couldn't fulfill — fully booked or marketing-only." },
                  { val: "demand", label: "Demand", tip: "Renter paid/progressed then the booking fell apart." },
                ] as const
              ).map((c) => {
                const active = missedComponent === c.val;
                return (
                  <button
                    key={c.val}
                    onClick={() => setMissedComponent(c.val)}
                    title={c.tip}
                    className="px-1.5 py-0.5 text-[11px] rounded transition-colors"
                    style={{
                      background: active ? "rgba(245,158,11,0.18)" : "transparent",
                      color: active ? "#f59e0b" : "#8b8fa3",
                      border: active
                        ? "1px solid rgba(245,158,11,0.35)"
                        : "1px solid transparent",
                    }}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex gap-1">
            {periodOpts.map((p) => (
              <button
                key={p.val}
                onClick={() => setDays(p.val)}
                className="px-1.5 py-0.5 text-[11px] rounded transition-colors"
                style={{
                  background: days === p.val ? "rgba(110,168,254,0.15)" : "transparent",
                  color: days === p.val ? "#6ea8fe" : "#8b8fa3",
                  border: days === p.val ? "1px solid rgba(110,168,254,0.3)" : "1px solid transparent",
                }}
              >{p.label}</button>
            ))}
          </div>
          {!isMissed && (
          <div className="flex gap-1">
            {metricOpts.map((m) => {
              const disabled = isMissed && m.val === "count";
              const active = effectiveMetric === m.val;
              return (
                <button
                  key={m.val}
                  onClick={() => { if (!disabled) setMetric(m.val); }}
                  disabled={disabled}
                  className="px-1.5 py-0.5 text-[11px] rounded transition-colors"
                  style={{
                    background: active ? "rgba(110,168,254,0.15)" : "transparent",
                    color: active ? "#6ea8fe" : "#8b8fa3",
                    border: active ? "1px solid rgba(110,168,254,0.3)" : "1px solid transparent",
                    opacity: disabled ? 0.4 : 1,
                    cursor: disabled ? "not-allowed" : "pointer",
                  }}
                >{m.label}</button>
              );
            })}
          </div>
          )}
        </div>
      </div>

      {isMissed ? (
        missedData === undefined ? (
          <SkeletonBlock className={`h-[${CHART_HEIGHT}px] w-full`} />
        ) : missedData.missed.slices.length === 0 ? (
          <EmptyState message={`No missed revenue in ${periodLabel.toLowerCase()}`} icon="📉" />
        ) : (() => {
          // Phase 10.6 — per-component filtering.
          // "all" → outer = total missed (legacy), inner = denied (legacy).
          // "denied"/"gap"/"demand" → outer recomputed for that component only,
          // inner mirrors that component (gap/demand inner replaces denied).
          type OuterSlice = (typeof missedData.missed.slices)[number];
          const compKey: "missed" | "denied" | "gap" | "demandLost" =
            missedComponent === "all" ? "missed"
            : missedComponent === "denied" ? "denied"
            : missedComponent === "gap" ? "gap"
            : "demandLost";
          const filteredOuter: OuterSlice[] = missedComponent === "all"
            ? missedData.missed.slices
            : missedData.missed.slices
                .map((s) => ({ ...s, missed: s[compKey], revenue: s[compKey] }))
                .filter((s) => s.missed > 0);

          // Inner ring data: "all" or "denied" uses the denied breakdown; "gap"
          // and "demand" use that component's per-kind breakdown via outer.
          const innerDataAll = missedData.denied.slices;
          const innerData = missedComponent === "all" || missedComponent === "denied"
            ? innerDataAll
            : filteredOuter.map((s) => ({
                kind: s.kind,
                label: s.label,
                denied: s[compKey],
                revenue: s[compKey],
                count: 0,
                color: s.color,
              }));
          const innerKey: "denied" = "denied";

          return (
          <div
            style={{
              background: "radial-gradient(circle at 50% 50%, rgba(245,158,11,0.06) 0%, transparent 60%)",
            }}
          >
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <PieChart margin={{ top: 20, right: 90, bottom: 20, left: 90 }} style={{ overflow: "visible" }}>
                <Pie
                  data={filteredOuter}
                  dataKey="missed"
                  nameKey="label"
                  cx="50%"
                  cy="50%"
                  innerRadius={OUTER_INNER}
                  outerRadius={OUTER_OUTER}
                  paddingAngle={4}
                  cornerRadius={6}
                  labelLine={false}
                  label={drillKind ? false : makeLeaderLabel("revenue", "label", OUTER_LEADER_OFFSET)}
                  isAnimationActive={true}
                  animationDuration={400}
                  animationEasing="ease-out"
                  onClick={(_e, idx: number) => {
                    const slice = filteredOuter[idx];
                    if (slice) {
                      setDrillKind((prev) => (prev === slice.kind ? null : slice.kind));
                      setSubDrillKind(null);
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  {filteredOuter.map((s) => (
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
                {/* Phase 7.5 — middle ring shows per-item drill within the clicked kind. */}
                {drillKind && missedBreakdown && missedBreakdown.items.length > 0 && (
                  <Pie
                    data={missedBreakdown.items}
                    dataKey="revenue"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={MIDDLE_INNER}
                    outerRadius={MIDDLE_OUTER}
                    paddingAngle={3}
                    cornerRadius={6}
                    labelLine={false}
                    label={makeLeaderLabel("revenue", "name", INNER_LEADER_OFFSET)}
                    legendType="none"
                    isAnimationActive={true}
                    animationDuration={400}
                    animationEasing="ease-out"
                  >
                    {missedBreakdown.items.map((it) => (
                      <Cell
                        key={it.itemId}
                        fill={it.color}
                        style={{
                          filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.25))",
                          transition: "fill-opacity 220ms ease",
                        }}
                      />
                    ))}
                  </Pie>
                )}
                {false && !drillKind && innerData.length > 0 && (
                  <Pie
                    data={innerData}
                    dataKey={innerKey}
                    nameKey="label"
                    cx="50%"
                    cy="50%"
                    innerRadius={MIDDLE_INNER}
                    outerRadius={MIDDLE_OUTER}
                    paddingAngle={3}
                    cornerRadius={6}
                    labelLine={false}
                    label={false}
                    legendType="none"
                    isAnimationActive={true}
                    animationDuration={400}
                    animationEasing="ease-out"
                  >
                    {innerData.map((s) => (
                      <Cell
                        key={`d-${s.kind}`}
                        fill={s.color}
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
                    const p = (item as { payload?: OuterSlice })?.payload;
                    if (!p) return [`£${n.toFixed(0)}`, ""];
                    // Outer slice in "all" mode: show three-component split.
                    const hasSplit =
                      missedComponent === "all" &&
                      typeof p.denied === "number" &&
                      typeof p.gap === "number" &&
                      typeof p.demandLost === "number";
                    if (hasSplit) {
                      return [
                        `£${n.toFixed(0)}: £${p.denied.toFixed(0)} denials + £${p.gap.toFixed(0)} gap + £${p.demandLost.toFixed(0)} demand`,
                        p.label ?? "",
                      ];
                    }
                    return [`£${n.toFixed(0)}`, p.label ?? ""];
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          );
        })()
      ) : data === undefined ? (
        <SkeletonBlock className={`h-[${CHART_HEIGHT}px] w-full`} />
      ) : data.slices.length === 0 ? (
        <EmptyState message={`No rentals in ${periodLabel.toLowerCase()}`} icon="📊" />
      ) : (
        <div
          style={{
            background: "radial-gradient(circle at 50% 50%, rgba(96,165,250,0.06) 0%, transparent 60%)",
          }}
        >
          <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
            <PieChart margin={{ top: 20, right: 90, bottom: 20, left: 90 }} style={{ overflow: "visible" }}>
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
                  label={subDrillKind ? false : renderMiddleLabel}
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

      {!isMissed && data && data.slices.length > 0 && (
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
      {isMissed && missedData && missedData.missed.slices.length > 0 && (
        <div className="grid grid-cols-2 gap-3 pt-3 border-t border-white/5">
          <div>
            <div className="text-xs text-[#8b8fa3] uppercase tracking-wider">Total Missed</div>
            <div className="text-lg font-bold" style={{ color: "#f59e0b" }}>
              £{missedData.missed.totals.missed.toFixed(0)}
            </div>
          </div>
          <div>
            <div className="text-xs text-[#8b8fa3] uppercase tracking-wider">Denied Revenue</div>
            <div className="text-lg font-bold" style={{ color: "#ef4444" }}>
              £{missedData.denied.totals.denied.toFixed(0)}
              <span className="text-xs ml-1 text-[#8b8fa3] font-normal">({missedData.denied.totals.count})</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
