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

// Stack order (bottom → top): Daniel → Vertus → DB Cinema → Leo → AI Boost → Claims → Booked next → Pending next
const SERIES = [
  { key: "danielOrganic",   label: "Daniel (retired)", color: "#f59e0b", fill: "rgba(245,158,11,0.7)" },
  { key: "vertusOrganic",   label: "Vertus (retired)", color: "#10b981", fill: "rgba(16,185,129,0.7)" },
  { key: "dbcinemaOrganic", label: "DB Cinema",        color: "#3b82f6", fill: "rgba(59,130,246,0.7)" },
  { key: "leoOrganic",      label: "Leo Adams",        color: "#a855f7", fill: "rgba(168,85,247,0.7)" },
  { key: "aiBoost",         label: "AI Boost",         color: "#22c55e", fill: "rgba(34,197,94,0.5)" },
  { key: "damageClaims",    label: "Claims",           color: "#ef4444", fill: "rgba(239,68,68,0.6)" },
  { key: "bookedNext",      label: "Booked (next mo)", color: "#6ea8fe", fill: "rgba(110,168,254,0.55)" },
  { key: "pendingNext",     label: "Pending (next mo)",color: "#eab308", fill: "rgba(234,179,8,0.45)" },
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
    series?.label ?? String(name);
  return ["£" + v.toFixed(2), label];
}

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
    return { ...row, label: fmtMonth(row.month), forecastLine: fc ? fc.value : null };
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
              {/* Stacked bars — bottom to top per spec */}
              {SERIES.map((s) => (
                <Bar
                  key={s.key}
                  yAxisId="right"
                  dataKey={s.key}
                  name={s.key}
                  stackId="monthly"
                  fill={s.fill}
                  stroke={s.color}
                  strokeWidth={0}
                  maxBarSize={24}
                  hide={hidden[s.key] ?? false}
                />
              ))}
              {/* Cumulative — solid green line, left axis */}
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
              {/* Forecast — gray dashed line, right axis */}
              <Line
                yAxisId="right"
                dataKey="forecastLine"
                name="forecastLine"
                type="monotone"
                stroke="#94a3b8"
                strokeWidth={2}
                strokeDasharray="5 5"
                dot={false}
                activeDot={{ r: 4, fill: "#94a3b8" }}
                connectNulls={false}
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
