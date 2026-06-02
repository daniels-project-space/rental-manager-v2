/**
 * Pure compute core for getMissedAndDeniedByCategory (read-reduction refactor,
 * 2026-06-02).
 *
 * BEFORE: the live branch of revenue.ts:getMissedAndDeniedByCategory did 5 DB
 * reads per call (items.collect, pricing_catalog.collect, reservations
 * by_is_obsolete TWICE, reservations by_start_date), and diagnoseDenialCapacity
 * did a fresh items.collect + per-ref ctx.db.get for every owner-denied row.
 * The MV refresher called this 9× (3 accounts × {30,90,365}) → 45 obsolete
 * scans + 9 items scans + 9 completed scans + N per-row item gets per refresh.
 *
 * AFTER: fetchMissedDeniedData() does the 4 reads ONCE (widest window, no
 * account filter — windows nest 30⊂90⊂365 and "all" = dbcinema+leo). The pure
 * computeMissedAndDeniedByCategory() derives every (account, days) cell from
 * that one snapshot in memory, sharing one clock (`now`).
 *
 * The compute body below is copied VERBATIM from the original live branch
 * (revenue.ts ~1038–1512) with the 5 DB reads replaced by in-memory filters.
 * Output MUST stay byte-identical — this is a pure refactor.
 */
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  buildCommitmentMap,
  buildItemLookup,
  diagnoseDenialCapacityPure,
  isCompletedCommitting,
} from "../lib/capacity_gap";
import { resolveListingToInventory } from "../lib/listing_equivalence";
import { MASTER_INVENTORY_KEYS } from "../lib/item_matcher";

// ---------------------------------------------------------------------------
// Shared pure helpers (moved here from revenue.ts so both modules share ONE
// definition; revenue.ts re-imports them from this module).
// ---------------------------------------------------------------------------

export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const MISSED_KIND_LABELS: Record<string, string> = {
  camera: "Cameras", lens: "Lenses", drone: "Drones", audio: "Audio",
  lighting: "Lighting", grip: "Grip", gimbal: "Gimbals", monitor: "Monitors",
  transmission: "Transmission", accessory: "Accessories", smoke_fx: "Smoke/FX",
  dj_audio: "DJ Audio", power: "Power", storage_card: "Storage", support: "Support",
  motion: "Motion", stabilizer: "Stabilizers", video: "Video", effects: "Effects",
  bundle: "Bundles", unknown: "Unknown", other: "Other",
};
export const MISSED_PALETTE = ["#fde047", "#fbbf24", "#f59e0b", "#fb923c", "#f97316", "#ef4444"];
export const MISSED_OTHER_COLOR = "#7f1d1d";
export const MISSED_UNMATCHED_COLOR = "#94a3b8";

export function missedLabelFor(k: string): string {
  return MISSED_KIND_LABELS[k] ?? (k.charAt(0).toUpperCase() + k.slice(1));
}

/**
 * Phase 7.10 — keyword-based fallback kind classifier. Used when the resolver
 * fails to map an item_name to a canonical and we still want to bucket it.
 * Order matters — earliest match wins. Returns undefined only on total miss.
 */
