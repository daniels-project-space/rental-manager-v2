import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

const TODAY = () => new Date().toISOString().slice(0, 10);

/**
 * W05 Live Activity Feed — recent reservations ordered by creation time
 */
export const getRecentActivity = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    limit: v.number(),
  },
  handler: async (ctx, { accountSlug, limit }) => {
    // Newest-first ordering on _creationTime is Convex's default; take(N)
    // stops after N matching rows instead of scanning the full table.
    // When account-scoped, we over-fetch 4x and post-filter (cheap).
    const overFetch = accountSlug ? limit * 4 : limit;
    let rows = await ctx.db.query("reservations").order("desc").take(overFetch);
    if (accountSlug) {
      rows = rows.filter((r) => r.account_slug === accountSlug).slice(0, limit);
    }

    return rows.map((r) => ({
      id: r._id,
      accountSlug: r.account_slug,
      renterName: (r as { renter_name?: string }).renter_name,
      itemNames: (r.items ?? []).map((i) => i.item_name),
      status: r.status,
      // Phase 2: expose order_step + is_obsolete so dashboards/diagnostics
      // can verify the poller wired the field end-to-end.
      order_step: (r as { order_step?: string }).order_step,
      is_obsolete: (r as { is_obsolete?: boolean }).is_obsolete,
      startDate: r.start_date,
      endDate: r.end_date,
      createdAt: r._creationTime,
    }));
  },
});

/**
 * W07 Return Hub — active reservations due today or overdue
 *
 * Pass 12a (2026-05-26): wrap-and-cache via mv_due_returns. Live handler
 * reads ~250 confirmed rich rows + N+1 renter lookups; eager-subscribed by
 * WallESignals so every reservation mutation re-evaluates. Refresher runs
 * hourly. `_bypassMv:true` is set ONLY by mv/due_returns.ts:refreshAll.
 */
import { renterMaps, renterForReservation, trustOf } from "./lib/renters";
import { discountMessageFor } from "./lib/return_messages";
import { reservationItemUnits, buildProductIndexMap, buildOverrideMap, isStandardAccessory, type ResolvableRes } from "./lib/reservations/itemUnits";
import { groupLogicalRentals, displayReturnDate, type ReservationRow } from "./lib/reservations/predicates";

