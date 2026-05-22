"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceDot,
  ReferenceLine,
} from "recharts";
import type {
  ValueType,
  NameType,
} from "recharts/types/component/DefaultTooltipContent";
import type { TooltipContentProps } from "recharts";

// V1 colour palette (matches /home/ubuntu/rental-manager/src/public/js/dashboard-core.js).
// Order is bottom → top of the stack. Only segments that can crown the stack get radius.
const SERIES = [
  { key: "danielOrganic",      label: "Daniel (retired)",  color: "#f97316", fill: "url(#grad-daniel)",   roundTop: false },
  { key: "vertusOrganic",      label: "Vertus (retired)",  color: "#8b5a2b", fill: "url(#grad-vertus)",   roundTop: false },
  { key: "dbcinemaOrganic",    label: "DB Cinema",          color: "#6366f1", fill: "url(#grad-dbcinema)", roundTop: false },
  { key: "leoOrganic",         label: "Leo Adams",          color: "#a855f7", fill: "url(#grad-leo)",      roundTop: false },
  { key: "aiBoost",            label: "AI Boost",           color: "#22c55e", fill: "url(#grad-ai)",       roundTop: true  },
  { key: "damageClaims",       label: "Claims",             color: "#ffffff", fill: "url(#grad-damage)",   roundTop: true  },
  { key: "bookedNext",         label: "Booked (next mo)",   color: "#94a3b8", fill: "url(#grad-booked)",   roundTop: true  },
  { key: "pendingNext",        label: "Pending (next mo)",  color: "#eab308", fill: "url(#pending-stripe)",roundTop: true  },
  { key: "predictedRemainder", label: "Projected",          color: "#94a3b8", fill: "url(#grad-predicted)",roundTop: true  },
] as const;


function fmtK(v: number) {
  if (v >= 1000) return "£" + (v / 1000).toFixed(0) + "k";
  return "£" + v.toFixed(0);
}

const fmtGbp = (n: number) => "£" + Math.round(n).toLocaleString("en-GB");

function fmtMonth(yyyyMM: string): string {
  const NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const parts = yyyyMM.split("-");
  return NAMES[parseInt(parts[1]) - 1] + " " + parts[0].slice(2);
}

function tooltipFmt(value: ValueType, name: NameType): [string, string] {
  const v = typeof value === "number" ? value : 0;
  const series = SERIES.find((s) => s.key === name);
  const label =
    name === "cumulative" ? "Cumulative" :
    name === "forecastLine" ? "Forecast" :
    name === "predictedRemainder" ? "Predicted remainder" :
    series?.label ?? String(name);
  return ["£" + v.toFixed(2), label];
}

// Series counted toward "how much of the predicted total is already realised".
// pendingNext is SPECULATIVE (renter paid but still in doc verification — can
// fall through). It feeds the chart's forward overlay bar but must NOT count
// toward Total / Avg / Best / Weakest, or it would inflate stats with
// not-yet-realised revenue. bookedNext stays — those are confirmed-and-paid
// future bookings (FUNDS_RESERVED+), real expected revenue.
const ACTUAL_KEYS = [
  "danielOrganic",
  "vertusOrganic",
  "dbcinemaOrganic",
  "leoOrganic",
  "aiBoost",
  "damageClaims",
  "bookedNext",
] as const;

