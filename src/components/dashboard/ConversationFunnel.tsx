"use client";
import { api } from "../../../convex/_generated/api";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

type Days = 7 | 30 | 90;

type FunnelData = {
  inquiries: number;
  responses: number;
  bookings: number;
  denials: number;
  conversionRate: number;
  denialRate: number;
};

/** Percent with sensible precision (7.5% but 70%). */
function pct(n: number): string {
  if (!Number.isFinite(n)) return "0%";
  return `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;
}

function rateColor(n: number): string {
  return n >= 0.5 ? "#22c55e" : n >= 0.2 ? "#f59e0b" : "#ef4444";
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
        <SkeletonBlock className="h-44 w-full" />
      ) : data.inquiries === 0 ? (
        <p className="text-xs text-[#8b8fa3] py-8 text-center">
          No new inquiries in the last {days} days.
        </p>
      ) : (
        <FunnelBody data={data} />
      )}
    </Card>
  );
}

function FunnelBody({ data }: { data: FunnelData }) {
  const inquiries = data.inquiries;
  const responded = data.responses;
  const booked = data.bookings;

  const replyRate = inquiries > 0 ? responded / inquiries : 0;
  const closeRate = responded > 0 ? booked / responded : 0;
  const overall = inquiries > 0 ? booked / inquiries : 0;
  const notReplied = Math.max(0, inquiries - responded);
  const repliedNoBook = Math.max(0, responded - booked);

  const stages = [
    { label: "Inquiries", count: inquiries, color: "#f59e0b", share: 1 },
    { label: "Replied", count: responded, color: "#6ea8fe", share: inquiries ? responded / inquiries : 0 },
    { label: "Booked", count: booked, color: "#22c55e", share: inquiries ? booked / inquiries : 0 },
  ];
  // The drop-off shown UNDER each stage (last stage has none).
  const steps = [
    { rate: replyRate, lost: notReplied, lostLabel: "never replied to" },
    { rate: closeRate, lost: repliedNoBook, lostLabel: "replied, didn't book" },
  ];

  // Bottleneck = the transition that loses the biggest SHARE of its stage.
  const lossReply = inquiries ? notReplied / inquiries : 0;
  const lossBook = responded ? repliedNoBook / responded : 0;
  const bottleneck =
    lossBook >= lossReply
      ? { count: repliedNoBook, rate: lossBook, when: "after replying", advice: "converting replies into bookings — check pricing, availability and how fast you answer." }
      : { count: notReplied, rate: lossReply, when: "before a reply", advice: "replying to inquiries — you're leaving people unanswered." };

  return (
    <>
      <div className="mt-1">
        {stages.map((s, i) => (
          <div key={s.label}>
            <div className="flex items-center gap-3">
              <div className="w-[68px] text-xs text-[#8b8fa3] flex-shrink-0">{s.label}</div>
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
            {i < steps.length && (
              <div className="flex items-center gap-3 py-0.5">
                <div className="w-[68px]" />
                <div className="flex-1 flex items-center gap-2 text-[10px] text-[#6b7280]">
                  <span className="text-[#4b5563]">↓</span>
                  <span className="font-semibold tabular-nums" style={{ color: rateColor(steps[i].rate) }}>
                    {pct(steps[i].rate)}
                  </span>
                  <span className="text-[#3a3d4a]">·</span>
                  <span className="tabular-nums">{steps[i].lost}</span>
                  <span>{steps[i].lostLabel}</span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Rates */}
      <div className="grid grid-cols-3 gap-2 pt-3 mt-2 border-t border-white/5 text-center">
        <Stat label="Reply rate" value={pct(replyRate)} color="#6ea8fe" />
        <Stat label="Close rate" value={pct(closeRate)} color="#a78bfa" />
        <Stat label="Booked / inq" value={pct(overall)} color="#22c55e" />
      </div>

      {/* Actionable bottleneck */}
      {bottleneck.count > 0 && (
        <div
          className="mt-3 rounded-lg px-3 py-2 text-[11px] leading-relaxed"
          style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.16)" }}
        >
          <span className="font-semibold text-[#f59e0b]">Biggest leak · </span>
          <span className="text-[#c9cdd5]">
            {bottleneck.count} lost {bottleneck.when} ({pct(bottleneck.rate)} of that stage). Focus on {bottleneck.advice}
          </span>
        </div>
      )}
    </>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="text-[10px] text-[#8b8fa3] uppercase tracking-wider">{label}</div>
      <div className="text-base font-bold tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
