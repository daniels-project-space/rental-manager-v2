"use client";
import { api } from "../../../convex/_generated/api";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

type Days = 7 | 30 | 90;

type Outcome = {
  key: string;
  label: string;
  tone: "good" | "bad" | "neutral";
  count: number;
  share: number;
};

type FunnelData = {
  window_days: number;
  inquiries: number;
  requests: number;
  booked: number;
  booked_net_gbp: number;
  request_rate: number;
  book_rate_of_requests: number;
  book_rate_of_inquiries: number;
  reply: {
    eligible: number;
    replied: number;
    rate: number | null;
    awaiting_reply: number;
    too_new: number;
    p50_hours: number | null;
    p90_hours: number | null;
  };
  outcomes: Outcome[];
  top_leak: { key: string; label: string; count: number; share: number; advice: string } | null;
};

/** One colour per terminal outcome, shared by the bar and the legend. */
const OUTCOME_COLOR: Record<string, string> = {
  booked: "#22c55e",
  owner_denied: "#ef4444",
  expired: "#f59e0b",
  renter_cancelled: "#fb923c",
  verification_failed: "#a78bfa",
  still_open: "#6ea8fe",
  no_request: "#6b7280",
  other: "#4b5563",
};

function pct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;
}

function gbp(n: number): string {
  return `£${Math.round(n).toLocaleString("en-GB")}`;
}

function hours(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n < 1) return `${Math.round(n * 60)}m`;
  if (n < 48) return `${n < 10 ? n.toFixed(1) : Math.round(n)}h`;
  return `${(n / 24).toFixed(1)}d`;
}

export function ConversationFunnel() {
  const { activeAccountSlug } = useAccount();
  const [days, setDays] = useState<Days>(30);

  const data = useStableQuery(api.reservations.getConversionFunnel, {
    accountSlug: activeAccountSlug,
    days,
  }) as FunnelData | undefined;

  const dayOpts: Days[] = [7, 30, 90];

  return (
    <Card>
      <CardHeader
        title="Conversation Funnel"
        actions={
          <div className="flex gap-1">
            {dayOpts.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className="px-2 py-0.5 text-xs rounded transition-colors"
                style={{
                  background: days === d ? "rgba(110,168,254,0.15)" : "transparent",
                  color: days === d ? "#6ea8fe" : "#8b8fa3",
                  border: days === d ? "1px solid rgba(110,168,254,0.3)" : "1px solid transparent",
                }}
              >
                {d}d
              </button>
            ))}
          </div>
        }
      />

      {data === undefined ? (
        <SkeletonBlock className="h-56 w-full" />
      ) : data.inquiries === 0 ? (
        <p className="text-xs text-[#8b8fa3] py-8 text-center">
          No renter made first contact in the last {days} days.
        </p>
      ) : (
        <FunnelBody data={data} days={days} />
      )}
    </Card>
  );
}