export const getDueReturns = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    _bypassMv: v.optional(v.boolean()),
  },
  handler: async (ctx, { accountSlug, _bypassMv }) => {
    if (!_bypassMv) {
      const accountKey = accountSlug ?? "all";
      const cached = await ctx.db
        .query("mv_due_returns")
        .withIndex("by_account", (q) => q.eq("account", accountKey))
        .first();
      if (cached) {
        // Read-time overlay. mv_due_returns rebuilds only HOURLY, so a rental that
        // was just marked returned (status->completed) or had a case opened lingers
        // in the cached payload until the next rebuild — that was the "Return Hub
        // not updating" bug. Point-read each listed reservation (cheap — only the
        // handful currently in the Hub) and drop any that is no longer an open
        // return. Reading the live docs ALSO makes this query reactive to
        // markReturned / openCase, so Convex re-runs it instantly on close instead
        // of waiting for the hourly refresh.
        const payload = (cached.payload ?? []) as Array<
          Record<string, unknown> & { reservationId: Id<"reservations"> }
        >;
        const fresh: typeof payload = [];
        for (const row of payload) {
          const live = await ctx.db.get(row.reservationId);
          if (!live) continue; // reservation gone
          const r = live as { status?: string; case_open?: boolean; is_obsolete?: boolean; order_step?: string };
          if (r.status === "completed" || r.case_open || r.is_obsolete || r.order_step === "REVIEWED") continue;
          fresh.push(row);
        }
        return fresh;
      }
    }
    const today = TODAY();
    const now = Date.now();
    let active = await ctx.db
      .query("reservations")
      .withIndex("by_status", (q) => q.eq("status", "confirmed"))
      .collect();
    if (accountSlug) {
      active = active.filter((r) => r.account_slug === accountSlug);
    }
    type CandRow = (typeof active)[number];

    // Gear that is OUT per Hygglo: DELIVERED (picked up) or RETURNED (with the
    // renter, awaiting return). REVIEWED = already back. Legacy rows without an
    // order_step fall back to "end_date has passed". Obsolete excluded.
    const isOut = (r: CandRow) =>
      !r.is_obsolete &&
      !(r as { case_open?: boolean }).case_open &&
      r.order_step !== "REVIEWED" &&
      (r.order_step === "DELIVERED" ||
        r.order_step === "RETURNED" ||
        (!r.order_step && r.end_date !== undefined && r.end_date <= today));
    let candidates = active.filter(isOut);

    // v1 completed-scan parity: only gear Hygglo STILL returns in the active poll.
    // A silently-completed rental keeps order_step frozen at RETURNED but stops
    // being polled (last_polled_at goes stale). Keep only the most-recent poll
    // wave — relative to maxPolled, so it survives poller cadence/pauses AND keeps
    // genuinely long-overdue rentals Hygglo still lists (e.g. open since March)
    // that an absolute date cutoff would wrongly hide.
    const polledAt = (r: { last_polled_at?: number; _creationTime?: number }) =>
      r.last_polled_at ?? r._creationTime ?? 0;
    const maxPolled = candidates.reduce((m, r) => Math.max(m, polledAt(r)), 0);
    const POLL_WAVE_MS = 6 * 60 * 60 * 1000;
    if (maxPolled > 0) candidates = candidates.filter((r) => polledAt(r) >= maxPolled - POLL_WAVE_MS);

    // Merge contiguous same-renter / same-item bookings into ONE logical rental,
    // exactly like the calendar + active-rentals widget. An extension (e.g. Dan
    // Thorpe re-booking the same JBL kit to a later day) becomes a single rental
    // whose return is the LAST member's — so it isn't flagged overdue on the
    // earlier date.
    const groups = groupLogicalRentals(candidates as unknown as ReservationRow[]);

    // Item-name shortening — SAME source the Active Rentals tile uses
    // (listing_short_names keyed by account#product_id). No extra processing.
    const shortRows = await ctx.db.query("listing_short_names").collect();
    const shortByProduct = new Map<string, string>();
    for (const sn of shortRows) shortByProduct.set(`${sn.account_slug}#${sn.product_id}`, sn.short_name);

    // Reliable per-listing resolution (covers items the LLM bundle-resolver
    // dropped from expanded/resolved) + inventory names for the case checklist.
    const productIndex = buildProductIndexMap(await ctx.db.query("hygglo_product_index").collect());
    const overrideMap = buildOverrideMap(await ctx.db.query("listing_resolution_override").collect());
    const itemNameById = new Map<string, string>();
    const stdAccIds = new Set<string>();
    for (const it of await ctx.db.query("items").collect()) { itemNameById.set(String(it._id), it.name_canonical); if (isStandardAccessory((it as { kind?: string }).kind, it.name_canonical)) stdAccIds.add(String(it._id)); }

    const maps = await renterMaps(ctx);
    const results: Array<Record<string, unknown>> = [];
    for (const g of groups) {
      const members = (g.members as unknown as CandRow[])
        .slice()
        .sort((a, b) => displayReturnDate(a).localeCompare(displayReturnDate(b)));
      const last = members[members.length - 1];
      const base = members[0]; // earliest pickup — representative row
      const retDate = displayReturnDate(last); // return_date ?? end_date
      const retTime = (last as { return_time?: string }).return_time;
      // Time-aware: only surface once the effective return MOMENT has passed. No
      // time → start-of-day, so a same-day no-time return still shows that day.
      const t0 = retTime && /^\d\d:\d\d/.test(retTime) ? retTime : "00:00";
      const retMomentMs = new Date(`${retDate}T${t0}:00`).getTime();
      if (Number.isFinite(retMomentMs) && retMomentMs > now) continue; // not due yet

      const renterDoc = await renterForReservation(ctx, base, maps);
      const t = trustOf(renterDoc);
      const hy = ((base as { hygglo_items?: Array<{ image_url?: string }> }).hygglo_items) ?? [];
      const imageUrl =
        hy.find((h) => h.image_url)?.image_url ??
        ((base as { photos_urls?: string[] }).photos_urls?.[0] ?? null);
      const itemNames = (() => {
        // Override-resolved component list (actual kit contents), not listing titles.
        const agg = new Map<string, number>();
        for (const m of members)
          for (const [id, qty] of reservationItemUnits(m as ResolvableRes, productIndex, overrideMap)) {
            if (stdAccIds.has(id)) continue;
            agg.set(id, (agg.get(id) ?? 0) + qty);
          }
        const out: string[] = [];
        for (const [id, qty] of agg) { const nm = itemNameById.get(id); if (nm) out.push(qty > 1 ? nm + " ×" + qty : nm); }
        if (out.length > 0) return out;
        // Fallback (marketing-only / unresolved): listing short-names then raw items.
        const names = new Set<string>();
        for (const m of members) {
          const hy = ((m as { hygglo_items?: Array<{ name?: string; product_id?: number }> }).hygglo_items) ?? [];
          let added = false;
          for (const h of hy) {
            const sn = h.product_id != null ? shortByProduct.get(`${m.account_slug}#${h.product_id}`) : undefined;
            if (sn) { names.add(sn); added = true; }
          }
          if (!added)
            for (const i of (m.items ?? []) as Array<{ item_name: string }>) names.add(i.item_name);
        }
        return Array.from(names);
      })();
      const assocItems = (() => {
        const m2 = new Map<string, { name: string; qty: number }>();
        for (const m of members) {
          for (const [id, qty] of reservationItemUnits(m as ResolvableRes, productIndex, overrideMap)) {
            const ex = m2.get(id);
            if (ex) ex.qty += qty;
            else m2.set(id, { name: itemNameById.get(id) ?? "item", qty });
          }
        }
        return Array.from(m2, ([item_id, v]) => ({ item_id, name: v.name, qty: v.qty }));
      })();
      results.push({
        reservationId: base._id,
        items: assocItems,
        memberIds: g.member_ids,
        memberCount: members.length,
        renterName: base.renter_name ?? "Unknown",
        itemNames,
        endDate: retDate,
        returnTime: retTime ?? null,
        isOverdue: retDate < today,
        accountSlug: base.account_slug,
        orderStep: (last as { order_step?: string }).order_step ?? null,
        imageUrl,
        renter: {
          blacklisted: t.blacklisted,
          whitelisted: t.whitelisted,
          blacklist_reason: t.blacklist_reason,
          total_rentals: t.total_rentals,
          rating: t.rating,
          note_count: t.note_count,
          notes: t.notes,
        },
      });
    }
    results.sort((a, b) => String(a.endDate).localeCompare(String(b.endDate)));
    return results;
  },
});

