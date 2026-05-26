/**
 * MV: mv_rental_volume_kind_breakdown
 *
 * Pass 10a (2026-05-25) — initial wrap-and-cache. ~8 kinds × 3 windows × 3
 * accounts = 72 rows at steady state. Refreshed by master.refreshSlow.
 *
 * Pass 13d (2026-05-26) — SINGLE-PASS refactor. Previous refresher looped
 * 72 combos and invoked the live handler each iteration, which re-ran a
 * reservations.collect (~250 rich rows × 50KB) + items.collect + pricing
 * .collect for every combo = ~12MB × 72 = ~850MB per refresh. New refresher
 * collects each input table exactly ONCE and runs the compute in-memory
 * for every (account × days × kind). Same output, 70× less bandwidth.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "../_generated/server";
import { anyApi } from "convex/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";
import { attributeRevenue } from "../lib/revenue_attribution";
import { dedupByLogicalRental, effectiveDate, isLive } from "../lib/reservations/predicates";

export const STANDARD_WINDOWS = [30, 90, 365] as const;

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
const PALETTE = ["#60a5fa", "#34d399", "#a78bfa", "#fbbf24", "#f87171", "#22d3ee"];

/** Pulls every input table in ONE indexed query. 365d covers the widest
 *  refresher window. */
export const collectInputs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoffStr = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const [reservations, items, pricing] = await Promise.all([
      ctx.db.query("reservations")
        .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
        .collect(),
      ctx.db.query("items").collect(),
      ctx.db.query("pricing_catalog").collect(),
    ]);
    return { reservations, items, pricing };
  },
});

export const refresh = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: true; written: number; durationMs: number }> => {
    return await refreshAll(ctx);
  },
});

