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

export const getSmartSellRanking = query({
  args: {
    idle_days: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { idle_days, limit }) => {
    const idleCutoff = addDaysIso(todayIso(), -(idle_days ?? 60));

    const allItems = await ctx.db.query("items").collect();
    const active = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);
    const reservations = await ctx.db.query("reservations").collect();

    const stats = new Map<string, { gross: number; net: number; rentalCount: number; lastRental: string }>();
    for (const r of reservations as RichRes[]) {
      if (!isPaidWithV1Legacy(r as any)) continue;
      const eff = effectiveDate(r);
      if (!eff) continue;
      const seen = new Set<string>();
      for (const x of r.expanded_items ?? r.resolved_items ?? []) {
        if (seen.has(x.item_id)) continue;
        seen.add(x.item_id);
        const share = grossShare(r, x.item_id);
        const cur = stats.get(x.item_id) ?? { gross: 0, net: 0, rentalCount: 0, lastRental: "" };
        cur.gross += share.gross;
        cur.net += share.net;
        cur.rentalCount += 1;
        if (eff > cur.lastRental) cur.lastRental = eff;
        stats.set(x.item_id, cur);
      }
    }

    type Row = {
      itemId: string;
      name: string;
      qty: number;
      acquisitionCostGbp: number | null;
      lifetimeNetGbp: number;
      paidBackPct: number | null;
      idleDays: number | null;
      lastRentalDate: string | null;
      score: number;
      reasons: string[];
    };

    const rows: Row[] = active.map((i) => {
      const s = stats.get(i._id as string) ?? { gross: 0, net: 0, rentalCount: 0, lastRental: "" };
      const cost = i.acquisition_cost_gbp ?? null;
      const paidBackPct = cost && cost > 0 ? (s.net / cost) * 100 : null;
      const lastRental = s.lastRental || null;
      const idleDays = lastRental
        ? Math.round(
            (new Date(todayIso() + "T00:00:00Z").getTime() -
              new Date(lastRental + "T00:00:00Z").getTime()) /
              86_400_000,
          )
        : null;
      let score = 0;
      const reasons: string[] = [];
      if (lastRental && lastRental < idleCutoff) {
        score += 30;
        reasons.push(`idle ${idleDays}d`);
      }
      if (!lastRental) {
        score += 50;
        reasons.push("never rented");
      }
      if (paidBackPct !== null && paidBackPct >= 100) {
        score += 25;
        reasons.push(`paid back ${Math.round(paidBackPct)}%`);
      }
      if (paidBackPct !== null && paidBackPct < 100 && idleDays !== null && idleDays > 90) {
        score -= 10;
        reasons.push("not yet paid back — selling realizes loss");
      }
      if ((cost ?? 0) >= 1000) {
        score += 10;
        reasons.push("high capital tied up");
      }
      return {
        itemId: i._id,
        name: i.name_canonical,
        qty: i.qty,
        acquisitionCostGbp: cost,
        lifetimeNetGbp: Math.round(s.net * 100) / 100,
        paidBackPct: paidBackPct === null ? null : Math.round(paidBackPct * 10) / 10,
        idleDays,
        lastRentalDate: lastRental,
        score,
        reasons,
      };
    });

    rows.sort((a, b) => b.score - a.score);
    return {
      ok: true as const,
      idleCutoff,
      rows: rows.filter((r) => r.score > 0).slice(0, limit ?? 15),
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

    // Denials in window → candidate demand
    const denials = await ctx.db.query("denial_records").collect();
    type Agg = { displayName: string; requestCount: number; lostGbp: number };
    const byNorm = new Map<string, Agg>();
    for (const r of denials) {
      if (r.created_at < cutoff) continue;
      if (!r.item_name) continue;
      const k = normName(r.item_name);
      const cur = byNorm.get(k) ?? { displayName: r.item_name, requestCount: 0, lostGbp: 0 };
      cur.requestCount += 1;
      cur.lostGbp += typeof r.estimated_value === "number" ? r.estimated_value : 0;
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

// ============================================================================
// B. BUNDLES + FORGOTTEN ACCESSORY
// ============================================================================

export const getBundleProfitRanking = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    const lookback = days ?? 365;
    const cutoff = addDaysIso(todayIso(), -lookback);
    const bundles = await ctx.db.query("bundles").collect();
    const reservations = await ctx.db.query("reservations").collect();

    const byBundle = new Map<string, { gross: number; net: number; count: number; days: number }>();
    for (const r of reservations as RichRes[]) {
      if (!isPaidWithV1Legacy(r as any)) continue;
      const eff = effectiveDate(r);
      if (!eff || eff < cutoff) continue;
      if (!r.bundle_id) continue;
      const cur = byBundle.get(r.bundle_id as string) ?? { gross: 0, net: 0, count: 0, days: 0 };
      cur.gross += r.gross_paid_gbp ?? 0;
      cur.net += r.net_to_owner_gbp ?? 0;
      cur.count += 1;
      cur.days += r.duration_days ?? 0;
      byBundle.set(r.bundle_id as string, cur);
    }

    const rows = bundles
      .map((b) => {
        const s = byBundle.get(b._id as string) ?? { gross: 0, net: 0, count: 0, days: 0 };
        const margin = s.gross > 0 ? (s.net / s.gross) * 100 : null;
        return {
          bundleId: b._id,
          name: b.bundle_name,
          slug: b.slug,
          dailyPriceMin: b.daily_price_min ?? null,
          dailyPriceMax: b.daily_price_max ?? null,
          accountScope: b.account_scope ?? null,
          rentalCount: s.count,
          totalGrossGbp: Math.round(s.gross * 100) / 100,
          totalNetGbp: Math.round(s.net * 100) / 100,
          avgNetPerRentalGbp:
            s.count > 0 ? Math.round((s.net / s.count) * 100) / 100 : 0,
          marginPct: margin === null ? null : Math.round(margin * 10) / 10,
          totalDays: s.days,
        };
      })
      .filter((r) => r.rentalCount > 0)
      .sort((a, b) => b.totalNetGbp - a.totalNetGbp);

    return { ok: true as const, lookbackDays: lookback, rows };
  },
});

export const getForgottenAccessories = query({
  args: {
    item_names: v.array(v.string()),         // items currently on the order
    min_support_pct: v.optional(v.number()), // default 30
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { item_names, min_support_pct, limit }) => {
    const minSupport = (min_support_pct ?? 30) / 100;
    if (item_names.length === 0) return { ok: true as const, suggestions: [] };

    const allItems = await ctx.db.query("items").collect();
    const itemById = new Map<string, typeof allItems[number]>();
    for (const i of allItems) itemById.set(i._id as string, i);

    function resolveName(name: string) {
      const q = normName(name);
      for (const i of allItems) {
        const cn = normName(i.name_canonical);
        if (cn === q || cn.includes(q) || (q.includes(cn) && cn.length > 3)) return i;
        if ((i.aliases ?? []).some((a) => normName(a) === q)) return i;
      }
      return null;
    }

    const targetIds = new Set<string>();
    for (const n of item_names) {
      const it = resolveName(n);
      if (it) targetIds.add(it._id as string);
    }
    if (targetIds.size === 0) return { ok: true as const, suggestions: [] };

    const reservations = await ctx.db.query("reservations").collect();
    let basisCount = 0;
    const coCount = new Map<string, number>();
    for (const r of reservations as RichRes[]) {
      if (!isPaidWithV1Legacy(r as any)) continue;
      const ids = new Set<string>(
        (r.expanded_items ?? r.resolved_items ?? []).map((x) => x.item_id),
      );
      let matchAll = true;
      for (const t of targetIds) {
        if (!ids.has(t)) {
          matchAll = false;
          break;
        }
      }
      if (!matchAll) continue;
      basisCount += 1;
      for (const id of ids) {
        if (targetIds.has(id)) continue;
        coCount.set(id, (coCount.get(id) ?? 0) + 1);
      }
    }

    const suggestions = Array.from(coCount.entries())
      .map(([id, count]) => ({
        itemId: id,
        name: itemById.get(id)?.name_canonical ?? id,
        kind: itemById.get(id)?.kind ?? null,
        coOccurrences: count,
        supportPct: basisCount > 0 ? Math.round((count / basisCount) * 1000) / 10 : 0,
      }))
      .filter((s) => s.supportPct / 100 >= minSupport)
      .sort((a, b) => b.supportPct - a.supportPct);

    return {
      ok: true as const,
      basisCount,
      targetItemCount: targetIds.size,
      suggestions: suggestions.slice(0, limit ?? 10),
    };
  },
});

// ============================================================================
// C. CUSTOMER INTELLIGENCE
// ============================================================================

export const getAtRiskRenters = query({
  args: {
    inactive_days: v.optional(v.number()),    // default 120
    min_lifetime_gbp: v.optional(v.number()), // default 200
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { inactive_days, min_lifetime_gbp, limit }) => {
    const inactiveDays = inactive_days ?? 120;
    const minLifetime = min_lifetime_gbp ?? 200;
    const cutoffMs = Date.now() - inactiveDays * 86_400 * 1000;

    const allRenters = await ctx.db.query("renters").collect();
    const allReservations = await ctx.db.query("reservations").collect();

    // Aggregate per renter from reservations as defence-in-depth — renters
    // table totals can drift.
    const aggByRenter = new Map<string, { gross: number; lastIso: string; count: number }>();
    for (const r of allReservations) {
      if (!r.renter_id) continue;
      if (!isLive(r as any)) continue;
      const eff = effectiveDate(r as any);
      if (!eff) continue;
      const cur = aggByRenter.get(r.renter_id as string) ?? { gross: 0, lastIso: "", count: 0 };
      cur.gross += (r as { gross_paid_gbp?: number }).gross_paid_gbp ?? 0;
      cur.count += 1;
      if (eff > cur.lastIso) cur.lastIso = eff;
      aggByRenter.set(r.renter_id as string, cur);
    }

    const rows = allRenters
      .map((rt) => {
        const agg = aggByRenter.get(rt._id as string) ?? { gross: 0, lastIso: "", count: 0 };
        const lastMs = agg.lastIso
          ? new Date(agg.lastIso + "T00:00:00Z").getTime()
          : rt.last_rental_at ?? 0;
        const daysSince = Math.round((Date.now() - lastMs) / 86_400_000);
        return {
          renterId: rt._id,
          displayName: rt.display_name ?? "?",
          email: rt.email ?? null,
          lifetimeGrossGbp: Math.round(agg.gross * 100) / 100,
          rentalCount: agg.count,
          lastRentalDate: agg.lastIso || null,
          daysSinceLastRental: daysSince,
          blacklisted: rt.blacklisted ?? false,
          hyggloRating: rt.hygglo_rating ?? null,
        };
      })
      .filter(
        (r) =>
          !r.blacklisted &&
          r.lifetimeGrossGbp >= minLifetime &&
          r.lastRentalDate !== null &&
          new Date((r.lastRentalDate ?? "") + "T00:00:00Z").getTime() < cutoffMs,
      )
      .sort((a, b) => b.lifetimeGrossGbp - a.lifetimeGrossGbp);

    return { ok: true as const, count: rows.length, rows: rows.slice(0, limit ?? 20) };
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

export const getNewVsRepeatRevenue = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    const lookback = days ?? 90;
    const cutoff = addDaysIso(todayIso(), -lookback);
    const reservations = (await ctx.db.query("reservations").collect()) as RichRes[];

    // Determine each renter's first-rental date (ever).
    const firstByRenter = new Map<string, string>();
    for (const r of reservations) {
      if (!r.renter_id || !isLive(r as any)) continue;
      const eff = effectiveDate(r as any);
      if (!eff) continue;
      const cur = firstByRenter.get(r.renter_id as string);
      if (!cur || eff < cur) firstByRenter.set(r.renter_id as string, eff);
    }

    let firstTimeRevenue = 0;
    let firstTimeRentals = 0;
    let repeatRevenue = 0;
    let repeatRentals = 0;
    const firstTimeRenters = new Set<string>();
    const repeatRenters = new Set<string>();

    for (const r of reservations) {
      if (!r.renter_id || !isLive(r as any)) continue;
      const eff = effectiveDate(r as any);
      if (!eff || eff < cutoff) continue;
      const first = firstByRenter.get(r.renter_id as string);
      const gross = (r as { gross_paid_gbp?: number }).gross_paid_gbp ?? 0;
      if (first && first >= cutoff && first === eff) {
        firstTimeRevenue += gross;
        firstTimeRentals += 1;
        firstTimeRenters.add(r.renter_id as string);
      } else {
        repeatRevenue += gross;
        repeatRentals += 1;
        repeatRenters.add(r.renter_id as string);
      }
    }
    const total = firstTimeRevenue + repeatRevenue;

    return {
      ok: true as const,
      lookbackDays: lookback,
      total: {
        grossGbp: Math.round(total * 100) / 100,
        rentalCount: firstTimeRentals + repeatRentals,
        renterCount: firstTimeRenters.size + repeatRenters.size,
      },
      firstTime: {
        grossGbp: Math.round(firstTimeRevenue * 100) / 100,
        rentalCount: firstTimeRentals,
        renterCount: firstTimeRenters.size,
        sharePct: total > 0 ? Math.round((firstTimeRevenue / total) * 1000) / 10 : 0,
      },
      repeat: {
        grossGbp: Math.round(repeatRevenue * 100) / 100,
        rentalCount: repeatRentals,
        renterCount: repeatRenters.size,
        sharePct: total > 0 ? Math.round((repeatRevenue / total) * 1000) / 10 : 0,
      },
    };
  },
});

// ============================================================================
// D. CASH FLOW + OVERDUE
// ============================================================================

export const getCashFlowForecast = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    const horizon = days ?? 30;
    const today = todayIso();
    const end = addDaysIso(today, horizon);

    const reservations = (await ctx.db.query("reservations").collect()) as RichRes[];
    const upcoming = reservations.filter((r) => {
      if (!isLive(r as any)) return false;
      const eff = effectiveDate(r as any);
      return eff !== undefined && eff >= today && eff <= end;
    });

    // Daily buckets
    const dailyMap = new Map<string, { grossGbp: number; netGbp: number; rentalCount: number }>();
    for (let i = 0; i <= horizon; i++) {
      const d = addDaysIso(today, i);
      dailyMap.set(d, { grossGbp: 0, netGbp: 0, rentalCount: 0 });
    }
    for (const r of upcoming) {
      const eff = effectiveDate(r as any)!;
      const bucket = dailyMap.get(eff);
      if (!bucket) continue;
      bucket.grossGbp += r.gross_paid_gbp ?? 0;
      bucket.netGbp += r.net_to_owner_gbp ?? 0;
      bucket.rentalCount += 1;
    }
    const daily = Array.from(dailyMap.entries()).map(([date, v]) => ({
      date,
      grossGbp: Math.round(v.grossGbp * 100) / 100,
      netGbp: Math.round(v.netGbp * 100) / 100,
      rentalCount: v.rentalCount,
    }));
    const totalGross = daily.reduce((s, d) => s + d.grossGbp, 0);
    const totalNet = daily.reduce((s, d) => s + d.netGbp, 0);

    return {
      ok: true as const,
      horizonDays: horizon,
      window: { from: today, to: end },
      totalGrossGbp: Math.round(totalGross * 100) / 100,
      totalNetGbp: Math.round(totalNet * 100) / 100,
      rentalCount: upcoming.length,
      daily,
    };
  },
});

