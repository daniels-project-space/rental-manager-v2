"use client";
import { api } from "../../../convex/_generated/api";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { useAccount } from "@/lib/account-context";
import { accountAccent } from "@/lib/account-theme";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

function relTime(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function AccountDot({ slug }: { slug: string }) {
  const color = accountAccent(slug);
  return (
    <span
      className="inline-block w-2 h-2 rounded-full flex-shrink-0 mt-0.5"
      style={{ background: color }}
    />
  );
}

function PulsingDot() {
  return (
    <span className="relative flex h-2 w-2">
      <span
        className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
        style={{ background: "#22c55e" }}
      />
      <span
        className="relative inline-flex rounded-full h-2 w-2"
        style={{ background: "#22c55e" }}
      />
    </span>
  );
}

export function HyggloInbox() {
  const { activeAccountSlug } = useAccount();
  const messages = useStableQuery(api.hygglo.getRecentMessages, {
    accountSlug: activeAccountSlug ?? undefined,
    limit: 15,
  });

  return (
    <Card>
      <CardHeader
        title="Hygglo Inbox (live)"
        badge={<PulsingDot />}
      />
      {messages === undefined ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : messages.length === 0 ? (
        <EmptyState
          message="No messages yet — first poll in next 5 minutes"
          icon="💬"
        />
      ) : (
        <div className="space-y-0.5 max-h-72 overflow-y-auto">
          {messages.map((msg) => (
            <div
              key={msg._id}
              className="flex items-start gap-2 px-2 py-2 rounded hover:bg-white/5 transition-colors border-b border-white/5 last:border-0"
            >
              <AccountDot slug={msg.account_slug} />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-[#8b8fa3] mb-0.5">
                  {msg.sender_name ?? (msg.sender === "owner" ? "Owner" : "Renter")}
                  {" · "}
                  <span className="text-[#6b7280]">Thread {msg.thread_id}</span>
                </div>
                <div className="text-sm text-[#e4e6eb] truncate">
                  {msg.body_text}
                </div>
              </div>
              <span
                className="text-xs px-1.5 py-0.5 rounded flex-shrink-0"
                style={{
                  background:
                    msg.sender === "renter"
                      ? "rgba(245,158,11,0.15)"
                      : "rgba(110,168,254,0.15)",
                  color: msg.sender === "renter" ? "#f59e0b" : "#6ea8fe",
                }}
              >
                {msg.sender === "renter" ? "RENTER" : "OWNER"}
              </span>
              <span className="text-xs text-[#8b8fa3] flex-shrink-0 tabular-nums">
                {relTime(msg.hygglo_sent_at ?? msg.fetched_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