/**
 * W09 Conversation Funnel — counts by stage derived from reservations + denials
 */
export const getConversionFunnel = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
    _bypassMv: v.optional(v.boolean()),
  },
  handler: async (ctx, { accountSlug, days, _bypassMv }) => {
    if (!_bypassMv) {
      const accountKey = accountSlug ?? "all";
      const cached = await ctx.db
        .query("mv_conversion_funnel")
        .withIndex("by_account_days", (q) =>
          q.eq("account", accountKey).eq("days", days),
        )
        .first();
      if (cached) return cached.payload;
    }
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // When account-scoped, the by_account_slug index is the tightest filter.
    // Otherwise the by_start_date range index returns only rows on/after the
    // cutoff (rows with undefined start_date are excluded by the index range,
    // which is fine — the JS filter below dropped them anyway). The identical
    // `start_date >= cutoffStr` JS filter is applied in BOTH branches so the
    // final `recent` set matches the previous full-scan behaviour exactly.
    let reservations;
    if (accountSlug) {
      reservations = await ctx.db
        .query("reservations")
        .withIndex("by_account_slug", (q) => q.eq("account_slug", accountSlug))
        .collect();
    } else {
      reservations = await ctx.db
        .query("reservations")
        .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
        .collect();
    }
    const recent = reservations.filter(
      (r) => r.start_date !== undefined && r.start_date >= cutoffStr
    );

    const bookings = recent.filter(
      (r) => r.status === "confirmed" || r.status === "completed"
    ).length;

    // Conversations as proxy for inquiries
    let conversations = await ctx.db.query("conversations").collect();
    if (accountSlug) {
      const accountRow = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) =>
          q.eq("slug", accountSlug as string)
        )
        .first();
      if (accountRow) {
        conversations = conversations.filter(
          (c) => c.account_id === accountRow._id
        );
      }
    }
    const inquiries = conversations.filter(
      (c) => c._creationTime >= cutoff.getTime()
    ).length;

    let denials = await ctx.db.query("denial_records").collect();
    if (accountSlug) {
      const accountRow = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) =>
          q.eq("slug", accountSlug as string)
        )
        .first();
      if (accountRow) {
        denials = denials.filter((d) => d.account_id === accountRow._id);
      }
    }
    // ALL-TIME denial count, NOT windowed: denial_records are a one-shot bulk
    // import (all created_at = the import date, no true per-event date), so a
    // created_at window is meaningless AND would cliff the rate to 0 once the
    // import date ages past the window. conversionRate stays windowed below
    // (bookings + conversations have real dates); the denial rate is all-time.
    const recentDenials = denials.length;

    const responses = inquiries; // conversations == responses (no separate sent-count available)
    const conversionRate = inquiries > 0 ? bookings / inquiries : 0;
    // denial_records can exceed tracked conversations — an auto-declined Hygglo
    // request never opens a conversation thread, and a multi-item decline can
    // write several rows. So recentDenials/inquiries could exceed 1, which
    // surfaced a nonsensical ">100% denial rate" on the funnel tile AND in chat.
    // Bound it by the larger of inquiries or total decisions made, so the rate
    // is always 0–100% and degrades to denials/inquiries when the data is clean.
    const decisions = bookings + recentDenials;
    const denialBase = Math.max(inquiries, decisions);
    const denialRate = denialBase > 0 ? recentDenials / denialBase : 0;

    return {
      inquiries,
      responses,
      bookings,
      denials: recentDenials,
      conversionRate,
      denialRate,
    };
  },
});