export const getOverdueReturns = query({
  args: {},
  handler: async (ctx) => {
    const today = todayIso();
    const allRenters = await ctx.db.query("renters").collect();
    const renterById = new Map<string, typeof allRenters[number]>();
    for (const r of allRenters) renterById.set(r._id as string, r);

    const reservations = (await ctx.db.query("reservations").collect()) as RichRes[];
    const overdue = reservations
      .filter((r) => {
        if (!isLive(r as any)) return false;
        if (!r.end_date || r.end_date >= today) return false;
        // Already returned?
        const step = (r as { order_step?: string }).order_step;
        if (step === "RETURNED" || step === "REVIEWED") return false;
        return true;
      })
      .map((r) => {
        const days = Math.round(
          (new Date(today + "T00:00:00Z").getTime() -
            new Date((r.end_date as string) + "T00:00:00Z").getTime()) /
            86_400_000,
        );
        const renter = r.renter_id ? renterById.get(r.renter_id as string) : null;
        return {
          reservationId: r._id,
          hyggloOrderId: r.hygglo_order_id ?? null,
          renterName: renter?.display_name ?? "?",
          renterEmail: renter?.email ?? null,
          orderStep: (r as { order_step?: string }).order_step ?? null,
          endDate: r.end_date,
          daysOverdue: days,
          grossGbp: r.gross_paid_gbp ?? 0,
          itemNames: (r.items ?? []).map((i) => i.item_name),
          accountSlug: r.account_slug ?? null,
        };
      })
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    return { ok: true as const, count: overdue.length, rows: overdue };
  },
});