function FunnelBody({ data, days }: { data: FunnelData; days: Days }) {
  // ── Axis 1: PROGRESSION ────────────────────────────────────────────
  // Only stages that are strict subsets of one another live here, so every
  // share is a real 0–100% and the bars genuinely narrow. "Replied" is
  // deliberately NOT a stage — on Hygglo a renter can place a request without
  // us answering first, so putting it between these two would imply a
  // dependency that does not exist.
  const stages = [
    {
      key: "inquiries",
      label: "Inquiries",
      sub: "renter made first contact",
      count: data.inquiries,
      share: 1,
      color: "#f59e0b",
    },
    {
      key: "requests",
      label: "Requests",
      sub: "placed a booking request",
      count: data.requests,
      share: data.request_rate,
      color: "#6ea8fe",
    },
    {
      key: "booked",
      label: "Booked",
      sub: gbp(data.booked_net_gbp) + " net",
      count: data.booked,
      share: data.book_rate_of_inquiries,
      color: "#22c55e",
    },
  ];

  const dropoffs = [
    {
      lost: data.inquiries - data.requests,
      label: "never placed a request",
      rate: data.request_rate,
    },
    {
      lost: data.requests - data.booked,
      label: "requested but didn't book",
      rate: data.book_rate_of_requests,
    },
  ];

  // ── Axis 3: OUTCOME ────────────────────────────────────────────────
  const outcomes = [...data.outcomes].sort((a, b) => b.count - a.count);
  const total = outcomes.reduce((s, o) => s + o.count, 0) || 1;

  return (
    <>
      {/* PROGRESSION */}
      <div className="mt-1">
        {stages.map((s, i) => (
          <div key={s.key}>
            <div className="flex items-center gap-3">
              <div className="w-[74px] flex-shrink-0">
                <div className="text-xs text-[#c9cdd5]">{s.label}</div>
                <div className="text-[9px] text-[#6b7280] leading-tight">{s.sub}</div>
              </div>
              <div
                className="flex-1 h-7 rounded-md overflow-hidden relative"
                style={{ background: "rgba(255,255,255,0.05)" }}
              >
                <div
                  className="h-full rounded-md transition-all duration-500 flex items-center px-2"
                  style={{ width: `${Math.max(7, s.share * 100)}%`, background: s.color }}
                >
                  <span className="text-[11px] font-bold" style={{ color: "#0b0e16" }}>
                    {s.count}
                  </span>
                </div>
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-[#8b8fa3] tabular-nums">
                  {pct(s.share)}
                </span>
              </div>
            </div>
            {i < dropoffs.length && dropoffs[i].lost > 0 && (
              <div className="flex items-center gap-3 py-0.5">
                <div className="w-[74px]" />
                <div className="flex-1 flex items-center gap-2 text-[10px] text-[#6b7280]">
                  <span className="text-[#4b5563]">↓</span>
                  <span className="tabular-nums font-semibold text-[#8b8fa3]">
                    {dropoffs[i].lost}
                  </span>
                  <span>{dropoffs[i].label}</span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* OUTCOME — mutually exclusive, sums to inquiries */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] text-[#8b8fa3] uppercase tracking-wider">
            Where all {data.inquiries} went
          </span>
          <span className="text-[9px] text-[#4b5563]">every inquiry counted once</span>
        </div>
        <div className="flex h-2.5 w-full rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.05)" }}>
          {outcomes.map((o) => (
            <div
              key={o.key}
              title={`${o.label}: ${o.count} (${pct(o.share)})`}
              style={{
                width: `${(o.count / total) * 100}%`,
                background: OUTCOME_COLOR[o.key] ?? "#4b5563",
              }}
            />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2">
          {outcomes.map((o) => (
            <div key={o.key} className="flex items-center gap-1.5 text-[10px]">
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: OUTCOME_COLOR[o.key] ?? "#4b5563" }}
              />
              <span className="text-[#8b8fa3] flex-1 truncate">{o.label}</span>
              <span className="tabular-nums font-semibold text-[#c9cdd5]">{o.count}</span>
              <span className="tabular-nums text-[#4b5563] w-8 text-right">{pct(o.share)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* SERVICE — our responsiveness, not a funnel stage */}
      <div className="grid grid-cols-3 gap-2 pt-3 mt-3 border-t border-white/5 text-center">
        <Stat
          label="Reply rate"
          value={pct(data.reply.rate)}
          color="#6ea8fe"
          hint={
            data.reply.rate === null
              ? `No inquiry in this window is older than 24h yet`
              : `${data.reply.replied} of ${data.reply.eligible} inquiries older than 24h. Newer ones are excluded so they can't drag it down.`
          }
        />
        <Stat
          label="Median reply"
          value={hours(data.reply.p50_hours)}
          color="#a78bfa"
          hint={`Half of your replies land within this. Slowest 10% take ${hours(data.reply.p90_hours)}.`}
        />
        <Stat
          label="Awaiting reply"
          value={String(data.reply.awaiting_reply)}
          color={data.reply.awaiting_reply > 0 ? "#f59e0b" : "#22c55e"}
          hint={`Inquiries from the last 24h you haven't answered yet (of ${data.reply.too_new} that recent).`}
        />
      </div>

      {/* Biggest leak — always a real, dated outcome */}
      {data.top_leak && data.top_leak.count > 0 && (
        <div
          className="mt-3 rounded-lg px-3 py-2 text-[11px] leading-relaxed"
          style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.16)" }}
        >
          <span className="font-semibold text-[#f59e0b]">Biggest leak · </span>
          <span className="text-[#c9cdd5]">
            {data.top_leak.label.toLowerCase()} — {data.top_leak.count} of {data.inquiries} inquiries
            ({pct(data.top_leak.share)}) in the last {days} days. {data.top_leak.advice}
          </span>
        </div>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  color,
  hint,
}: {
  label: string;
  value: string;
  color: string;
  hint?: string;
}) {
  return (
    <div title={hint}>
      <div className="text-[10px] text-[#8b8fa3] uppercase tracking-wider">{label}</div>
      <div className="text-base font-bold tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