/** W06 Return Hub — mark a reservation as returned. */
export const markReturned = mutation({
  args: {
    reservationId: v.id("reservations"),
    condition: v.string(),
    notes: v.optional(v.string()),
    issueDetails: v.optional(v.string()),
    blacklistRenter: v.optional(v.boolean()),
    blacklistReason: v.optional(v.string()),
    flagOnRequest: v.optional(v.boolean()),
    whitelist: v.optional(v.boolean()),
    whitelistReason: v.optional(v.string()),
    outcome: v.optional(v.string()),
    sendReview: v.optional(v.boolean()),
    goodTags: v.optional(v.array(v.string())),
    badTags: v.optional(v.array(v.string())),
    memberIds: v.optional(v.array(v.id("reservations"))),
  },
  handler: async (ctx, args) => {
    const { reservationId, condition, notes, issueDetails, blacklistRenter, blacklistReason, flagOnRequest, whitelist, whitelistReason, outcome, sendReview, goodTags, badTags, memberIds } = args;
    const cleanGood = (goodTags ?? []).map((t) => t.trim()).filter(Boolean);
    const cleanBad = (badTags ?? []).map((t) => t.trim()).filter(Boolean);
    const tagsNote = cleanGood.length || cleanBad.length
      ? `Return tags: good[${cleanGood.join(", ")}] bad[${cleanBad.join(", ")}]`
      : null;
    const res = await ctx.db.get(reservationId);
    if (!res) throw new Error("Reservation not found");
    // Double-click / re-submit: the reservation is already completed. This is a
    // benign no-op, NOT an error — return early so the UI doesn't surface a
    // scary "Already returned" banner. Genuine bad-input/not-found throws below
    // stay intact so they DO surface.
    if (res.status === "completed") {
      return { ok: true, alreadyCompleted: true, blacklisted: false, whitelisted: false, flagged: false, reviewQueued: false, platformClosePending: !!res.platform_close_pending };
    }
    const detail = issueDetails ?? notes;
    const cn = detail ? `Condition: ${condition}. ${detail}` : `Condition: ${condition}`;
    const base = res.notes ?? "";

    // Renter CRM doc — fetched up-front because the discount/review message is
    // SUPPRESSED for anyone currently flagged or blacklisted (operator rule
    // 2026-06-15: flagged/blacklisted renters are only marked returned on the
    // platform, never rewarded with a discount or review ask).
    const maps = await renterMaps(ctx);
    const renterDoc = await renterForReservation(ctx, res, maps);
    const alreadyBadActor = !!(
      renterDoc && (renterDoc.blacklisted || renterDoc.blacklist || renterDoc.flag_on_request)
    );

    // Post-rental message = the per-account discount + review-request copy
    // (LEO10OFF / DB15OFF). PREPARED ONLY — the actual send + platform close run
    // through the gated hygglo-write chokepoint (READ_ONLY by default) via the
    // return-finalize CLI, so nothing reaches a real renter / the platform yet.
    // Gated: good outcome only (sendReview), renter is NOT a current bad actor
    // and is NOT being flagged/blacklisted on THIS return, and the account has
    // defined copy (unknown account -> no message sent).
    const eligibleForMessage = !!sendReview && !alreadyBadActor && !blacklistRenter && !flagOnRequest;
    const reviewMessage = eligibleForMessage
      ? (discountMessageFor(res.account_slug) ?? undefined)
      : undefined;

    const resPatch: Record<string, unknown> = {
      status: "completed",
      notes: base ? `${base} | ${cn}` : cn,
      return_outcome: outcome ?? (condition === "good" ? "smooth" : "issues"),
      platform_close_pending: true,
    };
    if (cleanGood.length) resPatch.return_good_tags = cleanGood;
    if (cleanBad.length) resPatch.return_bad_tags = cleanBad;
    if (reviewMessage) resPatch.review_message = reviewMessage;
    await ctx.db.patch(reservationId, resPatch);

    // Merged logical rental: complete every member booking too.
    for (const mid of memberIds ?? []) {
      if (mid === reservationId) continue;
      const m = await ctx.db.get(mid);
      if (m && m.status !== "completed") {
        const mb = m.notes ?? "";
        const mPatch: Record<string, unknown> = { status: "completed", notes: mb ? `${mb} | ${cn}` : cn, platform_close_pending: true };
        if (cleanGood.length) mPatch.return_good_tags = cleanGood;
        if (cleanBad.length) mPatch.return_bad_tags = cleanBad;
        await ctx.db.patch(mid, mPatch);
      }
    }

    // Renter CRM — all REAL saves (blacklist / whitelist / flag / note log).
    const did = { blacklisted: false, whitelisted: false, flagged: false };
    if (renterDoc) {
      const log = [
        ...(renterDoc.note_log ?? []),
        { text: `Return (${condition})${detail ? ": " + detail : ""}`, at: Date.now(), source: "return-hub" },
      ];
      if (tagsNote) log.push({ text: tagsNote, at: Date.now(), source: "return-hub" });
      const patch: Record<string, unknown> = { note_log: log };
      if (blacklistRenter) {
        patch.blacklisted = true;
        patch.blacklist = true;
        patch.blacklist_reason = blacklistReason ?? `Damage on return (${condition})`;
        patch.blacklisted_at = Date.now();
        log.push({ text: `BLACKLISTED: ${blacklistReason ?? "damage on return"}`, at: Date.now(), source: "return-hub" });
        did.blacklisted = true;
      }
      if (flagOnRequest) {
        patch.flag_on_request = true;
        patch.flag_on_request_reason = detail ?? `Issue on return (${condition})`;
        patch.flag_on_request_at = Date.now();
        log.push({ text: `FLAGGED on next request: ${detail ?? "issue on return"}`, at: Date.now(), source: "return-hub" });
        did.flagged = true;
      }
      if (whitelist) {
        patch.whitelisted = true;
        patch.whitelist_reason = whitelistReason ?? "Fantastic rental";
        patch.whitelisted_at = Date.now();
        log.push({ text: `WHITELISTED${whitelistReason ? ": " + whitelistReason : ""}`, at: Date.now(), source: "return-hub" });
        did.whitelisted = true;
      }
      await ctx.db.patch(renterDoc._id, patch);
    }
    return { ok: true, ...did, reviewQueued: !!reviewMessage, platformClosePending: true };
  },
});

/**
 * Admin restore / undo of a return. Reverses `markReturned`: flips the
 * reservation (and any merged logical-group members) back from "completed" to
 * "confirmed" and CLEARS every return-side field so the rental re-appears in the
 * Return Hub (`getDueReturns`) and drops out of `pendingPlatformClose`.
 *
 * Use when a rental was marked returned but its Hygglo order was never actually
 * closed (platform_close_pending=true, platform_closed_at unset) and it now
 * needs to go back through the Return flow. This only mutates OUR Convex state —
 * it does NOT touch the Hygglo platform. Convex field-delete semantics: setting
 * an optional field to `undefined` removes it; `platform_close_pending` is set
 * to `false` so `pendingPlatformClose`'s truthiness filter excludes the row.
 */