// ============================================================================
// E. SEASONALITY / YoY / TREND
// ============================================================================

export const getItemSeasonality = query({
  args: { item_name: v.string() },
  handler: async (ctx, { item_name }) => {
    const allItems = await ctx.db.query("items").collect();
    const q = normName(item_name);
    const target =
      allItems.find((i) => normName(i.name_canonical) === q) ??
      allItems.find(
        (i) => normName(i.name_canonical).includes(q) || q.includes(normName(i.name_canonical)),
      );
    if (!target) return { ok: false as const, error: "Item not found", item_name };

    const reservations = (await ctx.db.query("reservations").collect()) as RichRes[];
    const matched = reservations.filter((r) => {
      if (!isPaidWithV1Legacy(r as any)) return false;
      const ids = (r.expanded_items ?? r.resolved_items ?? []).map((x) => x.item_id);
      return ids.includes(target._id as string);
    });

    // Per-month-of-year: month 1-12 → {rentals, gross}
    const monthOfYear = new Map<number, { rentals: number; gross: number }>();
    for (let m = 1; m <= 12; m++) monthOfYear.set(m, { rentals: 0, gross: 0 });
    let totalRentals = 0;
    let firstYear = 9999;
    let lastYear = 0;
    for (const r of matched) {
      const eff = effectiveDate(r as any);
      if (!eff) continue;
      const d = new Date(eff + "T00:00:00Z");
      const m = d.getUTCMonth() + 1;
      const y = d.getUTCFullYear();
      firstYear = Math.min(firstYear, y);
      lastYear = Math.max(lastYear, y);
      const share = grossShare(r, target._id as string);
      const cur = monthOfYear.get(m)!;
      cur.rentals += 1;
      cur.gross += share.gross;
      totalRentals += 1;
    }
    const years = totalRentals > 0 ? Math.max(1, lastYear - firstYear + 1) : 0;
    const months = Array.from(monthOfYear.entries()).map(([m, v]) => ({
      month: m,
      monthLabel: new Date(2000, m - 1, 1).toLocaleString("en", { month: "short" }),
      avgRentalsPerYear: years > 0 ? Math.round((v.rentals / years) * 10) / 10 : 0,
      avgGrossGbp: years > 0 ? Math.round((v.gross / years) * 100) / 100 : 0,
      totalRentals: v.rentals,
    }));
    months.sort((a, b) => a.month - b.month);
    const peakMonth = months.reduce(
      (best, m) => (m.totalRentals > best.totalRentals ? m : best),
      months[0],
    );

    return {
      ok: true as const,
      item: { id: target._id, name: target.name_canonical },
      yearsObserved: years,
      totalRentals,
      peakMonth: { month: peakMonth.month, monthLabel: peakMonth.monthLabel, rentals: peakMonth.totalRentals },
      months,
    };
  },
});

