"use client";

import Image from "next/image";
import { useState, useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

export type Kind = "ongoing" | "upcoming" | "pending";

export interface Rental {
  reservation_id: string;
  renter_name: string | null;
  account_slug: string;
  start_date: string | null;
  end_date: string | null;
  pickup_date?: string | null;
  pickup_time?: string | null;
  return_date?: string | null;
  return_time?: string | null;
  pickup_method?: string | null;
  return_method?: string | null;
  item_tiles?: Array<{
    name: string;
    image_url: string | null;
    qty: number;
    raw_name?: string;
    // 2026-05-24 — listing info pool fields (null when flag OFF or no row).
    info_pool_badge?: "manual" | "needs_review" | "llm" | null;
    product_id?: number | null;
  }>;
  // PASS-8: distinct-image tiles (deduped by image_url). First entry = master.
  item_image_tiles?: Array<{
    image_url: string;
    name: string;
    names_in_group: string[];
    qty: number;
  }>;
  // PASS-8: items with no resolved image (rendered as small text pills).
  extra_text_items?: string[];
  items: string[];
  photo_url?: string | null;
  master_image_url?: string | null;
  item_names_summary?: string | null;
  duration_days?: number | null;
  net_gbp?: number | null;
  order_step?: string | null;
  kind?: Kind;
  is_ongoing?: boolean;
}

interface Props {
  data: {
    total: number;
    ongoing_count: number;
    upcoming_count: number;
    pending_count: number;
    pending_value_gbp?: number;
    rentals: Rental[];
  };
}

export const ACCOUNT_PILL: Record<string, { bg: string; text: string }> = {
  dbcinema: { bg: "bg-blue-900/60 border border-blue-500/30", text: "text-blue-200" },
  leo:      { bg: "bg-amber-900/40 border border-amber-500/30", text: "text-amber-200" },
};

export const SECTION: Record<Kind, { label: string; color: string; bg: string; border: string; ring: string }> = {
  ongoing:  { label: "ONGOING",  color: "#f59e0b", bg: "bg-amber-500/5",  border: "border-amber-500/20",  ring: "shadow-[inset_3px_0_0_#f59e0b]" },
  upcoming: { label: "UPCOMING", color: "#a78bfa", bg: "bg-violet-500/5", border: "border-violet-500/20", ring: "shadow-[inset_3px_0_0_#a78bfa]" },
  pending:  { label: "PENDING",  color: "#ec4899", bg: "bg-pink-500/5",   border: "border-pink-500/20",   ring: "shadow-[inset_3px_0_0_#ec4899]" },
};

export const fmtDate = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric" }).format(new Date(d));

export const fmtTime = (t?: string | null) => {
  if (!t) return null;
  return t.length >= 5 ? t.slice(0, 5) : t;
};

// ── Phase 4: tile chip with edit affordance ───────────────────────────────
//
// Renders the canonical name chip + a small badge (🤖 / ✏️ / ⚠️) showing
// derivation provenance. Hover surfaces a pencil → opens edit modal that
// calls setManualOverride. Click the 🤖 badge → confirm re-derive prompt
// that calls forceReDerive.
//
// Renders identically to the legacy chip when info_pool_badge is null
// (flag OFF or no pool row), so this component is a drop-in replacement.

const BADGE_DEF: Record<"manual" | "needs_review" | "llm", { glyph: string; color: string; title: string }> = {
  manual: { glyph: "✏️", color: "#a78bfa", title: "manually overridden" },          // pencil
  needs_review: { glyph: "⚠️", color: "#fbbf24", title: "needs review" },           // warning
  llm: { glyph: "🤖", color: "#94a3b8", title: "LLM-derived (click to re-derive)" }, // robot
};

function ItemTileChip({
  tile,
  accountSlug,
}: {
  tile: NonNullable<Rental["item_tiles"]>[number];
  accountSlug: string;
}) {
  const [editing, setEditing] = useState(false);
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const forceReDerive = useMutation(api.listing_info_pool.forceReDerive);
  const badge = tile.info_pool_badge ? BADGE_DEF[tile.info_pool_badge] : null;
  const canEdit = !!tile.product_id; // pool wired only when product_id known

  const handleReDeriveClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!tile.product_id) return;
      if (!window.confirm(`Re-derive "${tile.name}" from the source title?\n\nThis will overwrite the LLM result with a fresh derivation but will NOT touch manual overrides.`)) {
        return;
      }
      setBusy(true);
      try {
        await forceReDerive({ account_slug: accountSlug, product_id: tile.product_id });
        // The poller / next render will pick up the fresh value once the
        // background action completes; nothing to do client-side.
      } finally {
        setBusy(false);
      }
    },
    [tile.product_id, tile.name, accountSlug, forceReDerive],
  );

  return (
    <>
      <span
        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-800/60 border border-slate-700 text-slate-300 group"
        title={tile.raw_name ?? tile.name}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {tile.name}
        {tile.qty > 1 && (
          <span className="ml-1 text-slate-500">×{tile.qty}</span>
        )}
        {badge && (
          <button
            type="button"
            className="ml-1 cursor-pointer"
            style={{ color: badge.color }}
            title={badge.title}
            onClick={tile.info_pool_badge === "llm" ? handleReDeriveClick : undefined}
            disabled={busy}
            aria-label={badge.title}
          >
            {badge.glyph}
          </button>
        )}
        {canEdit && (hover || editing) && (
          <button
            type="button"
            className="ml-1 text-slate-500 hover:text-slate-200"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            title="Edit canonical name + components"
            aria-label="Edit"
          >
            ✏
          </button>
        )}
      </span>
      {editing && tile.product_id && (
        <TileEditor
          accountSlug={accountSlug}
          productId={tile.product_id}
          initialDisplayName={tile.name}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

// ── Edit-in-place modal ───────────────────────────────────────────────────
//
// Two fields:
//   1. Display name (free text).
//   2. Bundle components (newline-separated list of canonical item names).
//      Each line is fuzzy-matched against the items table to resolve item_id.
//      Unresolvable lines are flagged inline; user can save with them
//      unresolved (the pool row stays needs_review).
//
// Calls listing_info_pool:setManualOverride. Override fields are per-field;
// unchanged inputs leave the existing override (or null) untouched.

function TileEditor({
  accountSlug,
  productId,
  initialDisplayName,
  onClose,
}: {
  accountSlug: string;
  productId: number;
  initialDisplayName: string;
  onClose: () => void;
}) {
  const current = useQuery(api.listing_info_pool.getEffective, {
    account_slug: accountSlug,
    product_id: productId,
  });
  const inventory = useQuery(api.items.listActive, {});
  const setOverride = useMutation(api.listing_info_pool.setManualOverride);

  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [componentsText, setComponentsText] = useState("");
  const [initialised, setInitialised] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Hydrate the editor with the latest effective view once it arrives.
  if (current && !initialised) {
    setDisplayName(current.display_name);
    setComponentsText(
      current.bundle_components
        .filter((c) => c.source_kind !== "comparison_reference")
        .map((c) => `${c.item_name_canonical ?? c.source_span ?? "(unknown)"}${c.qty > 1 ? ` x${c.qty}` : ""}`)
        .join("\n"),
    );
    setInitialised(true);
  }

  // Resolve each line to an item_id by case-insensitive canonical match.
  // Unmatched lines surface inline so the user sees them before saving.
  const resolvedLines = (() => {
    if (!inventory) return [] as Array<{ line: string; match: { id: Id<"items">; name: string } | null; qty: number }>;
    return componentsText
      .split("\n")
      .map((raw) => raw.trim())
      .filter((s) => s.length > 0)
      .map((line) => {
        // Extract trailing " x2" / " ×2" qty annotation.
        let qty = 1;
        let nameOnly = line;
        const m = line.match(/^(.*?)\s+[x×]\s*(\d+)\s*$/i);
        if (m) {
          nameOnly = m[1].trim();
          qty = Math.max(1, parseInt(m[2], 10) || 1);
        }
        const lc = nameOnly.toLowerCase();
        let best: { id: Id<"items">; name: string } | null = null;
        for (const it of inventory) {
          if (it.name.toLowerCase() === lc) {
            best = { id: it.id as Id<"items">, name: it.name };
            break;
          }
        }
        if (!best) {
          // Fuzzy: contains-match
          for (const it of inventory) {
            if (it.name.toLowerCase().includes(lc) || lc.includes(it.name.toLowerCase())) {
              best = { id: it.id as Id<"items">, name: it.name };
              break;
            }
          }
        }
        return { line: nameOnly, match: best, qty };
      });
  })();

  const allResolved = resolvedLines.length === 0 || resolvedLines.every((r) => r.match !== null);

  const onSave = async () => {
    setSaving(true);
    setErr(null);
    try {
      // Don't ship a bundle_summary; let the read-side derive it from display_name.
      const args: {
        account_slug: string;
        product_id: number;
        set_by: string;
        short_name?: string;
        bundle_summary?: string;
        bundle_components?: Array<{ item_id: Id<"items">; qty: number }>;
      } = {
        account_slug: accountSlug,
        product_id: productId,
        set_by: "dashboard-ui",
      };
      if (displayName.trim() !== (current?.display_name ?? "")) {
        // Split display into short_name + bundle_summary on the FIRST " + ".
        const idx = displayName.indexOf(" + ");
        if (idx > 0) {
          args.short_name = displayName.slice(0, idx).trim();
          args.bundle_summary = "+ " + displayName.slice(idx + 3).trim();
        } else {
          args.short_name = displayName.trim();
          args.bundle_summary = "";
        }
      }
      const components = resolvedLines
        .filter((r) => r.match !== null)
        .map((r) => ({ item_id: r.match!.id, qty: r.qty }));
      if (components.length > 0) {
        args.bundle_components = components;
      }
      await setOverride(args);
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100">
            Edit listing info
            <span className="ml-2 text-[10px] text-slate-500">
              {accountSlug}#{productId}
            </span>
          </h3>
          <button
            type="button"
            className="text-slate-500 hover:text-slate-200"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] uppercase tracking-wider text-slate-400">
            Display name
          </span>
          <input
            type="text"
            className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder='e.g. "Sony FX3 + 24-70mm GM"'
          />
          <span className="mt-1 block text-[10px] text-slate-500">
            Split at the first " + " into short_name + bundle_summary.
          </span>
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] uppercase tracking-wider text-slate-400">
            Bundle components (one per line)
          </span>
          <textarea
            className="h-32 w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100 font-mono"
            value={componentsText}
            onChange={(e) => setComponentsText(e.target.value)}
            placeholder={"Sony FX3\nSony GM 24-70mm f2.8\nAtomos Ninja V"}
          />
          <span className="mt-1 block text-[10px] text-slate-500">
            Each line matched against items table. Add " x2" for multi-unit
            (e.g. "Sony FX3 x2"). Unresolvable lines are flagged below.
          </span>
        </label>

        {!inventory ? (
          <div className="mb-3 text-[11px] text-slate-500">Loading inventory...</div>
        ) : resolvedLines.length > 0 && (
          <div className="mb-3 max-h-32 overflow-y-auto rounded border border-slate-800 p-2 text-[11px]">
            {resolvedLines.map((r, i) => (
              <div key={i} className="flex items-center gap-2 py-0.5">
                <span className={r.match ? "text-emerald-400" : "text-amber-400"}>
                  {r.match ? "✓" : "⚠"}
                </span>
                <span className="text-slate-300">
                  {r.line} {r.qty > 1 && <span className="text-slate-500">x{r.qty}</span>}
                </span>
                {r.match && (
                  <span className="text-slate-500">
                    → {r.match.name}
                  </span>
                )}
                {!r.match && (
                  <span className="text-amber-500">unresolved</span>
                )}
              </div>
            ))}
          </div>
        )}

        {!allResolved && (
          <div className="mb-3 rounded border border-amber-700 bg-amber-900/30 p-2 text-[11px] text-amber-300">
            Some lines unresolved. They will be dropped from the saved
            components list (but display_name is saved). To save them, add
            matching aliases in the items table or rename the lines.
          </div>
        )}
        {err && (
          <div className="mb-3 rounded border border-red-700 bg-red-900/30 p-2 text-[11px] text-red-300">
            {err}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save override"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RentalRow({ r }: { r: Rental }) {
  const kind: Kind = r.kind ?? (r.is_ongoing ? "ongoing" : "upcoming");
  const s = SECTION[kind];
  const pill = ACCOUNT_PILL[r.account_slug] ?? { bg: "bg-slate-800 border border-slate-700", text: "text-slate-300" };
  // PASS-7: v1-faithful multi-item display.
  // Backend (convex/dashboard.ts mapRental) ships `item_names_summary` as
  // the FULL comma-separated list of distinct items (with " ×N" suffix when
  // qty > 1, INSURANCE filtered). We render it verbatim — no truncation —
  // matching v1's `r.items.join(", ")` at dashboard-mobile.html:1275.
  // The legacy fallback (build from r.items[]) covers stale API responses
  // during deploys; it now joins ALL names rather than emitting "+N more".
  const summary = r.item_names_summary
    ?? (r.items.length > 0 ? r.items.join(", ") : "(no item)");
  // PASS-8: prefer item_image_tiles[0] (distinct-image dedup output) for
  // the master thumb. Fall back to legacy master_image_url for stale API.
  const imageTiles = r.item_image_tiles ?? [];
  const masterImg =
    imageTiles[0]?.image_url ?? r.master_image_url ?? r.photo_url ?? null;
  const masterAlt = imageTiles[0]?.name ?? summary;
  // Additional distinct-image tiles (skip master). Cap at 4 visible + "+N".
  const additionalTiles = imageTiles.slice(1);
  const MAX_VISIBLE_ADDL = 4;
  const visibleAddl = additionalTiles.slice(0, MAX_VISIBLE_ADDL);
  const hiddenAddlCount = Math.max(0, additionalTiles.length - MAX_VISIBLE_ADDL);
  // Items with no image — rendered as small text pills (up to 3 + "+N").
  const extraText = r.extra_text_items ?? [];
  const MAX_PILLS = 3;
  const visiblePills = extraText.slice(0, MAX_PILLS);
  const hiddenPillCount = Math.max(0, extraText.length - MAX_PILLS);

  return (
    <div
      className={`relative flex items-stretch gap-3 rounded-lg border ${s.border} ${s.bg} ${s.ring} px-2.5 py-2`}
    >
      {/* Master Thumbnail — v1 pattern (one 56x56 photo per rental).
          Rounding lives on the <img> so hover-zoom is not clipped. */}
      <div className="relative h-14 w-14 flex-shrink-0 rounded-md bg-slate-900/60 ring-1 ring-slate-800">
        {masterImg ? (
          <Image
            src={masterImg}
            alt={masterAlt}
            fill
            sizes="56px"
            className="object-cover rounded-md"
            unoptimized
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-600">
            no img
          </div>
        )}
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold text-slate-100 truncate">
            {r.renter_name ?? "—"}
          </span>
          {r.start_date && r.end_date && (
            <span className="text-[11px] text-slate-400">
              {fmtDate(r.start_date)} – {fmtDate(r.end_date)}
            </span>
          )}
          {r.duration_days != null && (
            <span className="text-[10px] text-slate-500">({r.duration_days}d)</span>
          )}
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${pill.bg} ${pill.text}`}>
            {r.account_slug}
          </span>
        </div>
        {/* PASS-8: additional distinct-image tiles (deduped by image_url).
            Rendered when >1 distinct images exist for the rental. Each tile
            is 40x40, rounded, hover-title shows all collapsed item names. */}
        {(visibleAddl.length > 0 || visiblePills.length > 0) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {visibleAddl.map((t) => (
              <div
                key={t.image_url}
                className="relative h-10 w-10 flex-shrink-0 rounded-md bg-slate-900/60 ring-1 ring-slate-800"
                title={t.names_in_group.join(", ")}
              >
                <Image
                  src={t.image_url}
                  alt={t.name}
                  fill
                  sizes="40px"
                  className="object-cover rounded-md"
                  unoptimized
                />
              </div>
            ))}
            {hiddenAddlCount > 0 && (
              <span
                className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-slate-800/60 text-[10px] font-semibold text-slate-300 ring-1 ring-slate-700"
                title={additionalTiles
                  .slice(MAX_VISIBLE_ADDL)
                  .flatMap((t) => t.names_in_group)
                  .join(", ")}
              >
                +{hiddenAddlCount}
              </span>
            )}
            {visiblePills.map((name) => (
              <span
                key={name}
                className="inline-flex items-center px-1.5 py-0.5 text-[10px] text-slate-400 border border-slate-700 rounded"
                title={name}
              >
                {name}
              </span>
            ))}
            {hiddenPillCount > 0 && (
              <span className="inline-flex items-center px-1 py-0.5 text-[10px] text-slate-400 border border-slate-700 rounded">
                +{hiddenPillCount}
              </span>
            )}
          </div>
        )}
        {/* Canonical inventory-matched item chips (was: comma-joined SEO
            summary). One chip per item from r.item_tiles, qty suffix when
            > 1. Falls back to the old single-line summary if item_tiles is
            empty (stale API responses during deploys).
            2026-05-24: chip rendering moved to ItemTileChip which adds the
            listing-info-pool badge + edit-in-place affordance when the per-
            account flag is ON (info_pool_badge non-null). When OFF, the
            chip renders identically to the pre-pool design. */}
        {r.item_tiles && r.item_tiles.length > 0 ? (
          <div
            className="mt-0.5 flex flex-wrap items-center gap-1"
            title={summary}
          >
            {r.item_tiles.map((t, i) => (
              <ItemTileChip
                key={`${t.name}-${i}`}
                tile={t}
                accountSlug={r.account_slug}
              />
            ))}
          </div>
        ) : (
          <div
            className="mt-0.5 text-[11px] leading-snug text-slate-300 truncate"
            title={summary}
          >
            {summary}
          </div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
          {(r.pickup_date || r.start_date) && (
            <span
              className="inline-flex items-center gap-1"
              style={{ color: r.pickup_time ? "#60a5fa" : "#64748b" }}
              title={r.pickup_method ? `pickup via ${r.pickup_method}` : undefined}
            >
              <span style={{ fontWeight: 700 }}>↓</span>
              {r.pickup_time ? (
                <span className="font-medium">{fmtTime(r.pickup_time)}</span>
              ) : (
                <span className="italic">no time</span>
              )}
              <span className="text-slate-500">·</span>
              <span>{fmtDate((r.pickup_date ?? r.start_date) as string)}</span>
              {/* Day-before pickup hint: renter arranged to collect the
                  evening before the rental starts. Highlights so it's
                  obvious in the active card that gear is out earlier. */}
              {r.pickup_date && r.start_date && r.pickup_date < r.start_date && (
                <span
                  className="text-[9px] font-bold px-1 rounded"
                  style={{ background: "rgba(139,92,246,0.22)", color: "#c4b5fd" }}
                  title="Pickup is the day BEFORE the rental window starts"
                >
                  −1d
                </span>
              )}
              {r.pickup_method === "delivery" && (
                <span className="text-[9px] px-1 rounded" style={{ background: "rgba(245,158,11,0.18)", color: "#fbbf24" }}>DEL</span>
              )}
            </span>
          )}
          {(r.return_date || r.end_date) && (
            <span
              className="inline-flex items-center gap-1"
              style={{ color: r.return_time ? "#60a5fa" : "#64748b" }}
              title={r.return_method ? `return via ${r.return_method}` : undefined}
            >
              <span style={{ fontWeight: 700 }}>↑</span>
              {r.return_time ? (
                <span className="font-medium">{fmtTime(r.return_time)}</span>
              ) : (
                <span className="italic">no time</span>
              )}
              <span className="text-slate-500">·</span>
              <span>{fmtDate((r.return_date ?? r.end_date) as string)}</span>
              {/* Morning-after return hint: renter is dropping off the next
                  day. The calendar holds the gear through this date. */}
              {r.return_date && r.end_date && r.return_date > r.end_date && (
                <span
                  className="text-[9px] font-bold px-1 rounded"
                  style={{ background: "rgba(139,92,246,0.22)", color: "#c4b5fd" }}
                  title="Return is the morning AFTER the rental window ends"
                >
                  +1d
                </span>
              )}
              {r.return_method === "delivery" && (
                <span className="text-[9px] px-1 rounded" style={{ background: "rgba(245,158,11,0.18)", color: "#fbbf24" }}>DEL</span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Price */}
      <div className="flex flex-col items-end justify-center">
        <div className="text-base font-bold text-emerald-400 tabular-nums">
          {r.net_gbp != null ? "£" + Math.round(r.net_gbp) : "—"}
        </div>
      </div>
    </div>
  );
}

export default function ActiveDrawer({ data }: Props) {
  const groups: Record<Kind, Rental[]> = { ongoing: [], upcoming: [], pending: [] };
  for (const r of data.rentals) {
    const k: Kind = r.kind ?? (r.is_ongoing ? "ongoing" : "upcoming");
    groups[k].push(r);
  }
  for (const k of Object.keys(groups) as Kind[]) {
    groups[k].sort((a, b) => {
      const ad = a.start_date ?? "";
      const bd = b.start_date ?? "";
      if (ad !== bd) return ad.localeCompare(bd);
      return (a.pickup_time ?? "99:99").localeCompare(b.pickup_time ?? "99:99");
    });
  }

  const sections: Array<{ kind: Kind; count: number }> = [
    { kind: "ongoing", count: data.ongoing_count },
    { kind: "upcoming", count: data.upcoming_count },
    { kind: "pending", count: data.pending_count },
  ];

  const anyRows = data.rentals.length > 0;

  if (!anyRows) {
    return <div className="text-xs text-slate-500 italic py-4 text-center">No active rentals.</div>;
  }

  return (
    <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
      {sections.map(({ kind, count }) => {
        const s = SECTION[kind];
        const rows = groups[kind];
        if (rows.length === 0) return null;
        return (
          <div key={kind} className="space-y-1.5">
            <div className="flex items-center gap-2 px-0.5">
              <span
                className="text-[11px] font-bold tracking-wider uppercase"
                style={{ color: s.color, textShadow: `0 0 8px ${s.color}40` }}
              >
                {s.label} ({count})
              </span>
            </div>
            <div className="space-y-1.5">
              {rows.map((r) => (
                <RentalRow key={r.reservation_id} r={r} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
