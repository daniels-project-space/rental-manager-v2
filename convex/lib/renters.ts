/**
 * Renter resolution + trust helpers. The `renters` table is the owner's CRM:
 * blacklist (bad actors), whitelist (trusted), and a timestamped note_log,
 * all CLI-managed via convex/renters_admin.ts.
 *
 * Reservations link to a renter doc in three ways, in priority order:
 *   1. reservation.renter_id   → renters._id            (newest, exact)
 *   2. reservation.hygglo_user_id / renter_id-as-huid   → by_hygglo_user_id
 *   3. reservation.renter_name → renters.display_name    (case-insensitive)
 */
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

export type RenterDoc = Doc<"renters">;

export type RenterTrust = {
  renterDocId: string | null;
  blacklisted: boolean;
  blacklist_reason: string | null;
  whitelisted: boolean;
  whitelist_reason: string | null;
  total_rentals: number | null;
  rating: number | null;
  notes: string | null;
  note_count: number;
};

export const isBlacklisted = (r: RenterDoc | null | undefined): boolean =>
  !!(r && (r.blacklisted || r.blacklist));
export const isWhitelisted = (r: RenterDoc | null | undefined): boolean => !!(r && r.whitelisted);

export function trustOf(r: RenterDoc | null | undefined): RenterTrust {
  return {
    renterDocId: r ? (r._id as string) : null,
    blacklisted: isBlacklisted(r),
    blacklist_reason: r?.blacklist_reason ?? null,
    whitelisted: isWhitelisted(r),
    whitelist_reason: r?.whitelist_reason ?? null,
    total_rentals: r?.total_rentals_count ?? null,
    rating: r?.hygglo_rating ?? null,
    notes: r?.notes ?? null,
    note_count: (r?.note_log?.length ?? 0) + (r?.notes ? 1 : 0),
  };
}

/** Build bulk lookup maps from one collect — for per-reservation resolution. */
export async function renterMaps(ctx: QueryCtx | MutationCtx) {
  const all = await ctx.db.query("renters").collect();
  const byHuid = new Map<string, RenterDoc>();
  const byName = new Map<string, RenterDoc>();
  for (const r of all) {
    if (r.hygglo_user_id) byHuid.set(r.hygglo_user_id, r);
    const nm = (r.display_name ?? "").trim().toLowerCase();
    // Prefer the row with the most rentals when names collide.
    if (nm) {
      const ex = byName.get(nm);
      if (!ex || (r.total_rentals_count ?? 0) > (ex.total_rentals_count ?? 0)) byName.set(nm, r);
    }
  }
  return { all, byHuid, byName };
}

type ResLike = {
  renter_id?: string | null;
  hygglo_user_id?: string | null;
  renter_name?: string | null;
};

/** Resolve a reservation's renter from prebuilt maps (point-read for renter_id). */
export async function renterForReservation(
  ctx: QueryCtx | MutationCtx,
  r: ResLike,
  maps: { byHuid: Map<string, RenterDoc>; byName: Map<string, RenterDoc> },
): Promise<RenterDoc | null> {
  if (r.renter_id) {
    try {
      const direct = await ctx.db.get(r.renter_id as Id<"renters">);
      if (direct && (direct as RenterDoc).display_name !== undefined) return direct as RenterDoc;
    } catch {
      // renter_id may be a hygglo_user_id on some rows — fall through.
    }
    const viaHuid = maps.byHuid.get(r.renter_id);
    if (viaHuid) return viaHuid;
  }
  if (r.hygglo_user_id) {
    const viaHuid = maps.byHuid.get(r.hygglo_user_id);
    if (viaHuid) return viaHuid;
  }
  const nm = (r.renter_name ?? "").trim().toLowerCase();
  if (nm) return maps.byName.get(nm) ?? null;
  return null;
}

/** Single resolution for CLI: by doc id, hygglo_user_id, or name (exact→contains). */
export async function resolveRenter(
  ctx: QueryCtx | MutationCtx,
  ident: string,
): Promise<{ renter: RenterDoc } | { ambiguous: RenterDoc[] } | { notfound: true }> {
  const trimmed = ident.trim();
  // doc id?
  try {
    const direct = await ctx.db.get(trimmed as Id<"renters">);
    if (direct && (direct as RenterDoc).display_name !== undefined) return { renter: direct as RenterDoc };
  } catch {
    /* not an id */
  }
  // hygglo_user_id?
  const byHuid = await ctx.db
    .query("renters")
    .withIndex("by_hygglo_user_id", (q) => q.eq("hygglo_user_id", trimmed))
    .first();
  if (byHuid) return { renter: byHuid };
  // name
  const low = trimmed.toLowerCase();
  const all = await ctx.db.query("renters").collect();
  const exact = all.filter((r) => (r.display_name ?? "").trim().toLowerCase() === low);
  if (exact.length === 1) return { renter: exact[0] };
  const contains = exact.length
    ? exact
    : all.filter((r) => (r.display_name ?? "").toLowerCase().includes(low));
  if (contains.length === 1) return { renter: contains[0] };
  if (contains.length === 0) return { notfound: true };
  return { ambiguous: contains.slice(0, 20) };
}
