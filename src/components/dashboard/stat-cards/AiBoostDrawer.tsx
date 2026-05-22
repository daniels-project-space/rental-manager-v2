"use client";

import { useState } from "react";

interface BreakdownItem {
  source?: string;
  label?: string;
  amount?: number;
  gbp?: number;
  count?: number;
  weight?: number;
}

interface CurrentMonth {
  hard_gbp?: number;
  soft_gbp?: number;
  soft_credit_gbp?: number;
  assisted_gbp?: number;
  baseline_gbp?: number;
  hard_count?: number;
  soft_count?: number;
  assisted_count?: number;
  baseline_count?: number;
  total_credit_gbp?: number;
}

interface Props {
  data: {
    current_month?: CurrentMonth;
    prior_3mo_median_gbp?: number;
    delta_vs_p3m_gbp?: number;
    delta_vs_p3m_pct?: number;
    confidence?: "low" | "med" | "high";
    sample_count?: number;
    drilldown_reservation_ids?: string[];
    // back-compat
    total_uplift_gbp?: number;
    breakdown?: BreakdownItem[];
  };
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;

const CONF_COLOR: Record<string, string> = {
  low: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  med: "bg-blue-500/20 text-blue-300 border-blue-500/40",
  high: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
};

export default function AiBoostDrawer({ data }: Props) {
  const [showDrilldown, setShowDrilldown] = useState(false);

  const cm: CurrentMonth = data?.current_month ?? {};
  const hardGbp = cm.hard_gbp ?? 0;
  const softCreditGbp = cm.soft_credit_gbp ?? 0;
  const softGbp = cm.soft_gbp ?? 0;
  const assistedGbp = cm.assisted_gbp ?? 0;
  const baselineGbp = cm.baseline_gbp ?? 0;
  const hardCount = cm.hard_count ?? 0;
  const softCount = cm.soft_count ?? 0;
  const assistedCount = cm.assisted_count ?? 0;
  const totalCredit = cm.total_credit_gbp ?? (hardGbp + softCreditGbp);

  const sampleCount = data?.sample_count ?? 0;
  const confidence = data?.confidence ?? "low";
  const priorMedian = data?.prior_3mo_median_gbp ?? 0;
  const drilldownIds = data?.drilldown_reservation_ids ?? [];

  if (sampleCount === 0 && totalCredit === 0) {
    return (
      <div className="text-xs text-slate-500 italic py-4 text-center">
        No AI decisions yet this month.
      </div>
    );
  }

  // Bar scale: include prior median as a marker
  const maxBar = Math.max(hardGbp, softCreditGbp, assistedGbp, priorMedian, 1);

  const tiers: Array<{ label: string; gbp: number; count: number; weight: string; color: string }> = [
    { label: "Hard AI", gbp: hardGbp, count: hardCount, weight: "100%", color: "bg-emerald-500" },
    { label: "Soft AI", gbp: softCreditGbp, count: softCount, weight: "50%", color: "bg-violet-500" },
    { label: "Assisted", gbp: assistedGbp, count: assistedCount, weight: "—", color: "bg-slate-500" },
  ];

  return (
    <div className="text-sm text-slate-300 space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold text-emerald-400">{gbp(totalCredit)}</span>
        <span className="text-xs text-slate-500">AI credit this month</span>
        <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded-full border ${CONF_COLOR[confidence] ?? CONF_COLOR.low}`}>
          {confidence}
        </span>
      </div>

      <div className="space-y-2">
        {tiers.map((t) => {
          const pct = Math.round((t.gbp / maxBar) * 100);
          const medianPct = Math.round((priorMedian / maxBar) * 100);
          return (
            <div key={t.label}>
              <div className="flex justify-between text-xs mb-0.5">
                <span className="text-slate-300">
                  {t.label} <span className="text-slate-500">· n={t.count}</span>
                  <span className="ml-1 text-[9px] uppercase tracking-wide text-slate-500 border border-slate-700 px-1 rounded">{t.weight}</span>
                </span>
                <span className="text-emerald-400">{gbp(t.gbp)}</span>
              </div>
              <div className="relative h-1.5 bg-slate-700 rounded-full overflow-hidden">
                <div className={`h-full ${t.color} rounded-full`} style={{ width: `${pct}%` }} />
                {/* prior 3mo median marker */}
                {priorMedian > 0 && (
                  <div
                    className="absolute top-[-2px] bottom-[-2px] w-[2px] bg-slate-300/60"
                    style={{ left: `${medianPct}%` }}
                    title={`3mo median ${gbp(priorMedian)}`}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="text-[11px] text-slate-500 leading-snug">
        Confidence: {confidence} (based on N={sampleCount} decisions).
        {priorMedian > 0 && <> Prior 3mo median: {gbp(priorMedian)}.</>}
        {softGbp > 0 && <> Soft raw: {gbp(softGbp)} (weighted 50%).</>}
        {baselineGbp > 0 && <> Baseline: {gbp(baselineGbp)} (excluded).</>}
      </div>

      {drilldownIds.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowDrilldown((v) => !v)}
            className="text-[11px] text-slate-400 hover:text-slate-200 underline decoration-dotted"
          >
            {showDrilldown ? "Hide" : "Show"} reservations ({drilldownIds.length})
          </button>
          {showDrilldown && (
            <div className="mt-2 flex flex-wrap gap-1">
              {drilldownIds.map((id) => (
                <span
                  key={id}
                  className="text-[10px] font-mono text-slate-400 bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded"
                >
                  {id}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
