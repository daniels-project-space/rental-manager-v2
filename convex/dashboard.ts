import { query } from "./_generated/server";
import { v } from "convex/values";
import { infoPoolEnabledAccounts } from "./lib/feature_flags_helper";
import {
  dedupByLogicalRental,
  dedupKey,
  effectiveDate,
  isConfirmedWithDates,
  isLive,
  isOngoing,
  isPaidWithV1Legacy,
  isPendingVerification,
  isUpcoming,
  netOf,
  displayPickupDate,
  displayReturnDate,
  logicalGroupIds,
  type ReservationRow,
} from "./lib/reservations/predicates";
import { realisedMonthRevenue } from "./lib/reservations/monthRevenue";
import { londonToday } from "./lib/effectiveDates";
import { ACCOUNT_SLUGS } from "./lib/reservations/accounts";
import {
  resolveImageForReservationItem,
  buildSharedImageBlacklist,
  pickRepresentativeItem,
  normaliseItemName,
  type ImageHint,
} from "./lib/imageResolution";
import { effEnd as effEndImpl, effStart as effStartImpl } from "./lib/double_booking";
// Attribution engine (was gated by `use_new_attribution_engine` — Phase 6 cutover).
import {
  attributeRevenue,
  OWNER_SHARE as OWNER_SHARE_CANONICAL,
  type RentalForAttribution,
} from "./lib/revenue_attribution";
import {
  tieredCreditTotals,
  median as medianOfArray,
  type AiDecisionLite,
  type AiDecisionAuditLite,
} from "./lib/ai_attribution";
import { computeMissedRevenue } from "./lib/missed_revenue";

// ─────────────────────────────────────────────────────────────────────────────
// Shared item-tile builder (Phase 9 / FIX-DESIGN §4.5)
// Lifted out of getStatsDrawerData / getNextRentals to eliminate the previous
// duplication. Routes every image through resolveImageForReservationItem so
// catalogue-level cross-pollination (Pass-1 root cause) cannot leak into
// dashboard widgets.
// ─────────────────────────────────────────────────────────────────────────────
type TileSourceItem = {
  item_id?: string | null;
  item_name_canonical: string;
  qty?: number;
};
type ResolvedItemEntry = {
  item_id?: string | null;
  item_name_canonical: string;
  qty?: number;
  confidence?: number;
};
export type ItemTile = {
  name: string;
  image_url: string | null;
  qty: number;
};

/**
 * Build the per-tile array for one reservation row using the
 * resolveImageForReservationItem resolver. Null/undefined item_ids are NOT
 * collapsed into a single bucket — they are emitted as separate placeholder
 * tiles keyed by `__null_<index>` so unresolved items render individually
 * rather than disappearing into one merged row.
 */
export function buildItemTilesShared(args: {
  reservation: {
    image_hints?: ImageHint[] | null;
    expanded_items?: Array<TileSourceItem> | null;
    resolved_items?: Array<ResolvedItemEntry> | null;
    photos_urls?: string[] | null;
    account_slug?: string | null;
  };
  itemImageById: Map<string, { name: string; image_url: string | null }>;
  sharedBlacklist: Set<string>;
  // Phase 5.3: forward the priority-0 listing_images bank so the shared-helper
  // paths (getStatsDrawerData fallback, getNextRentals) stop bypassing it.
  bankByProduct?: Map<string, string>;
  // Resolve a hygglo product_id for one source item (by item_id + canonical
  // name). Caller owns the mapping (it has the reservation's hygglo_items).
  productIdForItem?: (item: TileSourceItem) => number | null;
}): ItemTile[] {
  const {
    reservation,
    itemImageById,
    sharedBlacklist,
    bankByProduct,
    productIdForItem,
  } = args;
  const accountSlug = reservation.account_slug ?? null;
  const imageHints: ImageHint[] = reservation.image_hints ?? [];
  const resolved: ResolvedItemEntry[] = reservation.resolved_items ?? [];

  // PASS-5 fix (2026-05-15): The Pass-4 round-robin fallback CAUSED visual
  // duplication on the live dashboard. When a rental had M items but only
  // N<M product photos (e.g. Isiaq Adeyemi: 3 items, 1 photo → 3 identical
  // tiles; Christian Asante: 4 items, 1 photo → 4 identical tiles), every
  // unresolved item got assigned the SAME repeating photo from the round
  // robin. User reported "items duplicating multiple times" because tiles
  // looked identical even though `alt` text differed.
  //
  // We now keep `image_url = null` when the per-item resolver returns null.
  // The frontend (ActiveDrawer.tsx, CalendarStrip, etc.) already renders a
  // distinctive 3-letter abbreviation placeholder for null URLs, which is
  // unique per item name and avoids the duplicate-photo illusion. This is
  // closer to v1 behavior (v1 showed "Item × qty" text with no per-item
  // image; the abbrev tile is a strict UX improvement).
  //
  // photos_urls is still received in args for forward compat / debugging
  // but is intentionally NOT used to manufacture fallback tile images.
  // (referenced once for typecheck — the field is preserved in the API.)
  void reservation.photos_urls;

  // Confidence lookup keyed by item_id (only resolved entries have it).
  const confidenceById = new Map<string, number>();
  for (const ri of resolved) {
    if (ri.item_id != null && typeof ri.confidence === "number") {
      confidenceById.set(ri.item_id, ri.confidence);
    }
  }

  // Prefer expanded_items (bundle-decomposed). Fall back to resolved_items
  // when the resolver hasn't run yet on this reservation.
  const expanded: TileSourceItem[] = reservation.expanded_items ?? [];
  const source: TileSourceItem[] =
    expanded.length > 0
      ? expanded
      : resolved.map((x) => ({
          item_id: x.item_id ?? null,
          item_name_canonical: x.item_name_canonical,
          qty: x.qty ?? 1,
        }));

  // Dedup by item_id; null/undefined item_ids get a unique synthetic key per
  // row so they stay as distinct placeholder tiles instead of merging into
  // one bogus "undefined" bucket.
  const counts = new Map<string, ItemTile>();
  source.forEach((x, idx) => {
    const hasItemId = x.item_id != null && x.item_id !== "";
    const dedupKey = hasItemId ? (x.item_id as string) : `__null_${idx}`;
    const inv = hasItemId ? itemImageById.get(x.item_id as string) : undefined;
    const name = inv?.name ?? x.item_name_canonical;

    const itemsTableEntry = inv ? { image_url: inv.image_url } : undefined;
    const resolvedConfidence = hasItemId
      ? confidenceById.get(x.item_id as string)
      : undefined;

    const resolved = resolveImageForReservationItem({
      imageHints,
      itemName: name,
      itemsTableEntry,
      resolvedConfidence,
      sharedBlacklist,
      // Phase 5.3: priority-0 bank now reached on the shared-helper paths.
      bankByProduct,
      accountSlug,
      productId: productIdForItem ? productIdForItem(x) : null,
    });

    // PASS-5 fix: no round-robin fallback. Null URLs render as per-item
    // abbreviation placeholders in the frontend, which are unique per item
    // name and never look duplicated.
    const finalUrl = resolved.url ?? null;

    const qty = x.qty ?? 1;
    const existing = counts.get(dedupKey);
    if (existing) {
      existing.qty += qty;
    } else {
      counts.set(dedupKey, { name, image_url: finalUrl, qty });
    }
  });
  return Array.from(counts.values());
}

// Local alias so existing call sites that name the helper *Str stay working.
const effectiveDateStr = effectiveDate;

const TODAY = () => new Date().toISOString().slice(0, 10);

const isoWeekBounds = () => {
  const now = new Date();
  const day = now.getDay();
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const mon = new Date(now);
  mon.setDate(now.getDate() + diffToMon);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { weekStart: mon.toISOString().slice(0, 10), weekEnd: sun.toISOString().slice(0, 10) };
};

const monthBounds = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  return { monthStart: start, monthEnd: end };
};

// ─────────────────────────────────────────────────────────────────────────────
// W02 Stats Drawer — single reactive query powering all 16 stat-card drawers.
//
// Pre-fetch strategy: one query, 5 collect() calls total (reservations, items,
// denial_records, owner_unavailability, sync_state). All 16 card payloads are
// derived from these in-memory with zero extra round-trips.
//
// Cards with no real data source return placeholder zeros / empty arrays;
// each is marked TODO so callers can render empty-state gracefully.
// ─────────────────────────────────────────────────────────────────────────────

/** Order steps that represent a live paid/active booking (non-obsolete). */
const ACTIVE_ORDER_STEPS = new Set([
  "FUNDS_RESERVED",
  "VERIFIED",
  "BOOKED_AFTER_VERIFIED",
  "DELIVERED",
  "RETURNED",
  "REVIEWED",
]);

