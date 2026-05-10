import { query } from "./_generated/server";
import { v } from "convex/values";

type BundleDef = { name: string; items: string[] };

const BUNDLE_DEFINITIONS: BundleDef[] = [
  { name: "Sony FX3 + 24-70mm GM Kit", items: ["Sony FX3", "Sony GM 24-70mm f2.8"] },
  { name: "Sony FX3 + 24-70mm GM + RS3 Gimbal Kit", items: ["Sony FX3", "Sony GM 24-70mm f2.8", "DJI RS3 Pro gimbal"] },
  { name: "Sony FX3 Full Production Kit", items: ["Sony FX3", "Sony GM 24-70mm f2.8", "DJI RS3 Pro gimbal", "Rode Wireless Mic Pro set", "Atomos Ninja V", "ND filter"] },
  { name: "Sony FX3 Full Production Kit + V-Mount 95mAh", items: ["Sony FX3", "Sony GM 24-70mm f2.8", "DJI RS3 Pro gimbal", "Rode Wireless Mic Pro set", "Atomos Ninja V", "ND filter", "V-mount 95mAh"] },
  { name: "Sony FX3 Full Production Kit + V-Mount 150mAh", items: ["Sony FX3", "Sony GM 24-70mm f2.8", "DJI RS3 Pro gimbal", "Rode Wireless Mic Pro set", "Atomos Ninja V", "ND filter", "V-mount 150mAh"] },
  { name: "2x Sony FX3 Set", items: ["Sony FX3", "Sony FX3"] },
  { name: "BMPCC 6K Pro Cinema Kit", items: ["BMPCC 6K Pro", "Canon EF 24-105mm f4", "DJI RS3 Pro gimbal", "Atomos Ninja V"] },
  { name: "BMPCC 6K Pro Interview Kit", items: ["BMPCC 6K Pro", "Canon EF 24-105mm f4", "Nanlite Pavotube 30x II", "Rode Wireless Mic Pro set"] },
  { name: "BMPCC 6K Pro + Canon Dual Lens Set", items: ["BMPCC 6K Pro", "Canon EF 16-35mm f2.8", "Canon EF 24-105mm f4"] },
  { name: "BMPCC 6K Full Frame + Canon 24-105mm Kit", items: ["BMPCC 6K Full Frame", "Canon EF 24-105mm f4"] },
  { name: "BMPCC 6K Full Frame + Canon 24-105mm + Gimbal Kit", items: ["BMPCC 6K Full Frame", "Canon EF 24-105mm f4", "DJI RS3 Pro gimbal"] },
  { name: "BMPCC Explorer Set (6K Pro + Full Frame + Canon 16-35mm)", items: ["BMPCC 6K Pro", "BMPCC 6K Full Frame", "Canon EF 16-35mm f2.8", "DJI RS3 Pro gimbal"] },
  { name: "BMPCC 6K Pro Ultimate Short Film Set", items: ["BMPCC 6K Pro", "Canon EF 24-105mm f4", "DJI RS3 Pro gimbal", "Atomos Ninja V", "Rode Wireless Mic Pro set"] },
  { name: "Sony GM Triple Lens Set (16-35 + 24-70 + 70-200)", items: ["Sony GM 16-35mm f2.8", "Sony GM 24-70mm f2.8", "Sony GM 70-200mm f2.8"] },
  { name: "Blazar Remus 4-Lens Anamorphic Set", items: ["Anamorphic Blazar Remus 33mm", "Anamorphic Blazar Remus 45mm", "Anamorphic Blazar Remus 65mm", "Anamorphic Blazar Remus 100mm"] },
  { name: "JBL Speakers + Pioneer DJ RX3 Set", items: ["JBL Club 120 speaker", "JBL Club 120 speaker", "DJ RX3 Pioneer controller"] },
  { name: "Interview Lighting Kit (2x LED + Softbox)", items: ["LED light panels RGB", "LED light panels RGB", "Softbox 85cm"] },
  { name: "Full Lighting Kit (Forza + 2x Pavotube + C-stand)", items: ["Nanlite Forza 300", "Nanlite Pavotube 30x II", "Nanlite Pavotube 30x II", "C-stand"] },
  { name: "2x Nanlite Pavotube 30x II Set", items: ["Nanlite Pavotube 30x II", "Nanlite Pavotube 30x II"] },
  { name: "4x Nanlite Pavotube 30x II Set", items: ["Nanlite Pavotube 30x II", "Nanlite Pavotube 30x II", "Nanlite Pavotube 30x II", "Nanlite Pavotube 30x II"] },
  { name: "3x GoPro Hero 12 Set", items: ["GoPro 12 Hero", "GoPro 12 Hero", "GoPro 12 Hero"] },
  { name: "Action Cam Duo (GoPro + DJI Osmo)", items: ["GoPro 12 Hero", "DJI Osmo Action Pro 5"] },
  { name: "Car Mount Kit (3x Suction Cups + GoPro)", items: ["Suction cups", "Suction cups", "Suction cups", "GoPro 12 Hero"] },
  { name: "Dual Drone Kit (Mavic 3 Pro + Mini 4 Pro)", items: ["DJI Mavic 3 Pro", "DJI Mini 4 Pro"] },
  { name: "Aerial + Ground Kit (Mavic 3 + FX3 + 16-35mm)", items: ["DJI Mavic 3 Pro", "Sony FX3", "Sony GM 16-35mm f2.8"] },
  { name: "Full Audio Kit (Rode + Boom + VideoMic)", items: ["Rode Wireless Mic Pro set", "Audio boom mic Sennheiser", "Rode Video Mic Pro Plus"] },
  { name: "Interview Audio Kit (Rode Wireless + Boom)", items: ["Rode Wireless Mic Pro set", "Audio boom mic Sennheiser"] },
  { name: "Dual Wireless Mic Kit (2x Rode)", items: ["Rode Wireless Mic Pro set", "Rode Wireless Mic Pro set"] },
  { name: "Smoke Duo (Ninja + Ninja Pro)", items: ["Smoke Ninja", "Smoke Ninja Pro hazer"] },
  { name: "Music Video Atmosphere Kit (Smoke + 2x Pavotube)", items: ["Smoke Ninja Pro hazer", "Nanlite Pavotube 30x II", "Nanlite Pavotube 30x II"] },
  { name: "Wireless Monitor Kit (Hollyland 7in + Mars 4K)", items: ["Hollyland 7-inch monitor", "Hollyland Mars 4K transmitter"] },
  { name: "Wedding Dual Camera Kit", items: ["Sony FX3", "Sony FX3", "Sony GM 24-70mm f2.8", "Sony GM 70-200mm f2.8"] },
  { name: "Documentary Filmmaker Kit", items: ["Sony FX3", "Sony GM 24-70mm f2.8", "Rode Wireless Mic Pro set", "Audio boom mic Sennheiser"] },
];