export const adminMarkUnreturned = mutation({
  args: {
    reservationId: v.id("reservations"),
    memberIds: v.optional(v.array(v.id("reservations"))),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { reservationId, memberIds, reason }) => {
    const why = (reason ?? "manual restore").trim() || "manual restore";
    const restoreNote = `restored to return hub: ${why}`;

    const restoreOne = async (id: Id<"reservations">) => {
      const r = await ctx.db.get(id);
      if (!r) return false;
      // Only un-complete a completed row; leave anything else untouched so this
      // is a safe no-op on already-restored / never-completed members.
      if (r.status !== "completed") return false;
      const prev = r.notes ?? "";
      await ctx.db.patch(id, {
        status: "confirmed",
        platform_close_pending: false,
        platform_closed_at: undefined,
        return_outcome: undefined,
        review_message: undefined,
        notes: prev ? `${prev} | ${restoreNote}` : restoreNote,
      });
      return true;
    };

    const restored: string[] = [];
    if (await restoreOne(reservationId)) restored.push(String(reservationId));
    for (const mid of memberIds ?? []) {
      if (mid === reservationId) continue;
      if (await restoreOne(mid)) restored.push(String(mid));
    }

    // Mirror the restore into the renter's note_log (the real audit trail), so
    // the CRM shows why this rental went back into the Hub.
    const res = await ctx.db.get(reservationId);
    if (res) {
      const maps = await renterMaps(ctx);
      const renterDoc = await renterForReservation(ctx, res, maps);
      if (renterDoc) {
        const log = [
          ...(renterDoc.note_log ?? []),
          { text: restoreNote, at: Date.now(), source: "return-hub" },
        ];
        await ctx.db.patch(renterDoc._id, { note_log: log });
      }
    }

    return { ok: true as const, restored, count: restored.length };
  },
});

/**
 * Reservations marked returned in our system but not yet closed on the Hygglo
 * platform. Read-only feed for the return-finalize CLI (which is gated by
 * READ_ONLY_MODE — see src/lib/hygglo-write.ts).
 */
export const pendingPlatformClose = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_status", (q) => q.eq("status", "completed"))
      .collect();
    return rows
      .filter((r) => {
        const rr = r as { platform_close_pending?: boolean; platform_closed_at?: number };
        return rr.platform_close_pending && !rr.platform_closed_at && !!r.hygglo_order_id;
      })
      .map((r) => ({
        reservationId: r._id,
        account_slug: r.account_slug,
        hygglo_order_id: r.hygglo_order_id,
        review_message: (r as { review_message?: string }).review_message ?? null,
      }));
  },
});




/**
 * Stamp a reservation as closed on the Hygglo platform (idempotency guard for
 * the return-finalize CLI). Called ONLY after `returnOrder` actually succeeds on
 * the platform, so the row drops out of `pendingPlatformClose` and is never
 * re-marked / re-messaged on a subsequent run. Until writes go live the CLI runs
 * READ-ONLY (returnOrder -> skipped) and never calls this, so rows stay pending.
 */
export const markPlatformClosed = mutation({
  args: { reservationId: v.id("reservations") },
  handler: async (ctx, { reservationId }) => {
    const r = await ctx.db.get(reservationId);
    if (!r) return { ok: false as const };
    await ctx.db.patch(reservationId, { platform_closed_at: Date.now() });
    return { ok: true as const };
  },
});

/**
 * T4: listObsolete — cancelled/rejected orders (lost revenue / dead deals)
 */
export const listObsolete = internalQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    sinceTs: v.optional(v.number()),
  },
  handler: async (ctx, { paginationOpts, sinceTs }) => {
    const page = await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("is_obsolete"), true))
      .paginate(paginationOpts);
    const filtered = page.page.filter(
      (r) => !sinceTs || (r.v1_updated_at ?? r._creationTime) >= sinceTs,
    );
    const rows = await Promise.all(
      filtered.map(async (r) => {
        // Use the denormalized renter_name instead of an N+1 renter doc
        // point-read — only the display name was used.
        const renterName: string | null = r.renter_name ?? null;
        return {
          order_id: r.hygglo_order_id ?? null,
          account: r.account_slug ?? null,
          order_step: r.order_step ?? null,
          obsolete_reason: r.obsolete_reason ?? "other",
          renter_name: renterName,
          start_date: r.start_date ?? null,
          end_date: r.end_date ?? null,
          items: r.items ?? [],
          last_seen_at: r.v1_updated_at ?? r._creationTime,
        };
      }),
    );
    return {
      page: rows,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * T4: getPipelineCounts — aggregate active order counts per order_step
 */
export const getPipelineCounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("reservations").collect();
    const counts: Record<string, number> = {};
    for (const r of rows) {
      if (r.is_obsolete) continue;
      const step = r.order_step ?? "UNKNOWN";
      counts[step] = (counts[step] ?? 0) + 1;
    }
    const paidSteps = [
      "FUNDS_RESERVED",
      "VERIFIED",
      "BOOKED_AFTER_VERIFIED",
      "DELIVERED",
      "RETURNED",
    ];
    const paidCount = paidSteps.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
    const requestedCount = (counts["REQUEST"] ?? 0) + (counts["APPROVED"] ?? 0);
    return {
      perStep: counts,
      summary: {
        requested_unpaid: requestedCount,
        paid_active: paidCount,
        unknown: counts["UNKNOWN"] ?? 0,
      },
    };
  },
});

