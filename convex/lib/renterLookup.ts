/**
 * Shared renter display-name lookup helpers.
 *
 * Consolidates a pattern that was duplicated four times across
 * convex/calendar.ts (getCalendarStrip, getGanttWeek, getWeeklyCalendar, and
 * the calendar_holds renter-name fallback): given one or more `Id<"renters">`,
 * batch-fetch the renter docs in parallel and read `display_name`.
 *
 * Cost/perf audit (2026-08): all four call sites were ALREADY wrapped in
 * `Promise.all`, so this is a pure de-duplication — no query behavior
 * changes. Do not "simplify" this back into sequential awaits.
 *
 * Callers still decide their own fallback order against the denormalized
 * `reservations.renter_name` field (web/site bookings have no `renter_id`
 * but do carry a denormalized name) — that ordering differs slightly across
 * call sites and is intentionally left in each call site, not folded in here.
 */

import type { Id } from "../_generated/dataModel";

type RenterGetCtx = {
  db: {
    get: (id: Id<"renters">) => Promise<{ display_name?: string | null } | null>;
  };
};

/**
 * Fetch a single renter doc and return its display name, or `null` when the
 * renter doc no longer exists (deleted / dangling id).
 */
export async function getRenterDisplayName(
  ctx: RenterGetCtx,
  renterId: Id<"renters">,
): Promise<string | null> {
  const renter = await ctx.db.get(renterId);
  return renter ? (renter.display_name ?? "?") : null;
}

/**
 * Batch-fetch renter docs for a set of ids and build a
 * `renter_id (string) -> display_name` map. Missing/deleted renter docs are
 * simply omitted from the map (matches the original per-call-site behavior:
 * `if (renter) renterMap.set(...)`).
 *
 * Runs all lookups in parallel via `Promise.all` — identical to the inline
 * loops this replaces.
 */
export async function buildRenterDisplayNameMap(
  ctx: RenterGetCtx,
  renterIds: Array<Id<"renters">>,
): Promise<Map<string, string>> {
  const renterMap = new Map<string, string>();
  await Promise.all(
    renterIds.map(async (rid) => {
      const name = await getRenterDisplayName(ctx, rid);
      if (name !== null) renterMap.set(rid as unknown as string, name);
    }),
  );
  return renterMap;
}
