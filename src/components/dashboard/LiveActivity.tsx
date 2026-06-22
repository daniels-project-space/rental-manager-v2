"use client";
import { api } from "../../../convex/_generated/api";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { useAccount } from "@/lib/account-context";
import { accountAccent } from "@/lib/account-theme";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

const STATUS_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  confirmed:      { label: "BOOKED",   bg: "rgba(34,197,94,0.15)",  color: "#22c55e" },
  completed:      { label: "RETURNED", bg: "rgba(110,168,254,0.15)", color: "#6ea8fe" },
  pending_review: { label: "INQUIRY",  bg: "rgba(245,158,11,0.15)", color: "#f59e0b" },
  cancelled:      { label: "CANCELLED",bg: "rgba(107,114,128,0.15)",color: "#6b7280" },
  declined:       { label: "DECLINED", bg: "rgba(239,68,68,0.15)",  color: "#ef4444" },
};

function fmtDate(d?: string) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function relTime(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function AccountDot({ slug }: { slug?: string }) {
  const color = accountAccent(slug);
  return (
    <span
      className="inline-block w-2 h-2 rounded-full flex-shrink-0 mt-0.5"
      style={{ background: color }}
    />
  );
}

export function LiveActivity() {
  const { activeAccountSlug } = useAccount();
  const rows = useStableQuery(api.reservations.getRecentActivity, {
    accountSlug: activeAccountSlug,
    limit: 20,
  });

  return (
    <Card>
      <CardHeader title="Live Activity" />
      {rows === undefined ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState message="No recent activity" icon="📋" />
      ) : (
        <div className="space-y-0.5 max-h-72 overflow-y-auto">
          {rows.map((r) => {
            const badge = STATUS_BADGE[r.status] ?? {
              label: r.status.toUpperCase(),
              bg: "rgba(139,143,163,0.15)",
              color: "#8b8fa3",
            };
            const names = r.itemNames.slice(0, 2).join(", ");
            const extra = r.itemNames.length > 2 ? ` +${r.itemNames.length - 2}` : "";
            const dateRange = r.startDate && r.endDate ? `${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}` : "";
            const fallback = dateRange ? `Rental · ${dateRange}` : "Rental";
            return (
              <div
                key={r.id}
                className="flex items-start gap-2 px-2 py-2 rounded hover:bg-white/5 transition-colors border-b border-white/5 last:border-0"
              >
                <AccountDot slug={r.accountSlug} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-[#e4e6eb] truncate">
                    {names || fallback}{extra}
                  </div>
                </div>
                <span
                  className="text-xs px-1.5 py-0.5 rounded flex-shrink-0"
                  style={{ background: badge.bg, color: badge.color }}
                >
                  {badge.label}
                </span>
                <span className="text-xs text-[#8b8fa3] flex-shrink-0 tabular-nums">
                  {relTime(r.createdAt)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
