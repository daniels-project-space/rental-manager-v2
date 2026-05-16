/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Business intelligence queries — the long-tail analytics the chat
 *  agent can pull on demand. Each query is self-contained: walks the
 *  primary tables, computes its answer, returns a JSON-friendly shape.
 *
 *  Roughly grouped:
 *    A. ROI / smart buy & sell        (3 queries)
 *    B. Bundles + forgotten accessory (2)
 *    C. Customer intelligence         (3)
 *    D. Cash flow + overdue           (2)
 *    E. Seasonality / YoY / trend     (3)
 *    F. Pricing signal                (1)
 * ──────────────────────────────────────────────────────────────────────────
 */

import { query } from "./_generated/server";
import { v } from "convex/values";
import {
  effectiveDate,
  dedupByLogicalRental,
  isLive,
  isPaidWithV1Legacy,
  type ReservationRow,
} from "./lib/reservations/predicates";

// ─── Shared helpers ─────────────────────────────────────────────────────────

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function monthKeyOf(iso: string): string {
  return iso.slice(0, 7);
}

type RichRes = ReservationRow & {
  pickup_date?: string;
  items?: Array<{ item_name: string; qty?: number }>;
  resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
  expanded_items?: Array<{ item_id: string; qty: number }>;
  gross_paid_gbp?: number;
  net_to_owner_gbp?: number;
  platform_fee_gbp?: number;
  duration_days?: number;
  hygglo_order_id?: string;
  bundle_id?: string;
  order_step?: string;
};

/** Gross attributed to one item from one reservation, equal-split among
 *  resolved_items (or via expanded_items when available). */
function grossShare(r: RichRes, itemId: string): { gross: number; net: number } {
  const expanded = r.expanded_items ?? [];
  if (expanded.length > 0) {
    const totalQty = expanded.reduce((s, x) => s + (x.qty ?? 1), 0);
    const mine = expanded.filter((x) => x.item_id === itemId).reduce((s, x) => s + (x.qty ?? 1), 0);
    if (totalQty > 0 && mine > 0) {
      return {
        gross: (r.gross_paid_gbp ?? 0) * (mine / totalQty),
        net: (r.net_to_owner_gbp ?? 0) * (mine / totalQty),
      };
    }
  }
  const resolved = r.resolved_items ?? [];
  if (resolved.length > 0) {
    const totalQty = resolved.reduce((s, x) => s + (x.qty ?? 1), 0);
    const mine = resolved.filter((x) => x.item_id === itemId).reduce((s, x) => s + (x.qty ?? 1), 0);
    if (totalQty > 0 && mine > 0) {
      return {
        gross: (r.gross_paid_gbp ?? 0) * (mine / totalQty),
        net: (r.net_to_owner_gbp ?? 0) * (mine / totalQty),
      };
    }
  }
  return { gross: 0, net: 0 };
}

// ============================================================================
// A. ROI / SMART BUY & SELL
// ============================================================================