export function kindFromKeywords(rawName: string): string | undefined {
  const n = rawName.toLowerCase();
  // Audio first (microphone/mic/speaker/audio recorder)
  if (/\b(microphone|microphones|wireless\s+mic|radio\s+mic|shotgun\s+mic|lapel|lavalier|sennheiser|senheiser|rode|zoom\s+h\d|mke\s*\d|ew\s*\d|audio\s+recorder|partybox|jbl|mackie|pa\s+system|loud\s*speaker|party\s+speaker|dj\s+speaker|bluetooth\s+speaker|mic\s+set)\b/.test(n)) {
    if (/\b(speaker|partybox|jbl|mackie|pa\s+system)\b/.test(n)) return "dj_audio";
    return "audio";
  }
  // Smoke / FX
  if (/\b(fog\s*machine|smoke\s*machine|haze\s*machine|fogger|smoke\s*fx)\b/.test(n)) return "smoke_fx";
  // Projectors
  if (/\b(projector|nebula\s+4k|viewsonic|epson|benq)\b/.test(n)) return "video";
  // Transmission
  if (/\b(hollyland|teradek|wireless\s+video|video\s+transmitter|sdi\s+transmitter|hdmi\s+transmitter|mars\s+4k)\b/.test(n)) return "transmission";
  // Monitor
  if (/\b(smallhd|monitor|cine\s+\d|atomos\s+ninja|director\s+monitor)\b/.test(n)) return "monitor";
  // Gimbal / stabilizer
  if (/\b(gimbal|ronin|rs\s*\d|crane\s*\d|stabilizer|flycam|easyrig|easy\s*rig|flow\s*line|float\s+gimbal)\b/.test(n)) return "stabilizer";
  // Support: tripod, slider, support vest
  if (/\b(tripod|slider|manfrotto\s+190|sachtler|benro|fluid\s+head|video\s+head|support\s+vest|jib|crane)\b/.test(n)) return "support";
  // Lighting
  if (/\b(aputure|godox|softbox|lantern|600x|600d|300x|amaran|nanlite|light\s+modifier|bowens|key\s+light|fill\s+light)\b/.test(n)) return "lighting";
  // Drone
  if (/\b(drone|dji\s+air|dji\s+mavic|dji\s+inspire|dji\s+mini|fpv\s+drone)\b/.test(n)) return "drone";
  // Lens — must contain "mm" AND lens-y term
  if (/\b\d{1,3}(\.\d)?\s*[-–]?\s*\d{0,3}(\.\d)?\s*mm\b/.test(n) && /\b(lens|prime|zoom|fisheye|anamorphic|gm|g\s*master|gmaster|f\/?\d|t\d|art|sigma|sony\s+fe|canon\s+rf|dzo|zeiss|vespid|arles)\b/.test(n)) return "lens";
  if (/\b(lens|prime\s+set|zoom\s+lens|fisheye)\b/.test(n)) return "lens";
  // Camera
  if (/\b(camera|sony\s+a\d|sony\s+fx\d|fx\s*3|fx\s*6|alpha\s+\d|canon\s+r\d|c\s*70|c\s*200|c\s*300|red\s+komodo|alexa|arri|bmpcc|pyxis|blackmagic|panasonic\s+s\d|fujifilm|x[-\s]?t\d|gh\d|osmo\s+pocket|pocket\s+camera|mirrorless|camcorder)\b/.test(n)) return "camera";
  // Storage / SD
  if (/\b(sd\s*card|cfexpress|cf\s*express|nvme|ssd\s+drive|storage|v\d{2}\s*card|128gb|256gb|512gb|1tb)\b/.test(n)) return "storage_card";
  // Power / batteries
  if (/\b(battery|np-?fw|np-?w|np-?f|d-?tap|v-?mount|gold\s*mount|battery\s+plate|power\s+station)\b/.test(n)) return "power";
  // Accessory (filters etc.)
  if (/\b(nd\s+filter|vnd|polarizer|cpl\s+filter|matte\s+box|follow\s+focus|flash|speedlight|cage|rig\s+plate)\b/.test(n)) return "accessory";
  return undefined;
}

/**
 * Module-scope owner-denied-like predicate (Phase 7.12 + EQ-B).
 *
 * Shared between `getMissedAndDeniedByCategory` and `getMissedKindBreakdown`
 * so drill-down semantics match the parent ring. A row counts as
 * "owner-denied" if EITHER:
 *   (a) reclassified_outcome / denial_actor = "owner_denied"  (post-classifier), OR
 *   (b) is_obsolete=true AND status in {cancelled, declined} AND order_step
 *       in {REQUEST, APPROVED, FUNDS_RESERVED} — pre-handover owner cancel.
 * Explicit renter cancel / ghost actors short-circuit to false.
 */
export function isOwnerDeniedLike(r: {
  reclassified_outcome?: string | null;
  denial_actor?: string | null;
  order_step?: string | null;
  status?: string | null;
}): boolean {
  const actor = r.reclassified_outcome ?? r.denial_actor;
  if (actor === "owner_denied") return true;
  if (actor === "renter_cancelled_explicit" || actor === "renter_ghosted") return false;
  const preHandover =
    r.order_step === "REQUEST" ||
    r.order_step === "APPROVED" ||
    r.order_step === "FUNDS_RESERVED";
  const ownerCancelStatus = r.status === "cancelled" || r.status === "declined";
  return preHandover && ownerCancelStatus;
}

// ---------------------------------------------------------------------------
// Single-pass data fetch + pure compute.
// ---------------------------------------------------------------------------

