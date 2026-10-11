"use node";
import { action } from "./owner_functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/** Operator-only composition. No bot turn, provider write, draft cache or send. */
export const generate = action({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const [tile, messages] = await Promise.all([
      ctx.runQuery(internal.replyInbox.__service_getThreadById, { thread_id }),
      ctx.runQuery(internal.hygglo.__service_listByThread, { thread_id }),
    ]);
    if (!tile || !messages.length) throw Error("The conversation is not ready. Refresh and try again.");
    const secret = process.env.RENTER_BOT_API_SECRET;
    if (!secret) throw Error("AI reply drafts are not configured.");
    const base = process.env.NOTIF_BASE_URL ?? "https://rental-manager-v2-nu.vercel.app";
    const response = await fetch(`${base.replace(/\/$/, "")}/api/dbcinema-chat-draft`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        renter_name: tile.renter_name,
        booking: {
          status: tile.booking_status,
          start: tile.start_date ? Date.parse(tile.start_date + "T12:00:00Z") : undefined,
          end: tile.end_date ? Date.parse(tile.end_date + "T12:00:00Z") : undefined,
          items: tile.items.map((item) => ({ name: item.name, qty: item.qty })),
        },
        // Only a fresh query supplies stock facts. Dates/mapping unknown remain
        // unknown; the model must not invent an availability confirmation.
        availability: tile.availability,
        account: tile.account_slug,
        messages: messages.slice(-40).map((message) => ({
          role: message.role, text: message.content.slice(0, 3000), at: message.timestamp,
        })),
      }),
      signal: AbortSignal.timeout(40_000),
    });
    if (!response.ok) throw Error("The draft assistant is temporarily unavailable. Try again.");
    const result = await response.json() as { draft?: string };
    if (typeof result.draft !== "string" || !result.draft.trim()) throw Error("The draft assistant returned an empty reply. Try again.");
    return { status: "ok" as const, draft: result.draft.trim() };
  },
});