export const getItemROIRanking = query({
  args: {
    limit: v.optional(v.number()),
    include_unknown_cost: v.optional(v.boolean()),
  },
  handler: async (ctx, { limit, include_unknown_cost }) => {
    const allItems = await ctx.db.query("items").collect();
    const active = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);
    const reservations = await ctx.db.query("reservations").collect();

    const grossByItem = new Map<string, { gross: number; net: number; rentalCount: number }>();
    for (const r of reservations as RichRes[]) {
      if (!isPaidWithV1Legacy(r as any)) continue;
      const seen = new Set<string>();
      for (const x of r.expanded_items ?? r.resolved_items ?? []) {
        if (seen.has(x.item_id)) continue;
        seen.add(x.item_id);
        const share = grossShare(r, x.item_id);
        const cur = grossByItem.get(x.item_id) ?? { gross: 0, net: 0, rentalCount: 0 };
        cur.gross += share.gross;
        cur.net += share.net;
        cur.rentalCount += 1;
        grossByItem.set(x.item_id, cur);
      }
    }

    const rows = active.map((i) => {
      const stats = grossByItem.get(i._id as string) ?? { gross: 0, net: 0, rentalCount: 0 };
      const acquired =
        (i as { acquired_at?: number }).acquired_at ?? i.created_at;
      const monthsOwned = Math.max(1, (Date.now() - acquired) / (1000 * 60 * 60 * 24 * 30));
      const cost = i.acquisition_cost_gbp ?? null;
      const lifetimeNet = Math.round(stats.net * 100) / 100;
      const lifetimeGross = Math.round(stats.gross * 100) / 100;
      const monthlyNet = stats.net / monthsOwned;
      const roiPct = cost && cost > 0 ? (stats.net / cost) * 100 : null;
      const annualizedROIPct =
        cost && cost > 0 ? (monthlyNet * 12 / cost) * 100 : null;
      return {
        itemId: i._id,
        name: i.name_canonical,
        kind: i.kind,
        qty: i.qty,
        acquisitionCostGbp: cost,
        lifetimeGrossGbp: lifetimeGross,
        lifetimeNetGbp: lifetimeNet,
        rentalCount: stats.rentalCount,
        monthsOwned: Math.round(monthsOwned * 10) / 10,
        monthlyAvgNetGbp: Math.round(monthlyNet * 100) / 100,
        roiPct: roiPct === null ? null : Math.round(roiPct * 10) / 10,
        annualizedROIPct:
          annualizedROIPct === null ? null : Math.round(annualizedROIPct * 10) / 10,
      };
    });

    const filtered = include_unknown_cost ? rows : rows.filter((r) => r.acquisitionCostGbp !== null);
    filtered.sort((a, b) => (b.annualizedROIPct ?? -Infinity) - (a.annualizedROIPct ?? -Infinity));
    return {
      ok: true as const,
      count: filtered.length,
      rows: filtered.slice(0, limit ?? 20),
      note:
        rows.length > filtered.length && !include_unknown_cost
          ? `${rows.length - filtered.length} items have no acquisition cost recorded — pass include_unknown_cost:true to include them.`
          : undefined,
    };
  },
});