/**
 * Raw snapshot needed to compute ANY (account, days) cell. Fetched ONCE at the
 * widest window with NO account filter; the pure compute slices it per cell.
 */
export type RecomputeData = {
  allItems: Array<Doc<"items">>;
  pricingRows: Array<Doc<"pricing_catalog">>;
  obsoleteAll: Array<Doc<"reservations">>;
  completed365: Array<Doc<"reservations">>;
};

/**
 * The 4 reads that back every cell. `now` pins the 365-day cutoff so a single
 * snapshot covers the widest standard window; narrower windows (30/90) are
 * derived in-memory by `computeMissedAndDeniedByCategory`.
 */
export async function fetchMissedDeniedData(
  ctx: QueryCtx,
  now: number,
): Promise<RecomputeData> {
  const allItems = await ctx.db.query("items").collect();
  const pricingRows = await ctx.db.query("pricing_catalog").collect();
  // ALL obsolete rows (no cutoff, no account) — the per-cell window/account
  // predicates are applied in-memory. ~50 rows.
  const obsoleteAll = await ctx.db
    .query("reservations")
    .withIndex("by_is_obsolete", (q) => q.eq("is_obsolete", true))
    .collect();
  // Completed rentals back to the widest window's cutoff (365d from `now`),
  // no account filter.
  const cutoff365 = new Date(now);
  cutoff365.setDate(cutoff365.getDate() - 365);
  const cutoff365Str = cutoff365.toISOString().slice(0, 10);
  const completed365 = await ctx.db
    .query("reservations")
    .withIndex("by_start_date", (q) => q.gte("start_date", cutoff365Str))
    .collect();
  return { allItems, pricingRows, obsoleteAll, completed365 };
}

/**
 * Pure compute. Body copied VERBATIM from revenue.ts:getMissedAndDeniedByCategory
 * live branch (~1038–1512) with the 5 DB reads replaced by in-memory
 * derivations from `data`. `now` is the shared clock (NOT a fresh Date), so all
 * 9 cells in a single refresh agree on the cutoff.
 */
