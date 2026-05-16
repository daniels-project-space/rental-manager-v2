import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Data-access layer for the audit_listings one-shot sweep.
 *
 * Approach: paginate the reservations table (full scan, ordered by
 * _creationTime) and deduplicate by hygglo_listing_id in-process using a
 * Set. The cursor is the _creationTime of the last row returned, encoded
 * as a string so it is a valid Convex value.
 *
 * Scaling concern: if the reservations table grows very large (>100k rows)
 * this becomes a full-table scan per chunk. V1 mitigation: build a
 * listing_resolution covering index (already exists) and swap to querying
 * that table for distinct listing_ids — that set is 10-100× smaller.
 * Flagged as "needs optimization" for V2; the working V1 is shipped here.
 *
 * skip_resolved: when true, listings that already have a listing_resolution
 * row with status="resolved" are excluded from the returned chunk so the
 * caller skips the expensive resolveListing action for them. This is the
 * idempotency mechanism — re-runs are cheap unless force=true.
 */
export const listDistinctListings = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    limit: v.number(),
    account: v.optional(v.string()),
    skip_resolved: v.boolean(),
  },
  handler: async (ctx, { cursor, limit, account, skip_resolved }) => {
    const cap = Math.min(Math.max(1, limit), 200);

    // We scan more rows than `cap` per page to find enough distinct listings
    // despite duplicates. Heuristic: scan 5× cap then stop.
    const scanLimit = cap * 5;

    // Build query from reservations ordered by _creationTime ascending.
    // cursor encodes the _creationTime (ms) of the last row from the prior page.
    const cursorMs = cursor !== null ? Number(cursor) : 0;

    let q = ctx.db.query("reservations").withIndex("by_status");
    // We can't use a generic _creationTime index via withIndex here because
    // schema only defines named indexes. Fall back to full-table order via
    // .order("asc") — Convex uses _creationTime as the implicit tiebreaker.
    // We filter out rows before the cursor manually after collection.
    void q; // suppress unused-var; we re-assign below

    // Collect up to scanLimit rows with _creationTime > cursorMs.
    // Convex doesn't support a raw _creationTime range query without a
    // dedicated index, so we fetch a large page and slice after the cursor.
    const rawRows = await ctx.db
      .query("reservations")
      .order("asc")
      .filter((q) =>
        account
          ? q.and(
              q.gt(q.field("_creationTime"), cursorMs),
              q.or(
                q.eq(q.field("account_slug"), account),
                q.eq(q.field("hygglo_account" as any), account),
              ),
            )
          : q.gt(q.field("_creationTime"), cursorMs),
      )
      .take(scanLimit);

    // Deduplicate by hygglo_listing_id.
    const seen = new Set<string>();
    const distinct: Array<{
      hygglo_listing_id: string;
      hygglo_account: string;
      hygglo_title: string;
      hygglo_description: string | undefined;
      hygglo_detail_payload: unknown | undefined;
      image_url: string | undefined;
    }> = [];

    // Pre-load resolved listing ids if skip_resolved is set.
    // We query listing_resolution for all resolved ids that match our account
    // scope, then exclude those from the output.
    const resolvedIds = new Set<string>();
    if (skip_resolved) {
      // Index: by_account_status exists → use it. Pull resolved rows for the
      // given account (or all accounts when account is undefined).
      if (account) {
        const resolvedRows = await ctx.db
          .query("listing_resolution")
          .withIndex("by_account_status", (q) =>
            q.eq("hygglo_account", account).eq("status", "resolved"),
          )
          .collect();
        for (const r of resolvedRows) resolvedIds.add(r.hygglo_listing_id);
      } else {
        const resolvedRows = await ctx.db
          .query("listing_resolution")
          .withIndex("by_status", (q) => q.eq("status", "resolved"))
          .collect();
        for (const r of resolvedRows) resolvedIds.add(r.hygglo_listing_id);
      }
    }

    let lastCreationTime = cursorMs;

    for (const row of rawRows) {
      lastCreationTime = row._creationTime;
      const listingId = row.hygglo_listing_id;
      if (!listingId) continue;
      if (seen.has(listingId)) continue;
      seen.add(listingId);

      if (skip_resolved && resolvedIds.has(listingId)) continue;

      // Derive hygglo_account from account_slug field (reservations table
      // uses account_slug; the listing_resolution table uses hygglo_account
      // with the same slug values).
      const hyggloAccount = (row as any).hygglo_account ?? row.account_slug ?? "unknown";

      // Extract the listing title from hygglo_items or items arrays as a
      // best-effort — reservations don't store hygglo_title directly.
      // The resolver itself will look up the title from the listing_resolution
      // cache or skip Tier 1 if not present. We pass empty string and let the
      // caller pass the real title fetched via another means if needed.
      // For the audit sweep we use the first hygglo_items entry name as title.
      const hyggloTitle =
        (row.hygglo_items && row.hygglo_items.length > 0
          ? row.hygglo_items[0].name
          : undefined) ??
        (row.items && row.items.length > 0 ? row.items[0].item_name : undefined) ??
        listingId;

      const imageUrl =
        (row.hygglo_items && row.hygglo_items.length > 0
          ? row.hygglo_items[0].image_url ?? undefined
          : undefined) ??
        (row.photos_urls && row.photos_urls.length > 0
          ? row.photos_urls[0]
          : undefined);

      distinct.push({
        hygglo_listing_id: listingId,
        hygglo_account: hyggloAccount,
        hygglo_title: hyggloTitle,
        hygglo_description: undefined,
        hygglo_detail_payload: undefined,
        image_url: imageUrl,
      });

      if (distinct.length >= cap) break;
    }

    // next_cursor: if we consumed all scanned rows and still have space, we
    // are at the end of the table. Otherwise return the last _creationTime.
    const exhausted = rawRows.length < scanLimit;
    const next_cursor =
      distinct.length === 0 || exhausted ? null : String(lastCreationTime);

    return { listings: distinct, next_cursor };
  },
});
