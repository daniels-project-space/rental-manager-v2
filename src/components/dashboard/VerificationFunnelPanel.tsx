"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

type Stalled = {
  reservation_id: string;
  hygglo_order_id: string | null;
  account_slug: string;
  renter_name: string | null;
  start_date: string | null;
  end_date: string | null;
  gross_paid_gbp: number | null;
  net_to_owner_gbp: number | null;
  current_step: string;
  step_label: string;
  first_seen_at: number;
  age_hours: number;
  photos_urls: string[];
};

type Funnel = {
  now: number;
  threshold_hours: number;
  stalled: Stalled[];
  stalled_total: number;
  stalled_potential_revenue_gbp: number;
  distribution: Record<string, number>;
  timing: {
    sample_size: number;
    median_hours_to_confirm: number;
    p25_hours: number;
    p75_hours: number;
    p90_hours: number;
  };
};

function fmtGbp(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return "£" + Math.round(n);
}
function fmtAge(h: number): string {
  if (h < 24) return Math.round(h * 10) / 10 + "h";
  return Math.round(h / 24) + "d";
}

const STEP_COLOR: Record<string, string> = {
  REQUEST: "#f59e0b",
  APPROVED: "#f59e0b",
  FUNDS_RESERVED: "#f59e0b",
  VERIFIED: "#ec4899",
  BOOKED_AFTER_VERIFIED: "#6ea8fe",
  DELIVERED: "#6ea8fe",
  RETURNED: "#22c55e",
  REVIEWED: "#22c55e",
};

const FUNNEL_ORDER = [
  "REQUEST", "APPROVED", "FUNDS_RESERVED", "VERIFIED",
  "BOOKED_AFTER_VERIFIED", "DELIVERED", "RETURNED", "REVIEWED",
];

export function VerificationFunnelPanel() {
  const [threshold, setThreshold] = useState<number>(12);
  const raw = useQuery(api.intel.getVerificationFunnel, {
    ageThresholdHours: threshold,
    limit: 25,
  });
  const data: Funnel | undefined = raw as Funnel | undefined;

  const thresholdOpts = [
    { label: "6h", val: 6 },
    { label: "12h", val: 12 },
    { label: "24h", val: 24 },
    { label: "48h", val: 48 },
  ];

  return (
    <Card>
      <CardHeader
        title="Verification Funnel"
        actions={
          <div className="flex gap-1 items-center">
            <span className="text-[10px] text-slate-500 mr-1">stalled &gt;</span>
            {thresholdOpts.map((d) => (
              <button
                key={d.val}
                onClick={() => setThreshold(d.val)}
                className="px-2 py-0.5 text-xs rounded transition-colors"
                style={{
                  background: threshold === d.val ? "rgba(245,158,11,0.18)" : "transparent",
                  color: threshold === d.val ? "#fbbf24" : "#8b8fa3",
                  border: threshold === d.val ? "1px solid rgba(245,158,11,0.4)" : "1px solid transparent",
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
          {[1, 2, 3, 4].map((i) => <SkeletonBlock key={i} className="h-10 w-full" />)}
        </div>
      ) : (
        <>
          {/* Stage distribution mini-funnel */}
          <div className="mb-3">
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Current pipeline</div>
            <div className="flex items-end gap-1 h-12">
              {FUNNEL_ORDER.map((step) => {
                const count = data.distribution[step] ?? 0;
                const max = Math.max(...Object.values(data.distribution), 1);
                const h = (count / max) * 100;
                const color = STEP_COLOR[step] ?? "#6b6f80";
                return (
                  <div key={step} className="flex-1 flex flex-col items-center justify-end" title={`${step}: ${count}`}>
                    <div className="text-[10px] text-slate-300 font-semibold mb-0.5">{count}</div>
                    <div
                      style={{
                        width: "100%",
                        height: `${Math.max(2, h)}%`,
                        background: color,
                        opacity: count === 0 ? 0.2 : 1,
                        borderRadius: 3,
                      }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex gap-1 mt-1">
              {FUNNEL_ORDER.map((step) => (
                <div key={step} className="flex-1 text-[8px] text-slate-500 truncate text-center" title={step}>
                  {step.replace("BOOKED_AFTER_VERIFIED", "BOOKED").replace("FUNDS_RESERVED", "FUNDS")}
                </div>
              ))}
            </div>
          </div>

          {/* Timing stats */}
          {data.timing.sample_size > 0 && (
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div className="rounded px-2 py-1.5 text-center" style={{ background: "rgba(110,168,254,0.10)", border: "1px solid rgba(110,168,254,0.25)" }}>
                <div className="text-[9px] uppercase tracking-wider text-slate-400">Median</div>
                <div className="text-sm font-bold text-sky-300">{fmtAge(data.timing.median_hours_to_confirm)}</div>
              </div>
              <div className="rounded px-2 py-1.5 text-center" style={{ background: "rgba(110,168,254,0.10)", border: "1px solid rgba(110,168,254,0.25)" }}>
                <div className="text-[9px] uppercase tracking-wider text-slate-400">P75</div>
                <div className="text-sm font-bold text-sky-300">{fmtAge(data.timing.p75_hours)}</div>
              </div>
              <div className="rounded px-2 py-1.5 text-center" style={{ background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.25)" }}>
                <div className="text-[9px] uppercase tracking-wider text-slate-400">P90</div>
                <div className="text-sm font-bold text-amber-300">{fmtAge(data.timing.p90_hours)}</div>
              </div>
            </div>
          )}

          {/* Stalled list */}
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">
            Stalled {data.threshold_hours}h+
            <span className="text-rose-300 ml-2 font-semibold normal-case tracking-normal">
              {data.stalled_total} · {fmtGbp(data.stalled_potential_revenue_gbp)} at stake
            </span>
          </div>
          {data.stalled.length === 0 ? (
            <EmptyState message="No stalled orders — pipeline flowing freely" />
          ) : (
            <div className="space-y-1">
              {data.stalled.map((r) => {
                const color = STEP_COLOR[r.current_step] ?? "#6b6f80";
                return (
                  <div
                    key={r.reservation_id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded"
                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderLeft: `3px solid ${color}` }}
                  >
                    {r.photos_urls[0] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={r.photos_urls[0]}
                        alt=""
                        className="rounded object-cover flex-shrink-0"
                        style={{ width: 32, height: 32 }}
                      />
                    ) : (
                      <div className="rounded flex-shrink-0" style={{ width: 32, height: 32, background: "rgba(255,255,255,0.04)" }} />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-slate-100 truncate">
                        {r.renter_name ?? "?"} <span className="text-slate-500">·</span> <span className="text-[11px] text-slate-400">{r.account_slug}</span>
                      </div>
                      <div className="text-[10px]" style={{ color }}>{r.step_label}</div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-xs font-bold text-amber-300">{fmtAge(r.age_hours)}</div>
                      <div className="text-[10px] text-emerald-300">{fmtGbp(r.net_to_owner_gbp)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