/**
 * Wave 2 Task 5: listForReconcile — projection-trimmed reservation rows for
 * hold reconciliation. Returns only the ~15 fields that
 * src/lib/reconcile-holds.ts:ReservationInput actually reads, not the full
 * 50KB rich payload (which includes raw Hygglo `order` JSON, photos_urls,
 * ai_decision blobs, notes, etc.).
 *
 * Pass 13a (2026-05-26): replaced `.filter().collect()` full-table scan
 * with `withIndex("by_account_slug")` lookup and explicit projection. Was
 * the largest single Convex-bandwidth cost source (~729 MB/day) — invoked
 * every 5 min from poll-hygglo.ts × 2 accounts.
 */
export const listForReconcile = query({
  args: { account_slug: v.string() },
  handler: async (ctx, { account_slug }) => {
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_account_slug", (q) => q.eq("account_slug", account_slug))
      .collect();
    return rows.map((r) => ({
      _id: r._id,
      hygglo_order_id: r.hygglo_order_id,
      account_slug: r.account_slug,
      start_date: r.start_date,
      end_date: r.end_date,
      pickup_date: (r as { pickup_date?: string }).pickup_date,
      return_date: (r as { return_date?: string }).return_date,
      order_step: r.order_step,
      status: r.status,
      is_obsolete: r.is_obsolete,
      items: r.items,
      resolved_items: (r as { resolved_items?: Array<{ item_id: string; qty?: number }> }).resolved_items,
      expanded_items: (r as { expanded_items?: Array<{ item_id: string; qty?: number }> }).expanded_items,
      renter_name: r.renter_name,
    }));
  },
});

// Lookup by Hygglo order ID (used by backfill scripts and reconciliation tools)
export const getByHygglo = query({
  args: { hygglo_order_id: v.string() },
  handler: async (ctx, { hygglo_order_id }) => {
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) =>
        q.eq("hygglo_order_id", hygglo_order_id)
      )
      .collect();
    return rows[0] ?? null;
  },
});

// Admin backfill mutation — direct status override with audit trail.
// Used for one-off corrections (e.g. v1-imported rows skipped by poller guard).
export const adminSetStatus = mutation({
  args: {
    reservation_id: v.id("reservations"),
    new_status: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, { reservation_id, new_status, reason }) => {
    const existing = await ctx.db.get(reservation_id);
    if (!existing) throw new Error(`Reservation ${reservation_id} not found`);
    const prev = existing.status;
    if (prev === new_status) return { reservation_id, prev, new_status, reason, skipped: true };
    await ctx.db.patch(reservation_id, { status: new_status });
    return { reservation_id, prev, new_status, reason, skipped: false };
  },
});

// B-3: list pending rentals for dashboard chat tool
// NOTE: Index-based filter replaced with full collect + permissive client-side filter
// because prod data has zero rows with status="pending_review". All 138 rows are
// legacy rows with order_step undefined. We must also match modern REQUEST/APPROVED
// order_step values and old "pending" status strings.
// Also match rows where booking_status === "pending_review" (captured from Hygglo since
// many "pending_review" orders have order_step=APPROVED already — renter approved by owner
// but renter hasn't paid yet).
export const listPending = internalQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    accountSlug: v.optional(v.string()),
    // verified_only=true keeps the strict dashboard semantics (escrow paid +
    // verifying). Default false matches chat expectations: "what's pending"
    // means the whole pre-handover pipeline (REQUEST / APPROVED /
    // FUNDS_RESERVED / VERIFIED). v1 chat returned ~15 items here; v2 was
    // returning 0 because nothing happens to be in VERIFIED right now.
    verified_only: v.optional(v.boolean()),
  },
  handler: async (ctx, { paginationOpts, accountSlug, verified_only }) => {
    // See convex/order_step_semantics.ts for full semantics.
    const PIPELINE = new Set(["REQUEST", "APPROVED", "FUNDS_RESERVED", "VERIFIED"]);
    const page = await ctx.db
      .query("reservations")
      .order("desc")
      .paginate(paginationOpts);
    let rows = page.page.filter((r) => {
      if (r.is_obsolete === true) return false;
      if (verified_only === true) return r.order_step === "VERIFIED";
      return r.order_step !== undefined && PIPELINE.has(r.order_step);
    });
    if (accountSlug) {
      rows = rows.filter((r) => r.account_slug === accountSlug);
    }
    const rentals = await Promise.all(
      rows.map(async (r) => {
        // Use the denormalized renter_name instead of an N+1 renter doc
        // point-read — only the display name was used.
        const renterName = r.renter_name ?? '';
        return {
          id: r._id,
          accountSlug: r.account_slug,
          item: (r.items ?? []).map((i) => i.item_name).join(', '),
          renter: renterName,
          start_date: r.start_date,
          end_date: r.end_date,
          gross: r.gross_paid_gbp ?? 0,
          order_step: r.order_step ?? null,
        };
      })
    );
    return {
      count: rentals.length,
      rentals,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * Fix D — Backfill: re-derive status from order_step for all existing rows.
 * Corrects ~10 rows wrongly tagged status=pending_review due to sourceFilter bug.
 */
export const adminFixStatusFromStep = mutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("reservations").collect();
    let fixed = 0;
    // v1 parity (app.service.ts:244): APPROVED-but-unpaid is a phantom. Only
    // FUNDS_RESERVED+ rows have money locked in and count as confirmed.
    const PENDING = new Set(["REQUEST", "APPROVED"]);
    const PAID = new Set(["FUNDS_RESERVED", "VERIFIED", "BOOKED_AFTER_VERIFIED", "DELIVERED"]);
    const COMPLETED = new Set(["RETURNED", "REVIEWED"]);
    const CANCELLED_STEPS = new Set(["CANCELED", "VERIFICATION_FAILED"]);
    for (const r of rows) {
      let newStatus: string | null = null;
      if (PENDING.has(r.order_step ?? "")) newStatus = "pending_review";
      else if (PAID.has(r.order_step ?? "")) newStatus = "confirmed";
      else if (COMPLETED.has(r.order_step ?? "")) newStatus = "completed";
      else if (CANCELLED_STEPS.has(r.order_step ?? "")) newStatus = "cancelled";
      if (newStatus && r.status !== newStatus) {
        await ctx.db.patch(r._id, { status: newStatus });
        fixed++;
      }
    }
    return { total: rows.length, fixed };
  },
});

