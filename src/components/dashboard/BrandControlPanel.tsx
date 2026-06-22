"use client";
import { useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

// Command Center for the Hygglo listing-PORTING accounts (Leo, Diogo, ...).
// Reads the porting service feed via the /api/brand-control proxy. Shows each
// account's GATED brand (background + header font — locked per account so images
// never cross-upload), render/upload counts, and the ported listings with their
// price + demand slots (open until the dynamic-pricing job fills them).

type Listing = {
  productId: string;
  title: string | null;
  isBundle: boolean;
  image: string | null;
  listingId: number | null;
  price: number | null;
  basePrice: number | null;
  currency: string | null;
  demand: { views: number | null; bookings: number | null; stock: number | null; available: number | null };
};
type Account = {
  account: string;
  brand: { background?: string; plateMode?: string; font?: string; headerFontName?: string };
  hygglo: { locationId?: number | null };
  listings: Listing[];
  stats: { rendered: number; uploaded: number; bundles: number };
};
type Feed = { accounts: Account[] };

const MUTED = "#8b8fa3";
const TEXT = "#e4e6eb";
const proxied = (u: string | null) =>
  u ? `/api/brand-control?image=${encodeURIComponent(u)}` : null;

function isHex(s?: string) {
  return !!s && /^#?[0-9a-fA-F]{6}$/.test(s.trim());
}

function Swatch({ bg }: { bg?: string }) {
  const hex = isHex(bg) ? (bg!.startsWith("#") ? bg : `#${bg}`) : null;
  return (
    <div className="flex items-center gap-2">
      <div
        className="w-8 h-8 rounded-lg border"
        style={{ background: hex ?? "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}
        title={hex ?? bg}
      />
      <span className="text-xs font-mono" style={{ color: TEXT }}>
        {hex ?? bg ?? "—"}
      </span>
    </div>
  );
}

function Stat({ n, label, color = TEXT }: { n: number; label: string; color?: string }) {
  return (
    <div className="px-2.5 py-1.5 rounded-lg text-center" style={{ background: "rgba(255,255,255,0.04)" }}>
      <div className="text-lg font-bold" style={{ color }}>{n}</div>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: MUTED }}>{label}</div>
    </div>
  );
}

function ListingTile({ l }: { l: Listing }) {
  const src = proxied(l.image);
  return (
    <div className="rounded-lg overflow-hidden" style={{ background: "rgba(255,255,255,0.03)" }}>
      <div className="aspect-[4/3] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.25)" }}>
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={l.title ?? l.productId} className="w-full h-full object-contain" loading="lazy" />
        ) : (
          <span className="text-xs" style={{ color: MUTED }}>no image</span>
        )}
      </div>
      <div className="p-2 space-y-1">
        <div className="text-[11px] leading-tight line-clamp-2" style={{ color: TEXT }}>
          {l.title ?? l.productId}
          {l.isBundle && (
            <span className="ml-1 px-1 rounded text-[9px]" style={{ background: "rgba(167,139,250,0.18)", color: "#a78bfa" }}>
              BUNDLE
            </span>
          )}
        </div>
        <div className="flex items-center justify-between text-[10px]" style={{ color: MUTED }}>
          <span>
            {l.price != null ? `£${l.price}/day` : <span style={{ color: "#f59e0b" }}>price unset</span>}
          </span>
          <span>{l.listingId ? `#${l.listingId}` : "not uploaded"}</span>
        </div>
      </div>
    </div>
  );
}

function AccountCard({ a }: { a: Account }) {
  const [open, setOpen] = useState(false);
  const shown = open ? a.listings : a.listings.slice(0, 8);
  return (
    <div className="rounded-xl p-4 space-y-3" style={{ background: "rgba(255,255,255,0.03)" }}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-bold capitalize" style={{ color: TEXT }}>{a.account}</h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(110,168,254,0.15)", color: "#6ea8fe" }}>
            loc {a.hygglo?.locationId ?? "—"}
          </span>
        </div>
        <div className="flex gap-2">
          <Stat n={a.stats.rendered} label="rendered" color="#6ea8fe" />
          <Stat n={a.stats.uploaded} label="uploaded" color="#22c55e" />
          <Stat n={a.stats.bundles} label="bundles" color="#a78bfa" />
        </div>
      </div>

      {/* GATED brand controls (locked per account -> no cross-upload) */}
      <div className="grid grid-cols-2 gap-3">
        <div className="p-2.5 rounded-lg" style={{ background: "rgba(255,255,255,0.03)" }}>
          <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: MUTED }}>Background</div>
          <Swatch bg={a.brand?.background} />
        </div>
        <div className="p-2.5 rounded-lg" style={{ background: "rgba(255,255,255,0.03)" }}>
          <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: MUTED }}>Header font</div>
          <div className="text-xs" style={{ color: TEXT }}>{a.brand?.headerFontName ?? a.brand?.font ?? "—"}</div>
        </div>
      </div>

      {a.listings.length > 0 && (
        <>
          <div className="grid grid-cols-4 gap-2">
            {shown.map((l) => <ListingTile key={l.productId} l={l} />)}
          </div>
          {a.listings.length > 8 && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="text-xs px-3 py-1.5 rounded-lg w-full"
              style={{ background: "rgba(255,255,255,0.05)", color: MUTED }}
            >
              {open ? "Show less" : `Show all ${a.listings.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function BrandControlPanel() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setFeed(null);
    setError(null);
    fetch("/api/brand-control", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then((d) => live && setFeed(d))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [nonce]);

  return (
    <Card>
      <CardHeader
        title="Brand Control Center"
        badge={
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e" }}>
            porting accounts
          </span>
        }
        actions={
          <button
            onClick={() => setNonce((n) => n + 1)}
            className="text-xs px-2.5 py-1 rounded-lg"
            style={{ background: "rgba(255,255,255,0.06)", color: MUTED }}
          >
            ↻ Refresh
          </button>
        }
      />

      <p className="text-xs mb-3" style={{ color: MUTED }}>
        Background colour + header font are <span style={{ color: TEXT }}>locked per account</span> so ported images never cross-upload. Prices/demand fill in once the dynamic-pricing job runs.
      </p>

      {error && (
        <div className="text-xs p-3 rounded-lg" style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444" }}>
          Could not load porting feed: {error}
        </div>
      )}

      {!feed && !error && (
        <div className="space-y-3">
          {[...Array(2)].map((_, i) => <SkeletonBlock key={i} className="h-40 rounded-xl" />)}
        </div>
      )}

      {feed && (
        <div className="space-y-4">
          {feed.accounts
            .slice()
            .sort((a, b) => b.stats.rendered - a.stats.rendered)
            .map((a) => <AccountCard key={a.account} a={a} />)}
        </div>
      )}
    </Card>
  );
}