export function LifetimeRevenue() {
  const { activeAccountSlug } = useAccount();
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [chartMode, setChartMode] = useState<"bars" | "lines">("bars");
  const raw = useQuery(api.revenue.getLifetimeByMonth, { accountSlug: activeAccountSlug });
  // Single source of truth for the current-month target: the Expected Monthly
  // stat card (data.monthly.target_gbp). The lifetime chart mirrors that value
  // so the two widgets cannot disagree.
  const stats = useQuery(api.dashboard.getStatsDrawerData, { accountSlug: activeAccountSlug });
  const expectedMonthlyTarget = (stats as { monthly?: { target_gbp?: number } } | undefined)
    ?.monthly?.target_gbp ?? 0;
  // ai_active_from: months earlier than this are PRE-AI; defensively zero out
  // their aiBoost contribution client-side regardless of what backend returns.
  const settingsQ = useQuery(api.settings.get);
  const aiActiveFrom: string =
    (settingsQ as { ai_active_from?: string } | undefined)?.ai_active_from ?? "2026-02";

  const toggle = (key: string) => setHidden((h) => ({ ...h, [key]: !h[key] }));

  // The current-month ghost bar uses the SAME target as Expected Monthly (single
  // source of truth) and is also gated on day-of-month >= 7. Future months keep
  // using the lifetime forecast so the chart still projects ahead.
  const todayDayOfMonth = new Date().getDate();
  const showCurrentMonthPrediction = todayDayOfMonth >= 7 && expectedMonthlyTarget > 0;
  const rawCurrentMonth = (raw as { currentMonth?: string } | undefined)?.currentMonth;

  const rawData = raw?.months.map((row) => {
    const fc = raw.forecast.find((f) => f.month === row.month);
    const r = row as unknown as Record<string, number | undefined>;
    // Pre-AI months: zero out aiBoost client-side so no green sliver renders
    // for months earlier than settings.ai_active_from. String compare on YYYY-MM
    // is sound since the format is fixed-width.
    if (row.month < aiActiveFrom) {
      r.aiBoost = 0;
    }
    const realised = ACTUAL_KEYS.reduce((sum, k) => sum + (r[k] ?? 0), 0);
    // For the CURRENT month, use the Expected Monthly target (dashboard.ts) so the
    // ghost bar and the target marker reference the same number. For other future
    // months, fall back to the lifetime forecast.
    let predictedRemainder = 0;
    if (row.month === rawCurrentMonth) {
      predictedRemainder = showCurrentMonthPrediction
        ? Math.max(0, expectedMonthlyTarget - realised)
        : 0;
    } else if (fc) {
      predictedRemainder = Math.max(0, fc.value - realised);
    }
    return {
      ...row,
      label: fmtMonth(row.month),
      forecastLine: fc ? fc.value : null,
      predictedRemainder,
    };
  }) ?? [];

  const seriesTotals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of SERIES) out[s.key] = 0;
    for (const row of raw?.months ?? []) {
      const r = row as unknown as Record<string, number | undefined>;
      for (const s of SERIES) {
        if (s.key === "predictedRemainder") continue;
        // For aiBoost, respect ai_active_from (pre-AI months contribute 0).
        if (s.key === "aiBoost" && row.month < aiActiveFrom) continue;
        out[s.key] += r[s.key] ?? 0;
      }
    }
    out.predictedRemainder = rawData.reduce((a, row) => a + (row.predictedRemainder ?? 0), 0);
    return out;
  }, [raw, rawData, aiActiveFrom]);

  // To get elegant fade animations on legend toggles, we ZERO OUT hidden
  // series instead of using Recharts' instant <Bar hide />. Bars then animate
  // smoothly between current value ↔ 0 over animationDuration.
  // Also recompute `cumulative` from visible ACTUAL_KEYS so the green growth
  // curve reacts to legend toggles (server-side row.cumulative is the full
  // lifetime running sum and doesn't know about client-side hidden state).
  const data = useMemo(() => {
    let running = 0;
    return rawData.map((row) => {
      const r = row as unknown as Record<string, number | undefined>;
      const out: Record<string, unknown> = { ...row };
      for (const s of SERIES) {
        if (hidden[s.key]) out[s.key] = 0;
      }
      let monthSum = 0;
      for (const k of ACTUAL_KEYS) {
        if (!hidden[k]) monthSum += r[k] ?? 0;
      }
      running += monthSum;
      out.cumulative = running;
      return out as typeof row;
    });
  }, [rawData, hidden]);

  // Stats bar reacts to legend toggles: filter ACTUAL_KEYS by visibility,
  // then recompute totals/avg/best/weakest/boost from the visible-only sums.
  const { totalRevenue, avgMonthly, strongest, weakest, boostPct, sumAiBoostGbp } = useMemo(() => {
    const visibleActualKeys = ACTUAL_KEYS.filter((k) => !hidden[k]);
    const months = raw?.months ?? [];
    const perMonth = months.map((row) => {
      const r = row as unknown as Record<string, number | undefined>;
      const sum = visibleActualKeys.reduce((acc, k) => acc + (r[k] ?? 0), 0);
      return { month: row.month, sum };
    });
    const total = perMonth.reduce((acc, m) => acc + m.sum, 0);

    // Trailing-window boundaries relative to today (auto-shifts each month).
    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const monthsBack = (n: number) => {
      const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    };
    const minBestWeakestMonth = monthsBack(12); // [current-12 .. current-1]
    const minAvgMonth = monthsBack(24); // [current-24 .. current-1]

    const completedMonths = perMonth.filter((m) => m.month < currentMonthKey);
    const last12 = completedMonths.filter((m) => m.month >= minBestWeakestMonth);
    const last24 = completedMonths.filter((m) => m.month >= minAvgMonth);

    // Avg/mo from last 24 completed months; denominator = months-with-data
    // (preserves existing behavior of skipping zero-revenue months).
    const last24WithData = last24.filter((m) => m.sum > 0);
    const last24Sum = last24.reduce((acc, m) => acc + m.sum, 0);
    const avg = last24WithData.length > 0 ? Math.round(last24Sum / last24WithData.length) : 0;

    // Best/Weakest from last 12 completed months, excluding zero-revenue months.
    const last12NonZero = last12.filter((m) => m.sum > 0);
    let best: { month: string; revenue: number } | undefined;
    let worst: { month: string; revenue: number } | undefined;
    for (const m of last12NonZero) {
      if (!best || m.sum > best.revenue) best = { month: m.month, revenue: m.sum };
      if (!worst || m.sum < worst.revenue) worst = { month: m.month, revenue: m.sum };
    }
    let boost = 0;
    let sumAiBoostGbp = 0;
    if (!hidden.aiBoost && total > 0) {
      sumAiBoostGbp = months.reduce((acc, row) => {
        if (row.month < aiActiveFrom) return acc;
        const r = row as unknown as Record<string, number | undefined>;
        return acc + (r.aiBoost ?? 0);
      }, 0);
      boost = Math.round((sumAiBoostGbp / total) * 100);
    }
    return {
      totalRevenue: total,
      avgMonthly: avg,
      strongest: best,
      weakest: worst,
      boostPct: boost,
      sumAiBoostGbp,
    };
  }, [raw, hidden, aiActiveFrom]);

  // hiddenDelta = (sum of ALL ACTUAL_KEYS across months) − (sum of VISIBLE
  // ACTUAL_KEYS, i.e. totalRevenue). Computed client-side from seriesTotals
  // so the baseline matches what the chart can actually show — server-side
  // raw.totalRevenue may include legacy series (e.g. pendingNext) that the
  // stats bar no longer counts, which would otherwise leave a permanent
  // positive delta even with nothing hidden.
  const lifetimeActualsTotal = ACTUAL_KEYS.reduce((a, k) => a + (seriesTotals[k] ?? 0), 0);
  const hiddenDelta = Math.max(0, lifetimeActualsTotal - totalRevenue);
  return (
    <>
      <Card className="relative overflow-hidden min-h-[460px]">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: "radial-gradient(ellipse at top left, rgba(34,197,94,0.08) 0%, transparent 60%)" }}
        />

        <CardHeader title="Lifetime Revenue" />

        {/* Stats bar */}
        {raw !== undefined && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3 text-xs text-[#8b8fa3]">
            <span>Total: <b style={{ color: "#22c55e" }}>{"£"}{totalRevenue.toLocaleString("en-GB", { maximumFractionDigits: 0 })}</b>
              {hiddenDelta > 0 && (
                <span className="ml-1 text-[#6b7280]">(−£{hiddenDelta.toLocaleString("en-GB", { maximumFractionDigits: 0 })})</span>
              )}
            </span>
            <span>Avg/mo: <b style={{ color: "#e4e6eb" }}>{"£"}{avgMonthly.toLocaleString("en-GB")}</b></span>
            {strongest && (
              <span>Best: <b style={{ color: "#22c55e" }}>{fmtMonth(strongest.month)} {"£"}{strongest.revenue.toLocaleString("en-GB", { maximumFractionDigits: 0 })}</b></span>
            )}
            {weakest && (
              <span>Weakest: <b style={{ color: "#f59e0b" }}>{fmtMonth(weakest.month)} {"£"}{weakest.revenue.toLocaleString("en-GB", { maximumFractionDigits: 0 })}</b></span>
            )}
            {boostPct > 0 && (() => {
              const aiBoostCur = (stats as { ai_boost?: { current_month?: {
                hard_gbp?: number; soft_credit_gbp?: number; hard_count?: number; soft_count?: number;
              } } } | undefined)?.ai_boost?.current_month;
              const hGbp = aiBoostCur?.hard_gbp ?? 0;
              const sGbp = aiBoostCur?.soft_credit_gbp ?? 0;
              const hN = aiBoostCur?.hard_count ?? 0;
              const sN = aiBoostCur?.soft_count ?? 0;
              const tooltip =
                `Hard AI £${Math.round(hGbp).toLocaleString("en-GB")} (n=${hN}), ` +
                `Soft AI £${Math.round(sGbp).toLocaleString("en-GB")} (n=${sN}, weighted 50%). ` +
                `Excludes assisted and baseline. Lifetime AI credit: £${Math.round(sumAiBoostGbp).toLocaleString("en-GB")}.`;
              return (
                <span title={tooltip} className="inline-flex items-center gap-1 cursor-help">
                  AI Boost: <b style={{ color: "#22c55e" }}>{boostPct}%</b>
                  <span style={{ color: "#22c55e" }}>(£{Math.round(sumAiBoostGbp).toLocaleString("en-GB")})</span>
                  <span
                    aria-label="AI Boost details"
                    className="inline-flex items-center justify-center text-[8px] w-[12px] h-[12px] rounded-full border border-[#22c55e80] text-[#22c55e]"
                  >i</span>
                </span>
              );
            })()}
          </div>
        )}

        {/* Chart mode toggle */}
        <div className="flex gap-1 mb-2">
          <button
            onClick={() => setChartMode("bars")}
            className="text-[11px] px-2.5 py-0.5 rounded-full transition-all hover:opacity-90"
            style={{
              border: "1px solid " + (chartMode === "bars" ? "#22c55e80" : "#3a3f4b"),
              color: chartMode === "bars" ? "#22c55e" : "#6b7280",
              background: chartMode === "bars" ? "rgba(34,197,94,0.08)" : "rgba(255,255,255,0.02)",
              opacity: chartMode === "bars" ? 1 : 0.5,
            }}
          >Bars</button>
          <button
            onClick={() => setChartMode("lines")}
            className="text-[11px] px-2.5 py-0.5 rounded-full transition-all hover:opacity-90"
            style={{
              border: "1px solid " + (chartMode === "lines" ? "#22c55e80" : "#3a3f4b"),
              color: chartMode === "lines" ? "#22c55e" : "#6b7280",
              background: chartMode === "lines" ? "rgba(34,197,94,0.08)" : "rgba(255,255,255,0.02)",
              opacity: chartMode === "lines" ? 1 : 0.5,
            }}
          >Lines</button>
        </div>

        {/* Toggleable legend — two-line pills (label on top, £ amount below).
            Daniel's explicit design. To prevent the taller header from pushing
            the chart out of the Card's overflow-hidden boundary, the outer
            Card has min-h-[460px] and the chart was reduced from h=300 → 280.
            Pill row is capped at max-h-[80px] with overflow-y-auto so 3+ rows
            of wrapping scroll internally instead of pushing the chart down. */}
        <div className="flex flex-wrap gap-1 mb-3 max-h-[80px] overflow-y-auto">
          {SERIES.map((s) => {
            const isHidden = hidden[s.key] ?? false;
            const amount = fmtGbp(seriesTotals[s.key] ?? 0);
            return (
              <button
                key={s.key}
                onClick={() => toggle(s.key)}
                title={`${s.label} · ${amount}`}
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full transition-all hover:opacity-90"
                style={{
                  border: "1px solid " + (isHidden ? "#3a3f4b" : s.color + "80"),
                  color: isHidden ? "#6b7280" : s.color,
                  background: isHidden ? "rgba(255,255,255,0.02)" : s.color + "14",
                  opacity: isHidden ? 0.5 : 1,
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 6,
                    borderRadius: 9999,
                    background: isHidden ? "#6b7280" : s.color,
                  }}
                />
                <span className="flex flex-col items-start leading-tight">
                  <span>{s.label}</span>
                  <span className="text-[9px] opacity-70 tabular-nums">{amount}</span>
                </span>
              </button>
            );
          })}
          {/* Cumulative toggle */}
          <button
            onClick={() => toggle("cumulative")}
            title={`Cumulative · ${fmtGbp(totalRevenue)}`}
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full transition-all hover:opacity-90"
            style={{
              border: "1px solid " + (hidden.cumulative ? "#3a3f4b" : "#22c55e80"),
              color: hidden.cumulative ? "#6b7280" : "#22c55e",
              background: hidden.cumulative ? "rgba(255,255,255,0.02)" : "rgba(34,197,94,0.08)",
              opacity: hidden.cumulative ? 0.5 : 1,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 6,
                height: 6,
                borderRadius: 9999,
                background: hidden.cumulative ? "#6b7280" : "#22c55e",
              }}
            />
            <span className="flex flex-col items-start leading-tight">
              <span>Cumulative</span>
              <span className="text-[9px] opacity-70 tabular-nums">{fmtGbp(totalRevenue)}</span>
            </span>
          </button>
          {/* Target toggle — gates the current-month projected-total marker */}
          {expectedMonthlyTarget > 0 && (
            <button
              onClick={() => toggle("target")}
              title={`Target · ${fmtGbp(expectedMonthlyTarget)}`}
              className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full transition-all hover:opacity-90"
              style={{
                border: "1px solid " + (hidden.target ? "#3a3f4b" : "#eab30880"),
                color: hidden.target ? "#6b7280" : "#eab308",
                background: hidden.target ? "rgba(255,255,255,0.02)" : "rgba(234,179,8,0.08)",
                opacity: hidden.target ? 0.5 : 1,
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: 9999,
                  background: hidden.target ? "#6b7280" : "#eab308",
                }}
              />
              <span className="flex flex-col items-start leading-tight">
                <span>Target</span>
                <span className="text-[9px] opacity-70 tabular-nums">{fmtGbp(expectedMonthlyTarget)}</span>
              </span>
            </button>
          )}
        </div>

        {/* Chart */}
        {raw === undefined ? (
          <SkeletonBlock className="h-[280px] w-full" />
        ) : data.length === 0 ? (
          <div className="flex items-center justify-center h-[280px] text-sm text-[#8b8fa3]">
            No revenue data
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={data} margin={{ top: 24, right: 16, left: 0, bottom: 0 }}>
              <defs>
                {/* Per-series vertical gradients — lighter at top of bar, darker at base.
                    Gives bars a depth/sheen instead of flat rgba. */}
                <linearGradient id="grad-daniel" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#fb923c" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#c2410c" stopOpacity={0.85} />
                </linearGradient>
                <linearGradient id="grad-vertus" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#b07a4a" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#5c3a1c" stopOpacity={0.85} />
                </linearGradient>
                <linearGradient id="grad-dbcinema" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#818cf8" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#4338ca" stopOpacity={0.85} />
                </linearGradient>
                <linearGradient id="grad-leo" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#c084fc" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#7e22ce" stopOpacity={0.85} />
                </linearGradient>
                <linearGradient id="grad-ai" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#4ade80" stopOpacity={0.9} />
                  <stop offset="100%" stopColor="#15803d" stopOpacity={0.8} />
                </linearGradient>
                <linearGradient id="grad-damage" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity={0.85} />
                  <stop offset="100%" stopColor="#cbd5e1" stopOpacity={0.65} />
                </linearGradient>
                <linearGradient id="grad-booked" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#cbd5e1" stopOpacity={0.7} />
                  <stop offset="100%" stopColor="#64748b" stopOpacity={0.55} />
                </linearGradient>
                {/* Ghost "predicted" bar — very low opacity slate, dashed border drawn on the Bar itself. */}
                <linearGradient id="grad-predicted" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#94a3b8" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="#475569" stopOpacity={0.12} />
                </linearGradient>
                {/* Pending = V1's caution-tape pattern: translucent yellow tile + white diagonal stripes. */}
                <pattern
                  id="pending-stripe"
                  patternUnits="userSpaceOnUse"
                  width="14"
                  height="14"
                  patternTransform="rotate(-45)"
                >
                  <rect width="14" height="14" fill="rgba(234,179,8,0.6)" />
                  <line x1="0" y1="0" x2="0" y2="14" stroke="rgba(255,255,255,0.55)" strokeWidth={3} />
                </pattern>
                {/* Per-series line-mode gradients — use exact series color faded to transparent. */}
                {SERIES.map((s) => (
                  <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.55} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                  </linearGradient>
                ))}
                {/* Cumulative area gradient — green fading to transparent below the line. */}
                <linearGradient id="cumulative-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.42} />
                  <stop offset="60%" stopColor="#22c55e" stopOpacity={0.12} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" strokeDasharray="0" />
              <XAxis
                dataKey="label"
                tick={{ fill: "#8b8fa3", fontSize: 9 }}
                axisLine={false}
                tickLine={false}
                interval={Math.floor(data.length / 8)}
              />
              {/* Left axis: cumulative (green) */}
              <YAxis
                yAxisId="left"
                orientation="left"
                tickFormatter={fmtK}
                tick={{ fill: "#22c55e", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={48}
              />
              {/* Right axis: monthly (blue) */}
              <YAxis
                yAxisId="right"
                orientation="right"
                tickFormatter={fmtK}
                tick={{ fill: "#6ea8fe", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={40}
              />
              <Tooltip
                cursor={{ fill: "rgba(255,255,255,0.04)" }}
                content={(props: TooltipContentProps<ValueType, NameType>) => {
                  const { active, payload, label } = props;
                  if (!active || !payload || payload.length === 0) return null;
                  // Filter zero/null entries; sort biggest first; collapse the predicted &
                  // cumulative-area duplicates the same series renders to keep tooltip tight.
                  const seen = new Set<string>();
                  const numValue = (p: { value?: ValueType }): number => {
                    const x = p.value;
                    if (typeof x === "number") return x;
                    if (typeof x === "string") return parseFloat(x) || 0;
                    return 0;
                  };
                  const rows = payload
                    .filter((p) => {
                      const v = numValue(p);
                      // Drop exact zeros AND tiny floats that would render as "£0".
                      if (Math.round(v) === 0) return false;
                      const k = String(p.name ?? "");
                      // Skip the cumulative-area duplicate row entirely.
                      if (k === "cumulative-area") return false;
                      if (seen.has(k)) return false;
                      seen.add(k);
                      return true;
                    })
                    .sort((a, b) => numValue(b) - numValue(a));
                  if (rows.length === 0) return null;
                  return (
                    <div
                      style={{
                        background: "rgba(14,17,28,0.95)",
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: 8,
                        fontSize: 12,
                        padding: "8px 10px",
                        minWidth: 180,
                        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                      }}
                    >
                      <div style={{ color: "#e4e6eb", marginBottom: 6, fontWeight: 600 }}>{label}</div>
                      {rows.map((p, i) => {
                        const series = SERIES.find((s) => s.key === p.name);
                        const niceLabel =
                          p.name === "cumulative" ? "Cumulative" :
                          p.name === "cumulative-area" ? null :
                          p.name === "forecastLine" ? "Forecast" :
                          p.name === "predictedRemainder" ? "Predicted remainder" :
                          series?.label ?? String(p.name);
                        if (niceLabel === null) return null;
                        const dotColor = series?.color ?? (p.name === "cumulative" ? "#22c55e" : "#94a3b8");
                        const v = numValue(p);
                        return (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, lineHeight: "18px" }}>
                            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: dotColor }} />
                            <span style={{ color: "#94a3b8", flex: 1 }}>{niceLabel}</span>
                            <span style={{ color: "#e4e6eb", fontVariantNumeric: "tabular-nums" }}>£{v.toLocaleString("en-GB", { maximumFractionDigits: 0 })}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                }}
              />
              {/* Stacked bars — bottom to top per SERIES order. Only segments that can
                  cap the stack (aiBoost / damage / booked / pending / predictedRemainder)
                  get a rounded top, matching V1's borderRadius:3 selection.
                  Animated toggle: legend click → Recharts fades opacity over 350ms. */}
              {chartMode === "bars" && SERIES.map((s) => {
                const isPredicted = s.key === "predictedRemainder";
                return (
                  <Bar
                    key={s.key}
                    yAxisId="right"
                    dataKey={s.key}
                    name={s.key}
                    stackId="monthly"
                    fill={s.fill}
                    stroke={isPredicted ? s.color : "none"}
                    strokeWidth={isPredicted ? 1 : 0}
                    strokeDasharray={isPredicted ? "4 3" : undefined}
                    radius={s.roundTop ? [4, 4, 0, 0] : 0}
                    maxBarSize={28}
                    isAnimationActive
                    animationDuration={650}
                    animationEasing="ease-in-out"
                  />
                );
              })}
              {chartMode === "lines" && SERIES.filter((s) => s.key !== "predictedRemainder").map((s) => (
                <Area
                  key={s.key}
                  yAxisId="right"
                  type="monotone"
                  dataKey={s.key}
                  name={s.key}
                  stroke={s.color}
                  strokeWidth={2}
                  fill={`url(#grad-${s.key})`}
                  fillOpacity={1}
                  isAnimationActive
                  animationDuration={900}
                  animationEasing="ease-out"
                  activeDot={{ r: 4, stroke: s.color, fill: "#0f1115", strokeWidth: 2 }}
                  hide={hidden[s.key] ?? false}
                />
              ))}
              {/* Line-mode forecast continuation: dashed slate area showing the
                  projected remainder for the current + future months. Mirrors
                  the bar-mode predictedRemainder so the line view also shows
                  forward-looking expectations. Gated on hidden.predictedRemainder
                  so the "Projected" toggle controls both modes uniformly. */}
              {chartMode === "lines" && !hidden.predictedRemainder && (
                <Area
                  yAxisId="right"
                  type="monotone"
                  dataKey="predictedRemainder"
                  name="predictedRemainder"
                  stroke="#94a3b8"
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  fill="url(#grad-predictedRemainder)"
                  fillOpacity={0.6}
                  isAnimationActive
                  animationDuration={900}
                  animationEasing="ease-out"
                  activeDot={{ r: 4, stroke: "#94a3b8", fill: "#0f1115", strokeWidth: 2 }}
                />
              )}
              {/* Vertical boundary marking where actuals end and projections begin.
                  Only renders in line mode. Gated on hidden.predictedRemainder
                  so the "Projected" legend pill hides this too. */}
              {chartMode === "lines" && rawCurrentMonth && !hidden.predictedRemainder && (
                <ReferenceLine
                  yAxisId="right"
                  x={fmtMonth(rawCurrentMonth)}
                  stroke="#94a3b8"
                  strokeDasharray="4 4"
                  strokeOpacity={0.5}
                  label={{
                    value: "Projected →",
                    position: "top",
                    fill: "#94a3b8",
                    fontSize: 10,
                    opacity: 0.7,
                  }}
                />
              )}
              {/* Cumulative area: gradient falloff. Animation starts AFTER the line
                  finishes drawing (animationBegin) so the gradient doesn't bloom
                  ahead of the line stroke. */}
              <Area
                yAxisId="left"
                dataKey="cumulative"
                name="cumulative-area"
                type="monotone"
                stroke="none"
                fill="url(#cumulative-area)"
                isAnimationActive
                animationBegin={1100}
                animationDuration={500}
                animationEasing="ease-out"
                hide={hidden.cumulative ?? false}
                legendType="none"
              />
              {/* Cumulative — solid green line, left axis. Pulse dot only on the
                  final data point to draw the eye to the latest cumulative value. */}
              <Line
                yAxisId="left"
                dataKey="cumulative"
                name="cumulative"
                type="monotone"
                stroke="#22c55e"
                strokeWidth={2.5}
                dot={(props: { cx?: number; cy?: number; index?: number; payload?: { cumulative?: number | null } }) => {
                  const { cx, cy, index, payload } = props;
                  const isLast = index === data.length - 1;
                  if (!isLast || cx == null || cy == null || payload?.cumulative == null) {
                    return <g key={index} />;
                  }
                  // Gentle pulse: small amplitude, slow cadence — "alive" not flashy.
                  return (
                    <g key={index}>
                      <circle cx={cx} cy={cy} r={4} fill="#22c55e" opacity={0.4}>
                        <animate attributeName="r"       values="4;8;4"     dur="2.6s" repeatCount="indefinite" />
                        <animate attributeName="opacity" values="0.4;0;0.4" dur="2.6s" repeatCount="indefinite" />
                      </circle>
                      <circle cx={cx} cy={cy} r={3} fill="#22c55e" stroke="#0b0e18" strokeWidth={1.5} />
                    </g>
                  );
                }}
                activeDot={{ r: 5, fill: "#22c55e" }}
                isAnimationActive
                animationDuration={1200}
                animationEasing="ease-out"
                hide={hidden.cumulative ?? false}
              />
              {/* Current-month expected ceiling: small dashed T-marker drawn at the
                  projected total. Lets you see at-a-glance whether realised + booked
                  + pending has already reached target. */}
              {raw && expectedMonthlyTarget > 0 && !hidden.target && (() => {
                // Target marker only appears once the current month is ≥7 days in
                // — before that there isn't enough month-to-date data to make the
                // projection meaningful, and the marker would be misleading.
                const dayOfMonth = new Date().getDate();
                if (dayOfMonth < 7) return null;
                const rawWithMonth = raw as typeof raw & { currentMonth?: string };
                const target = expectedMonthlyTarget;
                const currentLabel = data.find((d) => d.month === rawWithMonth.currentMonth)?.label;
                if (!currentLabel || target <= 0) return null;
                return (
                  <ReferenceDot
                    yAxisId="right"
                    x={currentLabel}
                    y={target}
                    ifOverflow="extendDomain"
                    shape={(props: { cx?: number; cy?: number }) => {
                      const { cx, cy } = props;
                      if (cx == null || cy == null) return <g />;
                      // Match bar width (maxBarSize 28 → ±16). Bright yellow line + glow + label.
                      const w = 18;
                      const fmtTarget = target >= 1000 ? "£" + (target / 1000).toFixed(1) + "k" : "£" + Math.round(target);
                      return (
                        <g>
                          <line
                            x1={cx - w} x2={cx + w} y1={cy} y2={cy}
                            stroke="#facc15" strokeWidth={2.5} strokeDasharray="5 3"
                            style={{ filter: "drop-shadow(0 0 4px rgba(250,204,21,0.55))" }}
                          />
                          <line x1={cx - w} x2={cx - w} y1={cy - 3} y2={cy + 3} stroke="#facc15" strokeWidth={2} />
                          <line x1={cx + w} x2={cx + w} y1={cy - 3} y2={cy + 3} stroke="#facc15" strokeWidth={2} />
                          <text
                            x={cx + w + 5} y={cy + 3}
                            fill="#facc15" fontSize={9.5} fontWeight={700}
                            style={{ filter: "drop-shadow(0 0 3px rgba(0,0,0,0.6))" }}
                          >
                            target {fmtTarget}
                          </text>
                        </g>
                      );
                    }}
                  />
                );
              })()}
            </ComposedChart>
          </ResponsiveContainer>
        )}

      </Card>
    </>
  );
}