export async function refreshAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
): Promise<{ ok: true; written: number; durationMs: number }> {
  const startedAt = Date.now();
  const { reservations, items, pricing } = await ctx.runQuery(
    anyApi.mv.rental_volume_kind_breakdown.collectInputs,
    {},
  );

  // Build shared maps ONCE (re-used across every combo).
  const priceByCanonical = new Map<string, number>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pricing as any[]).map((p) => [p.item_name_canonical, p.daily_price_min]),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const itemById = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const itemByCanonical = new Map<string, any>();
  const kindById = new Map<string, { kind: string; name: string }>();
  const distinctKinds = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const it of items as any[]) {
    itemById.set(it._id as string, it);
    const nm = it.name_canonical as string | undefined;
    if (nm) itemByCanonical.set(nm, it);
    kindById.set(it._id as string, { kind: it.kind, name: nm ?? it.kind });
    if (it.kind) distinctKinds.add(it.kind);
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const slugs: Array<{ key: string; arg: string | null }> = [
    { key: ACCOUNT_ALL, arg: null },
    ...ACCOUNTS.map((s) => ({ key: s, arg: s })),
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Reservation = any;
  // Pre-bucket reservations by account_slug to avoid re-filtering per combo.
  const byAccount = new Map<string, Reservation[]>();
  byAccount.set(ACCOUNT_ALL, reservations as Reservation[]);
  for (const r of reservations as Reservation[]) {
    if (!r.account_slug) continue;
    const list = byAccount.get(r.account_slug) ?? [];
    list.push(r);
    byAccount.set(r.account_slug, list);
  }

  const writes: Array<{ account: string; days: number; kind: string; payload: unknown }> = [];

  for (const { key, arg } of slugs) {
    const accountSlice = arg === null
      ? byAccount.get(ACCOUNT_ALL) ?? []
      : byAccount.get(arg) ?? [];
    const live = accountSlice.filter(isLive);
    const deduped = dedupByLogicalRental(live);

    for (const days of STANDARD_WINDOWS) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const inWindow = deduped.filter((r) => {
        const d = effectiveDate(r);
        return d !== undefined && d >= cutoffStr && d <= todayStr;
      });

      // First pass: countByKind to derive top-6/other split (same logic as live).
      const countByKind = new Map<string, number>();
      for (const r of inWindow) {
        const resolved: Array<{ item_id: string; qty?: number }> = r.resolved_items ?? [];
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

      // Pre-compute attributeRevenue results ONCE per reservation (independent
      // of `kind`). We then filter per `kind` in the inner loop. Saves
      // re-running the (expensive) attribution math kinds.length × inWindow
      // times — replaced by a single inWindow pass.
      type Line = { kind: string; key: { id?: string; nameCanonical?: string }; share: number };
      const attribByRes: Array<Line[]> = inWindow.map((r) => {
        const resolved = r.resolved_items ?? [];
        if (resolved.length === 0) return [];
        return attributeRevenue(
          {
            _id: r._id,
            gross_gbp: r.gross_paid_gbp ?? 0,
            duration_days: r.duration_days,
            expanded_items: r.expanded_items,
            resolved_items: resolved,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { itemById, itemByCanonical, priceByName: priceByCanonical } as any,
        ) as Line[];
      });

      const kindsToWrite = new Set<string>([...distinctKinds, "other"]);
      for (const kind of kindsToWrite) {
        const isInTargetSet = (k: string): boolean =>
          kind === "other" ? otherKinds.has(k) : k === kind;
        const itemCount = new Map<string, number>();
        const itemRevenue = new Map<string, number>();
        for (const lines of attribByRes) {
          for (const line of lines) {
            if (!isInTargetSet(line.kind)) continue;
            const idStr = line.key.id ?? line.key.nameCanonical ?? "";
            if (!idStr) continue;
            itemCount.set(idStr, (itemCount.get(idStr) ?? 0) + 1);
            itemRevenue.set(idStr, (itemRevenue.get(idStr) ?? 0) + line.share);
          }
        }

        type ItemSlice = {
          itemId: string;
          name: string;
          count: number;
          revenue: number;
          color: string;
        };
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

        const items_out: ItemSlice[] = entries.slice(0, 15).map((e, i) => ({
          ...e,
          color: PALETTE[i % PALETTE.length],
        }));
        const totals = {
          count: items_out.reduce((s, e) => s + e.count, 0),
          revenue: Math.round(items_out.reduce((s, e) => s + e.revenue, 0) * 100) / 100,
        };
        const payload = {
          days,
          periodStart: cutoffStr,
          kind,
          kindLabel: labelFor(kind),
          items: items_out,
          totals,
        };
        // suppress unused topKinds (kept for parity with live handler's
        // semantic — top-6 are NOT excluded from the per-kind breakdown,
        // they're listed by their own kind label; only "other" rolls up
        // the long tail).
        void topKinds;
        writes.push({ account: key, days, kind, payload });
      }
    }
  }

  // Single mutation per row keeps failure isolation; could batch via a
  // multi-row write mutation in a follow-up. Refresher runs once daily so
  // per-row overhead isn't load-bearing.
  for (const w of writes) {
    await ctx.runMutation(anyApi.mv.rental_volume_kind_breakdown.write, {
      account: w.account,
      days: w.days,
      kind: w.kind,
      payload: w.payload,
      generatedAt: startedAt,
    });
  }

  return { ok: true, written: writes.length, durationMs: Date.now() - startedAt };
}

export const write = internalMutation({
  args: {
    account: v.string(),
    days: v.number(),
    kind: v.string(),
    payload: v.any(),
    generatedAt: v.number(),
  },
  handler: async (ctx, { account, days, kind, payload, generatedAt }) => {
    const existing = await ctx.db
      .query("mv_rental_volume_kind_breakdown")
      .withIndex("by_account_days_kind", (q) =>
        q.eq("account", account).eq("days", days).eq("kind", kind),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { payload, generatedAt });
    } else {
      await ctx.db.insert("mv_rental_volume_kind_breakdown", {
        account,
        days,
        kind,
        payload,
        generatedAt,
      });
    }
    return { ok: true };
  },
});

export const get = query({
  args: {
    account: v.optional(v.string()),
    days: v.number(),
    kind: v.string(),
  },
  handler: async (ctx, { account, days, kind }) => {
    const key = account ?? ACCOUNT_ALL;
    const row = await ctx.db
      .query("mv_rental_volume_kind_breakdown")
      .withIndex("by_account_days_kind", (q) =>
        q.eq("account", key).eq("days", days).eq("kind", kind),
      )
      .first();
    return row;
  },
});
