import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalQuery } from "./_generated/server";
import { action, requireOwner } from "./owner_functions";
import { callDbCinema } from "./dbcinema_chat";

export function remainingSearchTerms(terms: string[], texts: string[]) {
  if (terms.length > 32 || terms.some((term) => term.length > 256))
    throw Error("Use up to 32 search words.");
  const normalized = [
    ...new Set(
      terms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean),
    ),
  ];
  const haystacks = texts.map((text) => text.toLocaleLowerCase());
  return normalized.filter(
    (term) => !haystacks.some((text) => text.includes(term)),
  );
}

export const __nativePage = internalQuery({
  args: {
    thread_id: v.string(),
    terms: v.array(v.string()),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const terms = remainingSearchTerms(args.terms, []);
    if (!terms.length)
      return { remaining: [], done: true, cursor: null, scanned: 0 };
    const result = await ctx.db
      .query("hygglo_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", args.thread_id))
      .order("desc")
      .paginate({ numItems: 16, cursor: args.cursor });
    const remaining = remainingSearchTerms(
      terms,
      result.page.map((message) => message.body_text),
    );
    const done = result.isDone || !remaining.length;
    return {
      remaining,
      done,
      cursor: done ? null : result.continueCursor,
      scanned: result.page.length,
    };
  },
});

/** On-demand pages only: no messages, unread flags, drafts or rental writes. */
export const page = action({
  args: {
    requests: v.array(
      v.object({
        thread_id: v.string(),
        booking_id: v.optional(v.string()),
        terms: v.array(v.string()),
        cursor: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (ctx, { requests }): Promise<any> => {
    await requireOwner(ctx);
    if (requests.length > 16)
      throw Error("Search up to 16 conversations per page.");
    requests.forEach((request) => remainingSearchTerms(request.terms, []));
    if (
      new Set(requests.map((request) => request.thread_id)).size !==
      requests.length
    )
      throw Error("Search each conversation once per page.");
    const native = requests.filter((request) => !request.booking_id);
    const website = requests.filter((request) => request.booking_id);
    const nativeResults = await Promise.all(
      native.map(async (request) => ({
        thread_id: request.thread_id,
        ...(await ctx.runQuery(
          internal.quick_reply_search.__nativePage,
          {
            thread_id: request.thread_id,
            terms: request.terms,
            cursor: request.cursor,
          },
        )),
      })),
    );
    let websiteResults: any[] = [];
    if (website.length) {
      try {
        websiteResults = await callDbCinema<any[]>(
          "action",
          "rentalChatSearch:page",
          {
            requests: website.map((request) => ({
              bookingId: request.booking_id,
              terms: request.terms,
              cursor: request.cursor,
            })),
          },
        );
      } catch {
        websiteResults = website.map((request) => ({
          bookingId: request.booking_id,
          remaining: request.terms,
          done: true,
          cursor: null,
          scanned: 0,
          error: "Website message history is unavailable. Retry the search.",
        }));
      }
    }
    return {
      results: [
        ...nativeResults,
        ...websiteResults.map((result) => ({
          ...result,
          thread_id: website.find(
            (request) => request.booking_id === result.bookingId,
          )?.thread_id,
        })),
      ],
    };
  },
});
