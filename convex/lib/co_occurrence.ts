/**
 * Co-occurrence + substitution metrics (Phase 5b).
 *
 *   computeCoRentedPairs       → For an item, what 3 OTHER canonicals show up
 *                                most often on the same rental? (rentals where
 *                                the focus item was actually booked.)
 *   computeSubstitutionsAfterDenial → For each denied reservation, look at
 *                                the SAME renter's NEXT booked rental within
 *                                60 days. Items in that next rental but not
 *                                in the denied one count as substitutions.
 *
 * Pure functions. Caller passes pre-fetched rows.
 */

import type { Doc, Id } from "../_generated/dataModel";

export type CoRented = { canonical_name: string; count: number };

/**
 * For a given focus item, walk all rentals that include it and tally the
 * OTHER canonical names that appear alongside. Returns top 3.
 *
 * "Rentals that include it" = expanded_items (or resolved_items fallback)
 * contains focusItemId. We restrict to live (non-cancelled, non-obsolete)
 * rentals — past co-purchases are the operational signal.
 */
export function computeCoRentedPairs(
  reservations: Array<Doc<"reservations">>,
  focusItemId: Id<"items">,
  topN = 3,
): CoRented[] {
  const focusStr = String(focusItemId);
  const counts = new Map<string, number>();
  for (const r of reservations) {
    if (r.is_obsolete) continue;
    if (r.status === "cancelled" || r.status === "declined") continue;

    const lines = (r.expanded_items && r.expanded_items.length > 0
      ? r.expanded_items
      : (r.resolved_items ?? [])) as Array<{
        item_id?: Id<"items">;
        item_name_canonical: string;
      }>;
    const hasFocus = lines.some((ln) => ln.item_id && String(ln.item_id) === focusStr);
    if (!hasFocus) continue;

    const seenInThisRental = new Set<string>();
    for (const ln of lines) {
      if (!ln.item_id) continue;
      if (String(ln.item_id) === focusStr) continue;
      const canon = ln.item_name_canonical;
      if (!canon) continue;
      if (seenInThisRental.has(canon)) continue;
      seenInThisRental.add(canon);
      counts.set(canon, (counts.get(canon) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([canonical_name, count]) => ({ canonical_name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

/**
 * Substitution map: for each FOCUS item that was denied to a renter, find the
 * SAME renter's NEXT booked rental within 60 days. Items in that next rental
 * but not in the original denial count as substitutions.
 *
 * Input:
 *   - deniedReservations: subset where owner_denied (or marketing_only) — the
 *     "loss" events whose substitutes we want to track.
 *   - subsequentReservations: all live/booked rentals (any account) — we'll
 *     filter to the SAME renter and AFTER denial date.
 *
 * Output: Map<item_id, Array<{canonical_name, count}>> — top substitutes per
 * focus item (ordered desc). Caller picks topN.
 */
export function computeSubstitutionsAfterDenial(
  deniedReservations: Array<Doc<"reservations">>,
  subsequentReservations: Array<Doc<"reservations">>,
  windowDays = 60,
): Map<string, CoRented[]> {
  // Index booked rentals by renter for fast lookup.
  const byRenter = new Map<string, Array<Doc<"reservations">>>();
  for (const r of subsequentReservations) {
    if (r.is_obsolete) continue;
    if (r.status === "cancelled" || r.status === "declined") continue;
    if (!r.start_date) continue;
    const k = renterGroupKey(r);
    if (!k) continue;
    let arr = byRenter.get(k);
    if (!arr) {
      arr = [];
      byRenter.set(k, arr);
    }
    arr.push(r);
  }
  for (const arr of byRenter.values()) {
    arr.sort((a, b) => (a.start_date ?? "").localeCompare(b.start_date ?? ""));
  }

  // For each denial, find renter's next rental within window.
  // Tally per FOCUS item id.
  const out = new Map<string, Map<string, number>>();
  for (const denial of deniedReservations) {
    const rk = renterGroupKey(denial);
    if (!rk) continue;
    const denialDate = denial.start_date ?? denial.end_date;
    if (!denialDate) continue;

    const candidates = byRenter.get(rk) ?? [];
    if (candidates.length === 0) continue;

    // first booking strictly AFTER denialDate, within windowDays
    const limit = addDaysISO(denialDate, windowDays);
    const next = candidates.find(
      (r) => (r.start_date ?? "") > denialDate && (r.start_date ?? "") <= limit,
    );
    if (!next) continue;

    // Items denied (focus items)
    const denialItems = itemLines(denial);
    if (denialItems.length === 0) continue;
    const denialItemIds = new Set(denialItems.map((l) => String(l.item_id ?? "")));

    // Items they BOOKED instead
    const subs = itemLines(next).filter(
      (l) => l.item_id && !denialItemIds.has(String(l.item_id)),
    );
    if (subs.length === 0) continue;

    for (const focus of denialItems) {
      if (!focus.item_id) continue;
      const focusKey = String(focus.item_id);
      let m = out.get(focusKey);
      if (!m) {
        m = new Map();
        out.set(focusKey, m);
      }
      const seen = new Set<string>();
      for (const s of subs) {
        if (!s.canonical_name) continue;
        if (seen.has(s.canonical_name)) continue;
        seen.add(s.canonical_name);
        m.set(s.canonical_name, (m.get(s.canonical_name) ?? 0) + 1);
      }
    }
  }

  // Convert inner maps to sorted arrays.
  const result = new Map<string, CoRented[]>();
  for (const [focusKey, counts] of out) {
    const arr = Array.from(counts.entries())
      .map(([canonical_name, count]) => ({ canonical_name, count }))
      .sort((a, b) => b.count - a.count);
    result.set(focusKey, arr);
  }
  return result;
}

function renterGroupKey(r: Doc<"reservations">): string | null {
  if (r.renter_id) return `R:${String(r.renter_id)}`;
  if (r.renter_name) return `N:${r.account_slug ?? "?"}|${r.renter_name}`;
  return null;
}

function itemLines(
  r: Doc<"reservations">,
): Array<{ item_id?: Id<"items">; canonical_name: string }> {
  const out: Array<{ item_id?: Id<"items">; canonical_name: string }> = [];
  const seen = new Set<string>();
  if (r.expanded_items && r.expanded_items.length > 0) {
    for (const x of r.expanded_items) {
      const idStr = x.item_id ? String(x.item_id) : x.item_name_canonical;
      if (seen.has(idStr)) continue;
      seen.add(idStr);
      out.push({ item_id: x.item_id, canonical_name: x.item_name_canonical });
    }
    return out;
  }
  for (const x of r.resolved_items ?? []) {
    const idStr = x.item_id ? String(x.item_id) : x.item_name_canonical;
    if (seen.has(idStr)) continue;
    seen.add(idStr);
    out.push({ item_id: x.item_id, canonical_name: x.item_name_canonical });
  }
  return out;
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