/**
 * Mark status=confirmed rows whose end_date passed more than 1 day ago as
 * completed. Hygglo drops these orders from all filters once they wrap up,
 * so the poller never sees them again — but our local copy keeps the old
 * "confirmed" status forever, inflating the Active widget's ongoing count.
 * Idempotent. Safe to run on every cron after the poll.
 */
/** Internal-cron variant of adminCompleteStaleConfirmed (same body). */
export const completeStaleConfirmedCron = internalMutation({
  args: {},
  handler: async (ctx) => {
    const dateCutoff = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const freshThreshold = Date.now() - 2 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_status", (q) => q.eq("status", "confirmed"))
      .collect();
    let completed = 0;
    for (const r of rows) {
      if (r.status !== "confirmed") continue;
      if (r.is_obsolete) continue;
      if (!r.end_date) continue;
      if ((r.end_date as string) >= dateCutoff) continue;
      // Hygglo keeps rentals in `current` until owner verifies return. Skip rows
      // where gear is still with the renter (order_step ∈ {RETURNED, DELIVERED})
      // so we don't auto-demote them to `completed` and hide them from the
      // double-booking detector.
      if (r.order_step === "RETURNED" || r.order_step === "DELIVERED") continue;
      // 2026-05-20: don't auto-complete rows where the renter still has the gear.
      // Hygglo classifies DELIVERED/BOOKED_AFTER_VERIFIED rows as "current" until
      // marked returned/reviewed — they're not actually done.
      if (r.order_step === "BOOKED_AFTER_VERIFIED") continue;
      const lastPolled =
        (r as { last_polled_at?: number }).last_polled_at ??
        (r as { _creationTime?: number })._creationTime ??
        0;
      if (lastPolled >= freshThreshold) continue;
      await ctx.db.patch(r._id, { status: "completed" });
      completed++;
    }
    return { total: rows.length, completed };
  },
});

export const adminCompleteStaleConfirmed = mutation({
  args: {},
  handler: async (ctx) => {
    const dateCutoff = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    // last_polled_at older than 2 hours → Hygglo dropped the row from every
    // filter and the poller stopped refreshing it. Two hours is roughly four
    // poll cycles, giving plenty of buffer for a single missed run.
    const freshThreshold = Date.now() - 2 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_status", (q) => q.eq("status", "confirmed"))
      .collect();
    let completed = 0;
    for (const r of rows) {
      if (r.status !== "confirmed") continue;
      if (r.is_obsolete) continue;
      if (!r.end_date) continue;
      if ((r.end_date as string) >= dateCutoff) continue;
      // Hygglo keeps rentals in `current` until owner verifies return. Skip rows
      // where gear is still with the renter (order_step ∈ {RETURNED, DELIVERED})
      // so we don't auto-demote them to `completed` and hide them from the
      // double-booking detector.
      if (r.order_step === "RETURNED" || r.order_step === "DELIVERED") continue;
      // 2026-05-20: don't auto-complete rows where the renter still has the gear.
      // Hygglo classifies DELIVERED/BOOKED_AFTER_VERIFIED rows as "current" until
      // marked returned/reviewed — they're not actually done.
      if (r.order_step === "BOOKED_AFTER_VERIFIED") continue;
      const lastPolled =
        (r as { last_polled_at?: number }).last_polled_at ??
        (r as { _creationTime?: number })._creationTime ??
        0;
      if (lastPolled >= freshThreshold) continue; // poller saw it recently
      await ctx.db.patch(r._id, { status: "completed" });
      completed++;
    }
    return { total: rows.length, completed, dateCutoff, freshThreshold };
  },
});

/**
 * Patch missing rich fields (renter_name, order_step, photos_urls, etc.) on
 * an existing reservation, keyed by hygglo_order_id. Used by the
 * sync-from-exciting-lion-29 backfill script to repair rows the Trigger.dev
 * poller wrote to the wrong Convex deployment.
 *
 * Only fills BLANK fields — never overwrites already-populated values, so the
 * script is idempotent and safe to re-run.
 */