function matchToBundle(itemNames: string[]): string | null {
  const freq = new Map<string, number>();
  for (const name of itemNames) {
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  let bestMatch: string | null = null;
  let bestLength = 0;
  const sorted = [...BUNDLE_DEFINITIONS].sort((a, b) => b.items.length - a.items.length);
  for (const bundle of sorted) {
    const required = new Map<string, number>();
    for (const item of bundle.items) {
      const key = item.toLowerCase().replace(/[^a-z0-9]/g, "");
      required.set(key, (required.get(key) ?? 0) + 1);
    }
    let matches = true;
    for (const [reqKey, count] of required.entries()) {
      let found = 0;
      for (const [rKey, rCount] of freq.entries()) {
        if (rKey.includes(reqKey) || reqKey.includes(rKey)) found += rCount;
      }
      if (found < count) { matches = false; break; }
    }
    if (matches && bundle.items.length > bestLength) {
      bestMatch = bundle.name;
      bestLength = bundle.items.length;
    }
  }
  return bestMatch;
}

export const getTopBundles = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
  },
  handler: async (ctx, { accountSlug, days }) => {
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
    reservations = reservations.filter(
      (r) => r.status !== "cancelled" && r.status !== "denied" && (r.items ?? []).length >= 2
    );
    const byBundle = new Map<string, { revenue: number; count: number; totalDays: number; items: string[] }>();
    for (const res of reservations) {
      const itemNames = (res.items ?? []).map((i: { item_name: string }) => i.item_name);
      if (itemNames.length < 2) continue;
      const bundleName = matchToBundle(itemNames);
      if (!bundleName) continue;
      const gross = res.gross_paid_gbp ?? 0;
      const dur = res.duration_days ?? 0;
      const existing = byBundle.get(bundleName) ?? {
        revenue: 0, count: 0, totalDays: 0,
        items: BUNDLE_DEFINITIONS.find((b) => b.name === bundleName)?.items ?? [],
      };
      existing.revenue += gross;
      existing.count += 1;
      existing.totalDays += dur;
      byBundle.set(bundleName, existing);
    }
    return Array.from(byBundle.entries())
      .map(([name, stats]) => ({
        name,
        totalRevenue: Math.round(stats.revenue * 100) / 100,
        rentalCount: stats.count,
        totalDays: stats.totalDays,
        avgValue: stats.count > 0 ? Math.round((stats.revenue / stats.count) * 100) / 100 : 0,
        items: stats.items,
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);
  },
});

export const getBundleRevenueRanking = getTopBundles;
