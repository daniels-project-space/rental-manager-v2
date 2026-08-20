"use client";

import { makeFunctionReference } from "convex/server";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { accountLabel } from "@/lib/account-theme";

type ChannelRate = {
  slug: string;
  rate: number | null;
  source?: "hygglo_profile" | "not_available";
};

type Snapshot = {
  generatedAt: number;
  channels: ChannelRate[];
};

// This module is new, so use a name reference until the generated API updates.
const channelResponseRatesRef = makeFunctionReference<"query">("channel_response_rates:get");

type RateTone = "green" | "amber" | "red" | "muted";

function rateTone(rate: number | null): RateTone {
  if (rate === null) return "muted";
  if (rate >= 0.9) return "green";
  if (rate >= 0.7) return "amber";
  return "red";
}

const TONE_COLOR: Record<RateTone, string> = {
  green: "#22c55e",
  amber: "#f59e0b",
  red: "#ef4444",
  muted: "#64748b",
};

function pointOnArc(pct: number, radius: number) {
  const angle = Math.PI - Math.PI * pct;
  return {
    x: 60 + radius * Math.cos(angle),
    y: 60 - radius * Math.sin(angle),
  };
}

function arcPath(start: number, end: number, radius = 40) {
  const a = pointOnArc(start, radius);
  const b = pointOnArc(end, radius);
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${radius} ${radius} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

function Speedometer({ channel }: { channel: ChannelRate }) {
  const tone = rateTone(channel.rate);
  const pin = channel.rate === null ? null : pointOnArc(channel.rate, 29);
  const label = accountLabel(channel.slug);
  const value = channel.rate === null ? "—" : `${Math.round(channel.rate * 100)}%`;
  const ariaLabel = channel.rate === null
    ? `${label}: Hygglo profile rate unavailable`
    : `${label}: ${value} official Hygglo response rate`;

  return (
    <div
      className="rounded-xl border px-2.5 py-2"
      style={{
        background: "rgba(2,6,23,0.34)",
        borderColor: `${TONE_COLOR[tone]}30`,
      }}
    >
      <div className="flex items-center justify-between gap-2 text-[10px] leading-tight">
        <span className="truncate font-semibold uppercase tracking-wide text-slate-300">{label}</span>
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: TONE_COLOR[tone], boxShadow: `0 0 7px ${TONE_COLOR[tone]}` }}
          aria-hidden="true"
        />
      </div>
      <svg
        viewBox="0 0 120 76"
        className="mx-auto mt-0.5 block h-[76px] w-full max-w-[150px]"
        role="img"
        aria-label={ariaLabel}
      >
        <path d={arcPath(0.01, 0.69)} fill="none" stroke="#ef4444" strokeWidth="8" strokeLinecap="round" opacity={channel.rate === null ? 0.28 : 0.9} />
        <path d={arcPath(0.72, 0.88)} fill="none" stroke="#f59e0b" strokeWidth="8" strokeLinecap="round" opacity={channel.rate === null ? 0.28 : 0.9} />
        <path d={arcPath(0.91, 0.99)} fill="none" stroke="#22c55e" strokeWidth="8" strokeLinecap="round" opacity={channel.rate === null ? 0.28 : 0.9} />
        {pin && (
          <>
            <line x1="60" y1="60" x2={pin.x} y2={pin.y} stroke={TONE_COLOR[tone]} strokeWidth="3" strokeLinecap="round" />
            <circle cx="60" cy="60" r="5" fill="#e2e8f0" stroke={TONE_COLOR[tone]} strokeWidth="2" />
          </>
        )}
        <text x="60" y="51" textAnchor="middle" fill={TONE_COLOR[tone]} fontSize="18" fontWeight="700">
          {value}
        </text>
        <text x="14" y="71" textAnchor="middle" fill="#64748b" fontSize="8">0</text>
        <text x="106" y="71" textAnchor="middle" fill="#64748b" fontSize="8">100</text>
      </svg>
      <p className="-mt-1 text-center text-[10px] text-slate-500">
        {channel.rate === null
          ? "Not available"
          : "Hygglo profile"}
      </p>
    </div>
  );
}

function formatUpdatedAt(generatedAt: number) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(generatedAt));
}

export function ChannelResponseRateCard() {
  const snapshot = useStableQuery(channelResponseRatesRef, {}) as Snapshot | null | undefined;

  if (snapshot === undefined) {
    return <div className="h-[204px] animate-pulse rounded-2xl bg-slate-900/40" aria-label="Loading channel response rates" />;
  }

  if (snapshot === null) {
    return (
      <div
        data-dashboard-card
        className="stat-card rounded-2xl border-l-[3px] p-4"
        style={{ background: "rgba(14,17,28,0.35)", backdropFilter: "blur(24px) saturate(1.5)", borderColor: "rgba(100,116,139,0.28)", borderLeftColor: "#64748b" }}
      >
        <p className="text-xs uppercase tracking-wider text-slate-400">Channel response rate</p>
        <p className="mt-3 text-sm text-slate-500">First snapshot will appear after the next scheduled refresh.</p>
      </div>
    );
  }

  return (
    <section
      data-dashboard-card
      className="stat-card rounded-2xl border-l-[3px] p-4"
      style={{
        background: "rgba(14,17,28,0.35)",
        backdropFilter: "blur(24px) saturate(1.5)",
        borderLeftColor: "#64748b",
      }}
      aria-label="Channel response rates"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-slate-400">Channel response rate</p>
          <p className="mt-1 text-[11px] text-slate-500">Official Hygglo profile metric · refreshed 4x daily</p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2.5">
        {snapshot.channels.map((channel) => <Speedometer key={channel.slug} channel={channel} />)}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 text-[10px] text-slate-500">
        <span>Red &lt;70% · yellow 70–89% · green ≥90%</span>
        <span className="shrink-0">Updated {formatUpdatedAt(snapshot.generatedAt)}</span>
      </div>
    </section>
  );
}