export const adminPatchRichFieldsByHyggloId = mutation({
  args: {
    hygglo_order_id: v.string(),
    renter_name: v.optional(v.string()),
    order_step: v.optional(v.string()),
    booking_status: v.optional(v.string()),
    pickup_time: v.optional(v.string()),
    return_time: v.optional(v.string()),
    pickup_date: v.optional(v.string()),
    photos_urls: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) =>
        q.eq("hygglo_order_id", args.hygglo_order_id),
      )
      .collect();
    let patched = 0;
    for (const r of rows) {
      const patch: Record<string, unknown> = {};
      if (args.renter_name && !r.renter_name) patch.renter_name = args.renter_name;
      if (args.order_step && !r.order_step) {
        const allowed = new Set([
          "REQUEST", "APPROVED", "FUNDS_RESERVED", "VERIFIED",
          "BOOKED_AFTER_VERIFIED", "DELIVERED", "RETURNED", "REVIEWED",
          "CANCELED", "VERIFICATION_FAILED",
        ]);
        if (allowed.has(args.order_step)) patch.order_step = args.order_step;
      }
      if (args.booking_status && !r.booking_status) patch.booking_status = args.booking_status;
      if (args.pickup_time && !r.pickup_time) patch.pickup_time = args.pickup_time;
      if (args.return_time && !r.return_time) patch.return_time = args.return_time;
      if (args.pickup_date && !r.pickup_date) patch.pickup_date = args.pickup_date;
      if (
        args.photos_urls &&
        args.photos_urls.length > 0 &&
        (!r.photos_urls || r.photos_urls.length === 0)
      ) {
        patch.photos_urls = args.photos_urls;
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(r._id, patch);
        patched++;
      }
    }
    return { rows: rows.length, patched };
  },
});

/**
 * Lightweight list of reservations missing rich fields, capped to the
 * dashboard window. Used by the backfill script to know which orders
 * to fetch from the source-of-truth deployment.
 */
export const adminListNeedsRichBackfill = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("reservations").collect();
    const missing: Array<{ hygglo_order_id: string; account_slug: string }> = [];
    for (const r of rows) {
      if (!r.hygglo_order_id) continue;
      const needs =
        !r.renter_name ||
        !r.order_step ||
        !r.photos_urls ||
        r.photos_urls.length === 0;
      if (needs) {
        missing.push({
          hygglo_order_id: r.hygglo_order_id,
          account_slug: r.account_slug ?? "",
        });
      }
    }
    return missing;
  },
});

/**
 * Wave 4 — Internal query consumed by the `hygglo_poll` Mastra workflow.
 *
 * Returns pending reservations that do NOT yet have a corresponding
 * `ai_decision` row (regardless of decision status). This is the net-new
 * surface for the AI decision step.
 */
export const listPendingWithoutDecision = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const pending = await ctx.db
      .query("reservations")
      .withIndex("by_status", (q) => q.eq("status", "pending_review"))
      .order("desc")
      .take(limit ?? 50);

    const out: typeof pending = [];
    for (const r of pending) {
      const decided = await ctx.db
        .query("ai_decision")
        .withIndex("by_reservation", (q) => q.eq("reservation_id", r._id))
        .first();
      if (!decided) out.push(r);
    }
    return out;
  },
});

/**
 * Phase 12.4 — patch hygglo_items[] / image_hints[] / photos_urls on an
 * existing reservation row by hygglo_order_id. Repopulates stuck rows
 * without going through upsertOrderAsReservation (which re-writes
 * `items: args.items` and trips the strict schema validator when the items
 * carry the PASS-10 `image` / `type` / `product_id` / `slug` shape).
 *
 * Also fires the listing_images write-through so the dashboard image bank
 * picks up product_ids on the same beat.
 */
export const patchHyggloItemsByOrderId = internalMutation({
  args: {
    account_slug: v.string(),
    hygglo_order_id: v.string(),
    hygglo_items: v.array(
      v.object({
        name: v.string(),
        image_url: v.union(v.string(), v.null()),
        type: v.string(),
        qty: v.optional(v.number()),
        product_id: v.optional(v.number()),
        slug: v.optional(v.string()),
      }),
    ),
    image_hints: v.optional(
      v.array(
        v.object({
          item_name: v.string(),
          item_name_normalised: v.string(),
          image_url: v.string(),
          source: v.union(
            v.literal("hygglo_per_item"),
            v.literal("hygglo_order"),
            v.literal("manual_override"),
          ),
          captured_at: v.number(),
        }),
      ),
    ),
    photos_urls: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) =>
        q.eq("hygglo_order_id", args.hygglo_order_id),
      )
      .collect();
    let patched = 0;
    for (const r of rows) {
      if (r.account_slug && r.account_slug !== args.account_slug) continue;
      const patch: Record<string, unknown> = {
        hygglo_items: args.hygglo_items,
        last_polled_at: Date.now(),
      };
      if (args.image_hints && args.image_hints.length > 0)
        patch.image_hints = args.image_hints;
      if (args.photos_urls && args.photos_urls.length > 0)
        patch.photos_urls = args.photos_urls;
      await ctx.db.patch(r._id, patch);
      patched++;
    }
    return { rows: rows.length, patched };
  },
});

/**
 * Phase 12.4 — list ACTIVE reservations whose hygglo_items[] are missing
 * product_id (i.e. rows polled before PASS-10 landed).
 */
export const listStuckActive = internalQuery({
  args: {},
  handler: async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await ctx.db.query("reservations").collect();
    return rows
      .filter((r) => {
        if (r.status !== "confirmed") return false;
        if (r.is_obsolete === true) return false;
        if (!r.end_date || (r.end_date as string) < today) return false;
        if (!r.hygglo_order_id || !r.account_slug) return false;
        const hi = (r as any).hygglo_items as Array<any> | undefined;
        if (!Array.isArray(hi) || hi.length === 0) return false;
        return hi.some(
          (h) => h == null || h.product_id == null || h.image_url == null,
        );
      })
      .map((r) => ({
        _id: r._id,
        hygglo_order_id: r.hygglo_order_id as string,
        account_slug: r.account_slug as string,
      }));
  },
});
