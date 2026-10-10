import { v } from "convex/values";
import {websiteSwapSnapshot} from "./lib/quick_reply_swap";
import { action, requireOwner } from "./owner_functions";
import { internal } from "./_generated/api";

type RenterTrustReview = { id: string; rating: number | null; text: string | null; author: string | null; created_at: string | null };
type LinkedRenterReviews = { reviews: RenterTrustReview[]; lowCount: number; fetched: boolean; unavailable: boolean };

type RemoteResult<T> = { status?: string; value?: T; errorMessage?: string };

export async function callDbCinema<T>(kind: "query" | "mutation", path: string, args: unknown): Promise<T> {
  const url = process.env.DBCINEMA_CONVEX_URL;
  const token = process.env.DBCINEMA_ADMIN_TOKEN;
  if (!url || !token) throw new Error("DB Cinema chat is not configured.");

  const response = await fetch(`${url.replace(/\/$/, "")}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { ...(args as object), token }, format: "json" }),
    signal: AbortSignal.timeout(15_000),
  });
  let result: RemoteResult<T>;
  try {
    result = (await response.json()) as RemoteResult<T>;
  } catch {
    throw new Error("DB Cinema returned an unreadable chat response.");
  }
  if (!response.ok || result.status !== "success") {
    // Keep provider details out of the browser; in particular, never echo a
    // remote validation response that could include submitted message text.
    throw new Error("DB Cinema chat is temporarily unavailable.");
  }
  return result.value as T;
}

/** Owner-authenticated, bounded read of DB Cinema rental conversations. */
export const inbox = action({
  args: {},
  handler: async (ctx): Promise<Array<Record<string, unknown>>> => {
    await requireOwner(ctx, true);
    const feed = await callDbCinema<{
      authorized?: boolean;
      items?: Array<{
        _id: string;
        accountId?: string | null;
        name?: string | null;
        renterPhoto?: string | null;
        verifiedRenterEmail?: string | null;
        status?: string | null;
        idVerifyStatus?: string | null;
        start?: number;
        end?: number;
        total?: number;
        items?: Array<{
          name?: string;
          qty?: number;
          heroImage?: string | null;
          stockAvailability?: {
            availableUnits?: number;
            ownedUnits?: number;
            requestedQty?: number;
            available?: boolean;
            blocked?: boolean;
          } | null;
        }>;
        escalated?: boolean;
        unreadOwner?: number;
        lastMessage?: string | null;
        lastSender?: string | null;
        updatedAt?: number;
      }>;
    }>("query", "rentalChat:adminInbox", {});

    if (!feed?.authorized || !Array.isArray(feed.items)) {
      throw new Error("DB Cinema did not authorize the chat inbox.");
    }

    const recentChats = feed.items
      .filter((booking) =>
        !!booking._id &&
        !!booking.accountId &&
        typeof booking.lastMessage === "string" &&
        booking.lastMessage.trim().length > 0 &&
        Number.isFinite(booking.updatedAt),
      )
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 100);
    const earnings = await ctx.runQuery(internal.replyInbox.dbCinemaReservationEarnings, {
      bookingIds: recentChats.map((booking) => booking._id),
    }) as Array<{ bookingId: string; net_to_owner_gbp: number | null; gross_paid_gbp: number | null; currency: string }>;
    const trustSummaries = await ctx.runQuery(internal.replyInbox.dbCinemaRenterTrustByEmails, {
      emails: recentChats.flatMap((booking) => booking.verifiedRenterEmail ? [booking.verifiedRenterEmail] : []),
    }) as Array<{
      email: string; renter_identity: string | null; rating: number | null;
      review_count: number | null; blacklisted: boolean; flagged: boolean;
    }>;
    const earningsById = new Map(earnings.map((entry) => [entry.bookingId, entry]));
    const trustByEmail = new Map(trustSummaries.map((entry) => [entry.email, entry]));

    return recentChats.map((booking) => {
      const money = earningsById.get(booking._id);
      const trust = booking.verifiedRenterEmail
        ? trustByEmail.get(booking.verifiedRenterEmail.trim().toLowerCase())
        : undefined;
      const availabilityItems = (booking.items ?? []).flatMap((item) => {
        const stock = item.stockAvailability;
        if (!stock || typeof stock.available !== "boolean") return [];
        const requested = Number.isSafeInteger(stock.requestedQty) && (stock.requestedQty ?? 0) > 0
          ? stock.requestedQty!
          : Number.isSafeInteger(item.qty) && (item.qty ?? 0) > 0 ? item.qty! : 1;
        const free = Number.isSafeInteger(stock.availableUnits) && (stock.availableUnits ?? 0) >= 0 ? stock.availableUnits! : 0;
        const total = Number.isSafeInteger(stock.ownedUnits) && (stock.ownedUnits ?? 0) >= 0 ? stock.ownedUnits! : 0;
        return [{
          name: item.name?.trim() || "Rental item",
          requested,
          total_units: total,
          booked: Math.max(0, total - free),
          pending: 0,
          free,
          available: stock.available,
        }];
      });
      const availability = availabilityItems.length
        ? {
            status: availabilityItems.every((item) => item.available) ? "available" as const : "conflict" as const,
            include_pending: true,
            items: availabilityItems,
          }
        : null;
      return {
        booking_id: booking._id,
        source_booking_id: booking._id,
        thread_id: `dbcinema:${booking._id}`,
        source: "dbcinema_web" as const,
        account_slug: "dbcinema_web",
        renter_name: booking.name?.trim() || "DB Cinema renter",
        renter_image_url: booking.renterPhoto ?? null,
        renter_identity: trust?.renter_identity ?? `dbcinema:${booking.accountId}`,
        verification_status: booking.idVerifyStatus ?? "required",
        renter_rating: trust?.rating ?? null,
        renter_review_count: trust?.review_count ?? null,
        renter_rating_source: trust?.renter_identity ? "hygglo" as const : null,
        renter_blacklisted: trust?.blacklisted ?? false,
        renter_flagged: trust?.flagged ?? false,
        status: booking.status ?? "Rental",
        start_at: booking.start ?? null,
        end_at: booking.end ?? null,
        total_gbp: typeof booking.total === "number" ? booking.total : null,
        net_to_owner_gbp: money?.net_to_owner_gbp ?? null,
        estimate_earnings_gbp: money?.net_to_owner_gbp ?? null,
        gross_paid_gbp: money?.gross_paid_gbp ?? null,
        currency: money?.currency ?? "GBP",
        items: (booking.items ?? []).map((item) => ({
          name: item.name?.trim() || "Rental item",
          qty: Number.isSafeInteger(item.qty) && (item.qty ?? 0) > 0 ? item.qty! : 1,
          image_url: item.heroImage ?? null,
        })),
        unread_owner: booking.unreadOwner ?? 0,
        last_message: booking.lastMessage!,
        last_sender: booking.lastSender ?? null,
        last_renter_msg_at: booking.updatedAt!,
        last_activity_at: booking.updatedAt!,
        last_msg_at: booking.updatedAt!,
        preview: booking.lastMessage!,
        kind: booking.status === "pending_payment" ? "request" as const : "message" as const,
        is_request: false,
        has_reservation: true,
        can_decide: false,
        can_accept: false,
        can_deny: false,
        start_date: booking.start ? new Date(booking.start).toISOString().slice(0, 10) : null,
        end_date: booking.end ? new Date(booking.end).toISOString().slice(0, 10) : null,
        return_date: booking.end ? new Date(booking.end).toISOString().slice(0, 10) : null,
        order_step: null,
        booking_status: booking.status ?? null,
        pickup_method: null,
        delivery_fee_gbp: null,
        estimate_gbp: null,
        estimate_days: null,
        availability,
        item_count: (booking.items ?? []).length,
        image_url: booking.items?.find((item) => item.heroImage)?.heroImage ?? null,
        has_draft: false,
        ai_draft_text: null,
        ai_draft_confidence: null,
        ai_draft_flags: null,
        location: null,
        updated_at: booking.updatedAt!,
      };
    });
  },
});

/** Gets renter trust reviews only through a verified, unique email match. */
export const renterReviews = action({
  args: { booking_id: v.string() },
  handler: async (ctx, { booking_id }): Promise<LinkedRenterReviews> => {
    await requireOwner(ctx, true);
    const identity = await callDbCinema<{ authorized?: boolean; email?: string | null }>(
      "query", "rentalChat:adminRenterIdentity", { bookingId: booking_id },
    );
    if (!identity?.authorized || !identity.email) {
      return { reviews: [], lowCount: 0, fetched: false, unavailable: true };
    }
    let details = await ctx.runQuery(internal.replyInbox.dbCinemaRenterTrustDetails, { email: identity.email });
    if (!details.linked) return { reviews: [], lowCount: 0, fetched: false, unavailable: true };
    if (details.thread_id) {
      try {
        await ctx.runAction(internal.renter_trust.__service_resolveForThread, { thread_id: details.thread_id });
        details = await ctx.runQuery(internal.replyInbox.dbCinemaRenterTrustDetails, { email: identity.email });
      } catch {
        // Keep the owner's review panel usable with cached verified trust if the
        // upstream order detail is temporarily unavailable.
      }
    }
    return {
      reviews: details.linked ? details.reviews : [],
      lowCount: details.linked ? details.lowCount : 0,
      fetched: details.linked && details.reviews.length > 0,
      unavailable: !details.linked,
    };
  },
});

/** Fetches the selected DB Cinema rental thread without exposing its admin token. */
export const thread = action({
  args: { booking_id: v.string() },
  handler: async (ctx, { booking_id }) => {
    await requireOwner(ctx, true);
    const page = await callDbCinema<{
      page?: Array<{ _id: string; sender: string; text: string; at: number }>;
      escalated?: boolean;
    }>("query", "rentalChat:messages", {
      bookingId: booking_id,
      admin: true,
      paginationOpts: { numItems: 40, cursor: null },
    });
    if (!page || !Array.isArray(page.page)) throw new Error("DB Cinema chat history is unavailable.");
    return {
      escalated: !!page.escalated,
      messages: page.page
        .slice()
        .reverse()
        .map((message) => ({
          id: message._id,
          role: message.sender === "owner" ? "owner" as const : "renter" as const,
          content: message.text,
          timestamp: message.at,
        })),
    };
  },
});

/** Sends through DB Cinema's own rental chat mutation so the renter sees it there. */
export const sendOwnerReply = action({
  args: { booking_id: v.string(), text: v.string() },
  handler: async (ctx, { booking_id, text }) => {
    await requireOwner(ctx, true);
    const body = text.trim();
    if (!body || body.length > 2000) throw new Error("Write a message of up to 2,000 characters.");
    const result = await callDbCinema<{ ok?: boolean }>("mutation", "rentalChat:sendOwner", {
      bookingId: booking_id,
      text: body,
    });
    if (!result?.ok) throw new Error("DB Cinema did not accept the reply.");
    return { ok: true };
  },
});

/** Grounded, unsent draft using the selected DB Cinema conversation context. */
export const draftReply = action({
  args: { booking_id: v.string() },
  handler: async (ctx, { booking_id }) => {
    await requireOwner(ctx, true);
    const [feed, page] = await Promise.all([
      callDbCinema<{ authorized?: boolean; items?: Array<Record<string, unknown>> }>("query", "rentalChat:adminInbox", {}),
      callDbCinema<{ page?: Array<{ sender: string; text: string; at: number }> }>("query", "rentalChat:messages", {
        bookingId: booking_id, admin: true, paginationOpts: { numItems: 40, cursor: null },
      }),
    ]);
    if (!feed?.authorized || !Array.isArray(feed.items) || !Array.isArray(page?.page)) throw new Error("DB Cinema draft context is unavailable.");
    const booking = feed.items.find((row) => row._id === booking_id);
    if (!booking) throw new Error("DB Cinema rental was not found.");
    const base = process.env.NOTIF_BASE_URL ?? "https://rental-manager-v2-nu.vercel.app";
    const secret = process.env.RENTER_BOT_API_SECRET;
    if (!secret) throw new Error("AI reply drafts are not configured.");
    const response = await fetch(`${base.replace(/\/$/, "")}/api/dbcinema-chat-draft`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        renter_name: booking.name,
        booking: { status: booking.status, start: booking.start, end: booking.end, items: booking.items },
        messages: page.page.slice().reverse().map((message) => ({ role: message.sender === "owner" ? "owner" : "renter", text: message.text, at: message.at })),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("AI reply draft is temporarily unavailable.");
    const result = await response.json() as { draft?: string };
    if (typeof result.draft !== "string" || !result.draft.trim()) throw new Error("AI returned an empty reply draft.");
    return { draft: result.draft.trim() };
  },
});

/** Replacement reads and explicit operator acceptance stay behind the server bridge. */
export const replacementOptions=action({args:{booking_id:v.string(),item_index:v.number()},handler:async(ctx,a)=>{
  await requireOwner(ctx,true);
  return await callDbCinema<any>("query","rentalReplacements:options",{bookingId:a.booking_id,lineIndex:a.item_index});
}});
export const acceptReplacement=action({args:{booking_id:v.string(),replacement_id:v.string(),original:v.any(),request_id:v.string(),dryRun:v.optional(v.boolean())},handler:async(ctx,a)=>{
  await requireOwner(ctx,true);
  if(a.dryRun){
    const fresh=await callDbCinema<any>("query","rentalReplacements:options",{bookingId:a.booking_id,lineIndex:a.original.lineIndex});
    const candidate=fresh.options.find((i:any)=>i.id===a.replacement_id);
    if(!candidate?.can_apply||websiteSwapSnapshot(candidate.original)!==websiteSwapSnapshot(a.original))throw Error("Kit or availability changed. Refresh the replacement choices.");
    return {ok:true,dryRun:true};
  }
  return await callDbCinema<any>("mutation","rentalReplacements:accept",{bookingId:a.booking_id,requestId:a.request_id,lineIndex:a.original.lineIndex,oldListingId:a.original.listingId,newListingId:a.replacement_id,qty:a.original.qty,start:a.original.start,end:a.original.end});
}});