export const getStatsDrawerData = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    // Phase 7d (2026-05-24): when true, skip the mv_stats_drawer lookup and
    // run the live compute below. Set ONLY by mv/stats_drawer.ts:refreshAll
    // so the refresher avoids an infinite loop (MV reader → MV → ... ).
    // Public callers should leave this undefined; the shim runs the cached
    // path by default.
    _bypassMv: v.optional(v.boolean()),
  },
  handler: async (ctx, { accountSlug, _bypassMv }) => {
    if (!_bypassMv) {
      // Phase 7d cached path: read the mv_stats_drawer row written hourly
      // by master.refreshFast. Falls through to live compute below when the
      // row is missing (cold-start window after deploy or after table wipe).
      const accountKey = accountSlug ?? "all";
      const cached = await ctx.db
        .query("mv_stats_drawer")
        .withIndex("by_account", (q) => q.eq("account", accountKey))
        .first();
      if (cached) {
        // Re-apply conflict dismissals at READ time so clicking "Resolve" clears
        // the card instantly. The cached MV payload is rebuilt only on
        // reservation mutations (not on a dismissal), so without this a resolved
        // conflict would linger until the next MV refresh.
        const dismissedNow = new Set(
          (await ctx.db.query("conflict_dismissals").collect()).map((d) => d.conflict_key),
        );
        const applyDismissals = (p: unknown): unknown => {
          const pp = p as { conflicts?: Array<{ conflict_key: string }> } | null;
          if (!pp || !Array.isArray(pp.conflicts) || dismissedNow.size === 0) return p;
          return {
            ...(pp as Record<string, unknown>),
            conflicts: pp.conflicts.filter((c) => !dismissedNow.has(c.conflict_key)),
          };
        };
        // Pass 13c (2026-05-26): skip the 3-row sync_state overlay when the
        // cached scanner snapshot is < 5 min old. Was costing ~6KB × 17000
        // reads/day = ~100MB/day in unnecessary indexed lookups. The
        // "stale poller" warning fires at 30+ min staleness, so a 5-min
        // freshness threshold preserves the alert behaviour while
        // eliminating the overlay on most reads.
        const cachedPayloadPeek = cached.payload as { scanner?: { last_scan_at?: number | null } } | null;
        const cachedScanAt = cachedPayloadPeek?.scanner?.last_scan_at ?? null;
        const SCANNER_OVERLAY_SKIP_MS = 5 * 60 * 1000;
        if (cachedScanAt && Date.now() - cachedScanAt < SCANNER_OVERLAY_SKIP_MS) {
          return applyDismissals(cached.payload);
        }
        // Scanner card needs real-time freshness (drives the "stale poller"
        // warning). Overlay the cached payload with fresh sync_state reads
        // so the widget reflects actual seconds-ago, not last-MV-refresh-ago.
        const [pRow, bRow, cRow] = await Promise.all([
          ctx.db.query("sync_state").withIndex("by_source", (q) => q.eq("source", "hygglo_poller")).first(),
          ctx.db.query("sync_state").withIndex("by_source", (q) => q.eq("source", "hygglo_backup_poller")).first(),
          ctx.db.query("sync_state").withIndex("by_source", (q) => q.eq("source", "hygglo_cron")).first(),
        ]);
        const candidates: Array<{ source: string; lastRunAt: number }> = [
          pRow && { source: "hygglo_poller", lastRunAt: pRow.lastRunAt },
          bRow && { source: "hygglo_backup_poller", lastRunAt: bRow.lastRunAt },
          cRow && { source: "hygglo_cron", lastRunAt: cRow.lastRunAt },
        ].filter(Boolean) as Array<{ source: string; lastRunAt: number }>;
        const winning = candidates.length > 0
          ? candidates.reduce((a, b) => (a.lastRunAt >= b.lastRunAt ? a : b))
          : null;
        const cachedPayload = cached.payload as Record<string, unknown>;
        const cachedScanner = (cachedPayload.scanner ?? {}) as Record<string, unknown>;
        // Match the live shape verbatim — same field names + types as the
        // legacy compute (line ~1336 of this file).
        const freshScanner = {
          last_scan_at: winning?.lastRunAt ?? cachedScanner.last_scan_at ?? null,
          last_scan_source: winning?.source ?? cachedScanner.last_scan_source ?? null,
          last_run_succeeded: pRow?.lastRunSucceeded ?? cachedScanner.last_run_succeeded ?? null,
          rows_upserted_last: pRow?.rowsUpserted?.reservations ?? 0,
        };
        return applyDismissals({ ...cachedPayload, scanner: freshScanner });
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    // London-business "today" — used ONLY for ACTIVE-rental membership
    // (ongoing/upcoming), so the Active tab classifies a rental on the same
    // calendar day the strip/calendar do (which now also use London). The
    // UTC `today` above stays the day basis for REVENUE/earnings attribution so
    // money-day boundaries are not silently shifted.
    const activeToday = londonToday();
    const now = new Date();

    // ── Week bounds ──────────────────────────────────────────────
    const dayOfWeek = now.getDay();
    const diffToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monDate = new Date(now);
    monDate.setDate(now.getDate() + diffToMon);
    const weekStart = monDate.toISOString().slice(0, 10);
    const sunDate = new Date(monDate);
    sunDate.setDate(monDate.getDate() + 6);
    const weekEnd = sunDate.toISOString().slice(0, 10);

    // ── Month bounds ─────────────────────────────────────────────
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = now.getDate();
    const daysRemaining = daysInMonth - daysElapsed;

    // ── Next-30-day window for out-of-stock calc ─────────────────
    const next30 = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);

    // ── COLLECT 1: reservations (indexed last 365d) ──────────────
    // Stat cards display current month + active + earnings (today/week/month).
    // YTD + lifetime-trend widgets pull their own MV/lifetime data; this
    // query never returns pre-365d totals. Indexed read drops ~1767 → ~250.
    const dashCutoff = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 365);
      return d.toISOString().slice(0, 10);
    })();
    const allResRaw = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", dashCutoff))
      .collect();
    // Account-scoped view for per-card numbers (active, earnings, monthly, etc.)
    let allRes = allResRaw;
    if (accountSlug) {
      allRes = allResRaw.filter((r) => r.account_slug === accountSlug);
    }
    // Cross-account view for double-booking detection.
    const allResCrossAccount = allResRaw;

    // ── COLLECT 2: items ─────────────────────────────────────────
    let allItems = await ctx.db.query("items").collect();
    if (accountSlug) {
      // items are cross-account; no slug filter needed for inventory_worth
      // but keep full list for out-of-stock which is also cross-account
    }
    const activeItems = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);

    // Phase 12.3: listing_images bank — product_id-keyed canonical photos.
    // Fetched once here, looked up per-rental in mapRental.useHygglo branch.
    const listingImagesRaw = await ctx.db.query("listing_images").collect();
    const bankByProduct = new Map<string, string>(); // key: `${account_slug}#${product_id}` → image_url
    for (const li of listingImagesRaw) {
      bankByProduct.set(`${li.account_slug}#${li.product_id}`, li.image_url);
    }

    // Per-Hygglo-product short canonical names (2026-05-23). Keyed by
    // `${account_slug}#${product_id}`. Looked up per item_tiles entry in
    // mapRental.useHygglo to replace SEO-stuffed Hygglo titles with the
    // canonical short form. Missing entries fall back to the raw name.
    const shortNameRows = await ctx.db.query("listing_short_names").collect();
    const shortNameByProduct = new Map<string, string>();
    for (const sn of shortNameRows) {
      shortNameByProduct.set(`${sn.account_slug}#${sn.product_id}`, sn.short_name);
    }

    // ── Listing info pool (2026-05-24) ──
    // Per-account opt-in via feature_flag `listing_info_pool:<slug>`.
    // When the flag is ON, display reads pool.display_name (which
    // includes bundle suffix like "+ 24-70mm GM"). When OFF, the
    // legacy listing_short_names path runs verbatim — see
    // mapRental.useHygglo below.
    const candidateSlugs = Array.from(new Set(
      allRes.map((r) => r.account_slug).filter((s): s is string => !!s)
    ));
    const poolEnabledAccounts = await infoPoolEnabledAccounts(ctx, candidateSlugs);
    const infoPoolByProduct = new Map<string, { display_name: string; needs_review: boolean; is_manually_overridden: boolean }>();
    /** components[] for double-booking + out-of-stock. Key
     *  `${slug}#${pid}` -> [{item_id, qty}]. Includes ONLY components with
     *  a resolved item_id (the equivalence guarantee). Excludes
     *  comparison_reference + standard_included so accessories never
     *  contribute to capacity conflicts. */
    const infoPoolComponentsByProduct = new Map<string, Array<{ item_id: string; qty: number }>>();
    if (poolEnabledAccounts.size > 0) {
      const poolRows = await ctx.db.query("listing_info_pool").collect();
      for (const pr of poolRows) {
        if (!poolEnabledAccounts.has(pr.account_slug)) continue;
        const mo = pr.manual_override;
        const sn = mo?.short_name ?? pr.short_name;
        const bs = mo?.bundle_summary !== undefined ? mo.bundle_summary : (pr.bundle_summary ?? null);
        const display = bs ? `${sn} ${bs}`.replace(/\s+/g, " ").trim() : sn;
        infoPoolByProduct.set(`${pr.account_slug}#${pr.product_id}`, {
          display_name: display,
          needs_review: pr.needs_review,
          is_manually_overridden: !!mo,
        });
        // Component map (equivalence semantics). Manual override component
        // list, if present, wins over the LLM derivation.
        const moComps = mo?.bundle_components;
        const comps: Array<{ item_id: string; qty: number }> = [];
        if (moComps && moComps.length > 0) {
          for (const c of moComps) comps.push({ item_id: String(c.item_id), qty: c.qty });
        } else {
          for (const c of pr.bundle_components) {
            if (!c.item_id) continue;
            if (c.source_kind === "comparison_reference") continue;
            if (c.source_kind === "standard_included") continue;
            comps.push({ item_id: String(c.item_id), qty: c.qty });
          }
        }
        if (comps.length > 0) {
          infoPoolComponentsByProduct.set(`${pr.account_slug}#${pr.product_id}`, comps);
        }
      }
    }

    // ── COLLECT 3: denial_records ────────────────────────────────
    let denialRows = await ctx.db.query("denial_records").collect();
    if (accountSlug) {
      // denial_records only have account_id; resolve via accounts if needed
      // (slug filter applied below per-card — keep full list here)
    }

    // ── COLLECT 4: owner_unavailability ─────────────────────────
    const unavailRows = await ctx.db.query("owner_unavailability").collect();

    // ── COLLECT 5: sync_state ─────────────────────────────────────
    // Fetch all three poller sources in parallel and pick max(lastRunAt) so
    // the scanner card reflects the most recent successful scan regardless
    // of which layer (primary Trigger.dev / backup poller / cron heartbeat)
    // ran last.
    const [primaryRow, backupRow, cronRow] = await Promise.all([
      ctx.db.query("sync_state").withIndex("by_source", (q) => q.eq("source", "hygglo_poller")).first(),
      ctx.db.query("sync_state").withIndex("by_source", (q) => q.eq("source", "hygglo_backup_poller")).first(),
      ctx.db.query("sync_state").withIndex("by_source", (q) => q.eq("source", "hygglo_cron")).first(),
    ]);
    const syncRow = primaryRow; // preserve legacy fields (lastRunSucceeded, rowsUpserted) from primary poller
    const scanCandidates: Array<{ source: string; lastRunAt: number }> = [
      primaryRow && { source: "hygglo_poller", lastRunAt: primaryRow.lastRunAt },
      backupRow && { source: "hygglo_backup_poller", lastRunAt: backupRow.lastRunAt },
      cronRow && { source: "hygglo_cron", lastRunAt: cronRow.lastRunAt },
    ].filter(Boolean) as Array<{ source: string; lastRunAt: number }>;
    const winningScan = scanCandidates.length > 0
      ? scanCandidates.reduce((a, b) => (a.lastRunAt >= b.lastRunAt ? a : b))
      : null;

    // ── COLLECT 6: insurance_claims (account-scoped) ──────────────
    let claimRows = accountSlug
      ? await ctx.db
          .query("insurance_claims")
          .withIndex("by_account", (q) => q.eq("account_slug", accountSlug))
          .collect()
      : await ctx.db.query("insurance_claims").collect();
    claimRows = claimRows.slice().sort((a, b) => (a.claim_date < b.claim_date ? 1 : a.claim_date > b.claim_date ? -1 : 0));

    // Units currently OUT ON REPAIR per item. Every open (non-terminal) case
    // holds its repair_item_ids, reducing effective availability until closed.
    // Cross-account (inventory is shared) so collect all claims.
    const REPAIR_TERMINAL = new Set(["added_to_revenue", "denied"]);
    const repairByItem = new Map<string, number>();
    for (const c of await ctx.db.query("insurance_claims").collect()) {
      const st = c.stage ?? (c.status === "denied" ? "denied" : c.status === "settled" ? "added_to_revenue" : "case_opened");
      if (REPAIR_TERMINAL.has(st)) continue;
      for (const iid of ((c as { repair_item_ids?: string[] }).repair_item_ids ?? [])) {
        repairByItem.set(iid as string, (repairByItem.get(iid as string) ?? 0) + 1);
      }
    }

    // ── COLLECT 7: conflict_dismissals (owner-resolved alerts) ────
    const dismissedKeys = new Set<string>(
      (await ctx.db.query("conflict_dismissals").collect()).map((d) => d.conflict_key),
    );

    // ── COLLECT 8: hygglo_product_index — deterministic product_id→item_id ─
    // Bootstrapped from history (admin_bootstrap_pidindex). When present,
    // overrides the LLM resolver's per-position guess. Closes the keyword-
    // bleed hole where listings containing "(same sensor as a7s iii)" would
    // hallucinate a Sony A7 III line even though only Sony FX3 was rented.
    const productIndexRows = await ctx.db.query("hygglo_product_index").collect();
    const productIndex = new Map<string, string>();
    for (const row of productIndexRows) {
      productIndex.set(`${row.account_slug}:${row.product_id}`, String(row.item_id));
    }

    /**
     * Structural sanity check for LLM-resolved item names. Strips parentheticals
     * containing comparison keywords ("same sensor as ...", "like ...") then
     * looks for any model-identifier token of the canonical name in the cleaned
     * titles. Used as a per-position filter in expandedIdsOf so spurious LLM
     * picks driven by marketing copy don't enter the conflict graph.
     */
    function stripParentheticalComparisons(s: string): string {
      return s.replace(
        /\([^)]*\b(same|like|equivalent|comparable|as good as|similar|alternative)\b[^)]*\)/gi,
        " ",
      );
    }
    function modelTokensOf(name: string): string[] {
      const out = new Set<string>();
      const re = /\b([a-z]+\d+\w*|[a-z]+\s*[ivx]{1,4}\b|\d+\.\d+|\d+[a-z]+)/gi;
      for (const m of name.toLowerCase().matchAll(re)) {
        out.add(m[1].replace(/\s+/g, ""));
      }
      return Array.from(out);
    }
    function passesNameSanityCheck(
      canonical: string,
      titles: Array<{ name?: string }>,
    ): boolean {
      const toks = modelTokensOf(canonical);
      if (toks.length === 0) return true; // no discriminating tokens — accept
      const cleaned = titles
        .map((t) => stripParentheticalComparisons(t.name ?? "").toLowerCase().replace(/\s+/g, ""))
        .filter((s) => s.length > 0);
      return toks.some((t) => cleaned.some((c) => c.includes(t)));
    }

    // ────────────────────────────────────────────────────────────
    // Derived sets from reservations
    // ────────────────────────────────────────────────────────────

    // Confirmed (non-obsolete, non-cancelled) with dates
    const confirmedWithDates = allRes.filter(
      (r) =>
        r.status === "confirmed" &&
        !r.is_obsolete &&
        r.start_date !== undefined &&
        r.end_date !== undefined,
    );

    // Active = ongoing + upcoming (from confirmed set).
    // ongoing = gear is out today or overdue (start has happened); upcoming =
    // gear not yet picked up (start is future). We deliberately drop the
    // end>=today constraint on ongoing so DELIVERED rentals whose end_date
    // has passed but owner hasn't yet marked RETURNED still appear as
    // ongoing/overdue — mirrors Hygglo's filter=future bucket.
    type ResRow = typeof allRes[number];
    const dedupRes = <T extends ResRow>(arr: T[]): T[] => dedupByLogicalRental(arr);

    const ongoingRentals = allRes.filter((r) => isOngoing(r as ResRow, activeToday));
    const upcomingRentals = allRes.filter((r) => isUpcoming(r as ResRow, activeToday));

    // "Paid" = live (not cancelled/declined/obsolete). Revenue candidate pool.
    const paidRes = allRes.filter(
      (r) => r.status !== "cancelled" && r.status !== "declined" && !r.is_obsolete,
    );

    const ongoingUniq = dedupRes(ongoingRentals);
    const upcomingUniq = dedupRes(upcomingRentals);

    // ── Logical-rental merge (DISPLAY/COUNT only) ───────────────────────────
    // Contiguous same-renter + same-item bookings collapse into ONE "large
    // rental": counted once and listed once, spanning the whole period with the
    // members' £ summed. Earnings/revenue rollups elsewhere stay on RAW rows so
    // totals never change — only the rental COUNT collapses.
    const activeGroupId = logicalGroupIds(confirmedWithDates as unknown as ReservationRow[]);
    const activeGroups = new Map<string, ResRow[]>();
    for (const r of dedupRes(confirmedWithDates)) {
      const gid = activeGroupId.get(r._id) ?? r._id;
      const arr = activeGroups.get(gid);
      if (arr) arr.push(r);
      else activeGroups.set(gid, [r]);
    }
    // One synthetic representative row per group: earliest member as the base
    // (items / renter / image), effective return extended to the merged span end
    // and net = Σ members (so the card shows the full period + total £); status
    // reflects whichever member is live today.
    const mergedActiveRows: ResRow[] = Array.from(activeGroups.values()).map((members) => {
      const sorted = members
        .slice()
        .sort((a, b) =>
          displayPickupDate(a as ReservationRow).localeCompare(displayPickupDate(b as ReservationRow)),
        );
      const base = sorted[0];
      let spanEnd = displayReturnDate(base as ReservationRow);
      let netSum = 0;
      for (const m of sorted) {
        const e = displayReturnDate(m as ReservationRow);
        if (e > spanEnd) spanEnd = e;
        netSum += netOf(m as ReservationRow);
      }
      const live =
        sorted.find(
          (m) =>
            displayPickupDate(m as ReservationRow) <= activeToday &&
            displayReturnDate(m as ReservationRow) >= activeToday,
        ) ?? base;
      return {
        ...base,
        return_date: spanEnd,
        net_to_owner_gbp: netSum,
        order_step: (live as { order_step?: string }).order_step,
      } as ResRow;
    });
    const ongoingGroupRows = mergedActiveRows.filter((r) => isOngoing(r as ReservationRow, activeToday));
    const upcomingGroupRows = mergedActiveRows.filter((r) => isUpcoming(r as ReservationRow, activeToday));

    // Monthly confirmed bookings (deduped) — confirmed status only, used for the
    // "still going" segments (done-via-date / active / upcoming).
    const monthConfirmedRentals = dedupRes(
      confirmedWithDates.filter((r) => {
        const d = effectiveDateStr(r);
        return d !== undefined && d >= monthStart && d <= monthEnd;
      }),
    );

    // Monthly booked rentals = everything non-cancelled (confirmed OR completed)
    // whose effective date falls in the month. v1 parity: a returned rental
    // still counts toward "Month Confirmed" revenue.
    //
    // SOURCE OF TRUTH: derived from `realisedMonthRevenue` in
    // lib/reservations/monthRevenue.ts. The same helper backs the lifetime
    // chart's current-month per-renter buckets, so the Month Confirmed tile
    // and the live-month bar cannot drift.
    const _currentMonthKey = monthStart.slice(0, 7);
    const monthBookedRentals = realisedMonthRevenue(
      allRes as unknown as ResRow[],
      _currentMonthKey,
      accountSlug,
    ).rentals;

    // Revenue slices — net_to_owner_gbp, deduped per rental.
    //
    // Pass 16a (2026-05-26): the "Earnings Today" widget should reflect
    // money from rentals that have ACTUALLY been picked up that day, not
    // just rentals whose start_date happens to be today (which inflates
    // the number with bookings still sitting in REQUEST / APPROVED /
    // FUNDS_RESERVED / VERIFIED — pre-handover). Gating by order_step
    // brings the number in line with what Daniel sees as "earned cash":
    // gear is with the renter, the rental is realised.
    //
    // PICKED_UP_STEPS = post-handover steps. BOOKED_AFTER_VERIFIED is
    // included because Hygglo applies it the moment escrow lands AFTER
    // a verification handshake — at that point the rental is committed
    // and the handover follows immediately (same-day or next-morning).
    // DELIVERED is the explicit "renter has the gear" marker.
    const PICKED_UP_STEPS = new Set([
      "BOOKED_AFTER_VERIFIED",
      "DELIVERED",
      "RETURNED",
      "REVIEWED",
    ]);
    const isPickedUp = (r: { order_step?: string }): boolean =>
      typeof r.order_step === "string" && PICKED_UP_STEPS.has(r.order_step);
    const earnedPaid = dedupRes(
      paidRes.filter((r) => {
        const d = effectiveDateStr(r);
        if (d === undefined || d > today) return false;
        return isPickedUp(r as { order_step?: string });
      }),
    );
    const todayEarned = earnedPaid.filter((r) => effectiveDateStr(r) === today);
    const weekEarned = earnedPaid.filter((r) => {
      const d = effectiveDateStr(r) as string;
      return d >= weekStart && d <= weekEnd;
    });
    const monthEarned = earnedPaid.filter((r) => {
      const d = effectiveDateStr(r) as string;
      return d >= monthStart && d <= monthEnd;
    });

    // netOf imported from predicates.
    const todayTotal = todayEarned.reduce((s, r) => s + netOf(r), 0);
    const weekTotal = weekEarned.reduce((s, r) => s + netOf(r), 0);
    const monthTotal = monthEarned.reduce((s, r) => s + netOf(r), 0);

    // Per-account earnings breakdown (net)
    const accountSlugs = [...new Set(allRes.map((r) => r.account_slug).filter(Boolean))] as string[];
    const byAccount = accountSlugs.map((slug) => {
      const todayAcc = todayEarned
        .filter((r) => r.account_slug === slug)
        .reduce((s, r) => s + netOf(r), 0);
      const weekAcc = weekEarned
        .filter((r) => r.account_slug === slug)
        .reduce((s, r) => s + netOf(r), 0);
      return { account_slug: slug, today: Math.round(todayAcc * 100) / 100, week: Math.round(weekAcc * 100) / 100 };
    });

    // Month projection (net)
    const avgDailyRate = daysElapsed > 0 ? monthTotal / daysElapsed : 0;
    const bookedFutureUniq = dedupRes(
      confirmedWithDates.filter((r) => {
        const d = r.start_date as string;
        return d > today && d >= monthStart && d <= monthEnd;
      }),
    );
    const bookedFuture = bookedFutureUniq.reduce((s, r) => s + netOf(r), 0);
    const projected = Math.round(monthTotal + bookedFuture + avgDailyRate * daysRemaining);

    // ── card: active ─────────────────────────────────────────────
    // V1 PARITY: count unique rentals; expose ongoing/upcoming/pending split
    // for segmented bar visualisation.
    //
    // "Pending" = renter has paid (escrow funds reserved) AND is currently in
    // the ID/document verification stage. order_step represents the renter's
    // NEXT-TO-DO step. So:
    //   order_step === REQUEST          → owner needs to accept (renter waiting)  — not pending
    //   order_step === APPROVED         → renter needs to accept owner's terms     — not pending
    //   order_step === FUNDS_RESERVED   → renter needs to pay (not paid yet)        — not pending
    //   order_step === VERIFIED         → renter is currently verifying (paid ✓)    ← PENDING
    //   order_step === BOOKED_AFTER_VERIFIED → verified, awaiting handover          — confirmed
    //   later steps → already booked / out / done
    const pendingRes = allRes.filter((r) => isPendingVerification(r as ResRow));
    const pendingUniq = dedupRes(pendingRes);
    const pendingCount = pendingUniq.length;
    const pendingValueGbp = pendingUniq.reduce((s, r) => s + netOf(r), 0);
    const activeTotal = ongoingGroupRows.length + upcomingGroupRows.length;
    // ── UNTRACKED ITEM DETECTION (LLM-resolved) ────────────────
    // A reservation is "untracked" when its LLM-resolved items list is empty
    // OR resolution hasn't run yet AND items[] is non-empty. This replaces
    // the previous fuzzy substring matcher which conflated A7 II / A7 III
    // (any model-number disambiguation). Resolution is owned by the action
    // `item_resolver:resolveReservation` (see convex/item_resolver.ts) which
    // calls Grok 4.3 with strict instructions to respect II/III/Mk2/Mk3 etc.
    type ExpandedItem = { item_id: string; item_name_canonical: string; qty: number; via_bundle?: string };
    type ResolvedItem = { item_id: string; item_name_canonical: string; confidence: number; qty?: number };
    type HyggloItemSlim = { name?: string; product_id?: number; qty?: number };
    /**
     * Per-reservation item lookup used by conflict / untracked / sell-reco.
     *
     * Resolution priority (high → low):
     *   1. Per-position product_id → item_id from hygglo_product_index.
     *      This is the deterministic ground truth — Hygglo's product_id is
     *      a stable listing identifier, and the bootstrapped index covers
     *      every product_id whose history resolves unambiguously.
     *   2. Per-position resolved_items[i] from the LLM, IF its canonical
     *      name tokens actually appear in the listing title with comparison
     *      parentheticals stripped. Catches the marketing-copy bleed (e.g.
     *      "Sony FX 3 (same sensor as a7s iii)" must not pull in A7 III).
     *   3. Expanded_items[] (bundle-decomposed) — used only when no index
     *      coverage AND no positional resolved_items (e.g. v1 imports).
     */
    function expandedIdsOf(r: ResRow): Map<string, number> {
      const hItems = ((r as { hygglo_items?: HyggloItemSlim[] }).hygglo_items) ?? [];
      const resolved = ((r as { resolved_items?: ResolvedItem[] }).resolved_items) ?? [];
      const expanded = ((r as { expanded_items?: ExpandedItem[] }).expanded_items) ?? [];
      const accountSlug = (r as { account_slug?: string }).account_slug ?? "";

      // Path A: per-position resolution using hygglo_items[] when present.
      if (hItems.length > 0) {
        const out = new Map<string, number>();
        let allPositionsResolved = true;
        for (let i = 0; i < hItems.length; i++) {
          const h = hItems[i];
          const q = typeof h.qty === "number" && h.qty > 0 ? h.qty : 1;
          // (A.5) Listing info pool components, gated by per-account flag.
          // When the pool has multiple resolved components for this
          // product_id, ALL contribute to capacity tally (×listing-qty).
          // Sanity guard: when hygglo_product_index also covers the
          // product_id, pool's primary_item_id must match it; otherwise
          // we skip pool and fall through to the legacy LLM path
          // (qty_drift_alerts entry would be the follow-up — out of scope
          // for the flag-flip Phase 3 commit).
          if (typeof h.product_id === "number") {
            const comps = infoPoolComponentsByProduct.get(`${accountSlug}#${h.product_id}`);
            if (comps && comps.length > 0) {
              const indexItemId = productIndex.get(`${accountSlug}:${h.product_id}`);
              const primary = comps[0]?.item_id;
              const sanityOk = !indexItemId || indexItemId === primary;
              if (sanityOk) {
                for (const c of comps) {
                  // Multiply by listing-level qty from the line.
                  out.set(c.item_id, (out.get(c.item_id) ?? 0) + c.qty * q);
                }
                continue;
              }
            }
          }
          // (1) product_id index.
          if (typeof h.product_id === "number") {
            const itemId = productIndex.get(`${accountSlug}:${h.product_id}`);
            if (itemId) {
              out.set(itemId, (out.get(itemId) ?? 0) + q);
              continue;
            }
          }
          // (2) LLM resolved_items[i] with structural sanity check.
          const ri = resolved[i];
          if (ri) {
            // Check the name against THIS listing position only. Passing all
            // hItems let a resolved_items[i] that is misaligned with the
            // hygglo_items[] positions (longer resolved[] on bundle rows) match
            // because its name appeared in SOME other listing — double-counting
            // that item (e.g. an FX3 counted once via its own listing and again
            // via a gimbal listing position). Position-scoped check fixes it.
            if (passesNameSanityCheck(ri.item_name_canonical, [hItems[i]])) {
              const qty = ri.qty ?? q;
              out.set(String(ri.item_id), (out.get(String(ri.item_id)) ?? 0) + qty);
              continue;
            }
          }
          allPositionsResolved = false;
        }
        // If every position resolved via (1)/(2), trust this output.
        if (allPositionsResolved && out.size > 0) return out;
        // Partial coverage: also return what we have. The conflict path
        // tolerates missing items (they fall into the untracked bucket).
        if (out.size > 0) return out;
      }

      // Path B: legacy fallback for rows without hygglo_items[] (v1 imports).
      // Trust expanded_items (bundle-decomposed) when present, else resolved.
      if (expanded.length > 0) {
        const m = new Map<string, number>();
        for (const x of expanded) m.set(x.item_id, (m.get(x.item_id) ?? 0) + x.qty);
        return m;
      }
      const m = new Map<string, number>();
      for (const x of resolved) m.set(x.item_id, (m.get(x.item_id) ?? 0) + (x.qty ?? 1));
      return m;
    }
    function resolvedIdsOf(r: ResRow): Set<string> {
      return new Set(expandedIdsOf(r).keys());
    }
    function isResolved(r: ResRow): boolean {
      return (r as { resolved_items?: ResolvedItem[] }).resolved_items !== undefined;
    }
    function isTracked(r: ResRow): boolean {
      const ids = resolvedIdsOf(r);
      if (ids.size === 0) return false;
      // ids must reference an active item we currently have.
      for (const id of ids) {
        if (activeItemIds.has(id)) return true;
      }
      return false;
    }
    const activeItemIds = new Set<string>(activeItems.map((i) => i._id as string));
    const pendingTracked: typeof pendingUniq = [];
    const pendingUntracked: typeof pendingUniq = [];
    const pendingUnresolved: typeof pendingUniq = []; // resolver hasn't run yet — count as tracked-by-default to avoid scaring the owner
    for (const r of pendingUniq) {
      if (!isResolved(r as ResRow)) pendingUnresolved.push(r);
      else if (isTracked(r as ResRow)) pendingTracked.push(r);
      else pendingUntracked.push(r);
    }
    // Pending that are unresolved are counted as tracked optimistically — the
    // resolver cron will reclassify them shortly. This keeps the headline
    // pending number stable until the LLM has caught up.
    pendingTracked.push(...pendingUnresolved);
    const untrackedPayload = {
      count: pendingUntracked.length,
      total_value_gbp: Math.round(pendingUntracked.reduce((s, r) => s + netOf(r), 0) * 100) / 100,
      reservations: pendingUntracked.slice(0, 10).map((r) => ({
        reservation_id: r.v1_rental_id ?? r.hygglo_order_id ?? r._id,
        renter_name: r.renter_name ?? null,
        account_slug: r.account_slug ?? "",
        start_date: r.start_date ?? null,
        end_date: r.end_date ?? null,
        items: (r.items ?? []).map((i) => i.item_name),
        net_gbp: r.net_to_owner_gbp ?? null,
      })),
    };

    // ── DOUBLE-BOOKING DETECTION ────────────────────────────────
    // For each active item with qty>=1, scan ongoing+upcoming+pending(tracked)
    // reservations covering the next 90 days. If overlapping reservations on
    // ANY day exceed qty, surface a conflict. The first overlapping date is
    // reported; the full conflicting reservation set is included.
    type ResWithItems = ResRow;
    const conflictHorizonDays = 90;
    const horizonEnd = new Date(Date.now() + conflictHorizonDays * 86400000).toISOString().slice(0, 10);

    // Cross-account active reservations for conflict detection. Includes ALL
    // accounts (not just the scoped one) so an A7 III booked by DB Cinema
    // and an A7 III booked by Leo on the same day surface as ONE conflict
    // on either dashboard page.
    const ongoingCross = (allResCrossAccount as ResRow[]).filter((r) => isOngoing(r as ResRow, activeToday));
    const upcomingCross = (allResCrossAccount as ResRow[]).filter((r) => isUpcoming(r as ResRow, activeToday));
    const pendingCross = (allResCrossAccount as ResRow[]).filter((r) => isPendingVerification(r as ResRow));
    const dedupCross = <T extends ResRow>(arr: T[]): T[] => dedupByLogicalRental(arr);
    const ongoingCrossUniq = dedupCross(ongoingCross);
    const upcomingCrossUniq = dedupCross(upcomingCross);
    const pendingCrossUniq = dedupCross(pendingCross);
    // Pending-tracked equivalent for cross-account (filter to those whose
    // resolved_items point at active inventory).
    const pendingCrossTracked = pendingCrossUniq.filter((r) => {
      const ids = expandedIdsOf(r as ResRow);
      for (const id of ids.keys()) if (activeItemIds.has(id)) return true;
      return false;
    });
    const activeForConflicts: ResWithItems[] = [
      ...ongoingCrossUniq,
      ...upcomingCrossUniq,
      ...pendingCrossTracked,
    ];
    interface Conflict {
      conflict_key: string;
      item_id: string;
      item_canonical: string;
      item_image_url: string | null;
      /** "confirmed" = confirmed bookings alone oversell; "pending" = only
       *  oversells if a pending request is accepted. */
      severity: "confirmed" | "pending";
      qty: number;
      conflict_start: string;
      conflict_end: string;
      overlap_count: number;
      reservations: Array<{
        reservation_id: string;
        kind: "ongoing" | "upcoming" | "pending";
        renter_name: string | null;
        account_slug: string;
        start_date: string;
        end_date: string;
      }>;
    }
    const conflicts: Conflict[] = [];
    for (const item of activeItems) {
      if (item.qty < 1) continue;
      const matchingRes: Array<{ r: ResWithItems; kind: "ongoing" | "upcoming" | "pending" }> = [];
      const seenIds = new Set<string>();
      const tag = (r: ResWithItems): "ongoing" | "upcoming" | "pending" =>
        upcomingCrossUniq.includes(r) ? "upcoming"
        : ongoingCrossUniq.includes(r) ? "ongoing"
        : "pending";
      const itemIdStr = item._id as string;
      // Effective capacity = owned qty minus units out on repair (open cases).
      const effQty = item.qty - (repairByItem.get(itemIdStr) ?? 0);
      for (const r of activeForConflicts) {
        if (!r.start_date || !r.end_date) continue;
        if ((r.start_date as string) > horizonEnd) continue;
        // Strict match via LLM-resolved item IDs — no substring fuzzy.
        const idsToQty = expandedIdsOf(r as ResRow);
        const q = idsToQty.get(itemIdStr);
        if (!q || q < 1) continue;
        if (seenIds.has(r._id)) continue;
        seenIds.add(r._id);
        matchingRes.push({ r, kind: tag(r) });
      }
      // Concurrent qty SUM is what matters. A reservation holding 2× of the item
      // counts as 2 toward overlap.
      const sumQty = (rows: typeof matchingRes): number => {
        let total = 0;
        for (const { r } of rows) total += expandedIdsOf(r as ResRow).get(itemIdStr) ?? 0;
        return total;
      };
      if (sumQty(matchingRes) <= effQty) continue;

      // Sweep dates within horizon, count concurrency per day.
      // `effStart` honours an evening-before pickup_date (gear out earlier);
      // `effEnd` honours a morning-after return_date (gear out later) plus
      // the overdue-grace extension for RETURNED/DELIVERED + confirmed rows.
      const todayIso = today;
      const effEnd = (r: ResRow): string =>
        effEndImpl(
          {
            end_date: r.end_date as string,
            return_date: (r as any).return_date as string | null | undefined,
            order_step: r.order_step as string | null | undefined,
            status: r.status as string | null | undefined,
          },
          todayIso,
        );
      const effStart = (r: ResRow): string =>
        effStartImpl({
          start_date: r.start_date as string,
          pickup_date: r.pickup_date as string | null | undefined,
        });
      // Time-aware occupancy: a same-day handover (one rental returns, the next
      // is picked up LATER the same day) is not a real overlap. Build datetime
      // strings "YYYY-MM-DDThh:mm" from the effective dates + chat-extracted
      // pickup_time / return_time. Missing times default to all-day (00:00
      // pickup, 23:59 return) so behaviour is unchanged where we lack the data —
      // only KNOWN times can shrink an overlap, never invent one.
      const startDT = (r: ResRow): string =>
        effStart(r) + "T" + (((r as any).pickup_time as string | undefined) || "00:00");
      const endDT = (r: ResRow): string => {
        const ed = effEnd(r);
        const rawEnd = (((r as any).return_date as string | undefined) ?? (r.end_date as string));
        // When overdue-grace pushed the end past the booked return we have no
        // time for the extra day(s) → treat as out all day.
        const tm = ed > rawEnd ? "23:59" : (((r as any).return_time as string | undefined) || "23:59");
        return ed + "T" + tm;
      };
      let worstStart = "";
      let worstInstant = "";
      let worstCount = 0;
      // Worst CONFIRMED-only concurrency (ongoing + upcoming; excludes pending).
      // Lets us tell a live oversell apart from one that only appears if a
      // pending request is accepted — pending bookings don't block the calendar.
      let worstConfirmedCount = 0;
      const scanFromDT = todayIso + "T00:00";
      const scanToDT = horizonEnd + "T23:59";
      // Concurrency only rises at a pickup instant, so it suffices to evaluate at
      // each member's start datetime (and the scan start). A unit is out over the
      // half-open window [startDT, endDT): a return at exactly t frees it.
      const instants = Array.from(
        new Set<string>(
          [scanFromDT, ...matchingRes.map((m) => startDT(m.r as ResRow))].filter(
            (x) => x >= scanFromDT && x <= scanToDT,
          ),
        ),
      ).sort();
      for (const t of instants) {
        const overlapping = matchingRes.filter(
          (m) => startDT(m.r as ResRow) <= t && endDT(m.r as ResRow) > t,
        );
        const qtySum = overlapping.reduce(
          (s, m) => s + (expandedIdsOf(m.r as ResRow).get(itemIdStr) ?? 0),
          0,
        );
        const confirmedSum = overlapping.reduce(
          (s, m) => s + (m.kind === "pending" ? 0 : (expandedIdsOf(m.r as ResRow).get(itemIdStr) ?? 0)),
          0,
        );
        if (qtySum > worstCount) {
          worstCount = qtySum;
          worstInstant = t;
          worstStart = t.slice(0, 10);
        }
        if (confirmedSum > worstConfirmedCount) worstConfirmedCount = confirmedSum;
      }
      if (worstCount > effQty && worstInstant) {
        // The exact set of reservations concurrent at the peak instant.
        const overlappingSet = matchingRes.filter(
          (m) => startDT(m.r as ResRow) <= worstInstant && endDT(m.r as ResRow) > worstInstant,
        );
        const earliestEnd = overlappingSet
          .map((m) => effEnd(m.r as ResRow))
          .sort()[0];
        // Stable conflict identity: item_id + sorted reservation IDs.
        // If any reservation set member changes, the key changes too — a
        // dismissal of the OLD shape does not suppress a NEW shape.
        const conflictReservationIds = overlappingSet
          .map(({ r }) => (r.v1_rental_id ?? r.hygglo_order_id ?? (r._id as string)))
          .sort();
        const conflictKey = (item._id as string) + "|" + conflictReservationIds.join(",");
        if (dismissedKeys.has(conflictKey)) continue;
        // Per-account view: only surface conflicts that involve at least one
        // reservation in the scoped account. On 'All' (accountSlug=null) every
        // conflict shows.
        if (accountSlug) {
          const involves = overlappingSet.some(({ r }) => r.account_slug === accountSlug);
          if (!involves) continue;
        }

        // Image: prefer the master-inventory item photo, else fall back to a
        // Hygglo product image from one of the overlapping reservations
        // (~40% of items have no image_url of their own).
        const resImage = (() => {
          for (const { r } of overlappingSet) {
            const hy = (r as any).hygglo_items as Array<{ image_url?: string }> | undefined;
            const hit = hy?.find((h) => h.image_url)?.image_url;
            if (hit) return hit;
            const pu = (r as any).photos_urls as string[] | null | undefined;
            if (pu && pu.length) return pu[0];
          }
          return null;
        })();
        const severity: "confirmed" | "pending" =
          worstConfirmedCount > item.qty ? "confirmed" : "pending";

        conflicts.push({
          conflict_key: conflictKey,
          item_id: item._id as string,
          item_canonical: item.name_canonical,
          item_image_url: ((item as any).image_url as string | null) ?? resImage,
          severity,
          qty: effQty,
          conflict_start: worstStart,
          conflict_end: earliestEnd,
          overlap_count: worstCount,
          reservations: overlappingSet.map(({ r, kind }) => ({
            reservation_id: (r.v1_rental_id ?? r.hygglo_order_id ?? r._id) as string,
            kind,
            renter_name: r.renter_name ?? null,
            account_slug: r.account_slug ?? "",
            start_date: r.start_date as string,
            end_date: r.end_date as string,
            // Each clashing booking's own listing photo (Hygglo product image)
            // so the owner can eyeball which two rentals collide.
            image_url: (() => {
              const hy = (r as { hygglo_items?: Array<{ image_url?: string }> }).hygglo_items;
              const hit = hy?.find((h) => h.image_url)?.image_url;
              if (hit) return hit;
              const pu = (r as { photos_urls?: string[] | null }).photos_urls;
              return pu && pu.length ? pu[0] : null;
            })(),
          })),
        });
      }
    }
    // Sort conflicts: earliest start first (most urgent at top)
    conflicts.sort((a, b) =>
      a.severity !== b.severity
        ? a.severity === "confirmed" ? -1 : 1
        : a.conflict_start.localeCompare(b.conflict_start),
    );

    // Update pending count to exclude untracked rows so the headline number
    // reflects actionable pending verifications only.
    const pendingTrackedCount = pendingTracked.length;
    const pendingTrackedValue = pendingTracked.reduce((s, r) => s + netOf(r), 0);

    // Sub-count: pending verifications whose start_date falls in the NEXT
    // calendar month (UTC, matching the YYYY-MM-DD slicing used elsewhere
    // in this query). Pure additive — does not affect pendingTrackedCount.
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    const monthAfterStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)).toISOString().slice(0, 10);
    const pendingNextMonthCount = pendingTracked.filter(
      (r) => !!r.start_date && r.start_date >= nextMonthStart && r.start_date < monthAfterStart,
    ).length;

    const daysBetween = (a: string, b: string): number => {
      const ms = Date.parse(b) - Date.parse(a);
      return Math.max(1, Math.round(ms / 86400000) + 1);
    };

    // Inventory image lookup for the multi-tile item row in Active Rentals.
    // Match strictly via resolved_items[].item_id — no fuzzy substring matching.
    // Phase 11.2: historical hygglo_items[].image_url=null rows are now patched
    // by the backfill_hygglo_images mutation, so no name-based fallback needed.
    const itemImageById = new Map<string, { name: string; image_url: string | null }>();
    for (const it of activeItems) {
      itemImageById.set(it._id as string, {
        name: it.name_canonical,
        image_url: (it as { image_url?: string }).image_url ?? null,
      });
    }
    // Phase 9 / FIX-DESIGN §4.5: build the shared-image blacklist once for
    // the whole query so the resolver can guard the items_table fallback
    // against globally-aliased URLs (Pass-1 root cause).
    const sharedBlacklist = buildSharedImageBlacklist(
      allItems.map((it) => ({ image_url: (it as { image_url?: string | null }).image_url ?? null })),
    );
    const buildItemTiles = (r: ResRow): ItemTile[] => {
      // Map a source item → hygglo product_id (for the priority-0 bank) using
      // the row's raw hygglo_items, matched by normalised canonical name.
      const hyggloItems = ((r as { hygglo_items?: Array<{ name?: string; product_id?: number }> }).hygglo_items) ?? [];
      const productIdForItem = (item: { item_name_canonical: string }): number | null => {
        const target = normaliseItemName(item.item_name_canonical);
        if (!target) return null;
        const hit = hyggloItems.find((h) => normaliseItemName(h?.name ?? "") === target);
        return hit?.product_id ?? null;
      };
      return buildItemTilesShared({
        reservation: r as Parameters<typeof buildItemTilesShared>[0]["reservation"],
        itemImageById,
        sharedBlacklist,
        bankByProduct,
        productIdForItem,
      });
    };

    const mapRental = (r: ResRow, kind: "ongoing" | "upcoming" | "pending") => {
      // PASS-9 (2026-05-15): raw Hygglo per-rental items[] are AUTHORITATIVE.
      // The poller writes detail.items[] verbatim into r.hygglo_items. We use
      // that directly — never cross-match against the global items table —
      // to fix Michelle's Atomos showing a GM 24-70 Bundle image.
      const hyggloItemsRaw = (r as any).hygglo_items as
        | Array<{
            name: string;
            image_url: string | null;
            type: string;
            qty?: number;
            product_id?: number;
          }>
        | undefined;
      const useHygglo = Array.isArray(hyggloItemsRaw) && hyggloItemsRaw.length > 0;
      if (useHygglo) {
        // INSURANCE already filtered at poll time but defensive-filter here too.
        const hItems = hyggloItemsRaw!.filter(
          (h) => h?.name && h.type !== "INSURANCE",
        );
        type HygTile = {
          image_url: string;
          name: string;
          names_in_group: string[];
          qty: number;
        };
        // Per-row image hints (positionally aligned with items[] at poll time).
        // Used ONLY as a within-row name fallback when bank + hygglo image_url
        // are missing or stale — safe because the map is built from this row
        // alone (no cross-rental aliasing risk that Phase 12.3 was rolling back).
        const hintByName = new Map<string, string>();
        const imageHintsRaw = ((r as any).image_hints ?? []) as Array<{
          item_name?: string;
          image_url?: string;
        }>;
        for (const hint of imageHintsRaw) {
          if (hint?.item_name && hint.image_url) {
            hintByName.set(hint.item_name, hint.image_url);
          }
        }
        const tilesByImage = new Map<string, HygTile>();
        const tileOrderH: string[] = [];
        const noImage: string[] = [];
        // Per-item resolved images IN ORDER — feeds pickRepresentativeItem so
        // master_image_url + its name come from the SAME item (Phase 5.3).
        const repItems: Array<{ name: string; imageUrl: string | null; productId: number | null }> = [];
        for (const h of hItems) {
          const q = typeof h.qty === "number" && h.qty > 0 ? h.qty : 1;
          // Resolution order:
          //   1. listing_images bank (account_slug, product_id) — trusted.
          //   2. hygglo_items[i].image_url — per-row poller snapshot.
          //   3. image_hints[] by exact item_name — same-row fallback only.
          //   4. null → noImage[] pill.
          // The image_hints lookup was added back 2026-05-21 (image-hints
          // table held real Hygglo URLs that hygglo_items had lost — some
          // rows even contained the "https://example.com/test.jpg" seed value).
          // Phase 12.3's removal-of-name-fallback was a cross-rental concern;
          // a same-row name match cannot mis-attribute another rental's image.
          const bankUrl = h.product_id
            ? bankByProduct.get(`${r.account_slug}#${h.product_id}`)
            : undefined;
          const hyggloUrl =
            h.image_url && !h.image_url.includes("example.com")
              ? h.image_url
              : undefined;
          const hintUrl = hintByName.get(h.name);
          const url: string | null = bankUrl ?? hyggloUrl ?? hintUrl ?? null;
          repItems.push({ name: h.name, imageUrl: url, productId: h.product_id ?? null });
          if (url) {
            const ex = tilesByImage.get(url);
            if (ex) {
              ex.qty += q;
              ex.names_in_group.push(h.name);
              if (h.name.length < ex.name.length) ex.name = h.name;
            } else {
              tilesByImage.set(url, {
                image_url: url,
                name: h.name,
                names_in_group: [h.name],
                qty: q,
              });
              tileOrderH.push(url);
            }
          } else {
            noImage.push(h.name);
          }
        }
        const item_image_tiles_h = tileOrderH.map(
          (u) => tilesByImage.get(u) as HygTile,
        );
        // Representative item: first item (in order) with a real image; name +
        // image come from the SAME item so they always agree (Phase 5.3).
        // Treat a null per-item url as a placeholder; fall back to items[0].
        const repH = pickRepresentativeItem(repItems, (it) =>
          it.imageUrl
            ? { url: it.imageUrl, source: "hint_exact", confidence: 1 }
            : { url: null, source: "placeholder", confidence: 0 },
        );
        const master_image_url_h = repH.imageUrl ?? item_image_tiles_h[0]?.image_url ?? null;
        const item_names_summary_h = hItems
          .map((i) => (i.qty && i.qty > 1 ? `${i.name} \u00d7${i.qty}` : i.name))
          .join(", ");

        return {
          reservation_id: r.v1_rental_id ?? r.hygglo_order_id ?? r._id,
          renter_name: r.renter_name ?? null,
          account_slug: r.account_slug ?? "",
          start_date: r.start_date ?? null,
          end_date: r.end_date ?? null,
          pickup_date: r.pickup_date ?? r.start_date ?? null,
          pickup_time: r.pickup_time ?? null,
          return_date: (r as any).return_date ?? r.end_date ?? null,
          return_time: r.return_time ?? null,
          pickup_method: r.pickup_method ?? null,
          return_method: r.return_method ?? null,
          items: hItems.map((i) => i.name),
          photo_url: master_image_url_h,
          master_image_url: master_image_url_h,
          item_names_summary: item_names_summary_h.length > 0 ? item_names_summary_h : "(no item)",
          item_image_tiles: item_image_tiles_h,
          extra_text_items: noImage,
          duration_days:
            r.duration_days ??
            (r.start_date && r.end_date
              ? daysBetween(r.start_date as string, r.end_date as string)
              : null),
          net_gbp: r.net_to_owner_gbp ?? null,
          order_step: r.order_step ?? null,
          item_tiles: item_image_tiles_h.map((t) => {
            // 2026-05-23: prefer cached short_name (derived from Hygglo
            // SEO blob via DeepSeek). Fall back to raw name when no
            // cache row exists yet. We resolve the product_id by walking
            // hItems and matching on name+image_url - cheap (<=10 items
            // per rental). Tooltip / hover gets the raw t.name via
            // raw_name field below.
            let pid: number | undefined;
            for (const hi of hItems) {
              if (hi?.product_id != null && hi.name === t.name) {
                pid = hi.product_id;
                break;
              }
            }
            // 2026-05-24: pool override takes precedence when the per-
            // account flag is ON. Otherwise the legacy listing_short_names
            // lookup runs verbatim (preserves pre-pool display behaviour).
            const pool = pid != null
              ? infoPoolByProduct.get(`${r.account_slug}#${pid}`)
              : undefined;
            const sn = pid != null
              ? shortNameByProduct.get(`${r.account_slug}#${pid}`)
              : undefined;
            const displayName = pool ? pool.display_name : (sn ?? t.name);
            return {
              name: displayName,
              raw_name: t.name,
              qty: t.qty,
              image_url: t.image_url,
              info_pool_badge: pool
                ? (pool.is_manually_overridden ? "manual" : (pool.needs_review ? "needs_review" : "llm"))
                : null,
              product_id: pid ?? null,
            };
          }),
          kind,
          is_ongoing: kind === "ongoing",
        };
      }
      // ── Fallback path: no hygglo_items[] ──
      // Phase 12.3: REMOVED the items.image_url cross-match block (Pass-8/9
      // root cause — global-aliased URLs leaked into dashboard tiles, e.g.
      // Michelle's Atomos pulling a GM 24-70 Bundle image). The product_id
      // bank populated by the poller is the new source of truth. Rentals
      // without hygglo_items[] (legacy v1 imports) emit no tiles — names
      // go into the text-pill fallback (extra_text_items) and the bank
      // fills in over time as the poller re-touches them.
      const isInsurance = (n: string) =>
        /insurance/i.test(n) || /\binsur\b/i.test(n);
      const fallbackNames = (r.items ?? [])
        .map((i) => i.item_name)
        .filter((n) => n && !isInsurance(n));
      const itemNamesSummary = fallbackNames.length > 0
        ? fallbackNames.join(", ")
        : "(no item)";

      return {
        reservation_id: r.v1_rental_id ?? r.hygglo_order_id ?? r._id,
        renter_name: r.renter_name ?? null,
        account_slug: r.account_slug ?? "",
        start_date: r.start_date ?? null,
        end_date: r.end_date ?? null,
        pickup_date: r.pickup_date ?? r.start_date ?? null,
        pickup_time: r.pickup_time ?? null,
        return_date: (r as any).return_date ?? r.end_date ?? null,
        return_time: r.return_time ?? null,
        pickup_method: r.pickup_method ?? null,
        return_method: r.return_method ?? null,
        items: (r.items ?? []).map((i) => i.item_name),
        photo_url: null,
        master_image_url: null,
        item_names_summary: itemNamesSummary,
        item_image_tiles: [] as Array<{ image_url: string; name: string; names_in_group: string[]; qty: number }>,
        extra_text_items: fallbackNames,
        duration_days:
          r.duration_days ??
          (r.start_date && r.end_date ? daysBetween(r.start_date as string, r.end_date as string) : null),
        net_gbp: r.net_to_owner_gbp ?? null,
        order_step: r.order_step ?? null,
        item_tiles: [] as Array<{ name: string; qty: number; image_url: string | null }>,
        kind,
        is_ongoing: kind === "ongoing",
      };
    };

    // Active widget LIST = ongoing + upcoming + pending-verification (restored
    // 2026-06-02). Pending rows render as kind="pending" cards in the drawer.
    // NOTE: activeTotal (headline count) stays ongoing+upcoming ONLY — pending
    // is shown in the list but is still surfaced separately via
    // active.pending_count / pending_value_gbp (computation untouched).
    //
    // Dedupe guard: a confirmed row can transiently sit at order_step==="VERIFIED",
    // which satisfies BOTH isUpcoming/isOngoing (status==="confirmed") AND
    // isPendingVerification (order_step==="VERIFIED"). Genuine pending rows live
    // at status="pending_review" and are disjoint, but we filter pendingTracked
    // by dedupKey against the already-listed ongoing/upcoming to prevent a
    // double-render in that transient overlap window.
    const listedKeys = new Set<string>([
      ...ongoingUniq.map((r) => dedupKey(r as ResRow)),
      ...upcomingUniq.map((r) => dedupKey(r as ResRow)),
    ]);
    const pendingForList = pendingTracked.filter(
      (r) => !listedKeys.has(dedupKey(r as ResRow)),
    );
    const activeRentals = [
      ...ongoingGroupRows.map((r) => mapRental(r, "ongoing")),
      ...upcomingGroupRows.map((r) => mapRental(r, "upcoming")),
      ...pendingForList.map((r) => mapRental(r, "pending")),
    ]
      .sort((a, b) => {
        const ad = a.start_date ?? "";
        const bd = b.start_date ?? "";
        if (ad !== bd) return ad.localeCompare(bd);
        return (a.pickup_time ?? "99:99").localeCompare(b.pickup_time ?? "99:99");
      })
      .slice(0, 30);

    // ── card: earnings ───────────────────────────────────────────
    const earnings = {
      today: Math.round(todayTotal * 100) / 100,
      week: Math.round(weekTotal * 100) / 100,
      by_account: byAccount,
    };

    // Month revenue = all non-cancelled (confirmed + completed) net for the month.
    // v1 parity: "Month Confirmed £X" is total booked, NOT just earned-by-today.
    const monthBookedRevenue = monthBookedRentals.reduce((s, r) => s + netOf(r), 0);

    // ── card: monthly ────────────────────────────────────────────
    // Target = projected (current trend's end-of-month run-rate).
    const monthlyTarget = projected;
    const monthlyPct = monthlyTarget > 0
      ? Math.round((monthBookedRevenue / monthlyTarget) * 100)
      : 0;
    const monthly = {
      current_earnings: Math.round(monthTotal * 100) / 100,
      confirmed_revenue: Math.round(monthBookedRevenue * 100) / 100,
      projected,
      target_gbp: monthlyTarget,
      pct_of_target: Math.min(100, monthlyPct),
      days_remaining: daysRemaining,
      days_in_month: daysInMonth,
      days_elapsed: daysElapsed,
      avg_daily_rate: Math.round(avgDailyRate * 100) / 100,
    };

    // ── card: confirmed ──────────────────────────────────────────
    // Split this-month booked rentals into done / active / upcoming for the v1
    // 4-segment breakdown bar. A "completed" status row counts as done even if
    // end_date is in the future (unlikely but possible).
    // Month Confirmed split into done / active / upcoming. Composed from the
    // canonical isConfirmedWithDates/isUpcoming predicates so the count moves
    // in lockstep with the Active Rentals card when semantics shift. "active"
    // here is stricter than isOngoing — Month Confirmed only highlights
    // strictly current rentals (end >= today), whereas isOngoing also keeps
    // overdue/never-returned rows visible.
    const monthDone = monthBookedRentals.filter(
      (r) => r.status === "completed" || (r.end_date as string) < today,
    );
    const monthActive = monthBookedRentals.filter(
      (r) =>
        isConfirmedWithDates(r as ResRow) &&
        (r.start_date as string) <= today &&
        (r.end_date as string) >= today,
    );
    const monthUpcoming = monthBookedRentals.filter((r) =>
      isUpcoming(r as ResRow, today),
    );
    const monthPending = dedupRes(
      pendingRes.filter((r) => {
        const d = effectiveDateStr(r);
        return d !== undefined && d >= monthStart && d <= monthEnd;
      }),
    );
    const monthPendingValue = monthPending.reduce((s, r) => s + netOf(r), 0);
    // Daily buckets keyed by YYYY-MM-DD for the current month. Used by the
    // ConfirmedDrawer chart. Each rental contributes to exactly one bucket
    // based on effectiveDateStr (pickup_date ?? start_date); revenue is netOf.
    const lastDay = parseInt(monthEnd.slice(8, 10), 10);
    type DailyBucket = { date: string; day: number; done: number; active: number; upcoming: number; pending: number; revenue: number };
    const daily: DailyBucket[] = [];
    const yyyymm = monthStart.slice(0, 8);
    for (let d = 1; d <= lastDay; d++) {
      const dateStr = yyyymm + String(d).padStart(2, "0");
      daily.push({ date: dateStr, day: d, done: 0, active: 0, upcoming: 0, pending: 0, revenue: 0 });
    }
    const idxOf = (dateStr: string | undefined): number => {
      if (!dateStr || dateStr < monthStart || dateStr > monthEnd) return -1;
      return parseInt(dateStr.slice(8, 10), 10) - 1;
    };
    const bumpBucket = (r: ResRow, key: "done" | "active" | "upcoming" | "pending") => {
      const i = idxOf(effectiveDateStr(r));
      if (i < 0) return;
      daily[i][key] += 1;
      daily[i].revenue += netOf(r);
    };
    for (const r of monthDone) bumpBucket(r as ResRow, "done");
    for (const r of monthActive) bumpBucket(r as ResRow, "active");
    for (const r of monthUpcoming) bumpBucket(r as ResRow, "upcoming");
    for (const r of monthPending) bumpBucket(r as ResRow, "pending");
    for (const b of daily) b.revenue = Math.round(b.revenue * 100) / 100;

    const todayDay = parseInt(today.slice(8, 10), 10);

    // Insurance claims credited to the current month — match the SAME predicate
    // revenue.ts:343-351 uses for the lifetime chart's white bar so the Month
    // Confirmed tile and the lifetime current-month claims agree.
    const currentMonth = monthStart.slice(0, 7); // "YYYY-MM"
    let claims_count = 0;
    let claims_value_gbp = 0;
    for (const c of claimRows) {
      const credited = (c as any).credited_to_month as string | undefined;
      const payout   = (c as any).payout_amount_gbp as number | undefined;
      if (credited === currentMonth && typeof payout === "number") {
        claims_count += 1;
        claims_value_gbp += payout;
      }
    }
    claims_value_gbp = Math.round(claims_value_gbp * 100) / 100;

    // INVARIANT: per-slug sum from realisedMonthRevenue must equal the
    // all-accounts confirmed_revenue (monthBookedRevenue) computed above —
    // single source of truth in convex/lib/reservations/monthRevenue.ts.
    // If this warns, a code change reintroduced a predicate fork — fix it
    // in monthRevenue.ts, not by patching here. monthBookedRevenue is
    // already derived from realisedMonthRevenue (commit cc38126), so the
    // per-slug comparison is the meaningful guard.
    {
      const perSlugSum = ACCOUNT_SLUGS.reduce(
        (s, slug) =>
          s + realisedMonthRevenue(allRes as unknown as ResRow[], currentMonth, slug).netGbp,
        0,
      );
      const totalAll = realisedMonthRevenue(
        allRes as unknown as ResRow[],
        currentMonth,
        null,
      ).netGbp;
      // When accountSlug is set, `allRes` is already pre-filtered to one slug,
      // so per-slug sum collapses to a single non-zero term and the all-accounts
      // call returns the same number — invariant still holds. When accountSlug
      // is null we get the full fan-out.
      const deltaPerSlug = totalAll - perSlugSum;
      if (Math.abs(deltaPerSlug) > 0.01) {
        console.warn(
          "[INVARIANT] month-revenue drift",
          {
            currentMonth,
            accountSlug,
            totalAll,
            perSlugSum,
            monthBookedRevenue,
            delta_to_per_slug: deltaPerSlug,
            delta_to_inline: totalAll - monthBookedRevenue,
            known_slugs: ACCOUNT_SLUGS,
          },
        );
      }
    }

    const confirmed = {
      month_count: monthBookedRentals.length,
      month_revenue: Math.round((monthBookedRevenue + claims_value_gbp) * 100) / 100,
      done_count: monthDone.length,
      active_count: monthActive.length,
      upcoming_count: monthUpcoming.length,
      pending_count: monthPending.length,
      pending_value_gbp: Math.round(monthPendingValue * 100) / 100,
      claims_count,
      claims_value_gbp,
      total_rentals: monthDone.length + monthActive.length + monthUpcoming.length + monthPending.length,
      today_day: today >= monthStart && today <= monthEnd ? todayDay : null,
      month_label: monthStart,
      daily_breakdown: daily,
      rentals: monthBookedRentals.slice(0, 15).map((r) => ({
        reservation_id: r.v1_rental_id ?? r.hygglo_order_id ?? r._id,
        renter_name: r.renter_name ?? null,
        start_date: r.start_date ?? null,
        end_date: r.end_date ?? null,
        gross: r.gross_paid_gbp ?? null,
      })),
    };

    // ── card: ongoing ─────────────────────────────────────────────
    const ongoingCard = {
      count: ongoingGroupRows.length,
      rentals: ongoingGroupRows.slice(0, 15).map((r) => {
        // Merged rentals run to the span end (return_date overridden above).
        const endRef = r.return_date ?? r.end_date;
        const daysLeft = endRef
          ? Math.max(0, Math.round((Date.parse(endRef) - Date.now()) / 86400000))
          : null;
        return {
          ...mapRental(r, "ongoing"),
          days_left: daysLeft,
        };
      }),
    };

    // ── card: upcoming ────────────────────────────────────────────
    const upcomingCard = {
      count: upcomingGroupRows.length,
      rentals: upcomingGroupRows.slice(0, 15).map((r) => {
        const daysUntil = r.start_date
          ? Math.max(0, Math.round((Date.parse(r.start_date) - Date.now()) / 86400000))
          : null;
        return {
          ...mapRental(r, "upcoming"),
          days_until: daysUntil,
        };
      }),
    };

    // ── card: insurance_claims (W22 — pinned to-do list of cases) ─
    // "Open" cases need owner action; "settled" or "denied" are terminal.
    // Sums by status surface both pending workload (open count + amount) and
    // outcomes (settled total YTD).
    const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
    const claimStage = (c: { stage?: string; status?: string }): string => {
      if (c.stage) return c.stage;
      if (c.status === "denied") return "denied";
      if (c.status === "settled" || c.status === "added_to_revenue") return "added_to_revenue";
      return "case_opened";
    };
    let openCount = 0;
    let openAmount = 0;
    let settledCountYTD = 0;
    let settledAmountYTD = 0;
    let deniedCountYTD = 0;
    for (const c of claimRows) {
      const st = claimStage(c);
      if (st !== "added_to_revenue" && st !== "denied") { openCount++; openAmount += c.amount_gbp; continue; }
      if (c.claim_date >= yearStart) {
        if (st === "added_to_revenue") { settledCountYTD++; settledAmountYTD += ((c as { payout_amount_gbp?: number }).payout_amount_gbp ?? c.amount_gbp); }
        else if (st === "denied") { deniedCountYTD++; }
      }
    }
    const insurance = {
      open_count: openCount,
      open_amount_gbp: Math.round(openAmount * 100) / 100,
      settled_count_ytd: settledCountYTD,
      settled_amount_ytd_gbp: Math.round(settledAmountYTD * 100) / 100,
      denied_count_ytd: deniedCountYTD,
      total_count: claimRows.length,
      claims: claimRows.slice(0, 50).map((c) => ({
        id: c._id as string,
        accountSlug: c.account_slug ?? null,
        itemNameCanonical: c.item_name_canonical ?? null,
        renterName: (c as { renter_name?: string }).renter_name ?? null,
        amountGbp: c.amount_gbp,
        claimDate: c.claim_date,
        description: c.description ?? null,
        status: c.status,
        stage: claimStage(c),
        payoutAmountGbp: (c as { payout_amount_gbp?: number }).payout_amount_gbp ?? null,
        creditedToMonth: (c as { credited_to_month?: string }).credited_to_month ?? null,
        creditedAt: (c as { credited_at?: number }).credited_at ?? null,
        createdAt: c.created_at,
      })),
    };

    // ── card: scanner ─────────────────────────────────────────────
    // last_scan_at = max across primary/backup/cron sources (see COLLECT 5).
    // last_scan_source surfaces WHICH layer produced the most recent scan
    // so the UI can flag failover state.
    const scanner = {
      last_scan_at: winningScan?.lastRunAt ?? null,
      last_scan_source: winningScan?.source ?? null,
      last_run_succeeded: syncRow?.lastRunSucceeded ?? null,
      rows_upserted_last: syncRow?.rowsUpserted?.reservations ?? 0,
    };

    // ── card: denied_revenue ──────────────────────────────────────
    // denial_records: no reservation_id or renter_name; best-effort mapping.
    // Net convention (2026-05-22): estimated_value is gross — multiply by
    // 0.64 (OWNER_SHARE) so this matches the netOf(r) convention used by
    // every other revenue widget (revenue = take-home post platform fees).
    // ALL-TIME, not windowed: denial_records were bulk-imported on a single date
    // (created_at all = 2026-05-10, no true per-event date, no rental_id link), so
    // filtering by created_at is fiction — and the old 90d window would CLIFF the
    // tile to £0 once the import date ages out. Present denied revenue as the
    // lifetime total (flagged all_time so the UI/chat label it honestly).
    const DENIED_OWNER_SHARE = OWNER_SHARE_CANONICAL;
    const allDenials = denialRows;
    const deniedRevenueTotalGross = allDenials.reduce((s, d) => s + (d.estimated_value ?? 0), 0);
    const deniedRevenueTotal = deniedRevenueTotalGross * DENIED_OWNER_SHARE;
    const denied_revenue = {
      total_gbp: Math.round(deniedRevenueTotal * 100) / 100,
      all_time: true,
      items: allDenials.slice(0, 15).map((d) => ({
        reservation_id: d._id as string,
        renter_name: null as string | null,
        gross: d.estimated_value ?? null,
        net: d.estimated_value != null ? Math.round(d.estimated_value * DENIED_OWNER_SHARE * 100) / 100 : null,
        reason: d.reason ?? null,
      })),
    };

    // ── card: missed_revenue ──────────────────────────────────────
    // Phase 6a (2026-05-24): served from mv_missed_revenue (per
    // (account, days=30) row), refreshed hourly by master.refreshFast.
    // Cold-start fallback to live computeMissedRevenue keeps numbers
    // present for the first hour after deploy.
    const missedRevenueAccount = accountSlug ?? "all";
    const missedRevenueRow = await ctx.db
      .query("mv_missed_revenue")
      .withIndex("by_account_days", (q) =>
        q.eq("account", missedRevenueAccount).eq("days", 30),
      )
      .first();
    const missedRevenueResult = missedRevenueRow ?? await computeMissedRevenue(ctx, accountSlug, 30);
    const missed_revenue = {
      total_gbp: missedRevenueResult.totalMissed,
      items: [
        ...missedRevenueResult.denialLosses.slice(0, 10).map((d) => ({
          reservation_id: d.denialId as string,
          renter_name: null as string | null,
          gross: d.estimatedValueGross ?? null,
          net: d.estimatedValue,
          reason: d.reason ?? null,
          kind: "denial" as const,
        })),
        ...missedRevenueResult.gapLosses.slice(0, 10).map((g) => ({
          reservation_id: g.itemName as string,
          renter_name: null as string | null,
          gross: null as number | null,
          net: g.estimatedGapLoss,
          reason: `idle_gap (${g.idleDays}d)` as string | null,
          kind: "gap" as const,
        })),
      ].slice(0, 15),
    };

    // ── card: ai_boost (Wave AI-BE rework, 2026-05-22) ────────────
    // REAL attribution: classify each reservation in scope as
    //   hard_ai (100%) | soft_ai (50%) | assisted (0%) | baseline (0%)
    // using ai_decision + ai_decision_audit. Replaces the previous flat
    // `monthTotal * ai_boost_rate` skim. `ai_boost_rate` setting is kept
    // for backwards-compat but NO LONGER used in the £ math here.
    const allDecisions = (await ctx.db
      .query("ai_decision")
      .collect()) as unknown as AiDecisionLite[];
    const allAudits = (await ctx.db
      .query("ai_decision_audit")
      .collect()) as unknown as AiDecisionAuditLite[];

    // Current-month: tiered totals over `monthEarned` (the canonical
    // "earned in current month" slice — confirmed/completed, deduped,
    // already account-filtered above).
    const currentTotals = tieredCreditTotals(
      monthEarned as any,
      allDecisions,
      allAudits,
    );

    // Prior-3-month median: bucket earnedPaid by YYYY-MM, take totals
    // for the three calendar months immediately before the current one.
    const priorMonthKeys: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      priorMonthKeys.push(d.toISOString().slice(0, 7));
    }
    const priorMonthlyTotals = priorMonthKeys.map((mo) => {
      const rowsForMo = earnedPaid.filter((r) => {
        const ed = effectiveDateStr(r);
        return ed !== undefined && ed.slice(0, 7) === mo;
      });
      const t = tieredCreditTotals(rowsForMo as any, allDecisions, allAudits);
      return t.total_attributed_gbp;
    });
    const p3mMedian = medianOfArray(priorMonthlyTotals);

    const totalCreditGbp = currentTotals.total_attributed_gbp;
    const sampleCount = currentTotals.hard_count + currentTotals.soft_count;
    const confidence: "low" | "med" | "high" =
      sampleCount < 10 ? "low" : sampleCount < 50 ? "med" : "high";
    const deltaGbp = Math.round((totalCreditGbp - p3mMedian) * 100) / 100;
    const deltaPct =
      Math.round(((totalCreditGbp - p3mMedian) / Math.max(p3mMedian, 1)) * 10000) / 100;

    const ai_boost = {
      current_month: {
        hard_gbp: currentTotals.hard_ai_gbp,
        soft_gbp: currentTotals.soft_ai_gbp,
        soft_credit_gbp: currentTotals.soft_ai_credit_gbp,
        assisted_gbp: currentTotals.assisted_gbp,
        baseline_gbp: currentTotals.baseline_gbp,
        hard_count: currentTotals.hard_count,
        soft_count: currentTotals.soft_count,
        assisted_count: currentTotals.assisted_count,
        baseline_count: currentTotals.baseline_count,
        total_credit_gbp: totalCreditGbp,
      },
      prior_3mo_median_gbp: p3mMedian,
      delta_vs_p3m_gbp: deltaGbp,
      delta_vs_p3m_pct: deltaPct,
      confidence,
      sample_count: sampleCount,
      drilldown_reservation_ids:
        currentTotals.drilldown_reservation_ids.slice(0, 50),
      // Legacy field — preserved so existing FE consumers keep working
      // until the new shape is wired up in the AI-FE rework.
      total_uplift_gbp: totalCreditGbp,
      breakdown: [
        {
          label: "Hard AI",
          count: currentTotals.hard_count,
          gbp: currentTotals.hard_ai_gbp,
          weight: 1.0,
        },
        {
          label: "Soft AI (edited drafts)",
          count: currentTotals.soft_count,
          gbp: currentTotals.soft_ai_credit_gbp,
          weight: 0.5,
        },
        {
          label: "Assisted (no credit)",
          count: currentTotals.assisted_count,
          gbp: 0,
          weight: 0,
        },
      ] as Array<{ label: string; count: number; gbp: number; weight: number }>,
    };

    // ── card: out_of_stock ────────────────────────────────────────
    // NOW-based (not next-30d): items whose currently-active rentals
    // (isOngoing predicate — confirmed + today ∈ [start, end]) hold qty
    // equal to or greater than the item's total stock. Zero units
    // physically available right now.
    //
    // Per Daniel: "things that are rented rn and currently out of stock
    // as there is no longer inventory for it".
    //
    // Source of truth: reservations.expanded_items[].item_id — the
    // bundle-decomposed, master-inventory-linked item list. Schema
    // comment on reservations.expanded_items: "Conflict + out-of-stock
    // + sell-reco read this, not resolved_items." Falls back to
    // resolved_items when expanded_items is not yet populated.
    //
    // We MUST match by item_id, not by name. The resolver appends a
    // "[kind]" suffix to item_name_canonical (e.g. "Sony FX3 [camera]")
    // which never equals the bare items.name_canonical ("Sony FX3"),
    // and r.items[].item_name is the raw Hygglo listing title that
    // matches nothing canonical.
    const heldNowByItemId = new Map<string, number>();
    for (const r of ongoingRentals) {
      const expanded = (r as { expanded_items?: Array<{ item_id: string; qty: number }> }).expanded_items;
      const resolved = (r as { resolved_items?: Array<{ item_id: string; qty?: number }> }).resolved_items;
      const source: Array<{ item_id: string; qty?: number }> =
        expanded && expanded.length > 0
          ? expanded
          : resolved ?? [];
      for (const it of source) {
        if (!it.item_id) continue;
        const qty = it.qty ?? 1;
        heldNowByItemId.set(
          it.item_id as string,
          (heldNowByItemId.get(it.item_id as string) ?? 0) + qty,
        );
      }
    }
    const oosItems = activeItems
      .filter((i) => ((heldNowByItemId.get(i._id as string) ?? 0) + (repairByItem.get(i._id as string) ?? 0)) >= i.qty)
      .slice(0, 15)
      .map((i) => ({
        item_id: i._id as string,
        name: i.name_canonical,
        qty: i.qty,
        heldNow: heldNowByItemId.get(i._id as string) ?? 0,
        inRepair: repairByItem.get(i._id as string) ?? 0,
      }));
    const out_of_stock = {
      count: oosItems.length,
      items: oosItems,
    };

    // ── card: vacation ────────────────────────────────────────────
    // owner_unavailability joined with items for name
    const itemNameById = new Map(allItems.map((i) => [i._id as string, i.name_canonical]));
    const activeBlocks = unavailRows
      .filter((u) => u.end_date >= today)
      .slice(0, 20)
      .map((u) => ({
        item_name: itemNameById.get(u.item_id as string) ?? u.item_id,
        start: u.start_date,
        end: u.end_date,
        reason: u.reason ?? null,
      }));
    const vacation = { active_blocks: activeBlocks };

    // ── card: sell_reco ───────────────────────────────────────────
    // items.getSellRecommendations logic inlined: low-utilization or high-age items.
    const SELL_LOOKBACK_DAYS = 90;
    const SELL_UTIL_THRESHOLD = 25;
    const sellCutoffStr = new Date(Date.now() - SELL_LOOKBACK_DAYS * 86400000)
      .toISOString()
      .slice(0, 10);
    let sellReservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", sellCutoffStr))
      .collect();
    if (accountSlug) {
      sellReservations = sellReservations.filter((r) => r.account_slug === accountSlug);
    }
    const sellRentalDays = new Map<string, number>();
    for (const r of sellReservations) {
      for (const it of r.items ?? []) {
        const n = it.item_name ?? "";
        if (!n) continue;
        const s = new Date(r.start_date as string).getTime();
        const e = new Date(r.end_date as string).getTime();
        const days = Math.max(1, Math.round((e - s) / 86400000) + 1);
        sellRentalDays.set(n, (sellRentalDays.get(n) ?? 0) + days);
      }
    }
    const sellReco: Array<{ item_name: string; reason: string; suggested_price_gbp: number | null }> = [];
    for (const i of activeItems) {
      const rentalDays = sellRentalDays.get(i.name_canonical) ?? 0;
      const qty = i.qty ?? 1;
      const utilizationPct = Math.min(100, (rentalDays / Math.max(1, qty * SELL_LOOKBACK_DAYS)) * 100);
      const ageMonths = (Date.now() - i.created_at) / (1000 * 60 * 60 * 24 * 30);
      if (utilizationPct > SELL_UTIL_THRESHOLD && ageMonths < 24) continue;
      const priceRow = await ctx.db
        .query("pricing_catalog")
        .withIndex("by_name", (q) => q.eq("item_name_canonical", i.name_canonical))
        .first();
      const suggested = priceRow ? Math.round(priceRow.daily_price_min * 30) : null;
      const reason = utilizationPct <= SELL_UTIL_THRESHOLD ? "Low demand" : "High age";
      sellReco.push({ item_name: i.name_canonical, reason, suggested_price_gbp: suggested });
      if (sellReco.length >= 15) break;
    }
    const sell_reco = { recommendations: sellReco };

    // ── card: inventory_worth ─────────────────────────────────────
    // Qty-aware: equipment value = per-unit acquisition cost × units owned.
    // (e.g. owning 4× Sony FX3 @ £2,200 contributes £8,800, not £2,200.)
    const worthByKind = new Map<string, number>();
    for (const i of activeItems) {
      const lineValue = (i.acquisition_cost_gbp ?? 0) * (i.qty ?? 1);
      worthByKind.set(i.kind, (worthByKind.get(i.kind) ?? 0) + lineValue);
    }
    const totalWorth = activeItems.reduce(
      (s, i) => s + (i.acquisition_cost_gbp ?? 0) * (i.qty ?? 1),
      0,
    );
    const inventory_worth = {
      total_gbp: Math.round(totalWorth),
      by_category: Array.from(worthByKind.entries())
        .sort(([, a], [, b]) => b - a)
        .map(([kind, value]) => ({ kind, value: Math.round(value) })),
    };

    // ── card: tax ─────────────────────────────────────────────────
    // Aggregate historical_revenue by calendar year + estimate tax at 20% flat.
    // Also folds in current-year earnings from reservations.
    const histRows = await ctx.db.query("historical_revenue").collect();
    const taxByYear = new Map<number, number>();
    for (const h of histRows) {
      const yr = parseInt(h.month.slice(0, 4), 10);
      if (!isNaN(yr)) {
        taxByYear.set(yr, (taxByYear.get(yr) ?? 0) + (h.total_overall_made_gbp ?? 0));
      }
    }
    // Add current-year live earnings from reservations
    const currentYear = new Date().getFullYear();
    const currentYearEarnings = allRes
      .filter((r) => {
        const yr = parseInt((r.start_date as string ?? "").slice(0, 4), 10);
        return yr === currentYear && (r.status === "confirmed" || r.status === "completed");
      })
      .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
    if (currentYearEarnings > 0) {
      taxByYear.set(currentYear, (taxByYear.get(currentYear) ?? 0) + currentYearEarnings);
    }
    const TAX_RATE = 0.20;
    const tax = {
      years: Array.from(taxByYear.entries())
        .sort(([a], [b]) => b - a)
        .slice(0, 5)
        .map(([year, gross]) => ({
          year,
          gross: Math.round(gross),
          estimated_tax: Math.round(gross * TAX_RATE),
        })),
    };

    // ── card: business_intel ──────────────────────────────────────
    // Compose KPI badges from purchase_signals + churn_risk MVs.
    const [psRow, crRow] = await Promise.all([
      ctx.db
        .query("purchase_signals")
        .withIndex("by_account", (q) => q.eq("account", accountSlug ?? "all"))
        .first(),
      ctx.db
        .query("churn_risk_renters")
        .withIndex("by_account", (q) => q.eq("account", accountSlug ?? "all"))
        .first(),
    ]);
    type KpiBadge = "strong" | "moderate" | "watch";
    const kpis: Array<{ label: string; value: string; badge: KpiBadge }> = [];
    // Purchase signals KPI
    const psSignals: Array<{ itemRequested: string; requestCount30d: number; projectedAnnualGbp: number }> =
      (psRow as { signals?: Array<{ itemRequested: string; requestCount30d: number; projectedAnnualGbp: number }> } | null)?.signals ?? [];
    if (psSignals.length > 0) {
      const top = psSignals[0];
      kpis.push({
        label: "Top unmet demand",
        value: `${top.itemRequested} (${top.requestCount30d} req/30d, £${top.projectedAnnualGbp}/yr)`,
        badge: top.projectedAnnualGbp >= 500 ? "strong" : top.projectedAnnualGbp >= 150 ? "moderate" : "watch",
      });
    } else {
      kpis.push({ label: "Unmet demand", value: "No signals", badge: "watch" });
    }
    // Churn risk KPI
    const crRows: Array<{ risk: string; renterName: string; lifetimeGbp: number }> =
      (crRow as { rows?: Array<{ risk: string; renterName: string; lifetimeGbp: number }> } | null)?.rows ?? [];
    const highRisk = crRows.filter((r) => r.risk === "high");
    if (highRisk.length === 0) {
      kpis.push({ label: "Renter churn risk", value: "No high-risk renters", badge: "strong" });
    } else {
      kpis.push({
        label: "Renter churn risk",
        value: `${highRisk.length} high-risk renter${highRisk.length > 1 ? "s" : ""}`,
        badge: highRisk.length >= 3 ? "watch" : "moderate",
      });
    }
    // AI decision acceptance rate KPI
    const totalDecisions = await ctx.db.query("ai_decision").collect()
      .then((rows) => rows.filter((r) => (!accountSlug || r.account_slug === accountSlug)));
    const acceptedCount = totalDecisions.filter((r) => r.status === "approved").length;
    const acceptRate = totalDecisions.length > 0
      ? Math.round((acceptedCount / totalDecisions.length) * 100)
      : null;
    if (acceptRate !== null) {
      kpis.push({
        label: "AI accept rate",
        value: `${acceptRate}% (${acceptedCount}/${totalDecisions.length})`,
        badge: acceptRate >= 70 ? "strong" : acceptRate >= 40 ? "moderate" : "watch",
      });
    }
    const business_intel = { kpis };

    // ── Layer B (2026-05-19) — qty-drift count for CriticalAlerts widget ─
    // Cheap inline read: open rows in qty_drift_alerts scoped to the account
    // (or global on accountSlug=null). Surfaces as a small badge inside the
    // existing CriticalAlerts component rather than adding a new widget.
    const qtyDriftRows = accountSlug
      ? await ctx.db
          .query("qty_drift_alerts")
          .withIndex("by_account_status", (q) =>
            q.eq("account_slug", accountSlug).eq("status", "open"),
          )
          .collect()
      : await ctx.db
          .query("qty_drift_alerts")
          .withIndex("by_status", (q) => q.eq("status", "open"))
          .collect();
    // Drop drift on PAST bookings (returned/reviewed/completed): an unmatched
    // listing on a finished rental is not actionable, so it should not nag.
    const PAST_DRIFT_STEPS = new Set(["RETURNED", "REVIEWED"]);
    const driftRes = await Promise.all(
      qtyDriftRows.map((r) => ctx.db.get(r.reservation_id)),
    );
    const liveDriftRows = qtyDriftRows.filter((_, i) => {
      const res = driftRes[i] as { status?: string; order_step?: string } | null;
      if (!res) return false;
      if (res.status === "completed") return false;
      if (typeof res.order_step === "string" && PAST_DRIFT_STEPS.has(res.order_step)) return false;
      return true;
    });
    const qty_drift_count = liveDriftRows.length;
    const qty_drift_sample = liveDriftRows.slice(0, 10).map((r) => ({
      reservation_id: r.reservation_id as string,
      hygglo_order_id: r.hygglo_order_id,
      renter_name: r.renter_name ?? null,
      drift_kind: r.drift_kind,
      raw_n: r.raw_n,
      expanded_n: r.expanded_n,
    }));

    // ── Blacklisted-renter alerts ──────────────────────────────────────────
    // Every LIVE booking (request → out; not cancelled/declined/completed/
    // obsolete) from a blacklisted renter, surfaced top-of-dashboard so a repeat
    // bad actor is caught at request time and all the way through the rental.
    const blacklistAlerts: Array<{
      reservation_id: string;
      renter_name: string | null;
      order_step: string | null;
      start_date: string | null;
      end_date: string | null;
      items: string[];
      account_slug: string | null;
      reason: string | null;
    }> = [];
    {
      const allRenters = await ctx.db.query("renters").collect();
      const blByHuid = new Map<string, string | null>();
      const blByName = new Map<string, string | null>();
      const blById = new Map<string, string | null>();
      for (const rt of allRenters) {
        if (!(rt.blacklisted || rt.blacklist)) continue;
        const reason = rt.blacklist_reason ?? null;
        if (rt.hygglo_user_id) blByHuid.set(rt.hygglo_user_id, reason);
        blById.set(rt._id as string, reason);
        const nm = (rt.display_name ?? "").trim().toLowerCase();
        if (nm) blByName.set(nm, reason);
      }
      if (blById.size > 0) {
        for (const r of allRes) {
          if (r.status === "cancelled" || r.status === "declined" || r.status === "completed" || r.is_obsolete) continue;
          const rid = r.renter_id as string | undefined;
          const huid = (r as { hygglo_user_id?: string }).hygglo_user_id;
          const nm = (r.renter_name ?? "").trim().toLowerCase();
          const reason =
            (rid && blById.has(rid) ? blById.get(rid) : undefined) ??
            (huid && blByHuid.has(huid) ? blByHuid.get(huid) : undefined) ??
            (blByName.has(nm) ? blByName.get(nm) : undefined);
          if (reason === undefined) continue;
          blacklistAlerts.push({
            reservation_id: (r.hygglo_order_id ?? r._id) as string,
            renter_name: r.renter_name ?? null,
            order_step: r.order_step ?? null,
            start_date: r.start_date ?? null,
            end_date: r.end_date ?? null,
            items: (r.items ?? []).map((i) => i.item_name).slice(0, 3),
            account_slug: r.account_slug ?? null,
            reason: reason ?? null,
          });
        }
      }
    }

    return {
      active: {
        total: activeTotal,
        ongoing_count: ongoingGroupRows.length,
        upcoming_count: upcomingGroupRows.length,
        pending_count: pendingTrackedCount,
        pending_next_month_count: pendingNextMonthCount,
        pending_value_gbp: Math.round(pendingTrackedValue * 100) / 100,
        rentals: activeRentals,
      },
      // Pinned critical alerts — surfaced at the top of the dashboard.
      // conflicts: item has qty < concurrent reservations in next 90d.
      // untracked: paid+verifying rows whose items aren't in master inventory.
      // qty_drift_count: open rows in qty_drift_alerts (Layer B audit).
      conflicts,
      blacklist_alerts: blacklistAlerts,
      qty_drift_count,
      qty_drift_sample,
      untracked: untrackedPayload,
      earnings,
      monthly,
      confirmed,
      ongoing: ongoingCard,
      upcoming: upcomingCard,
      scanner,
      insurance,
      denied_revenue,
      missed_revenue,
      ai_boost,
      out_of_stock,
      vacation,
      sell_reco,
      inventory_worth,
      tax,
      business_intel,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Next Rentals widget query - pickups + returns for a target day.
// Phase 9 / FIX-DESIGN §4.5: now uses the shared `buildItemTilesShared`
// helper (top of file) instead of the previously-duplicated
// `buildItemTilesLocal`. Single source of truth eliminates drift.
// ─────────────────────────────────────────────────────────────────────────────
export const getNextRentals = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    day: v.union(v.literal("today"), v.literal("tomorrow")),
  },
  handler: async (ctx, { accountSlug, day }) => {
    const now = new Date();
    const baseToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = day === "today" ? baseToday : new Date(baseToday.getTime() + 86400000);
    const targetDate = target.toISOString().slice(0, 10);

    // Indexed read — only need rows whose start_date is within ~30 days
    // of target. Drops ~1767 → ~30.
    const nextCutoff = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString().slice(0, 10);
    })();
    let rows = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", nextCutoff))
      .collect();
    if (accountSlug) rows = rows.filter((r) => r.account_slug === accountSlug);
    const confirmed = rows.filter(
      (r) =>
        r.status === "confirmed" &&
        !r.is_obsolete &&
        r.start_date !== undefined &&
        r.end_date !== undefined,
    );

    // Build item-image lookup + shared-image blacklist once for this query.
    // Both feed the shared `buildItemTilesShared` helper (top of file).
    const items = await ctx.db.query("items").collect();
    const itemImageById = new Map<string, { name: string; image_url: string | null }>();
    for (const it of items) {
      const id = (it as { item_id?: string }).item_id ?? (it._id as unknown as string);
      itemImageById.set(id, {
        name: (it as { name?: string }).name ?? "",
        image_url: ((it as { image_url?: string | null }).image_url) ?? null,
      });
    }
    const sharedBlacklist = buildSharedImageBlacklist(
      items.map((it) => ({ image_url: (it as { image_url?: string | null }).image_url ?? null })),
    );

    // Phase 5.3: priority-0 listing_images bank for this query too, so the
    // shared helper no longer bypasses it on the Next Rentals widget.
    const listingImagesNext = await ctx.db.query("listing_images").collect();
    const bankByProductNext = new Map<string, string>();
    for (const li of listingImagesNext) {
      bankByProductNext.set(`${li.account_slug}#${li.product_id}`, li.image_url);
    }

    const buildItemTilesLocal = (r: any): ItemTile[] => {
      const hyggloItems = (r.hygglo_items ?? []) as Array<{ name?: string; product_id?: number }>;
      const productIdForItem = (item: { item_name_canonical: string }): number | null => {
        const target = normaliseItemName(item.item_name_canonical);
        if (!target) return null;
        const hit = hyggloItems.find((h) => normaliseItemName(h?.name ?? "") === target);
        return hit?.product_id ?? null;
      };
      return buildItemTilesShared({
        reservation: r as Parameters<typeof buildItemTilesShared>[0]["reservation"],
        itemImageById,
        sharedBlacklist,
        bankByProduct: bankByProductNext,
        productIdForItem,
      });
    };

    const mapForWire = (r: any, role: "pickup" | "return") => ({
      reservation_id: r.hygglo_order_id ?? r.v1_rental_id ?? (r._id as string),
      renter_name: r.renter_name ?? null,
      account_slug: r.account_slug,
      start_date: r.start_date ?? null,
      end_date: r.end_date ?? null,
      pickup_date: r.pickup_date ?? r.start_date ?? null,
      pickup_time: r.pickup_time ?? null,
      return_date: r.return_date ?? r.end_date ?? null,
      return_time: r.return_time ?? null,
      pickup_method: r.pickup_method ?? null,
      return_method: r.return_method ?? null,
      items: (r.items ?? []).map((i: any) => i.item_name),
      photo_url: (r.photos_urls ?? [])[0] ?? null,
      net_gbp: r.net_to_owner_gbp ?? null,
      duration_days: r.duration_days ?? null,
      role,
      item_tiles: buildItemTilesLocal(r),
    });

    const pickups = confirmed
      .filter((r) => (r.pickup_date ?? r.start_date) === targetDate)
      .map((r) => mapForWire(r, "pickup"))
      .sort((a, b) =>
        (a.pickup_time ?? "99:99").localeCompare(b.pickup_time ?? "99:99"),
      );

    const returns = confirmed
      .filter((r) => ((r as any).return_date ?? r.end_date) === targetDate)
      .map((r) => mapForWire(r, "return"))
      .sort((a, b) =>
        (a.return_time ?? "99:99").localeCompare(b.return_time ?? "99:99"),
      );

    // For each pickup, find returns within ±60min on the same target day.
    const timeToMin = (t: string | null): number | null => {
      if (!t || t.length < 5) return null;
      const h = parseInt(t.slice(0, 2), 10);
      const m = parseInt(t.slice(3, 5), 10);
      if (Number.isNaN(h) || Number.isNaN(m)) return null;
      return h * 60 + m;
    };

    const pickupsWithReturns = pickups.map((p) => {
      const pt = timeToMin(p.pickup_time);
      if (pt === null) return { ...p, concurrent_returns: [] as typeof returns };
      const matched = returns.filter((rt) => {
        const rtm = timeToMin(rt.return_time);
        return rtm !== null && Math.abs(rtm - pt) <= 60;
      });
      return { ...p, concurrent_returns: matched };
    });

    const pairedReturnIds = new Set(
      pickupsWithReturns.flatMap((p) =>
        p.concurrent_returns.map((r) => r.reservation_id),
      ),
    );
    const unpairedReturns = returns.filter(
      (r) => !pairedReturnIds.has(r.reservation_id),
    );

    return {
      targetDate,
      pickups: pickupsWithReturns,
      unpairedReturns,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Category Rental-Volume Pie widget — this-month deduped confirmed reservations
// grouped by item.kind. Returns both count and revenue per kind. Top 6 + Other.
// Reuses isConfirmedWithDates / isPaidWithV1Legacy / inDateRange / netOf /
// dedupByLogicalRental from predicates. Revenue split across resolver items
// weighted by (pricing_catalog daily_price_min * qty); equal split fallback.
// ─────────────────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<string, string> = {
  camera: "Cameras", lens: "Lenses", drone: "Drones", audio: "Audio",
  lighting: "Lighting", grip: "Grip", gimbal: "Gimbals", monitor: "Monitors",
  transmission: "Transmission", accessory: "Accessories", smoke_fx: "Smoke/FX",
  dj_audio: "DJ Audio", power: "Power", storage_card: "Storage", support: "Support",
  motion: "Motion", stabilizer: "Stabilizers", video: "Video", effects: "Effects",
  bundle: "Bundles", unknown: "Unknown", other: "Other",
};
const labelFor = (k: string): string =>
  KIND_LABELS[k] ?? (k.charAt(0).toUpperCase() + k.slice(1));

