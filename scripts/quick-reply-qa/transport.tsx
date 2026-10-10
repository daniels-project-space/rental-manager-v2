// @ts-nocheck
// Isolated test transport: no Convex client or external provider is constructed.
import { useCallback, useSyncExternalStore } from "react";
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const snapshot = () => version;
const changed = () => {
  version++;
  listeners.forEach((fn) => fn());
};
import { getFunctionName } from "convex/server";
const now = Date.now();
const names = [
  "Marcus Lee",
  "Priya Sharma",
  "Daniel Kim",
  "Elena Rossi",
  "James Carter",
  "Marcus Lee",
];
const previews = [
  "Hi! Is this still available?",
  "Could you confirm the pickup time?",
  "Is a later time possible?",
  "Thanks! Looks good.",
  "Do you have a spare battery?",
  "Also interested in this lens.",
];
export const rows = names.map((name, i) => ({
  thread_id: "fixture-" + i,
  source: i === 1 || i === 4 ? "dbcinema_web" : "hygglo",
  source_booking_id: "fixture" + i,
  account_slug: i === 1 || i === 4 ? "dbcinema_web" : "dbcinema",
  renter_name: name,
  renter_image_url: "/face" + i + ".png",
  renter_identity: i === 5 ? "person0" : "person" + i,
  renter_rating: 4.8,
  renter_review_count: 18,
  has_reservation: true,
  paid: true,
  verification_started: true,
  platform_booking_confirmed: i === 0,
  is_request: true,
  kind: "request",
  last_sender: "renter",
  can_accept: false,
  can_deny: false,
  can_decide: false,
  renter_blacklisted: false,
  renter_flagged: false,
  booking_status: "confirmed",
  status: "confirmed",
  verification_checks: {
    identity: true,
    address: i < 2 || i === 5,
    approved: i === 0,
  },
  order_step: i === 0 ? "VERIFIED" : i === 3 ? "APPROVED" : "REQUEST",
  verification_status: i === 1 ? "submitted" : "required",
  start_date: "2026-05-" + (14 + i),
  end_date: "2026-05-" + (17 + i),
  return_date: "2026-05-" + (17 + i),
  items: [
    {
      name: [
        "Sony FX6",
        "Sigma 24-70",
        "Aputure 600d",
        "Canon RF 50mm",
        "Atomos Ninja V",
        "Sigma 35mm",
      ][i],
      qty: 1,
      image_url: "/gear" + i + ".png",
    },
  ],
  image_url: "/gear" + i + ".png",
  item_count: 1,
  estimate_earnings_gbp: [284, 196, 142, 120, 98, 120][i],
  net_to_owner_gbp: null,
  availability: {
    status: i === 3 ? "conflict" : "available",
    include_pending: false,
    items: [],
  },
  last_renter_msg_at: now - [48, 25, 72, 123, 161, 48][i] * 60000,
  last_activity_at: now - i * 60000,
  last_msg_at: now - i * 60000,
  preview: previews[i],
  has_draft: false,
  ai_draft_text: null,
  ai_draft_confidence: null,
  ai_draft_flags: null,
  location: null,
}));
const messages = [
  {
    role: "renter",
    content: "Hi! Is this still available?",
    timestamp: now - 240000,
  },
  { role: "owner", content: "Yes, it’s available.", timestamp: now - 180000 },
  {
    role: "renter",
    content: "Great! Can you confirm the dates work?",
    timestamp: now - 120000,
  },
  {
    role: "owner",
    content: "Yep, all set. Let me know if you have any other questions!",
    timestamp: now - 60000,
  },
];
const settings = { availability_include_pending: false };
const canned = [
  {
    _id: "preset1",
    account_slug: "dbcinema",
    label: "Location",
    symbol: "📍",
    text: "Fixture studio location.",
  },
  {
    _id: "preset2",
    account_slug: "dbcinema",
    label: "Times",
    symbol: "🕒",
    text: "Fixture pickup time is 10 AM.",
  },
  {
    _id: "preset3",
    account_slug: "dbcinema",
    label: "Delivery info",
    symbol: "🚚",
    text: "Fixture delivery is available.",
  },
];
window.__calls = [];
window.__fixture = { rows, messages, changed };
export function useQuery(ref, args) {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  if (args === "skip") return undefined;
  const name = getFunctionName(ref);
  if (name === "replyInbox:getReplyQueue")
    return rows.filter((r) => r.source === "hygglo");
  if (name === "replyInbox:getThreadById")
    return rows.find((r) => r.thread_id === args.thread_id);
  if (name === "settings:get") return settings;
  if (name === "hygglo:listByThread") return messages;
  if (name === "replyInbox:getImminentHandoffs")
    return [
      {
        thread_id: rows[0].thread_id,
        renter_name: names[0],
        items: ["Sony FX6"],
        kind: "pickup",
        date: "14 May",
        time: "10:00",
        minutes_away: 24,
      },
      {
        thread_id: rows[1].thread_id,
        renter_name: names[1],
        items: ["Sigma 24-70"],
        kind: "return",
        date: "14 May",
        time: "09:00",
        minutes_away: -42,
      },
    ];
  if (name === "canned_responses:list")
    return canned.filter((c) => c.account_slug === args.account_slug);
  if (name === "online_listings:list")
    return [
      {
        product_id: 77,
        name: "Fixture spare battery",
        image: "/gear0.png",
        daily_price: 10,
        is_published: true,
      },
    ];
  if (
    name === "renter_reviews:get" ||
    name === "renter_reviews:getForThread" ||
    name === "renter_trust:getForThread"
  )
    return {
      reviews: [
        {
          rating: 5,
          text: "Great renter. On time and careful with the equipment.",
          reviewer: "Studio",
          date: "2026-05-01",
        },
      ],
      lowCount: 0,
      fetched: true,
    };
  if (name === "renter_bot_lab_order:get") return null;
  return null;
}
export function useAction(ref) {
  const name = getFunctionName(ref);
  return useCallback(
    async (args) => {
      window.__calls.push({ kind: "action", name, args });
      if (name === "dbcinema_chat:inbox")
        return rows.filter((r) => r.source === "dbcinema_web");
      if (name === "dbcinema_chat:thread") return { messages };
      if (name === "dbcinema_chat:renterReviews")
        return { reviews: [], lowCount: 0, fetched: true };
      if (name === "replyInbox_actions:generateDraft") {
        const draft =
          "Yes, those dates work. Pickup is available at the requested time.";
        rows[0].ai_draft_text = draft;
        rows[0].ai_draft_approval = {
          context_key: "fixture",
          epoch: 1,
          message_id: "fixture-msg",
        };
        changed();
        return {
          status: "ok",
          draft:
            "Yes, those dates work. Pickup is available at the requested time.",
          confidence: 0.9,
          flags: [],
        };
      }
      if (name === "dbcinema_chat:draftReply")
        return { draft: "Fixture DB Cinema contextual reply." };
      if (name === "renter_trust:profilePhotos") return args.thread_ids.map(thread_id=>({thread_id,image_url:"/face0.png"}));
      if (name === "dbcinema_chat:sendOwnerReply") return { ok: true };
      if (
        name === "quick_reply_replacements:options" ||
        name === "dbcinema_chat:replacementOptions"
      )
        return {
          options: [
            {
              id: "33",
              name: "Sony FX3 replacement",
              image_url: "/gear0.png",
              available: true,
              original: {
                item_id: 11,
                product_id: 22,
                name: "Canon RF 50mm",
                start: "2026-10-14",
                end: "2026-10-17",
              },
              can_apply: true,
              price_note: "Check the rental price before sending.",
            },
            {id:"34",name:"Canon C70 replacement",image_url:"/gear1.png",available:true,original:{item_id:11,product_id:22,name:"Canon RF 50mm",start:"2026-10-14",end:"2026-10-17"},can_apply:true,price_note:"Check price before sending."},
          ],
        };
      if (name === "quick_reply_replacements:draft")
        return {
          draft:
            "So sorry, the requested item is unavailable for those dates. We have a Sony FX3 instead. Would you like that?",
        };
      if (
        name === "quick_reply_replacements:accept" ||
        name === "dbcinema_chat:acceptReplacement"
      ) {
        return { ok: true, dryRun: false };
      }
      if (name === "order_edit:getOrderState")
        return {
          ok: true,
          order_id: args.hygglo_order_id,
          renter_name: "Marcus Lee",
          currency: "GBP",
          dates: { start: "2026-10-14", end: "2026-10-17" },
          price: { order_price: 350, total: 355, earnings: 284 },
          items: [
            {
              item_id: 11,
              product_id: 22,
              name: "Sony FX6",
              image: "/gear0.png",
              thumb: "/gear0.png",
              can_remove: true,
              price_label: "£350",
            },
          ],
          actions: {
            add_product: true,
            remove_item: true,
            change_price: true,
            change_dates: true,
            select_dates: false,
            partial_refund: true,
          },
          step: "VERIFIED",
        };
      if (name === "order_edit:itemUnavailableDates")
        return { dates: [], min_rental_days: 1 };
      if (name === "order_edit:previewPrice")
        return { ok: true, new_total: args.new_order_price + 5 };
      if (
        name.startsWith("order_edit:") ||
        name.startsWith("replyInbox_actions:")
      )
        return { status: "sent", reason: "DRY_RUN" };
      if (/resolve|refresh/.test(name)) return {};
      throw Error("Fixture blocked production action: " + name);
    },
    [name],
  );
}
export function useMutation(ref) {
  const name = getFunctionName(ref);
  return useCallback(
    async (args) => {
      window.__calls.push({ kind: "mutation", name, args });
      if (name === "settings:update") {
        Object.assign(settings, args);
        changed();
        return;
      }
      if (name === "canned_responses:create") {
        canned.push({ _id: "fixture-preset-" + canned.length, ...args });
        changed();
        return;
      }
      if (name === "canned_responses:update") {
        Object.assign(
          canned.find((c) => c._id === args.id),
          args,
        );
        changed();
        return;
      }
      if (name === "canned_responses:remove") {
        const i = canned.findIndex((c) => c._id === args.id);
        if (i >= 0) canned.splice(i, 1);
        changed();
        return;
      }
      if (name === "replyInbox:dismissThread") return;
      throw Error("Fixture blocked production mutation: " + name);
    },
    [name],
  );
}
export function usePaginatedQuery() {
  return { results: [], status: "Exhausted", loadMore() {} };
}
export function useConvexAuth() {
  return { isAuthenticated: true, isLoading: false };
}