export const getItemYoYGrowth = query({
  args: { item_name: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { item_name, limit }) => {
    const today = todayIso();
    const last12From = addDaysIso(today, -365);
    const prev12From = addDaysIso(today, -730);

    const allItems = await ctx.db.query("items").collect();
    const reservations = (await ctx.db.query("reservations").collect()) as RichRes[];

    function statsFor(itemId: string, fromIso: string, toIso: string) {
      let count = 0;
      let gross = 0;
      for (const r of reservations) {
        if (!isPaidWithV1Legacy(r as any)) continue;
        const eff = effectiveDate(r as any);
        if (!eff || eff < fromIso || eff > toIso) continue;
        const ids = (r.expanded_items ?? r.resolved_items ?? []).map((x) => x.item_id);
        if (!ids.includes(itemId)) continue;
        count += 1;
        gross += grossShare(r, itemId).gross;
      }
      return { count, gross };
    }

    const target = item_name
      ? (() => {
          const q = normName(item_name);
          return (
            allItems.find((i) => normName(i.name_canonical) === q) ??
            allItems.find(
              (i) =>
                normName(i.name_canonical).includes(q) ||
                q.includes(normName(i.name_canonical)),
            ) ??
            null
          );
        })()
      : null;
    if (item_name && !target) return { ok: false as const, error: "Item not found", item_name };

    const subset = target
      ? [target]
      : allItems.filter((i) => i.status === "active" && !i.is_marketing_only);

    const rows = subset
      .map((i) => {
        const last = statsFor(i._id as string, last12From, today);
        const prev = statsFor(i._id as string, prev12From, last12From);
        const growthGbp = last.gross - prev.gross;
        const growthPct = prev.gross > 0 ? (growthGbp / prev.gross) * 100 : last.gross > 0 ? 100 : null;
        return {
          itemId: i._id,
          name: i.name_canonical,
          last12Gross: Math.round(last.gross * 100) / 100,
          last12RentalCount: last.count,
          prev12Gross: Math.round(prev.gross * 100) / 100,
          prev12RentalCount: prev.count,
          growthGbp: Math.round(growthGbp * 100) / 100,
          growthPct: growthPct === null ? null : Math.round(growthPct * 10) / 10,
        };
      })
      .sort((a, b) => (b.growthGbp ?? -Infinity) - (a.growthGbp ?? -Infinity));

    return {
      ok: true as const,
      windowLast: { from: last12From, to: today },
      windowPrev: { from: prev12From, to: last12From },
      rows: rows.slice(0, limit ?? 30),
    };
  },
});