export function computeMissedAndDeniedByCategory(
  data: RecomputeData,
  { accountSlug, days, now }: { accountSlug: string | null; days: number; now: number },
) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffMs = cutoff.getTime();
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const periodStart = cutoffStr;

  // Item lookup prebuilt once for diagnoseDenialCapacityPure.
  const itemLookup = buildItemLookup(data.allItems);

  // Phase 6 — new denial classifier is the only path. Denied slice counts
  // ONLY reservations where Daniel actively denied (reclassified_outcome /
  // denial_actor = "owner_denied"). Renter-cancelled / ghosted / system
  // rows are excluded.

  // 1. Build kind maps from items. Phase 9.2: prefer item_id FK (resolved
  //    at write time by the LLM) over name_canonical string matching.
  const allItems = data.allItems;
  const nameToKind = new Map<string, string>();
  const idToKind = new Map<string, string>();
  for (const it of allItems) {
    const kind = it.kind ?? "unknown";
    if (it.name_canonical) nameToKind.set(it.name_canonical, kind);
    idToKind.set(it._id, kind);
  }

  // pricing fallback for denial value
  const pricingRows = data.pricingRows;
  const priceByName = new Map(
    pricingRows.map((p) => [p.item_name_canonical, p.daily_price_min]),
  );

  // 2. Denials path — feature-flagged (Phase 3c).
  const deniedByKind = new Map<string, { revenue: number; count: number }>();
  let unmatchedRevenue = 0;
  let unmatchedCount = 0;
  let totalDeniedRevenue = 0;
  // `deniedRecordCount` mirrors the original `denials.length` semantic so the
  // returned `denied.totals.count` shape is unchanged. Under the new path it
  // tracks owner_denied reservation rows.
  let deniedRecordCount = 0;

  // Count only reservations where Daniel actively denied.
  // Source = reservations table filtered by reclassified_outcome (Phase 3a
  // re-classifier output). Fall back to denial_actor if reclassified is
  // missing on an older row.
  // Single-pass refactor: window + account predicates applied in-memory to the
  // ONE obsoleteAll snapshot (was a per-call by_is_obsolete scan). Cutoff:
  // prefer obsolete_at, then v1_updated_at, then _creationTime.
  const obs = data.obsoleteAll
    .filter((r) => {
      const ts = r.obsolete_at ?? r.v1_updated_at ?? r._creationTime;
      return ts >= cutoffMs;
    })
    .filter((r) => (accountSlug ? r.account_slug === accountSlug : true));
  // Phase 7.12 — broaden denied predicate. EQ-B: predicate now lives at
  // module scope so `getMissedKindBreakdown` uses identical semantics.
  const ownerDenied = obs.filter(isOwnerDeniedLike);

  for (const r of ownerDenied) {
    // EstimatedValue: prefer gross_paid_gbp (rare on denials), else
    // first resolved_item daily_price * duration_days fallback, else 0.
    let estimatedValue = r.gross_paid_gbp ?? 0;
    const firstItem = (r.items ?? [])[0];
    const itemNameForLookup =
      (r.resolved_items ?? [])[0]?.item_name_canonical ??
      firstItem?.item_name;
    if (estimatedValue === 0 && itemNameForLookup) {
      const dp = priceByName.get(itemNameForLookup);
      if (dp) estimatedValue = dp * Math.max(1, r.duration_days ?? 2);
    }
    totalDeniedRevenue += estimatedValue;
    deniedRecordCount += 1;

    // Kind lookup: resolved_items[0].item_id → canonical name → items[0].item_name → unmatched.
    let kind: string | undefined;
    const resolved = (r.resolved_items ?? [])[0];
    if (resolved?.item_id) kind = idToKind.get(resolved.item_id);
    if (!kind && resolved?.item_name_canonical) {
      kind = nameToKind.get(resolved.item_name_canonical);
    }
    if (!kind && firstItem?.item_name) {
      kind = nameToKind.get(firstItem.item_name);
    }
    // Phase 7.10 — keyword fallback before declaring unmatched.
    if (!kind && firstItem?.item_name) {
      kind = kindFromKeywords(firstItem.item_name);
    }
    if (!kind) {
      unmatchedRevenue += estimatedValue;
      unmatchedCount += 1;
      continue;
    }
    const slot = deniedByKind.get(kind) ?? { revenue: 0, count: 0 };
    slot.revenue += estimatedValue;
    slot.count += 1;
    deniedByKind.set(kind, slot);
  }

  // 3. Gap + Demand path (Phase 6 — new gap/demand engine is the only path).
  //
  // Iterate owner_denied reservations. For each, diagnose per-item
  // availability over the requested date range using a commitment map built
  // from COMPLETED rentals. Attribute the rental's estimated value
  // (gross_paid_gbp or pricing fallback) split evenly across the items
  // that drove the denial.
  //
  // Marketing-only path: items.is_marketing_only=true → gap.marketing_only
  // Fully-booked path : all units busy on ≥1 requested date → gap.fully_booked
  // Available-anyway  : Daniel had inventory → voluntary_demand_lost
  //                     (does NOT count as gap, but tracked for demand)
  //
  // Phase 7.8 — `use_new_gap_demand` flag separates Denied/Gap from Demand.
  // When ON (default), owner_denied rows feed ONLY denied + gap; Demand is
  // sourced from a separate population: renter-side cancellations / ghosts /
  // paid-then-system-failed rows that exclude owner_denied. This eliminates
  // the historical double-count where a single rental could be classified as
  // both owner_denied (Denied) AND demand_loss_class=genuine_demand (Demand).
  // When OFF, retain Phase 6 behavior — every owner_denied row also adds to
  // demand — for instant rollback safety.
  const useNewGapDemand = true;
  const gapByKind = new Map<string, number>();
  const gapBreakdown = {
    marketing_only: 0,
    fully_booked: 0,
    voluntary_demand_lost: 0,
  };
  const demandByKind = new Map<string, number>();
  let totalDemandLost = 0;

  // Single-pass refactor: SAME `obs` snapshot as the denied path (the original
  // collected obsolete a second time here — identical query — so we reuse one).
  const obsoleteResAll = obs;
  // Phase 7.12 — same broadened predicate as denied path above.
  const ownerDeniedAll = obsoleteResAll.filter(isOwnerDeniedLike);

  // Build a commitment map from COMPLETED rentals (status confirmed/completed,
  // not obsolete) covering the cutoff window forward.
  // Single-pass refactor: the 365d snapshot (`completed365`) re-filtered to this
  // cell's narrower cutoff (start_date >= cutoffStr) then account-scoped. ISO
  // dates compare lexicographically == chronologically.
  const completedAll = data.completed365.filter(
    (c) => !!c.start_date && c.start_date >= cutoffStr,
  );
  const completedScoped = accountSlug
    ? completedAll.filter((c) => c.account_slug === accountSlug)
    : completedAll;
  const commitMap = buildCommitmentMap(
    completedScoped.filter(isCompletedCommitting),
  );

  for (const r of ownerDeniedAll) {
    // diagnoseDenialCapacityPure does its own £ estimation (same fallback).
    const diag = diagnoseDenialCapacityPure(
      r,
      commitMap,
      priceByName,
      itemLookup,
    );
    const estimated = diag.estimated_loss_gbp;
    const totalBuckets = diag.per_item_diagnosis.length;
    if (estimated <= 0 || totalBuckets === 0) continue;

    // Share by item — equal split across the items that drove the denial.
    const sharePer = estimated / totalBuckets;

    for (const p of diag.per_item_diagnosis) {
      const itemIdStr = p.item_id ? String(p.item_id) : undefined;
      const kind = itemIdStr ? idToKind.get(itemIdStr) ?? "unknown" : "unknown";
      // Phase 7.12 — Demand semantics rework. Daniel's clarified rule:
      // demand = "renter wanted this inventory item, system couldn't deliver".
      // ALL owner-denied rows with a resolved inventory match count as demand,
      // regardless of whether they're also gap (capacity) or voluntary. demand
      // and gap are NOT mutually exclusive — a single denial can fire both.
      if (p.classification === "marketing_only") {
        gapBreakdown.marketing_only += sharePer;
        gapByKind.set(kind, (gapByKind.get(kind) ?? 0) + sharePer);
        demandByKind.set(kind, (demandByKind.get(kind) ?? 0) + sharePer);
        totalDemandLost += sharePer;
      } else if (p.classification === "capacity_gap") {
        gapBreakdown.fully_booked += sharePer;
        gapByKind.set(kind, (gapByKind.get(kind) ?? 0) + sharePer);
        demandByKind.set(kind, (demandByKind.get(kind) ?? 0) + sharePer);
        totalDemandLost += sharePer;
      } else {
        // voluntary — had capacity, chose to deny. Still real demand (renter
        // wanted it). Just not a gap.
        gapBreakdown.voluntary_demand_lost += sharePer;
        demandByKind.set(kind, (demandByKind.get(kind) ?? 0) + sharePer);
        totalDemandLost += sharePer;
      }
    }
  }

  // Phase 7.8 — NEW demand path (flag ON).
  // Demand = obsolete AND NOT owner_denied AND (
  //   denial_actor in {renter_cancelled_explicit, renter_ghosted}
  //   OR (denial_actor null/system_or_other AND gross_paid_gbp > 0)
  // )
  // Mutually exclusive with Denied + Gap (those are sourced from owner_denied).
  if (useNewGapDemand) {
    const demandRows = obsoleteResAll.filter((r) => {
      // Phase 7.12 — exclude owner-denied (incl. broadened predicate). These
      // already added to demand via the gap path above (denial implies demand
      // by definition under Daniel's clarified semantics). Without this
      // exclusion, owner-denied rows that ALSO hit the paid-then-system path
      // would double-count in demand.
      if (isOwnerDeniedLike(r)) return false;
      const actor = r.reclassified_outcome ?? r.denial_actor;
      if (actor === "renter_cancelled_explicit") return true;
      if (actor === "renter_ghosted") return true;
      // paid-then-system-failed: no actor or system_or_other AND money changed hands
      if ((actor == null || actor === "system_or_other") &&
          (r.gross_paid_gbp ?? 0) > 0) return true;
      return false;
    });

    for (const r of demandRows) {
      // Estimated value: gross_paid_gbp || gross_gbp || duration × daily_price
      let estimatedValue = r.gross_paid_gbp ?? 0;
      if (estimatedValue === 0) {
        // gross_gbp may not exist on schema; fall back to pricing catalog
        const firstItem = (r.items ?? [])[0];
        const itemNameForLookup =
          (r.resolved_items ?? [])[0]?.item_name_canonical ??
          firstItem?.item_name;
        if (itemNameForLookup) {
          const dp = priceByName.get(itemNameForLookup);
          if (dp) estimatedValue = dp * Math.max(1, r.duration_days ?? 2);
        }
      }
      if (estimatedValue <= 0) continue;

      // Per-item attribution: split evenly across resolved items (consistent
      // with gap path which splits across per_item_diagnosis entries).
      const resolved = r.resolved_items ?? [];
      const items = r.items ?? [];
      const itemCount = Math.max(resolved.length, items.length, 1);
      const sharePer = estimatedValue / itemCount;

      for (let i = 0; i < itemCount; i++) {
        let kind: string | undefined;
        const ri = resolved[i];
        if (ri?.item_id) kind = idToKind.get(ri.item_id);
        if (!kind && ri?.item_name_canonical) {
          kind = nameToKind.get(ri.item_name_canonical);
        }
        if (!kind && items[i]?.item_name) {
          kind = nameToKind.get(items[i].item_name);
        }
        // Phase 7.10 — keyword fallback before bucketing as "unknown".
        if (!kind && items[i]?.item_name) {
          kind = kindFromKeywords(items[i].item_name);
        }
        const k = kind ?? "unknown";
        demandByKind.set(k, (demandByKind.get(k) ?? 0) + sharePer);
        totalDemandLost += sharePer;
      }
    }
  }

  // 3b. EQ-B — Equivalence pass for marketing-only owner-denied listings.
  //
  // When a listing has NO direct MASTER_INVENTORY match (resolved_items === [])
  // but the keyword equivalence map can attribute it (e.g. "GoPro" → "GoPro 12
  // Hero"), credit demand + gap to the equivalent SKU's kind so Category Mix
  // reflects real demand for inventory we DO own. Direct matches always win
  // (already attributed in loops above). Each reservation attributed at most
  // once via equivalence (best-match — first keyword hit's first owned SKU).
  const ownedSkus = new Set<string>(MASTER_INVENTORY_KEYS);
  const viaEquivalenceByKind = new Map<string, number>();
  const equivAttributedReservationIds = new Set<string>();
  for (const r of ownerDeniedAll) {
    const resolved = r.resolved_items ?? [];
    if (resolved.length > 0) continue; // direct match exists → skip
    const items = r.items ?? [];
    const title = items[0]?.item_name ?? "";
    if (!title) continue;
    const lcTitle = title.toLowerCase();
    // Defensive: if title literally contains a canonical SKU name, treat
    // as direct (would have resolved upstream); skip equivalence.
    const directHit = Array.from(ownedSkus).some(
      (sku) => lcTitle.includes(sku.toLowerCase()),
    );
    if (directHit) continue;

    const eq = resolveListingToInventory(title, null, ownedSkus);
    if (eq.matchType !== "equivalence" || !eq.sku) continue;
    const kind = nameToKind.get(eq.sku);
    if (!kind) continue;

    let estimatedValue = r.gross_paid_gbp ?? 0;
    if (estimatedValue === 0) {
      const dp = priceByName.get(eq.sku) ?? priceByName.get(title);
      if (dp) estimatedValue = dp * Math.max(1, r.duration_days ?? 2);
    }
    if (estimatedValue <= 0) continue;

    if (equivAttributedReservationIds.has(String(r._id))) continue;
    equivAttributedReservationIds.add(String(r._id));

    // Treat as marketing_only gap + demand (mirrors gap path's branch).
    gapBreakdown.marketing_only += estimatedValue;
    gapByKind.set(kind, (gapByKind.get(kind) ?? 0) + estimatedValue);
    demandByKind.set(kind, (demandByKind.get(kind) ?? 0) + estimatedValue);
    totalDemandLost += estimatedValue;
    viaEquivalenceByKind.set(kind, (viaEquivalenceByKind.get(kind) ?? 0) + 1);
  }

  // 4. Combine per-kind totals.
  const allKinds = new Set<string>([
    ...deniedByKind.keys(),
    ...gapByKind.keys(),
    ...demandByKind.keys(),
  ]);
  type Combined = {
    kind: string;
    missed: number;
    denied: number;
    gap: number;
    demandLost: number;
    count: number;
    via_equivalence_count: number;
  };
  const combined: Combined[] = [];
  for (const k of allKinds) {
    const d = deniedByKind.get(k) ?? { revenue: 0, count: 0 };
    const g = gapByKind.get(k) ?? 0;
    const dem = demandByKind.get(k) ?? 0;
    const missed = d.revenue + g + dem;
    if (missed <= 0) continue;
    combined.push({
      kind: k,
      missed: r2(missed),
      denied: r2(d.revenue),
      gap: r2(g),
      demandLost: r2(dem),
      count: d.count,
      via_equivalence_count: viaEquivalenceByKind.get(k) ?? 0,
    });
  }
  combined.sort((a, b) => b.missed - a.missed);

  // 5. Top-6 + Other for outer ring.
  const top = combined.slice(0, 6);
  const rest = combined.slice(6);
  const outerSlices: Array<{
    kind: string; label: string; missed: number; denied: number; gap: number; demandLost: number; revenue: number; color: string; via_equivalence_count: number;
  }> = top.map((c, i) => ({
    kind: c.kind,
    label: missedLabelFor(c.kind),
    missed: c.missed,
    denied: c.denied,
    gap: c.gap,
    demandLost: c.demandLost,
    revenue: c.missed,
    color: MISSED_PALETTE[i] ?? MISSED_PALETTE[MISSED_PALETTE.length - 1],
    via_equivalence_count: c.via_equivalence_count,
  }));
  if (rest.length > 0) {
    const oMissed = rest.reduce((s, c) => s + c.missed, 0);
    const oDenied = rest.reduce((s, c) => s + c.denied, 0);
    const oGap = rest.reduce((s, c) => s + c.gap, 0);
    const oDemand = rest.reduce((s, c) => s + c.demandLost, 0);
    const oVia = rest.reduce((s, c) => s + c.via_equivalence_count, 0);
    outerSlices.push({
      kind: "other",
      label: "Other",
      missed: r2(oMissed),
      denied: r2(oDenied),
      gap: r2(oGap),
      demandLost: r2(oDemand),
      revenue: r2(oMissed),
      color: MISSED_OTHER_COLOR,
      via_equivalence_count: oVia,
    });
  }
  if (unmatchedRevenue > 0) {
    outerSlices.push({
      kind: "unmatched",
      label: "Unmatched",
      missed: r2(unmatchedRevenue),
      denied: r2(unmatchedRevenue),
      gap: 0,
      demandLost: 0,
      revenue: r2(unmatchedRevenue),
      color: MISSED_UNMATCHED_COLOR,
      via_equivalence_count: 0,
    });
  }

  // 6. Inner ring — denied only, same order as outer for visual alignment.
  const innerSlices: Array<{ kind: string; label: string; denied: number; revenue: number; count: number; color: string }> = [];
  const restKinds = new Set(rest.map((c) => c.kind));
  for (const o of outerSlices) {
    if (o.kind === "unmatched") {
      if (unmatchedRevenue > 0) {
        innerSlices.push({
          kind: "unmatched",
          label: "Unmatched",
          denied: r2(unmatchedRevenue),
          revenue: r2(unmatchedRevenue),
          count: unmatchedCount,
          color: MISSED_UNMATCHED_COLOR,
        });
      }
      continue;
    }
    if (o.kind === "other") {
      const oDenied = rest.reduce((s, c) => s + c.denied, 0);
      const oCount = rest.reduce((s, c) => s + c.count, 0);
      if (oDenied > 0) {
        innerSlices.push({
          kind: "other",
          label: "Other",
          denied: r2(oDenied),
          revenue: r2(oDenied),
          count: oCount,
          color: MISSED_OTHER_COLOR,
        });
      }
      continue;
    }
    const c = combined.find((cc) => cc.kind === o.kind);
    if (!c || c.denied <= 0) continue;
    innerSlices.push({
      kind: c.kind,
      label: missedLabelFor(c.kind),
      denied: c.denied,
      revenue: c.denied,
      count: c.count,
      color: o.color,
    });
    // suppress unused-var warning
    void restKinds;
  }

  const totalMissed = combined.reduce((s, c) => s + c.missed, 0) + unmatchedRevenue;
  const totalGap = combined.reduce((s, c) => s + c.gap, 0);
  const totalDeniedCount = deniedRecordCount;

  return {
    days,
    periodStart,
    missed: {
      slices: outerSlices,
      totals: {
        missed: r2(totalMissed),
        denied: r2(totalDeniedRevenue),
        gap: r2(totalGap),
        demandLost: r2(totalDemandLost),
      },
    },
    denied: {
      slices: innerSlices,
      totals: {
        denied: r2(totalDeniedRevenue),
        count: totalDeniedCount,
      },
    },
    unmatchedDenials: {
      revenue: r2(unmatchedRevenue),
      count: unmatchedCount,
    },
  };
}
