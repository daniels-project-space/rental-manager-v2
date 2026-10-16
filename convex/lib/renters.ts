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

/** Build renter maps only for the supplied reservation set. Name-only legacy
 * rows keep the original case-insensitive/collision behavior through a bounded
 * fallback; normal ID/HUID rows never scan the renter table. */
export async function renterMapsForReservations(
  ctx: QueryCtx,
  reservations: Array<{ renter_id?: string | null; hygglo_user_id?: string | null; renter_name?: string | null }>,
) {
  const byId = new Map<string, RenterDoc>();
  const byHuid = new Map<string, RenterDoc>();
  const byName = new Map<string, RenterDoc>();
  const addName = (r: RenterDoc) => {
    const name = (r.display_name ?? "").trim().toLowerCase();
    if (!name) return;
    const previous = byName.get(name);
    if (!previous || (r.total_rentals_count ?? 0) > (previous.total_rentals_count ?? 0)) byName.set(name, r);
  };

  const ids = [...new Set(reservations.map(r => r.renter_id).filter((id): id is string => Boolean(id)))];
  const direct = await Promise.all(ids.map(async id => {
    try {
      const row = await ctx.db.get(id as Id<"renters">);
      return row && (row as RenterDoc).display_name !== undefined ? [id, row as RenterDoc] as const : null;
    } catch {
      return null;
    }
  }));
  for (const entry of direct) if (entry) {
    byId.set(entry[0], entry[1]);
    addName(entry[1]);
  }

  const huidKeys = [...new Set(reservations.flatMap(r => {
    // The reservation ID is authoritative when it resolves. Avoid a second
    // index read for its HUID; only use HUID lookup for unresolved IDs or rows
    // that have no direct renter reference.
    if (r.renter_id && byId.has(r.renter_id)) return [];
    return [r.hygglo_user_id, r.renter_id];
  }).filter((id): id is string => Boolean(id)))];
  const huidRows = await Promise.all(huidKeys.map(id => ctx.db.query("renters")
    .withIndex("by_hygglo_user_id", q => q.eq("hygglo_user_id", id)).collect()));
  for (const rows of huidRows) for (const row of rows) {
    const renter = row as RenterDoc;
    if (renter.hygglo_user_id) byHuid.set(renter.hygglo_user_id, renter);
    addName(renter);
  }

  const unresolvedNames = [...new Set(reservations.filter(r => {
    const resolved = Boolean((r.renter_id && (byId.has(r.renter_id) || byHuid.has(r.renter_id))) ||
      (r.hygglo_user_id && byHuid.has(r.hygglo_user_id)));
    return !resolved && Boolean(r.renter_name?.trim());
  }).map(r => r.renter_name!.trim()))];
  // The old map matched names case-insensitively and preferred the renter with
  // the most rentals on collisions. A name-only row cannot preserve that rule
  // through an exact display_name index alone, so retain the legacy scan only
  // when ID and HUID resolution both fail.
  if (unresolvedNames.length > 0) {
    const fallback = await renterMaps(ctx);
    for (const [key, value] of fallback.byHuid) byHuid.set(key, value);
    for (const [key, value] of fallback.byName) {
      const previous = byName.get(key);
      if (!previous || (value.total_rentals_count ?? 0) > (previous.total_rentals_count ?? 0)) byName.set(key, value);
    }
  }
  return { byId, byHuid, byName };
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
  maps: { byHuid: Map<string, RenterDoc>; byName: Map<string, RenterDoc>; byId?: Map<string, RenterDoc> },
): Promise<RenterDoc | null> {
  if (r.renter_id) {
    const cachedById = maps.byId?.get(r.renter_id);
    if (cachedById) return cachedById;
    if (!maps.byId) {
      try {
        const direct = await ctx.db.get(r.renter_id as Id<"renters">);
        if (direct && (direct as RenterDoc).display_name !== undefined) return direct as RenterDoc;
      } catch {
        // renter_id may be a hygglo_user_id on some rows — fall through.
      }
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