export const getDemandTrendSlope = query({
  args: { months: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, { months, limit }) => {
    const n = months ?? 12;
    const today = new Date();
    // Window start = first day of (today.month - (n-1))
    const fromDate = new Date(today.getUTCFullYear(), today.getUTCMonth() - (n - 1), 1)
      .toISOString()
      .slice(0, 10);

    const allItems = await ctx.db.query("items").collect();
    const active = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);
    const reservations = (await ctx.db.query("reservations").collect()) as RichRes[];

    // Pre-bucket reservations by (itemId, monthKey) → rental count.
    const map = new Map<string, Map<string, number>>();
    for (const r of reservations) {
      if (!isPaidWithV1Legacy(r as any)) continue;
      const eff = effectiveDate(r as any);
      if (!eff || eff < fromDate) continue;
      const mk = monthKeyOf(eff);
      const seen = new Set<string>();
      for (const x of r.expanded_items ?? r.resolved_items ?? []) {
        if (seen.has(x.item_id)) continue;
        seen.add(x.item_id);
        let inner = map.get(x.item_id);
        if (!inner) {
          inner = new Map();
          map.set(x.item_id, inner);
        }
        inner.set(mk, (inner.get(mk) ?? 0) + 1);
      }
    }

    // Build month keys in order
    const monthKeys: string[] = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(today.getUTCFullYear(), today.getUTCMonth() - (n - 1 - i), 1);
      monthKeys.push(d.toISOString().slice(0, 7));
    }

    // Linear regression on rental counts vs month index.
    function slope(counts: number[]): number {
      const N = counts.length;
      const xs = counts.map((_, i) => i);
      const meanX = (N - 1) / 2;
      const meanY = counts.reduce((a, b) => a + b, 0) / N;
      let num = 0;
      let den = 0;
      for (let i = 0; i < N; i++) {
        num += (xs[i] - meanX) * (counts[i] - meanY);
        den += (xs[i] - meanX) ** 2;
      }
      return den === 0 ? 0 : num / den;
    }

    const rows = active.map((i) => {
      const inner = map.get(i._id as string) ?? new Map();
      const counts = monthKeys.map((mk) => inner.get(mk) ?? 0);
      const total = counts.reduce((a, b) => a + b, 0);
      const sl = slope(counts);
      const recent = counts.slice(-3).reduce((a, b) => a + b, 0) / 3;
      const previous = counts.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
      return {
        itemId: i._id,
        name: i.name_canonical,
        totalRentals: total,
        monthlyCounts: counts,
        slopePerMonth: Math.round(sl * 100) / 100,
        recentAvg: Math.round(recent * 10) / 10,
        previousAvg: Math.round(previous * 10) / 10,
        direction: sl > 0.2 ? "growing" : sl < -0.2 ? "fading" : "flat",
      };
    });

    rows.sort((a, b) => Math.abs(b.slopePerMonth) - Math.abs(a.slopePerMonth));
    return { ok: true as const, months: n, monthKeys, rows: rows.slice(0, limit ?? 30) };
  },
});