export const getSmartBuyRanking = query({
  args: {
    days: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { days, limit }) => {
    const windowDays = days ?? 180;
    const cutoff = Date.now() - windowDays * 86_400 * 1000;

    // Denials in window → candidate demand.
    // Group by LLM-canonicalised product when available ("Sony FX6")
    // instead of the raw listing title ("Sony FX6 4K cinema camera + 24-70 GM + tripod...")
    // so the chat returns clean ranked items. Falls back to normName for any
    // denial that hasn't been canonicalised yet.
    const denials = await ctx.db.query("denial_records").collect();
    type Agg = { displayName: string; brand?: string; kind?: string; requestCount: number; lostGbp: number };
    const byNorm = new Map<string, Agg>();
    for (const r of denials) {
      if (r.created_at < cutoff) continue;
      if (!r.item_name) continue;
      const dr = r as {
        item_name?: string;
        canonical_product?: string;
        canonical_brand?: string;
        canonical_kind?: string;
        estimated_value?: number;
      };
      const display = dr.canonical_product ?? dr.item_name ?? "?";
      const k = dr.canonical_product
        ? "c:" + dr.canonical_product.toLowerCase().trim()
        : "r:" + normName(dr.item_name ?? "");
      const cur = byNorm.get(k) ?? {
        displayName: display,
        brand: dr.canonical_brand,
        kind: dr.canonical_kind,
        requestCount: 0,
        lostGbp: 0,
      };
      cur.requestCount += 1;
      cur.lostGbp += typeof dr.estimated_value === "number" ? dr.estimated_value : 0;
      byNorm.set(k, cur);
    }

    const allItems = await ctx.db.query("items").collect();
    const ownedKeys = new Set<string>();
    const costByKind = new Map<string, { sum: number; count: number }>();
    for (const i of allItems) {
      if (i.status === "active" && !i.is_marketing_only) {
        ownedKeys.add(normName(i.name_canonical));
        for (const a of i.aliases ?? []) ownedKeys.add(normName(a));
        if (i.acquisition_cost_gbp && i.kind) {
          const k = costByKind.get(i.kind) ?? { sum: 0, count: 0 };
          k.sum += i.acquisition_cost_gbp;
          k.count += 1;
          costByKind.set(i.kind, k);
        }
      }
    }

    const pricingRows = await ctx.db.query("pricing_catalog").collect();
    const pricingByKey = new Map<string, number>();
    for (const p of pricingRows) {
      const rate = (p.daily_price_min + (p.daily_price_max ?? p.daily_price_min)) / 2;
      pricingByKey.set(normName(p.item_name_canonical), rate);
    }

    // Light kind-classifier from the item name. Good enough for the cost
    // estimate fallback; not a critical decision path.
    function guessKind(name: string): string | null {
      const lower = name.toLowerCase();
      if (/camera|fx\d|a7|a1|fx3|fx6|red |alexa|komodo|bmpcc/.test(lower)) return "camera";
      if (/lens|prime|zoom|24-70|50mm|85mm|anamorphic|cinema lens/.test(lower)) return "lens";
      if (/mic|recorder|wireless|sennheiser|rode|deity|lavalier|boom/.test(lower)) return "audio";
      if (/light|panel|aputure|nanlite|godox|cob|kino|astera/.test(lower)) return "lighting";
      if (/gimbal|rs2|rs3|ronin|crane/.test(lower)) return "gimbal";
      if (/monitor|atomos|ninja|smallhd|director/.test(lower)) return "monitor";
      return null;
    }

    const recs: Array<{
      itemName: string;
      requestCount: number;
      estDailyRateGbp: number | null;
      estAcquisitionCostGbp: number | null;
      estAnnualNetGbp: number;
      firstYearROIPct: number | null;
      recommendation: "strong-buy" | "consider" | "monitor";
    }> = [];

    for (const [key, agg] of byNorm) {
      if (agg.requestCount < 2) continue;
      if (ownedKeys.has(key)) continue;
      const rate = pricingByKey.get(key) ?? null;
      const guess = guessKind(agg.displayName);
      const estCost =
        guess && costByKind.get(guess)
          ? Math.round(costByKind.get(guess)!.sum / costByKind.get(guess)!.count)
          : null;

      // Estimate annual revenue: scale request count to a 365-day window,
      // assume average rental is 3 days, owner share 0.78 (Hygglo cut).
      const scaledRequests = (agg.requestCount / windowDays) * 365;
      let estAnnualNet = 0;
      if (rate !== null) {
        estAnnualNet = Math.round(scaledRequests * rate * 3 * 0.78);
      } else if (agg.lostGbp > 0) {
        estAnnualNet = Math.round((agg.lostGbp / windowDays) * 365 * 0.78);
      }
      const firstYearROI =
        estCost && estCost > 0 ? Math.round((estAnnualNet / estCost) * 1000) / 10 : null;
      const recommendation: "strong-buy" | "consider" | "monitor" =
        firstYearROI !== null && firstYearROI >= 60
          ? "strong-buy"
          : firstYearROI !== null && firstYearROI >= 25
            ? "consider"
            : estAnnualNet >= 500
              ? "consider"
              : "monitor";
      recs.push({
        itemName: agg.displayName,
        requestCount: agg.requestCount,
        estDailyRateGbp: rate,
        estAcquisitionCostGbp: estCost,
        estAnnualNetGbp: estAnnualNet,
        firstYearROIPct: firstYearROI,
        recommendation,
      });
    }

    recs.sort((a, b) => (b.firstYearROIPct ?? -1) - (a.firstYearROIPct ?? -1));
    return { ok: true as const, windowDays, rows: recs.slice(0, limit ?? 12) };
  },
});




