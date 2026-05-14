"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { useState } from "react";
import { SettingsDrawer } from "@/components/dashboard/SettingsDrawer";

const ACCOUNTS = [
  { slug: null, label: "All" },
  { slug: "dbcinema", label: "DB Cinema", color: "#6ea8fe" },
  { slug: "leo", label: "Leo Adams", color: "#22c55e" },
];

export function HeaderBar() {
  const { activeAccountSlug, setActiveAccountSlug } = useAccount();
  const settings = useQuery(api.settings.get);
  // Global freshness signal — sourced from sync_state via dashboard.getStatsDrawerData.
  // (the Scanner card already reads the same field; this surfaces it in the header
  // so every widget gets an at-a-glance "how live is this dashboard" cue.)
  const stats = useQuery(api.dashboard.getStatsDrawerData, { accountSlug: activeAccountSlug }) as any;
  const lastScanAt: number | null = stats?.scanner?.last_scan_at ?? null;
  const staleMin = lastScanAt ? Math.round((Date.now() - lastScanAt) / 60_000) : null;
  const freshnessLabel =
    staleMin === null ? null :
    staleMin <= 1 ? "Just now" :
    staleMin < 60 ? `${staleMin} min ago` :
    `${Math.round(staleMin / 60)} h ago`;
  const freshnessTone =
    staleMin === null ? "#8b8fa3" :
    staleMin <= 10  ? "#22c55e" :
    staleMin <= 30  ? "#f59e0b" :
                      "#ef4444";
  const [showSettings, setShowSettings] = useState(false);

  return (
    <>
      <header
        className="sticky top-0 z-40 flex items-center justify-between px-4 md:px-6 h-14 border-b"
        style={{
          background: "rgba(7,9,16,0.92)",
          backdropFilter: "blur(16px)",
          borderColor: "rgba(255,255,255,0.08)",
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-[#e4e6eb] tracking-tight">
            Rental Manager
          </span>
          <span className="hidden sm:inline text-xs px-2 py-0.5 rounded-full border border-[rgba(255,255,255,0.12)] text-[#8b8fa3]">
            v2
          </span>
        </div>

        <nav className="flex items-center gap-1">
          {ACCOUNTS.map((a) => {
            const active = activeAccountSlug === a.slug;
            return (
              <button
                key={String(a.slug)}
                onClick={() => setActiveAccountSlug(a.slug)}
                className="px-3 py-1 rounded-full text-xs font-medium transition-colors"
                style={{
                  background: active ? `${a.color ?? "#e4e6eb"}22` : "transparent",
                  color: active ? (a.color ?? "#e4e6eb") : "#8b8fa3",
                  border: active
                    ? `1px solid ${a.color ?? "#e4e6eb"}55`
                    : "1px solid transparent",
                }}
              >
                {a.label}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-3">
          {freshnessLabel && (
            <span
              className="hidden sm:inline text-[11px] px-2 py-0.5 rounded-full border"
              style={{ background: `${freshnessTone}1a`, color: freshnessTone, borderColor: `${freshnessTone}55` }}
              title={lastScanAt ? `Last Hygglo poll: ${new Date(lastScanAt).toLocaleString()}` : "Sync state unknown"}
            >
              <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 9999, background: freshnessTone, marginRight: 6, verticalAlign: "middle" }} />
              {freshnessLabel}
            </span>
          )}
          {settings?.read_only_mode && (
            <span className="hidden md:inline text-xs px-2 py-0.5 rounded bg-[#f59e0b]/10 text-[#f59e0b] border border-[#f59e0b]/30">
              Read-only
            </span>
          )}
          <button
            onClick={() => setShowSettings(true)}
            className="text-[#8b8fa3] hover:text-[#e4e6eb] transition-colors text-base"
            aria-label="Settings"
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      {showSettings && (
        <SettingsDrawer onClose={() => setShowSettings(false)} />
      )}
    </>
  );
}
