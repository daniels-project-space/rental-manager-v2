"use client";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";
import { ClaimsRecordingModal } from "@/components/modals/ClaimsRecordingModal";
import { EditClaimModal } from "@/components/modals/EditClaimModal";
import type { ClaimRow } from "@/components/modals/EditClaimModal";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import type {
  ValueType,
  NameType,
} from "recharts/types/component/DefaultTooltipContent";

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
  { key: "predictedRemainder", label: "Predicted",          color: "#94a3b8", fill: "url(#grad-predicted)",roundTop: true  },
] as const;


function fmtK(v: number) {
  if (v >= 1000) return "£" + (v / 1000).toFixed(0) + "k";
  return "£" + v.toFixed(0);
}

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
const ACTUAL_KEYS = [
  "danielOrganic",
  "vertusOrganic",
  "dbcinemaOrganic",
  "leoOrganic",
  "aiBoost",
  "damageClaims",
  "bookedNext",
  "pendingNext",
] as const;

const STATUS_COLOR: Record<string, string> = {
  open: "#f59e0b",
  settled: "#22c55e",
  denied: "#ef4444",
};

export function LifetimeRevenue() {
  const { activeAccountSlug } = useAccount();
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [showClaimsModal, setShowClaimsModal] = useState(false);
  const [claimsOpen, setClaimsOpen] = useState(false);
  const [editingClaim, setEditingClaim] = useState<ClaimRow | null>(null);
  const deleteClaim = useMutation(api.insurance_claims.remove);

  const raw = useQuery(api.revenue.getLifetimeByMonth, { accountSlug: activeAccountSlug });
  const recentClaims = useQuery(api.insurance_claims.list, { accountSlug: activeAccountSlug ?? undefined });

  const toggle = (key: string) => setHidden((h) => ({ ...h, [key]: !h[key] }));

  const data = raw?.months.map((row) => {
    const fc = raw.forecast.find((f) => f.month === row.month);
    const r = row as unknown as Record<string, number | undefined>;
    const realised = ACTUAL_KEYS.reduce((sum, k) => sum + (r[k] ?? 0), 0);
    // Ghost "target" bar: gap between the projected total and what's already on the
    // chart. Only meaningful for current + future months that have a forecast.
    const predictedRemainder = fc ? Math.max(0, fc.value - realised) : 0;
    return {
      ...row,
      label: fmtMonth(row.month),
      forecastLine: fc ? fc.value : null,
      predictedRemainder,
    };
  }) ?? [];

  const totalRevenue = raw?.totalRevenue ?? 0;
  const avgMonthly = raw?.avgMonthly ?? 0;
  const strongest = raw?.strongestMonth;
  const weakest = raw?.weakestMonth;
  const boostPct = Math.round((raw?.boostRate ?? 0) * 100);
  const topClaims = (recentClaims ?? []).slice(0, 10);

  async function handleDeleteClaim(id: Id<"insurance_claims">) {
    if (!window.confirm("Delete this claim? This cannot be undone.")) return;
    await deleteClaim({ id });
  }

  return (
    <>
      <Card className="relative overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: "radial-gradient(ellipse at top left, rgba(34,197,94,0.08) 0%, transparent 60%)" }}
        />

        <CardHeader
          title="Lifetime Revenue"
          actions={
            <button
              onClick={() => setShowClaimsModal(true)}
              style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, background: "rgba(255,255,255,0.08)", color: "#e4e6eb", border: "1px solid rgba(255,255,255,0.15)" }}
            >
              + Claim
            </button>
          }
        />

        {/* Stats bar */}
        {raw !== undefined && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3 text-xs text-[#8b8fa3]">
            <span>Total: <b style={{ color: "#22c55e" }}>{"£"}{totalRevenue.toLocaleString("en-GB", { maximumFractionDigits: 0 })}</b></span>
            <span>Avg/mo: <b style={{ color: "#e4e6eb" }}>{"£"}{avgMonthly.toLocaleString("en-GB")}</b></span>
            {strongest && (
              <span>Best: <b style={{ color: "#22c55e" }}>{fmtMonth(strongest.month)} {"£"}{strongest.revenue.toLocaleString("en-GB", { maximumFractionDigits: 0 })}</b></span>
            )}
            {weakest && (
              <span>Weakest: <b style={{ color: "#f59e0b" }}>{fmtMonth(weakest.month)} {"£"}{weakest.revenue.toLocaleString("en-GB", { maximumFractionDigits: 0 })}</b></span>
            )}
            {boostPct > 0 && <span>AI Boost: <b style={{ color: "#22c55e" }}>{boostPct}%</b></span>}
          </div>
        )}

        {/* Toggleable legend */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {SERIES.map((s) => {
            const isHidden = hidden[s.key] ?? false;
            return (
              <button
                key={s.key}
                onClick={() => toggle(s.key)}
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full transition-all"
                style={{
                  border: "1px solid " + s.color,
                  color: isHidden ? "#6b7280" : s.color,
                  background: isHidden ? "rgba(255,255,255,0.03)" : s.fill,
                  opacity: isHidden ? 0.45 : 1,
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: isHidden ? "#6b7280" : s.color,
                  }}
                />
                {s.label}
              </button>
            );
          })}
          {/* Cumulative toggle */}
          <button
            onClick={() => toggle("cumulative")}
            className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full transition-all"
            style={{
              border: "1px solid #22c55e",
              color: hidden.cumulative ? "#6b7280" : "#22c55e",
              background: hidden.cumulative ? "rgba(255,255,255,0.03)" : "rgba(34,197,94,0.12)",
              opacity: hidden.cumulative ? 0.45 : 1,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 3,
                background: hidden.cumulative ? "#6b7280" : "#22c55e",
              }}
            />
            Cumulative
          </button>
        </div>

        {/* Chart */}
        {raw === undefined ? (
          <SkeletonBlock className="h-[300px] w-full" />
        ) : data.length === 0 ? (
          <div className="flex items-center justify-center h-[300px] text-sm text-[#8b8fa3]">
            No revenue data
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
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
                contentStyle={{ background: "rgba(14,17,28,0.95)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, fontSize: 12 }}
                labelStyle={{ color: "#e4e6eb" }}
                formatter={tooltipFmt as never}
              />
              {/* Stacked bars — bottom to top per SERIES order. Only segments that can
                  cap the stack (aiBoost / damage / booked / pending / predictedRemainder)
                  get a rounded top, matching V1's borderRadius:3 selection. */}
              {SERIES.map((s) => {
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
                    isAnimationActive={false}
                    hide={hidden[s.key] ?? false}
                  />
                );
              })}
              {/* Cumulative — solid green line, left axis. */}
              <Line
                yAxisId="left"
                dataKey="cumulative"
                name="cumulative"
                type="monotone"
                stroke="#22c55e"
                strokeWidth={3}
                dot={false}
                activeDot={{ r: 5, fill: "#22c55e" }}
                hide={hidden.cumulative ?? false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}

        {/* Recent Claims */}
        <div className="mt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
          <button
            className="flex items-center gap-1.5 text-xs font-medium w-full text-left"
            style={{ color: "#8b8fa3" }}
            onClick={() => setClaimsOpen((o) => !o)}
          >
            <span style={{ transform: claimsOpen ? "rotate(90deg)" : "rotate(0deg)", display: "inline-block", fontSize: 10 }}>&#9658;</span>
            Recent Claims
            {recentClaims !== undefined && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px]" style={{ background: "rgba(255,255,255,0.08)", color: "#e4e6eb" }}>
                {topClaims.length}
              </span>
            )}
          </button>
          {claimsOpen && (
            <div className="mt-2 space-y-1">
              {recentClaims === undefined && <SkeletonBlock className="h-8 w-full rounded" />}
              {recentClaims !== undefined && topClaims.length === 0 && (
                <p className="text-xs text-[#8b8fa3] py-2">No claims recorded.</p>
              )}
              {topClaims.map((c) => (
                <div key={c.id as string} className="flex items-center gap-2 px-2 py-1.5 rounded-lg" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-[#e4e6eb] truncate block">{c.claimDate} &bull; {c.itemNameCanonical ?? "no item"} &bull; £{c.amountGbp.toFixed(2)}</span>
                    <span className="text-[10px]" style={{ color: STATUS_COLOR[c.status] ?? "#8b8fa3" }}>{c.status}{c.accountSlug ? " · " + c.accountSlug : ""}</span>
                  </div>
                  <button onClick={() => setEditingClaim({ id: c.id, accountSlug: c.accountSlug, itemNameCanonical: c.itemNameCanonical, amountGbp: c.amountGbp, claimDate: c.claimDate, description: c.description, status: c.status })} className="text-[#8b8fa3] hover:text-[#e4e6eb] px-1 text-sm" title="Edit">&#9998;</button>
                  <button onClick={() => handleDeleteClaim(c.id)} className="text-[#8b8fa3] hover:text-[#ef4444] px-1 text-sm" title="Delete">&#x2715;</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {showClaimsModal && (
        <ClaimsRecordingModal onClose={() => setShowClaimsModal(false)} />
      )}
      {editingClaim && (
        <EditClaimModal claim={editingClaim} onClose={() => setEditingClaim(null)} />
      )}
    </>
  );
}