const CATEGORY_PALETTE = ["#60a5fa", "#34d399", "#a78bfa", "#fbbf24", "#f87171", "#22d3ee"];
const OTHER_COLOR = "#cbd5e1";

type ResolverItem = { item_id: string; item_name_canonical: string; qty: number };

/** Prefer expanded_items (bundle-decomposed); fall back to resolved_items. */
function readResolverItems(r: {
  expanded_items?: Array<{ item_id: string; item_name_canonical: string; qty: number }>;
  resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
}): ResolverItem[] {
  const expanded = r.expanded_items ?? [];
  if (expanded.length > 0) {
    return expanded.map((x) => ({
      item_id: x.item_id,
      item_name_canonical: x.item_name_canonical,
      qty: x.qty,
    }));
  }
  const resolved = r.resolved_items ?? [];
  return resolved.map((x) => ({
    item_id: x.item_id,
    item_name_canonical: x.item_name_canonical,
    qty: x.qty ?? 1,
  }));
}

export const getRentalVolumeByCategory = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.optional(v.number()),
    _bypassMv: v.optional(v.boolean()),
  },
  handler: async (ctx, { accountSlug, days, _bypassMv }) => {
    const effectiveDays = typeof days === "number" ? days : 30;
    if (!_bypassMv) {
      const accountKey = accountSlug ?? "all";
      const cached = await ctx.db
        .query("mv_rental_volume_by_category")
        .withIndex("by_account_days", (q) =>
          q.eq("account", accountKey).eq("days", effectiveDays),
        )
        .first();
      if (cached) return cached.payload;
    }
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - effectiveDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }
    // Match revenue.ts semantics: drop cancelled/declined/obsolete, then
    // collapse v1/Hygglo duplicates, then restrict to effectiveDate window.
    reservations = reservations.filter(isLive);
    reservations = dedupByLogicalRental(reservations);
    const todayStr = new Date().toISOString().slice(0, 10);
    reservations = reservations.filter((r) => {
      const d = effectiveDate(r);
      return d !== undefined && d >= cutoffStr && d <= todayStr;
    });

    // Pricing catalog for revenue split weights (canonical → daily_price_min).
    const pricingAll = await ctx.db.query("pricing_catalog").collect();
    const priceByCanonical = new Map<string, number>(
      pricingAll.map((p) => [p.item_name_canonical, p.daily_price_min]),
    );

    // Item kind lookup (_id → kind).
    const items = await ctx.db.query("items").collect();
    const kindById = new Map<string, string>();
    for (const it of items) kindById.set(it._id as string, it.kind);

    // Phase 6 — attribution engine is the only path. Maps built once, reused.
    const itemById = new Map<typeof items[number]["_id"], typeof items[number]>();
    const itemByCanonical = new Map<string, typeof items[number]>();
    for (const it of items) {
      itemById.set(it._id, it);
      const nm = (it as { name_canonical?: string }).name_canonical;
      if (nm) itemByCanonical.set(nm, it);
    }

    const countByKind = new Map<string, number>();
    const revenueByKind = new Map<string, number>();

    for (const r of reservations) {
      const resolved =
        (r as {
          resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
        }).resolved_items ?? [];
      if (resolved.length === 0) continue;

      const rental: RentalForAttribution = {
        _id: r._id,
        gross_gbp: r.gross_paid_gbp ?? 0,
        duration_days: r.duration_days,
        expanded_items: (r as { expanded_items?: RentalForAttribution["expanded_items"] }).expanded_items,
        resolved_items: resolved as RentalForAttribution["resolved_items"],
      };
      const lines = attributeRevenue(rental, {
        itemById,
        itemByCanonical,
        priceByName: priceByCanonical,
      });
      for (const line of lines) {
        const k = line.kind;
        // One AttributionLine per input pickLines entry; count is per source line.
        countByKind.set(k, (countByKind.get(k) ?? 0) + 1);
        revenueByKind.set(k, (revenueByKind.get(k) ?? 0) + line.share);
      }
    }

    // Assemble entries (any kind with count>0 OR revenue>0).
    const kinds = new Set<string>([...countByKind.keys(), ...revenueByKind.keys()]);
    const entries = Array.from(kinds)
      .map((k) => ({
        kind: k,
        label: labelFor(k),
        count: countByKind.get(k) ?? 0,
        revenue: revenueByKind.get(k) ?? 0,
      }))
      .filter((e) => e.count > 0 || e.revenue > 0)
      .sort((a, b) => b.count - a.count);

    // Pre-truncation totals.
    const totals = {
      count: entries.reduce((s, e) => s + e.count, 0),
      revenue: Math.round(entries.reduce((s, e) => s + e.revenue, 0) * 100) / 100,
    };

    // Phase 6 — extract `unknown` to its own "Unresolved" slice. Sits OUTSIDE
    // the top-6/Other split below.
    let unresolvedEntry: typeof entries[number] | null = null;
    let topPool = entries;
    const idx = entries.findIndex((e) => e.kind === "unknown");
    if (idx >= 0) {
      const e = entries[idx];
      if (e.revenue > 0 || e.count > 0) {
        unresolvedEntry = { ...e, label: "Unresolved" };
      }
      topPool = entries.filter((_, i) => i !== idx);
    }

    // Top 6 + Other.
    const top = topPool.slice(0, 6);
    const rest = topPool.slice(6);
    const slices: Array<{
      kind: string;
      label: string;
      count: number;
      revenue: number;
      color: string;
    }> = top.map((e, i) => ({
      kind: e.kind,
      label: e.label,
      count: e.count,
      revenue: Math.round(e.revenue * 100) / 100,
      color: CATEGORY_PALETTE[i] ?? OTHER_COLOR,
    }));
    if (rest.length > 0) {
      const otherCount = rest.reduce((s, e) => s + e.count, 0);
      const otherRevenue = rest.reduce((s, e) => s + e.revenue, 0);
      if (otherCount > 0) {
        slices.push({
          kind: "other",
          label: "Other",
          count: otherCount,
          revenue: Math.round(otherRevenue * 100) / 100,
          color: OTHER_COLOR,
        });
      }
    }
    if (unresolvedEntry && (unresolvedEntry.revenue > 0 || unresolvedEntry.count > 0)) {
      slices.push({
        kind: "unknown",
        label: "Unresolved",
        count: unresolvedEntry.count,
        revenue: Math.round(unresolvedEntry.revenue * 100) / 100,
        color: "#9ca3af",
      });
    }

    return {
      days: effectiveDays,
      periodStart: cutoffStr,
      slices,
      totals,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Drill-down: items within a kind (or items in the "other" merged bucket)
// for the same period/account as getRentalVolumeByCategory. Single-level.
// ─────────────────────────────────────────────────────────────────────────────

export const getRentalVolumeKindBreakdown = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
    kind: v.string(),
    // Pass 10a (2026-05-25): _bypassMv true ONLY for the refresher path.
    _bypassMv: v.optional(v.boolean()),
  },
  handler: async (ctx, { accountSlug, days, kind, _bypassMv }) => {
    if (!_bypassMv) {
      const accountKey = accountSlug ?? "all";
      const cached = await ctx.db
        .query("mv_rental_volume_kind_breakdown")
        .withIndex("by_account_days_kind", (q) =>
          q.eq("account", accountKey).eq("days", days).eq("kind", kind),
        )
        .first();
      if (cached) {
        return cached.payload;
      }
    }
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }
    reservations = reservations.filter(isLive);
    reservations = dedupByLogicalRental(reservations);
    const todayStr = new Date().toISOString().slice(0, 10);
    reservations = reservations.filter((r) => {
      const d = effectiveDate(r);
      return d !== undefined && d >= cutoffStr && d <= todayStr;
    });

    const pricingAll = await ctx.db.query("pricing_catalog").collect();
    const priceByCanonical = new Map<string, number>(
      pricingAll.map((p) => [p.item_name_canonical, p.daily_price_min]),
    );

    const items = await ctx.db.query("items").collect();
    const kindById = new Map<string, { kind: string; name: string }>();
    for (const it of items) {
      kindById.set(it._id as string, {
        kind: it.kind,
        name: (it as { name_canonical?: string }).name_canonical ?? it.kind,
      });
    }

    // First pass: count by kind to determine the top-6/other split, mirroring
    // the main query so "other" drill-down resolves to the same set.
    const countByKind = new Map<string, number>();
    for (const r of reservations) {
      const resolved =
        (r as {
          resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
        }).resolved_items ?? [];
      for (const x of resolved) {
        const k = kindById.get(x.item_id)?.kind ?? "unknown";
        countByKind.set(k, (countByKind.get(k) ?? 0) + (x.qty ?? 1));
      }
    }
    const rankedKinds = Array.from(countByKind.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
    const topKinds = new Set(rankedKinds.slice(0, 6));
    const otherKinds = new Set(rankedKinds.slice(6));

    const isInTargetSet = (k: string): boolean => {
      if (kind === "other") return otherKinds.has(k);
      return k === kind;
    };

    // Phase 6 — attribution engine is the only path.
    const itemById = new Map<typeof items[number]["_id"], typeof items[number]>();
    const itemByCanonical = new Map<string, typeof items[number]>();
    for (const it of items) {
      itemById.set(it._id, it);
      const nm = (it as { name_canonical?: string }).name_canonical;
      if (nm) itemByCanonical.set(nm, it);
    }

    // Second pass: split each row's gross across ALL resolved items (to keep
    // attribution math identical to the main query), then keep only the
    // in-target items.
    const itemCount = new Map<string, number>();
    const itemRevenue = new Map<string, number>();
    for (const r of reservations) {
      const resolved =
        (r as {
          resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
        }).resolved_items ?? [];
      if (resolved.length === 0) continue;

      const rental: RentalForAttribution = {
        _id: r._id,
        gross_gbp: r.gross_paid_gbp ?? 0,
        duration_days: r.duration_days,
        expanded_items: (r as { expanded_items?: RentalForAttribution["expanded_items"] }).expanded_items,
        resolved_items: resolved as RentalForAttribution["resolved_items"],
      };
      const lines = attributeRevenue(rental, {
        itemById,
        itemByCanonical,
        priceByName: priceByCanonical,
      });
      for (const line of lines) {
        if (!isInTargetSet(line.kind)) continue;
        const idStr = (line.key.id as string | undefined) ?? line.key.nameCanonical;
        itemCount.set(idStr, (itemCount.get(idStr) ?? 0) + 1);
        itemRevenue.set(idStr, (itemRevenue.get(idStr) ?? 0) + line.share);
      }
    }

    type ItemSlice = { itemId: string; name: string; count: number; revenue: number; color: string };
    const allIds = new Set<string>([...itemCount.keys(), ...itemRevenue.keys()]);
    const entries: ItemSlice[] = Array.from(allIds)
      .map((id) => ({
        itemId: id,
        name: kindById.get(id)?.name ?? id,
        count: itemCount.get(id) ?? 0,
        revenue: Math.round((itemRevenue.get(id) ?? 0) * 100) / 100,
        color: "",
      }))
      .filter((e) => e.count > 0 || e.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue);

    const PALETTE = ["#60a5fa", "#34d399", "#a78bfa", "#fbbf24", "#f87171", "#22d3ee"];
    // Show each item individually (no "Other items" bucket). Cap at top-15 by
    // revenue to keep middle-ring labels readable.
    const items_out: ItemSlice[] = entries.slice(0, 15).map((e, i) => ({
      ...e,
      color: PALETTE[i % PALETTE.length],
    }));

    const totals = {
      count: items_out.reduce((s, e) => s + e.count, 0),
      revenue: Math.round(items_out.reduce((s, e) => s + e.revenue, 0) * 100) / 100,
    };

    return {
      days,
      periodStart: cutoffStr,
      kind,
      kindLabel: labelFor(kind),
      items: items_out,
      totals,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Sub-kinds of the "Other" bucket: rolls the same dataset as
// getRentalVolumeByCategory but only over the kinds that were NOT in the top-6.
// Same isLive/dedup/effectiveDate filters so totals reconcile.
// ─────────────────────────────────────────────────────────────────────────────

export const getRentalVolumeOtherSubKinds = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, days }) => {
    const effectiveDays = typeof days === "number" ? days : 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - effectiveDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }
    reservations = reservations.filter(isLive);
    reservations = dedupByLogicalRental(reservations);
    const todayStr = new Date().toISOString().slice(0, 10);
    reservations = reservations.filter((r) => {
      const d = effectiveDate(r);
      return d !== undefined && d >= cutoffStr && d <= todayStr;
    });

    const pricingAll = await ctx.db.query("pricing_catalog").collect();
    const priceByCanonical = new Map<string, number>(
      pricingAll.map((p) => [p.item_name_canonical, p.daily_price_min]),
    );

    const items = await ctx.db.query("items").collect();
    const kindById = new Map<string, string>();
    for (const it of items) kindById.set(it._id as string, it.kind);

    // Phase 6 — attribution engine is the only path.
    const itemById = new Map<typeof items[number]["_id"], typeof items[number]>();
    const itemByCanonical = new Map<string, typeof items[number]>();
    for (const it of items) {
      itemById.set(it._id, it);
      const nm = (it as { name_canonical?: string }).name_canonical;
      if (nm) itemByCanonical.set(nm, it);
    }

    const countByKind = new Map<string, number>();
    const revenueByKind = new Map<string, number>();

    for (const r of reservations) {
      const resolved =
        (r as {
          resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
        }).resolved_items ?? [];
      if (resolved.length === 0) continue;

      const rental: RentalForAttribution = {
        _id: r._id,
        gross_gbp: r.gross_paid_gbp ?? 0,
        duration_days: r.duration_days,
        expanded_items: (r as { expanded_items?: RentalForAttribution["expanded_items"] }).expanded_items,
        resolved_items: resolved as RentalForAttribution["resolved_items"],
      };
      const lines = attributeRevenue(rental, {
        itemById,
        itemByCanonical,
        priceByName: priceByCanonical,
      });
      for (const line of lines) {
        const k = line.kind;
        countByKind.set(k, (countByKind.get(k) ?? 0) + 1);
        revenueByKind.set(k, (revenueByKind.get(k) ?? 0) + line.share);
      }
    }

    const kinds = new Set<string>([...countByKind.keys(), ...revenueByKind.keys()]);
    const entries = Array.from(kinds)
      .map((k) => ({
        kind: k,
        label: labelFor(k),
        count: countByKind.get(k) ?? 0,
        revenue: revenueByKind.get(k) ?? 0,
      }))
      .filter((e) => e.count > 0 || e.revenue > 0)
      .sort((a, b) => b.count - a.count);

    // Phase 6 — strip `unknown` from the "Other" sub-bucket so Unresolved is
    // not double-counted (it appears as its own slice in the parent query).
    const topPool = entries.filter((e) => e.kind !== "unknown");
    // Same split as main query: top 6 stay top, rest = "Other".
    const rest = topPool.slice(6);
    const PALETTE = ["#60a5fa", "#34d399", "#a78bfa", "#fbbf24", "#f87171", "#22d3ee", "#ec4899", "#14b8a6", "#eab308", "#8b5cf6", "#f97316", "#10b981", "#3b82f6", "#d946ef", "#84cc16", "#cbd5e1"];
    const slices = rest.map((e, i) => ({
      kind: e.kind,
      label: e.label,
      count: e.count,
      revenue: Math.round(e.revenue * 100) / 100,
      color: PALETTE[i % PALETTE.length],
    }));

    const totals = {
      count: slices.reduce((s, e) => s + e.count, 0),
      revenue: Math.round(slices.reduce((s, e) => s + e.revenue, 0) * 100) / 100,
    };

    return {
      days: effectiveDays,
      periodStart: cutoffStr,
      slices,
      totals,
    };
  },
});