export const getTopSpenders = query({
  args: { days: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, { days, limit }) => {
    const cutoffIso = days ? addDaysIso(todayIso(), -days) : null;
    const allRenters = await ctx.db.query("renters").collect();
    const renterById = new Map<string, typeof allRenters[number]>();
    for (const r of allRenters) renterById.set(r._id as string, r);

    const reservations = await ctx.db.query("reservations").collect();
    // Aggregate by renter_id when available (linked to renters doc); else by
    // renter_name text. v1 imports often have only renter_name after the
    // backfill, so falling back keeps them in the ranking instead of
    // dropping ~1432 historical rentals.
    const aggByKey = new Map<string, { gross: number; net: number; count: number; renterId: string | null; displayName: string }>();
    for (const r of reservations) {
      if (!isLive(r as any)) continue;
      const eff = effectiveDate(r as any);
      if (!eff) continue;
      if (cutoffIso && eff < cutoffIso) continue;

      const renterId = (r.renter_id as string | undefined) ?? null;
      const renterNameText = (r as { renter_name?: string }).renter_name ?? null;
      let key: string;
      let displayName: string;
      if (renterId) {
        key = "id:" + renterId;
        displayName = ""; // resolved later via renterById
      } else if (renterNameText && renterNameText.trim().length > 0) {
        const norm = renterNameText.trim().toLowerCase();
        key = "name:" + norm;
        displayName = renterNameText.trim();
      } else {
        continue; // anonymous, skip
      }

      const cur = aggByKey.get(key) ?? { gross: 0, net: 0, count: 0, renterId, displayName };
      cur.gross += (r as { gross_paid_gbp?: number }).gross_paid_gbp ?? 0;
      cur.net += (r as { net_to_owner_gbp?: number }).net_to_owner_gbp ?? 0;
      cur.count += 1;
      aggByKey.set(key, cur);
    }
    const aggByRenter = aggByKey;

    const rows = Array.from(aggByRenter.entries())
      .map(([key, agg]) => {
        const rt = agg.renterId ? renterById.get(agg.renterId) : undefined;
        return {
          renterId: agg.renterId,
          displayName: rt?.display_name ?? agg.displayName ?? "?",
          email: rt?.email ?? null,
          rentalCount: agg.count,
          grossGbp: Math.round(agg.gross * 100) / 100,
          netGbp: Math.round(agg.net * 100) / 100,
          blacklisted: rt?.blacklisted ?? false,
        };
      })
      .filter((r) => !r.blacklisted)
      .sort((a, b) => b.grossGbp - a.grossGbp);

    return { ok: true as const, lookbackDays: days ?? null, rows: rows.slice(0, limit ?? 15) };
  },
});








const FUNNEL_ACTIVE_STEPS = new Set(["REQUEST", "APPROVED", "FUNDS_RESERVED", "VERIFIED"]);
const FUNNEL_CONFIRMED_STEPS = new Set(["BOOKED_AFTER_VERIFIED", "DELIVERED", "RETURNED", "REVIEWED"]);
const FUNNEL_STEP_LABEL: Record<string, string> = {
  REQUEST: "Awaiting owner accept",
  APPROVED: "Awaiting renter payment",
  FUNDS_RESERVED: "Awaiting renter payment",
  VERIFIED: "Verifying renter",
  BOOKED_AFTER_VERIFIED: "Booked",
  DELIVERED: "Out with renter",
  RETURNED: "Returned",
  REVIEWED: "Complete",
};

