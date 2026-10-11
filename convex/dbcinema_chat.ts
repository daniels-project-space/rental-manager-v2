import { v } from "convex/values";
import {
  basketSwapSnapshot,
  websiteSwapSnapshot,
} from "./lib/quick_reply_swap";
import { action, requireOwner } from "./owner_functions";
import { internal } from "./_generated/api";

type RenterTrustReview = {
  id: string;
  rating: number | null;
  text: string | null;
  author: string | null;
  created_at: string | null;
};
type LinkedRenterReviews = {
  reviews: RenterTrustReview[];
  lowCount: number;
  fetched: boolean;
  unavailable: boolean;
};

type RemoteResult<T> = {
  status?: string;
  value?: T;
  errorMessage?: string;
  errorData?: { code?: string };
};
class EquipmentReviewChanged extends Error {
  constructor() {
    super(
      "The rental or equipment quote changed. Review the current kit again.",
    );
  }
}

export async function callDbCinema<T>(
  kind: "query" | "mutation" | "action",
  path: string,
  args: unknown,
): Promise<T> {
  const url = process.env.DBCINEMA_CONVEX_URL;
  const token = process.env.DBCINEMA_ADMIN_TOKEN;
  if (!url || !token) throw new Error("DB Cinema chat is not configured.");

  const response = await fetch(`${url.replace(/\/$/, "")}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path,
      args: { ...(args as object), token },
      format: "json",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  let result: RemoteResult<T>;
  try {
    result = (await response.json()) as RemoteResult<T>;
  } catch {
    throw new Error("DB Cinema returned an unreadable chat response.");
  }
  if (!response.ok || result.status !== "success") {
    if (result.errorData?.code === "EQUIPMENT_REVIEW_STALE")
      throw new EquipmentReviewChanged();
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
    await requireOwner(ctx);
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
        verificationArchiveReady?: boolean;
        verificationUpdatedAt?: number | null;
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
        requestedGearTexts?: string[];
        searchText?: string;
        createdAt?: number;
        updatedAt?: number;
      }>;
    }>("query", "rentalChat:adminInbox", {});

    if (!feed?.authorized || !Array.isArray(feed.items)) {
      throw new Error("DB Cinema did not authorize the chat inbox.");
    }

    const recentChats = feed.items
      .filter(
        (booking) =>
          !!booking._id &&
          !!booking.accountId &&
          typeof booking.lastMessage === "string" &&
          booking.lastMessage.trim().length > 0 &&
          Number.isFinite(booking.updatedAt),
      )
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 100);
    const earnings = (await ctx.runQuery(
      internal.replyInbox.dbCinemaReservationEarnings,
      {
        bookingIds: recentChats.map((booking) => booking._id),
      },
    )) as Array<{
      bookingId: string;
      net_to_owner_gbp: number | null;
      gross_paid_gbp: number | null;
      currency: string;
    }>;
    const trustSummaries = (await ctx.runQuery(
      internal.replyInbox.dbCinemaRenterTrustByEmails,
      {
        emails: recentChats.flatMap((booking) =>
          booking.verifiedRenterEmail ? [booking.verifiedRenterEmail] : [],
        ),
      },
    )) as Array<{
      email: string;
      renter_identity: string | null;
      rating: number | null;
      review_count: number | null;
      blacklisted: boolean;
      flagged: boolean;
    }>;
    const imageContexts = await ctx.runQuery(
      internal.replyInbox.dbCinemaRequestedImages,
      {
        requests: recentChats.map((booking) => ({
          id: booking._id,
          items: (booking.items ?? []).map((item) => ({
            name: item.name?.trim() || "Rental item",
            qty: item.qty ?? 1,
            image_url: item.heroImage ?? null,
          })),
          texts:
            booking.requestedGearTexts ??
            (booking.lastSender === "renter"
              ? [booking.lastMessage ?? ""]
              : []),
        })),
      },
    );
    const imagesById = new Map(
      imageContexts.map((row: any) => [row.id, row.items]),
    );
    const earningsById = new Map(
      earnings.map((entry) => [entry.bookingId, entry]),
    );
    const trustByEmail = new Map(
      trustSummaries.map((entry) => [entry.email, entry]),
    );

    return recentChats.map((booking) => {
      const money = earningsById.get(booking._id);
      const trust = booking.verifiedRenterEmail
        ? trustByEmail.get(booking.verifiedRenterEmail.trim().toLowerCase())
        : undefined;
      const availabilityItems = (booking.items ?? []).map(
        (item, item_index) => {
          const stock = item.stockAvailability;
          if (!stock || typeof stock.available !== "boolean")
            return {
              item_index,
              name: item.name?.trim() || "Rental item",
              requested: item.qty ?? 1,
              total_units: 0,
              booked: 0,
              pending: 0,
              free: 0,
              available: null,
              reason: "Website stock check needs review",
            };
          const requested =
            Number.isSafeInteger(stock.requestedQty) &&
            (stock.requestedQty ?? 0) > 0
              ? stock.requestedQty!
              : Number.isSafeInteger(item.qty) && (item.qty ?? 0) > 0
                ? item.qty!
                : 1;
          const free =
            Number.isSafeInteger(stock.availableUnits) &&
            (stock.availableUnits ?? 0) >= 0
              ? stock.availableUnits!
              : 0;
          const total =
            Number.isSafeInteger(stock.ownedUnits) &&
            (stock.ownedUnits ?? 0) >= 0
              ? stock.ownedUnits!
              : 0;
          return {
            item_index,
            name: item.name?.trim() || "Rental item",
            requested,
            total_units: total,
            booked: Math.max(0, total - free),
            pending: 0,
            free,
            available: stock.available,
          };
        },
      );
      // A checked subset never proves the full basket is available.
      const completeStock =
        availabilityItems.length === (booking.items?.length ?? 0) &&
        availabilityItems.length > 0 &&
        availabilityItems.every((item) => typeof item.available === "boolean");
      const hasConflict = availabilityItems.some(
        (item) => item.available === false,
      );
      const availability = {
        status: hasConflict
          ? ("conflict" as const)
          : completeStock
            ? ("available" as const)
            : ("unknown" as const),
        include_pending: true,
        checked_at: Date.now(),
        items: availabilityItems,
        ...(!hasConflict && !completeStock
          ? { reason: "Full basket needs a stock review" }
          : {}),
      };
      return {
        booking_id: booking._id,
        source_booking_id: booking._id,
        thread_id: `dbcinema:${booking._id}`,
        source: "dbcinema_web" as const,
        account_slug: "dbcinema_web",
        renter_name: booking.name?.trim() || "DB Cinema renter",
        renter_image_url: booking.renterPhoto ?? null,
        renter_identity:
          trust?.renter_identity ?? `dbcinema:${booking.accountId}`,
        verification_status: booking.idVerifyStatus ?? "required",
        paid: [
          "confirmed",
          "active",
          "ongoing",
          "returned",
          "completed",
        ].includes(booking.status ?? ""),
        verification_started:
          [
            "processing",
            "requires_input",
            "manual_review",
            "submitted",
            "pending",
            "in_review",
            "verified",
          ].includes(booking.idVerifyStatus ?? "") &&
          !!booking.verificationUpdatedAt,
        platform_booking_confirmed:
          ["confirmed", "active", "ongoing", "returned", "completed"].includes(
            booking.status ?? "",
          ) &&
          booking.idVerifyStatus === "verified" &&
          booking.verificationArchiveReady === true,
        renter_rating: trust?.rating ?? null,
        renter_review_count: trust?.review_count ?? null,
        renter_rating_source: trust?.renter_identity
          ? ("hygglo" as const)
          : null,
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
          qty:
            Number.isSafeInteger(item.qty) && (item.qty ?? 0) > 0
              ? item.qty!
              : 1,
          image_url: item.heroImage ?? null,
        })),
        requested_items: imagesById.get(booking._id) ?? [],
        unread_owner: booking.unreadOwner ?? 0,
        last_message: booking.lastMessage!,
        last_sender: booking.lastSender ?? null,
        last_renter_msg_at: booking.updatedAt!,
        request_created_at: booking.createdAt ?? null,
        last_activity_at: booking.updatedAt!,
        last_msg_at: booking.updatedAt!,
        preview: booking.lastMessage!,
        search_text: (
          booking.searchText ??
          (booking.requestedGearTexts ?? [booking.lastMessage ?? ""]).join(" ")
        ).slice(0, 12000),
        kind:
          booking.status === "pending_payment"
            ? ("request" as const)
            : ("message" as const),
        is_request: false,
        has_reservation: true,
        can_decide: false,
        can_accept: false,
        can_deny: false,
        start_date: booking.start
          ? new Date(booking.start).toISOString().slice(0, 10)
          : null,
        end_date: booking.end
          ? new Date(booking.end).toISOString().slice(0, 10)
          : null,
        return_date: booking.end
          ? new Date(booking.end).toISOString().slice(0, 10)
          : null,
        order_step: null,
        booking_status: booking.status ?? null,
        pickup_method: null,
        delivery_fee_gbp: null,
        estimate_gbp: null,
        estimate_days: null,
        availability,
        item_count: (booking.items ?? []).length,
        image_url:
          booking.items?.find((item) => item.heroImage)?.heroImage ?? null,
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
    await requireOwner(ctx);
    const identity = await callDbCinema<{
      authorized?: boolean;
      email?: string | null;
    }>("query", "rentalChat:adminRenterIdentity", { bookingId: booking_id });
    if (!identity?.authorized || !identity.email) {
      return { reviews: [], lowCount: 0, fetched: false, unavailable: true };
    }
    let details = await ctx.runQuery(
      internal.replyInbox.dbCinemaRenterTrustDetails,
      { email: identity.email },
    );
    if (!details.linked)
      return { reviews: [], lowCount: 0, fetched: false, unavailable: true };
    if (details.thread_id) {
      try {
        await ctx.runAction(internal.renter_trust.__service_resolveForThread, {
          thread_id: details.thread_id,
        });
        details = await ctx.runQuery(
          internal.replyInbox.dbCinemaRenterTrustDetails,
          { email: identity.email },
        );
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
    await requireOwner(ctx);
    const page = await callDbCinema<{
      page?: Array<{ _id: string; sender: string; text: string; at: number }>;
      escalated?: boolean;
    }>("query", "rentalChat:messages", {
      bookingId: booking_id,
      admin: true,
      paginationOpts: { numItems: 40, cursor: null },
    });
    if (!page || !Array.isArray(page.page))
      throw new Error("DB Cinema chat history is unavailable.");
    return {
      escalated: !!page.escalated,
      messages: page.page
        .slice()
        .reverse()
        .map((message) => ({
          id: message._id,
          role:
            message.sender === "owner"
              ? ("owner" as const)
              : ("renter" as const),
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
    await requireOwner(ctx);
    const body = text.trim();
    if (!body || body.length > 2000)
      throw new Error("Write a message of up to 2,000 characters.");
    const result = await callDbCinema<{ ok?: boolean }>(
      "mutation",
      "rentalChat:sendOwner",
      {
        bookingId: booking_id,
        text: body,
      },
    );
    if (!result?.ok) throw new Error("DB Cinema did not accept the reply.");
    return { ok: true };
  },
});

/** Grounded, unsent draft using the selected DB Cinema conversation context. */
export const draftReply = action({
  args: { booking_id: v.string() },
  handler: async (ctx, { booking_id }) => {
    await requireOwner(ctx);
    const [feed, page] = await Promise.all([
      callDbCinema<{
        authorized?: boolean;
        items?: Array<Record<string, unknown>>;
      }>("query", "rentalChat:adminInbox", {}),
      callDbCinema<{
        page?: Array<{ sender: string; text: string; at: number }>;
      }>("query", "rentalChat:messages", {
        bookingId: booking_id,
        admin: true,
        paginationOpts: { numItems: 40, cursor: null },
      }),
    ]);
    if (
      !feed?.authorized ||
      !Array.isArray(feed.items) ||
      !Array.isArray(page?.page)
    )
      throw new Error("DB Cinema draft context is unavailable.");
    const booking = feed.items.find((row) => row._id === booking_id);
    if (!booking) throw new Error("DB Cinema rental was not found.");
    const base =
      process.env.NOTIF_BASE_URL ?? "https://rental-manager-v2-nu.vercel.app";
    const secret = process.env.RENTER_BOT_API_SECRET;
    if (!secret) throw new Error("AI reply drafts are not configured.");
    const response = await fetch(
      `${base.replace(/\/$/, "")}/api/dbcinema-chat-draft`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          renter_name: booking.name,
          booking: {
            status: booking.status,
            start: booking.start,
            end: booking.end,
            items: booking.items,
          },
          messages: page.page
            .slice()
            .reverse()
            .map((message) => ({
              role: message.sender === "owner" ? "owner" : "renter",
              text: message.text,
              at: message.at,
            })),
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error("AI reply draft is temporarily unavailable.");
    const result = (await response.json()) as { draft?: string };
    if (typeof result.draft !== "string" || !result.draft.trim())
      throw new Error("AI returned an empty reply draft.");
    return { draft: result.draft.trim() };
  },
});

/** Replacement reads and explicit operator acceptance stay behind the server bridge. */
export const replacementOptions = action({
  args: { booking_id: v.string(), item_index: v.number() },
  handler: async (ctx, a) => {
    await requireOwner(ctx);
    return await callDbCinema<any>("query", "rentalReplacements:options", {
      bookingId: a.booking_id,
      lineIndex: a.item_index,
    });
  },
});
export const acceptReplacement = action({
  args: {
    booking_id: v.string(),
    replacement_id: v.string(),
    original: v.any(),
    request_id: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    await requireOwner(ctx);
    if (a.dryRun) {
      const fresh = await callDbCinema<any>(
        "query",
        "rentalReplacements:options",
        { bookingId: a.booking_id, lineIndex: a.original.lineIndex },
      );
      const candidate = fresh.options.find(
        (i: any) => i.id === a.replacement_id,
      );
      if (
        !candidate?.can_apply ||
        websiteSwapSnapshot(candidate.original) !==
          websiteSwapSnapshot(a.original)
      )
        throw Error(
          "Kit or availability changed. Refresh the replacement choices.",
        );
      return { ok: true, dryRun: true };
    }
    return await callDbCinema<any>("mutation", "rentalReplacements:accept", {
      bookingId: a.booking_id,
      requestId: a.request_id,
      lineIndex: a.original.lineIndex,
      oldListingId: a.original.listingId,
      newListingId: a.replacement_id,
      qty: a.original.qty,
      start: a.original.start,
      end: a.original.end,
    });
  },
});

export const replacementBasketOptions = action({
  args: { booking_id: v.string() },
  handler: async (ctx, a): Promise<any> => {
    await requireOwner(ctx);
    const result = await callDbCinema<any>("query", "rentalReplacements:basketOptions", {
      bookingId: a.booking_id,
    });
    const withImages = (item: any) => {
      const image_urls = equipmentImages([item.image_url, ...(item.image_urls ?? [])]);
      return { ...item, image_url: image_urls[0] ?? null, image_urls };
    };
    return {
      ...result,
      originals: result.originals?.map(withImages),
      options: result.options?.map((choice: any) => ({
        ...withImages(choice),
        items: choice.items?.map(withImages),
      })),
    };
  },
});
export const acceptReplacementBasket = action({
  args: {
    booking_id: v.string(),
    replacement_id: v.string(),
    original: v.any(),
    request_id: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<any> => {
    await requireOwner(ctx);
    if (a.dryRun) {
      const fresh = await callDbCinema<any>(
        "query",
        "rentalReplacements:basketOptions",
        { bookingId: a.booking_id },
      );
      const choice = fresh.options.find(
        (item: any) => item.id === a.replacement_id,
      );
      if (
        !choice?.can_apply ||
        basketSwapSnapshot(choice.original, a.replacement_id) !==
          basketSwapSnapshot(a.original, a.replacement_id)
      )
        throw Error(
          "The kit, dates or stock changed. Refresh the replacement sets.",
        );
      return { ok: true, dryRun: true };
    }
    return callDbCinema<any>("mutation", "rentalReplacements:acceptBasket", {
      bookingId: a.booking_id,
      requestId: a.request_id,
      replacementId: a.replacement_id,
      original: a.original,
    });
  },
});

function equipmentImages(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .filter(
          (url): url is string =>
            typeof url === "string" && /^(https:\/\/|\/(?!\/))/.test(url),
        )
        .map((url) =>
          url.startsWith("/")
            ? new URL(url, "https://dbcinemarentals.com").href
            : url,
        ),
    ),
  ];
}
/** Owner-only controls reuse the website's authoritative rental workflows. */
export const rentalControls = action({
  args: { booking_id: v.string() },
  handler: async (ctx, { booking_id }) => {
    await requireOwner(ctx);
    const b = await callDbCinema<any>("query", "rentalOperations:details", {
      bookingId: booking_id,
    });
    if (!b) throw Error("Rental details are unavailable.");
    return {
      status: b.status,
      total: b.total,
      depositHoldAmount: b.depositHoldAmount ?? 0,
      snapshot: b.controlsSnapshot,
      canChangeDates:
        b.status === "confirmed" &&
        !b.cancellationDecision &&
        !b.returnDecision &&
        !b.activeAdditionId &&
        !b.activeExtensionId,
      canAddEquipment:
        ["pending_payment", "confirmed", "active"].includes(b.status) &&
        !b.cancellationDecision &&
        !b.returnDecision &&
        !b.activeAdditionId &&
        !b.activeExtensionId,
      canRemoveEquipment:
        b.status === "confirmed" &&
        !b.cancellationDecision &&
        !b.returnDecision &&
        !b.activeAdditionId &&
        !b.activeExtensionId &&
        (b.lineItems ?? []).length > 1,
      lines: (b.lineItems ?? []).map((l: any, index: number) => ({
        listing_id: String(l.listingId),
        line_index: index,
        image_urls: equipmentImages(l.imageSources ?? [l.heroImage]),
        name: l.title,
        qty: l.qty,
        start: l.start,
        end: l.end,
        image_url:
          equipmentImages([l.heroImage, ...(l.imageSources ?? [])])[0] ?? null,
      })),
      refunds: (b.rentalRefunds ?? []).map((r: any) => ({
        status: r.status,
        amountPence: r.amountPence ?? 0,
      })),
    };
  },
});
export const previewRentalDates = action({
  args: {
    booking_id: v.string(),
    start: v.number(),
    end: v.number(),
    reason: v.string(),
    keep_agreed_price: v.boolean(),
  },
  handler: async (
    ctx,
    { booking_id, start, end, reason, keep_agreed_price },
  ) => {
    await requireOwner(ctx);
    return await callDbCinema<{
      ok: boolean;
      reason?: string;
      controlsSnapshot?: string;
      total?: number;
      depositHoldAmount?: number;
    }>("query", "rentalOperations:previewReschedule", {
      bookingId: booking_id,
      start,
      end,
      reason,
      keepAgreedPrice: keep_agreed_price,
    });
  },
});
export const applyRentalDates = action({
  args: {
    booking_id: v.string(),
    start: v.number(),
    end: v.number(),
    reason: v.string(),
    keep_agreed_price: v.boolean(),
    expected_snapshot: v.string(),
    operator_confirmed: v.boolean(),
  },
  handler: async (
    ctx,
    {
      booking_id,
      start,
      end,
      reason,
      keep_agreed_price,
      expected_snapshot,
      operator_confirmed,
    },
  ) => {
    await requireOwner(ctx);
    if (!operator_confirmed || !expected_snapshot)
      throw Error("Review and confirm the date change first.");
    await callDbCinema("mutation", "rentalOperations:reschedule", {
      bookingId: booking_id,
      start,
      end,
      reason,
      keepAgreedPrice: keep_agreed_price,
      expectedSnapshot: expected_snapshot,
    });
    return { ok: true };
  },
});
export const refundRental = action({
  args: {
    booking_id: v.string(),
    request_id: v.string(),
    amount_pence: v.number(),
    reason: v.string(),
    operator_confirmed: v.boolean(),
  },
  handler: async (
    ctx,
    { booking_id, request_id, amount_pence, reason, operator_confirmed },
  ) => {
    await requireOwner(ctx);
    if (
      !operator_confirmed ||
      !Number.isSafeInteger(amount_pence) ||
      amount_pence <= 0 ||
      reason.trim().length < 5
    )
      throw Error("Review the amount and reason before confirming.");
    return await callDbCinema<{ status: string; amount: number }>(
      "action",
      "checkout:refundRental",
      {
        bookingId: booking_id,
        requestId: request_id,
        amountPence: amount_pence,
        reason,
      },
    );
  },
});

/** These bridges only execute a change after the operator confirms the exact review. */
export const equipmentCatalog = action({
  args: { search: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const rows = await callDbCinema<
      Array<{
        listingId: string;
        title: string;
        imageSources: string[];
        daily: number;
      }>
    >("query", "rentalOperations:equipmentCatalog", args);
    return rows.map((row) => ({
      ...row,
      imageSources: equipmentImages(row.imageSources),
    }));
  },
});
export const previewEquipmentAddition = action({
  args: {
    booking_id: v.string(),
    listing_id: v.string(),
    qty: v.number(),
    reason: v.string(),
    complimentary: v.boolean(),
  },
  handler: async (ctx, { booking_id, listing_id, ...args }) => {
    await requireOwner(ctx);
    const result = await callDbCinema<any>(
      "query",
      "rentalAdditionState:preview",
      {
        bookingId: booking_id,
        listingId: listing_id,
        ...args,
      },
    );
    return {
      ...result,
      imageSources: equipmentImages(result.imageSources ?? []),
    };
  },
});
export const addEquipment = action({
  args: {
    booking_id: v.string(),
    listing_id: v.string(),
    request_id: v.string(),
    qty: v.number(),
    reason: v.string(),
    complimentary: v.boolean(),
    expected_snapshot: v.string(),
    expected_quote: v.string(),
    operator_confirmed: v.boolean(),
  },
  handler: async (
    ctx,
    {
      booking_id,
      listing_id,
      request_id,
      expected_snapshot,
      expected_quote,
      operator_confirmed,
      ...args
    },
  ) => {
    await requireOwner(ctx);
    if (!operator_confirmed || !expected_snapshot || !expected_quote)
      throw Error("Review and confirm the equipment addition first.");
    try {
      const result = await callDbCinema<{
        url: string;
        id: string;
        applied?: boolean;
      }>("action", "rentalAdditions:start", {
        bookingId: booking_id,
        listingId: listing_id,
        requestId: request_id,
        expectedSnapshot: expected_snapshot,
        expectedQuote: expected_quote,
        ...args,
      });
      return {
        applied: !!result.applied,
        payment_url: result.url,
        addition_id: result.id,
      };
    } catch (e) {
      if (e instanceof EquipmentReviewChanged) return { review_required: true };
      throw e;
    }
  },
});
export const removeEquipment = action({
  args: {
    booking_id: v.string(),
    listing_id: v.string(),
    request_id: v.string(),
    line_index: v.number(),
    qty: v.number(),
    start: v.number(),
    end: v.number(),
    reason: v.string(),
    expected_snapshot: v.string(),
    operator_confirmed: v.boolean(),
  },
  handler: async (
    ctx,
    {
      booking_id,
      listing_id,
      request_id,
      line_index,
      qty,
      start,
      end,
      reason,
      expected_snapshot,
      operator_confirmed,
    },
  ) => {
    await requireOwner(ctx);
    if (!operator_confirmed || !expected_snapshot)
      throw Error("Review and confirm the equipment removal first.");
    try {
      await callDbCinema("mutation", "rentalOperations:removeItem", {
        bookingId: booking_id,
        listingId: listing_id,
        requestId: request_id,
        lineIndex: line_index,
        expectedQty: qty,
        expectedStart: start,
        expectedEnd: end,
        reason,
        expectedSnapshot: expected_snapshot,
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof EquipmentReviewChanged) return { review_required: true };
      throw e;
    }
  },
});
