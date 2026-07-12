"use client";
import { api } from "../../../convex/_generated/api";
import { makeFunctionReference } from "convex/server";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { useAccount } from "@/lib/account-context";
import { useState } from "react";
import { SettingsDrawer } from "@/components/dashboard/SettingsDrawer";
import { NotificationBell } from "@/components/dashboard/NotificationBell";

// String ref (not api.dashboard.getScannerFreshness): the committed
// _generated api types don't include the new function yet — same pattern
// as ReplyInbox/SettingsDrawer refs.
const scannerFreshnessRef = makeFunctionReference<"query">("dashboard:getScannerFreshness");

const ACCOUNTS = [
  { slug: null, label: "All" },
  { slug: "dbcinema", label: "DB Cinema", color: "#6ea8fe" },
  { slug: "leo", label: "Leo Adams", color: "#a855f7" },
  { slug: "diogo", label: "Diogo", color: "#f97316" },
  { slug: "dbcinema_web", label: "DB Cinema Web", color: "#10b981" },
];

type AccountMeta = { slug: string; display_name: string; profile_image_url: string | null };

function imgForSlug(metas: AccountMeta[] | undefined, slug: string): string | null {
  return metas?.find((m) => m.slug === slug)?.profile_image_url ?? null;
}

/** Circular profile-picture cutout (or initials fallback) with a coloured ring. */
function AccountAvatar({
  src,
  label,
  size,
  ringColor,
}: {
  src: string | null;
  label: string;
  size: number;
  ringColor: string;
}) {
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{ width: size, height: size, boxShadow: `0 0 0 1.5px ${ringColor}`, background: "#11141d" }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={label} className="h-full w-full object-cover" />
      ) : (
        <span style={{ fontSize: size * 0.42, fontWeight: 700, color: "#cbd2e0" }}>
          {label.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase()}
        </span>
      )}
    </span>
  );
}

/** Overlapping avatar stack for the "All" pill — reads as "every account". */
function AllAvatars({ metas }: { metas: AccountMeta[] | undefined }) {
  const slugs = ["dbcinema", "leo", "diogo", "dbcinema_web"];
  return (
    <span className="inline-flex items-center">
      {slugs.map((s, i) => (
        <span
          key={s}
          className="inline-flex"
          style={{ marginLeft: i === 0 ? 0 : -7, zIndex: slugs.length - i }}
        >
          <AccountAvatar src={imgForSlug(metas, s)} label={s} size={18} ringColor="#070910" />
        </span>
      ))}
    </span>
  );
}

export function HeaderBar() {
  const { activeAccountSlug, setActiveAccountSlug } = useAccount();
  const settings = useStableQuery(api.settings.get);
  // Per-account profile pictures (Hygglo avatars seeded into the accounts table).
  const accountsMeta = useStableQuery(api.accounts.list) as AccountMeta[] | undefined;
  // Global freshness signal — dedicated 3-row sync_state query. Previously read
  // via getStatsDrawerData.scanner, which chained the megaquery subscription to
  // sync_state (patched by the Hygglo poller every 15 min → megaquery re-ran per
  // open tab per poll). This pill is the live consumer; the megaquery now serves
  // its scanner fields from the MV snapshot.
  const freshness = useStableQuery(scannerFreshnessRef, {}) as
    | { last_scan_at: number | null }
    | undefined;
  const STALE_THRESHOLD_MS = 60 * 60 * 1000;
  const lastScanAt: number | null = freshness?.last_scan_at ?? null;
  const staleMin = lastScanAt ? Math.round((Date.now() - lastScanAt) / 60_000) : null;
  const isStale = lastScanAt !== null && (Date.now() - lastScanAt) > STALE_THRESHOLD_MS;
  const freshnessLabel =
    staleMin === null ? null :
    staleMin <= 1 ? "Just now" :
    staleMin < 60 ? `${staleMin} min ago` :
    `${Math.round(staleMin / 60)} h ago`;
  const freshnessTone =
    staleMin === null ? "#8b8fa3" :
    isStale         ? "#ef4444" :
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

        <nav className="flex items-center gap-1.5">
          {ACCOUNTS.map((a) => {
            const active = activeAccountSlug === a.slug;
            const accent = a.color ?? "#e4e6eb";
            return (
              <button
                key={String(a.slug)}
                onClick={() => setActiveAccountSlug(a.slug)}
                title={a.label}
                aria-pressed={active}
                className="flex items-center gap-2 rounded-full py-1 pl-1 pr-1.5 sm:pr-3 text-xs font-semibold transition-all duration-200 hover:-translate-y-px"
                style={{
                  background: active ? `${accent}1f` : "rgba(255,255,255,0.035)",
                  color: active ? accent : "#9aa0ad",
                  border: `1px solid ${active ? `${accent}66` : "rgba(255,255,255,0.07)"}`,
                  boxShadow: active ? `0 2px 12px ${accent}33` : "none",
                }}
              >
                {a.slug === null ? (
                  <AllAvatars metas={accountsMeta} />
                ) : (
                  <AccountAvatar
                    src={imgForSlug(accountsMeta, a.slug)}
                    label={a.label}
                    size={22}
                    ringColor={active ? accent : "rgba(255,255,255,0.18)"}
                  />
                )}
                <span className="hidden sm:inline">{a.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-3">
          {freshnessLabel && (
            <span
              className={`hidden sm:inline text-[11px] px-2 py-0.5 rounded-full border${isStale ? " text-red-400/80" : ""}`}
              style={{ background: `${freshnessTone}1a`, color: freshnessTone, borderColor: `${freshnessTone}55` }}
              title={`${isStale ? "⚠ Scanner inactive (>1h) — " : ""}${lastScanAt ? `Last Hygglo poll: ${new Date(lastScanAt).toLocaleString()}` : "Sync state unknown"}`}
            >
              <span
                className={isStale ? "animate-pulse" : ""}
                style={{ display: "inline-block", width: 6, height: 6, borderRadius: 9999, background: freshnessTone, marginRight: 6, verticalAlign: "middle", boxShadow: isStale ? "0 0 8px #ef4444" : undefined }}
              />
              {freshnessLabel}{isStale ? " · inactive" : ""}
            </span>
          )}
          {settings?.read_only_mode && (
            <span className="hidden md:inline text-xs px-2 py-0.5 rounded bg-[#f59e0b]/10 text-[#f59e0b] border border-[#f59e0b]/30">
              Read-only
            </span>
          )}
          <NotificationBell />
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