export const getVerificationFunnel = query({
  args: {
    ageThresholdHours: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { ageThresholdHours, limit }) => {
    const threshold = (ageThresholdHours ?? 12) * 3600 * 1000;
    const now = Date.now();
    const all = await ctx.db.query("reservations").collect();

    // 1. Stalled orders (active step + age over threshold).
    type Stalled = {
      reservation_id: string;
      hygglo_order_id: string | null;
      account_slug: string;
      renter_name: string | null;
      start_date: string | null;
      end_date: string | null;
      gross_paid_gbp: number | null;
      net_to_owner_gbp: number | null;
      current_step: string;
      step_label: string;
      first_seen_at: number;
      age_hours: number;
      photos_urls: string[];
    };
    const stalled: Stalled[] = [];

    // 2. Distribution count per step (currently active).
    const distribution: Record<string, number> = {};

    // 3. Confirmed-order elapsed sample for median computation.
    type Sample = { hours: number };
    const confirmedSample: Sample[] = [];

    for (const r of all) {
      const step = (r as any).order_step as string | undefined;
      if (!step) continue;
      if (r.is_obsolete) continue;
      const firstSeen = r._creationTime ?? 0;
      const ageHours = (now - firstSeen) / 3600_000;

      if (FUNNEL_ACTIVE_STEPS.has(step)) {
        distribution[step] = (distribution[step] ?? 0) + 1;
        if (ageHours * 3600_000 >= threshold) {
          stalled.push({
            reservation_id: (r as any).v1_rental_id ?? r.hygglo_order_id ?? (r._id as string),
            hygglo_order_id: r.hygglo_order_id ?? null,
            account_slug: r.account_slug ?? "",
            renter_name: r.renter_name ?? null,
            start_date: r.start_date ?? null,
            end_date: r.end_date ?? null,
            gross_paid_gbp: r.gross_paid_gbp ?? null,
            net_to_owner_gbp: r.net_to_owner_gbp ?? null,
            current_step: step,
            step_label: FUNNEL_STEP_LABEL[step] ?? step,
            first_seen_at: firstSeen,
            age_hours: Math.round(ageHours * 10) / 10,
            photos_urls: (r as any).photos_urls ?? [],
          });
        }
      } else if (FUNNEL_CONFIRMED_STEPS.has(step)) {
        distribution[step] = (distribution[step] ?? 0) + 1;
        // Elapsed = first_seen → now. Imperfect (we don't know exactly when
        // it crossed into CONFIRMED) but a reasonable median for the cohort
        // since most orders confirm within hours of being polled.
        const startMs = firstSeen;
        const confirmedAtMs = (r as { times_extracted_at?: number }).times_extracted_at ?? now;
        const elapsedH = Math.max(0, (confirmedAtMs - startMs) / 3600_000);
        // Only count reasonable values (filter out obvious outliers and
        // historical rows from v1 imports that have weird timestamps).
        if (elapsedH >= 0 && elapsedH < 24 * 14) {
          confirmedSample.push({ hours: elapsedH });
        }
      }
    }

    // Median + p25 + p75 across the confirmed sample
    confirmedSample.sort((a, b) => a.hours - b.hours);
    const pct = (p: number): number => {
      if (confirmedSample.length === 0) return 0;
      const idx = Math.min(
        confirmedSample.length - 1,
        Math.floor(p * confirmedSample.length),
      );
      return Math.round(confirmedSample[idx].hours * 10) / 10;
    };

    stalled.sort((a, b) => b.age_hours - a.age_hours);

    return {
      now,
      threshold_hours: ageThresholdHours ?? 12,
      stalled: stalled.slice(0, limit ?? 30),
      stalled_total: stalled.length,
      stalled_potential_revenue_gbp: Math.round(
        stalled.reduce((s, r) => s + (r.net_to_owner_gbp ?? 0), 0) * 100,
      ) / 100,
      distribution,
      timing: {
        sample_size: confirmedSample.length,
        median_hours_to_confirm: pct(0.5),
        p25_hours: pct(0.25),
        p75_hours: pct(0.75),
        p90_hours: pct(0.9),
      },
    };
  },
});