// ============================================================================
// F. PRICING SIGNAL
// ============================================================================

export const getPricingSignals = query({
  args: { lookback_days: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, { lookback_days, limit }) => {
    const lookback = lookback_days ?? 90;
    const cutoffIso = addDaysIso(todayIso(), -lookback);
    const cutoffMs = Date.now() - lookback * 86_400 * 1000;

    const allItems = await ctx.db.query("items").collect();
    const active = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);
    const reservations = (await ctx.db.query("reservations").collect()) as RichRes[];
    const denials = await ctx.db.query("denial_records").collect();
    const pricing = await ctx.db.query("pricing_catalog").collect();

    const priceByName = new Map<string, { min: number; max: number }>();
    for (const p of pricing) {
      priceByName.set(normName(p.item_name_canonical), {
        min: p.daily_price_min,
        max: p.daily_price_max ?? p.daily_price_min,
      });
    }

    // Utilization: rental days in window / lookback days
    const rentalDaysById = new Map<string, number>();
    for (const r of reservations) {
      if (!isPaidWithV1Legacy(r as any)) continue;
      const eff = effectiveDate(r as any);
      if (!eff || eff < cutoffIso) continue;
      const seen = new Set<string>();
      for (const x of r.expanded_items ?? r.resolved_items ?? []) {
        if (seen.has(x.item_id)) continue;
        seen.add(x.item_id);
        rentalDaysById.set(
          x.item_id,
          (rentalDaysById.get(x.item_id) ?? 0) + (r.duration_days ?? 0),
        );
      }
    }

    // Denials per canonical name in window
    const denialsByName = new Map<string, number>();
    for (const d of denials) {
      if (d.created_at < cutoffMs) continue;
      if (!d.item_name) continue;
      const k = normName(d.item_name);
      denialsByName.set(k, (denialsByName.get(k) ?? 0) + 1);
    }

    const rows = active.map((i) => {
      const utilization = (rentalDaysById.get(i._id as string) ?? 0) / lookback;
      const price = priceByName.get(normName(i.name_canonical));
      const denialCount = denialsByName.get(normName(i.name_canonical)) ?? 0;
      let signal: "raise_price" | "lower_price" | "balanced" | "needs_data";
      let reason: string;
      if (!price) {
        signal = "needs_data";
        reason = "no pricing_catalog row";
      } else if (utilization >= 0.7 && denialCount > 0) {
        signal = "raise_price";
        reason = `${Math.round(utilization * 100)}% utilization + ${denialCount} denials → demand exceeds supply at current rate`;
      } else if (utilization >= 0.8) {
        signal = "raise_price";
        reason = `${Math.round(utilization * 100)}% utilization at current rate`;
      } else if (utilization <= 0.2 && i.qty <= 2) {
        signal = "lower_price";
        reason = `${Math.round(utilization * 100)}% utilization despite low supply`;
      } else {
        signal = "balanced";
        reason = `${Math.round(utilization * 100)}% utilization, ${denialCount} denials`;
      }
      return {
        itemId: i._id,
        name: i.name_canonical,
        qty: i.qty,
        utilizationPct: Math.round(utilization * 1000) / 10,
        dailyPriceMinGbp: price?.min ?? null,
        dailyPriceMaxGbp: price?.max ?? null,
        denialCountInWindow: denialCount,
        signal,
        reason,
      };
    });

    rows.sort((a, b) => {
      // Surface raise_price first, then lower_price, then needs_data, then balanced.
      const w = { raise_price: 0, lower_price: 1, needs_data: 2, balanced: 3 };
      return w[a.signal] - w[b.signal];
    });
    return { ok: true as const, lookbackDays: lookback, rows: rows.slice(0, limit ?? 30) };
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
