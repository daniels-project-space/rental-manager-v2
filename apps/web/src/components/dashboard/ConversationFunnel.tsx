"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

type Days = 7 | 30 | 90;

const STAGES = [
  { key: "inquiries", label: "Inquiries", color: "#f59e0b" },
  { key: "responses", label: "Responses", color: "#6ea8fe" },
  { key: "bookings",  label: "Bookings",  color: "#22c55e" },
] as const;

export function ConversationFunnel() {
  const { activeAccountSlug } = useAccount();
  const [days, setDays] = useState<Days>(30);

  const data = useQuery(api.reservations.getConversionFunnel, {
    accountSlug: activeAccountSlug,
    days,
  });

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
        <SkeletonBlock className="h-32 w-full" />
      ) : (
        <>
          {/* Funnel bars */}
          <div className="space-y-2 mb-4">
            {STAGES.map((stage) => {
              const count = data[stage.key] as number;
              const max = data.inquiries > 0 ? data.inquiries : 1;
              const pct = Math.max(4, (count / max) * 100);
              return (
                <div key={stage.key} className="flex items-center gap-3">
                  <div className="w-20 text-xs text-[#8b8fa3] flex-shrink-0">{stage.label}</div>
                  <div className="flex-1 h-6 rounded overflow-hidden" style={{ background: "rgba(255,255,255,0.05)" }}>
                    <div
                      className="h-full rounded transition-all duration-500"
                      style={{ width: `${pct}%`, background: stage.color }}
                    />
                  </div>
                  <div className="w-8 text-right text-sm font-semibold" style={{ color: stage.color }}>
                    {count}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Summary row */}
          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-white/5">
            <div>
              <div className="text-xs text-[#8b8fa3] uppercase tracking-wider">Conversion</div>
              <div className="text-lg font-bold" style={{ color: "#22c55e" }}>
                {(data.conversionRate * 100).toFixed(1)}%
              </div>
            </div>
            <div>
              <div className="text-xs text-[#8b8fa3] uppercase tracking-wider">Denial Rate</div>
              <div
                className="text-lg font-bold"
                style={{ color: data.denialRate > 0.1 ? "#ef4444" : "#8b8fa3" }}
              >
                {(data.denialRate * 100).toFixed(1)}%
              </div>
            </div>
          </div>
          {data.inquiries === 0 && (
            <p className="text-xs mt-3" style={{ color: "#8b8fa3" }}>
              No conversation data yet. Funnel will auto-populate once Hygglo message polling is active (Phase 4).
            </p>
          )}
        </>
      )}
    </Card>
  );
}
