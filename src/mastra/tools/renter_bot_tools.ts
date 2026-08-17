/**
 * Renter-bot Mastra tools (7) — thin wrappers over Convex queries.
 *
 * The agent calls these tools at runtime; the actual data fetches happen
 * inside Convex. This file is invoked from `src/mastra/agents/renter_bot.ts`
 * which registers the tools on the agent.
 *
 * Each tool defines:
 *   - id           — stable handle (the agent prompt references these names)
 *   - description  — used by the LLM to decide when to call
 *   - inputSchema  — Zod
 *   - outputSchema — Zod (helps the agent reason about the return type)
 *   - execute      — calls Convex via ConvexHttpClient
 *
 * READ-ONLY: every tool here calls a Convex `query()`, not a mutation.
 * Failing closed: no Hygglo write API is reachable from a tool.
 */
import "server-only";

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/../convex/_generated/api";
// Convex typegen runs against a real deployment via `npx convex dev`.
// Until the new modules (renter_bot_tools, knowledge, renter_bot_drafts)
// are typed against the live deployment, we use the project-wide
// `anyApi` cast — same pattern hygglo_poll.ts uses for new namespaces.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyApi = api as any;

// Canonical poller-write Convex (per CLAUDE.md): never read from
// exciting-lion-29 even when NEXT_PUBLIC_CONVEX_URL says so.
const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

function convex(): ConvexHttpClient {
  return new ConvexHttpClient(CONVEX_URL);
}

// ── Tool 1: get_renter_context ────────────────────────────────

export const getRenterContextTool = createTool({
  id: "get_renter_context",
  description:
    "Fetch renter + conversation context for a thread. ALWAYS call FIRST. Returns account_slug (for voice), renter profile (incl. blacklist, DNA, lifetime spend, rating), conversation_stage, and the last 3 messages.",
  inputSchema: z.object({
    thread_id: z.string().describe("Hygglo thread id (= hygglo_order_id)"),
  }),
  outputSchema: z.object({
    thread_id: z.string(),
    account_slug: z.string(),
    hygglo_order_id: z.string(),
    renter: z.unknown().nullable(),
    conversation_stage: z.string(),
    last_messages: z.array(
      z.object({
        sender: z.string(),
        sender_name: z.string(),
        body: z.string(),
        at: z.number(),
      }),
    ),
  }),
  execute: async ({ thread_id }) => {
    return await convex().query(anyApi.renter_bot_tools.get_renter_context, {
      thread_id,
    });
  },
});

// ── Tool 2: get_listing_context ───────────────────────────────

export const getListingContextTool = createTool({
  id: "get_listing_context",
  description:
    "Fetch the listing/items context for a thread. Returns the items on the booking (with qty), expanded items (after bundle decomposition), start_date, end_date, gross_paid, order_step. Call when the renter references the gear or asks what's included.",
  inputSchema: z.object({
    thread_id: z.string(),
  }),
  outputSchema: z.unknown(),
  execute: async ({ thread_id }) => {
    return await convex().query(anyApi.renter_bot_tools.get_listing_context, {
      thread_id,
    });
  },
});

// ── Tool 3: lookup_pricing ────────────────────────────────────

export const lookupPricingTool = createTool({
  id: "lookup_pricing",
  description:
    "Look up the daily rate + multi-day total for an item. Call BEFORE quoting any price. Use this ONLY for an item that is NOT on the current request (an ALTERNATIVE you are offering because we do not own what they asked for). For items that ARE on the request, use get_listing_context daily_price_gbp + whats_included instead — do NOT call this for them. Returns the real Hygglo daily rate for the alternative (pass account_slug).",
  inputSchema: z.object({
    item_name: z.string(),
    account_slug: z.string().optional().describe("The account_slug from get_renter_context. Pass it so the price + what-is-included come from THIS account real Hygglo listing (the ground truth)."),
    days: z.number().int().positive().optional().describe("Rental duration in days. Default 1."),
    listing_location_non_central: z
      .boolean()
      .optional()
      .describe("True if listing was at a non-central area (Shoreditch, Camden, etc.). Triggers the 10% distance discount."),
  }),
  outputSchema: z.unknown(),
  execute: async (input) => {
    return await convex().query(anyApi.renter_bot_tools.lookup_pricing, input);
  },
});

// ── Tool 4: check_availability ────────────────────────────────

export const checkAvailabilityTool = createTool({
  id: "check_availability",
  description:
    "Check whether an item is available for a date range across active reservations. Call BEFORE confirming availability. Returns boolean + conflict count (without naming other renters — privacy).",
  inputSchema: z.object({
    item_name: z.string(),
    start_date: z.string().describe("ISO YYYY-MM-DD"),
    end_date: z.string().describe("ISO YYYY-MM-DD"),
    account_slug: z.string().optional(),
  }),
  outputSchema: z.unknown(),
  execute: async (input) => {
    return await convex().query(anyApi.renter_bot_tools.check_availability, input);
  },
});

// ── Tool 5: search_knowledge ──────────────────────────────────

export const searchKnowledgeTool = createTool({
  id: "search_knowledge",
  description:
    "Free-text search across the knowledge base (33 business rules + 124 personal rules from Daniel + ~30 gear FAQs + 10 verbatim templates). Use for anything outside basic conversation: pricing rules, delivery policy, location handling, edge protocols, gear specs, templates. When unsure, query.",
  inputSchema: z.object({
    query: z.string(),
    scope: z
      .enum(["all", "rule", "memory", "operational", "template", "faq"])
      .optional(),
    limit: z.number().int().positive().optional().default(5),
  }),
  outputSchema: z.unknown(),
  execute: async (input) => {
    return await convex().query(anyApi.knowledge.search, input);
  },
});

// ── Tool 6: get_negotiation_stance ────────────────────────────

export const getNegotiationStanceTool = createTool({
  id: "get_negotiation_stance",
  description:
    "Compute Daniel's negotiation ladder state for this conversation. Returns objection count, whether a competitor was mentioned, stance (NONE | HOLD_FIRM | OFFER_ALTERNATIVES | SOFT_YIELD), and the suggested framing. Call WHEN the renter pushes back on price or mentions a cheaper option elsewhere.",
  inputSchema: z.object({
    thread_id: z.string(),
    latest_message: z.string(),
  }),
  outputSchema: z.unknown(),
  execute: async (input) => {
    return await convex().query(anyApi.renter_bot_tools.get_negotiation_stance, input);
  },
});

// ── Tool 7: get_template ──────────────────────────────────────

export const getTemplateTool = createTool({
  id: "get_template",
  description:
    "Fetch a verbatim template's text by name. Use when you've identified a template via search_knowledge (e.g. 'DB Cinema Welcome Text', 'DB Cinema Arrival Reminder', 'DB Cinema Price Match'). Returns the exact text to quote in the draft.",
  inputSchema: z.object({
    name: z.string(),
    account_slug: z.string().optional(),
  }),
  outputSchema: z.unknown(),
  execute: async ({ name, account_slug }) => {
    return await convex().query(anyApi.knowledge.getTemplate, {
      name,
      accountSlug: account_slug,
    });
  },
});

// ── Tool 8: check_vacation ────────────────────────────────────

export const checkVacationTool = createTool({
  id: "check_vacation",
  description:
    "Check whether a requested date range overlaps an active owner-vacation period. Call BEFORE drafting ANY rental confirmation, quote, or availability-affirming reply. If in_vacation=true, the requested window is closed — propose `before` and/or `after` alternative windows in the draft instead of confirming. Returns {in_vacation, vacation?, before?, after?}.",
  inputSchema: z.object({
    start_date: z.string().describe("ISO YYYY-MM-DD"),
    end_date: z.string().describe("ISO YYYY-MM-DD"),
    item_id: z.string().optional().describe("Convex item id when checking a specific listing."),
    requested_qty: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    in_vacation: z.boolean(),
    vacation: z
      .object({ start: z.string(), end: z.string() })
      .optional(),
    before: z.object({ start: z.string(), end: z.string() }).optional(),
    after: z.object({ start: z.string(), end: z.string() }).optional(),
  }),
  execute: async ({ start_date, end_date, item_id, requested_qty }) => {
    const res = await convex().query(
      anyApi.vacation.getClosestAvailableDates,
      {
        requested_start: start_date,
        requested_end: end_date,
        ...(item_id ? { item_id } : {}),
        ...(requested_qty ? { requested_qty } : {}),
      },
    );
    return {
      in_vacation: !!res?.inVacation,
      vacation: res?.vacationPeriod,
      before: res?.before,
      after: res?.after,
    };
  },
});

// ── Tool 9: get_active_vacations ──────────────────────────────

export const getActiveVacationsTool = createTool({
  id: "get_active_vacations",
  description:
    "List all currently-active owner vacation periods (ordered by start date). Use to proactively mention upcoming breaks when relevant (e.g. renter asks about future availability). Returns an array of {start_date, end_date, reason?} objects.",
  inputSchema: z.object({}),
  outputSchema: z.array(
    z.object({
      start_date: z.string(),
      end_date: z.string(),
      reason: z.string().optional(),
    }),
  ),
  execute: async () => {
    const rows: Array<{
      start_date: string;
      end_date: string;
      reason?: string;
    }> = await convex().query(anyApi.vacation.getActiveVacations, {});
    return (rows ?? []).map((r) => ({
      start_date: r.start_date,
      end_date: r.end_date,
      reason: r.reason,
    }));
  },
});

// ── Aggregate export ──────────────────────────────────────────

// ── Tool 10: get_order_edit_state (READ-ONLY) ─────────────────
// Live view of the booking behind a thread — current items, price, and dates —
// so the draft can reference exactly what's on the order. READ-ONLY: order
// edits (add/remove item, price, dates) are OPERATOR-only via the dashboard,
// never reachable from a tool (this file's no-write contract holds).
export const getOrderEditStateTool = createTool({
  id: "get_order_edit_state",
  description:
    "Read the live booking for an order: its current items, rental price + total, and dates. Use to ground replies about what's actually on the booking. Read-only — you cannot change the order from here.",
  inputSchema: z.object({
    account_slug: z.string(),
    hygglo_order_id: z.string().describe("The Hygglo order id (same as the chat thread id)."),
  }),
  outputSchema: z.unknown(),
  execute: async (input) => {
    return await convex().action(anyApi.order_edit.getOrderState, input);
  },
});

export const checkLocationTool = createTool({
  id: "check_location",
  description:
    "Compute the DELIVERY DISTANCE from THIS account hub to the renter postcode (postcodes.io + haversine) and whether it is within our delivery range. Call whenever the renter asks about delivery / drop-off / travel, or gives a postcode or area. Returns distance_km, within_delivery_range, and non_central (for the 10% distance discount).",
  inputSchema: z.object({
    renter_postcode: z.string().describe("The renter UK postcode (e.g. E1 6AN)."),
    account_slug: z.string().describe("The account_slug from get_renter_context."),
  }),
  outputSchema: z.unknown(),
  execute: async (input) => {
    return await convex().action(anyApi.renter_bot_tools.check_location, input);
  },
});

export const findOwnedAlternativesTool = createTool({
  id: "find_owned_alternatives",
  description:
    "List gear we ACTUALLY own and can rent right now (active, in stock), filtered to the SAME kind as the unavailable item (lens, camera, drone, gimbal, monitor, audio, lighting, grip) and, for lenses, lens_mount. Use this to recommend a REAL substitute when the renter asks for something we can't rent — kind is REQUIRED so a camera never gets swapped for a lens or vice versa (real bug, 2026-08-17: an unavailable Sony FX3 camera was 'substituted' with a Sony GM 16-35mm lens because kind was omitted). Returns names + real daily prices. Pass account_slug from get_renter_context.",
  inputSchema: z.object({
    account_slug: z.string(),
    kind: z
      .string()
      .describe("REQUIRED — camera|lens|drone|gimbal|monitor|audio|lighting|grip|... — the SAME kind as the item that's unavailable"),
    lens_mount: z.string().optional().describe("e.g. E, RF, EF — match the renter camera mount for lenses"),
    exclude_name: z.string().optional(),
  }),
  outputSchema: z.unknown(),
  execute: async (input) => {
    return await convex().query(anyApi.renter_bot_tools.find_owned_alternatives, input);
  },
});

export const RENTER_BOT_TOOLS = {
  find_owned_alternatives: findOwnedAlternativesTool,
  check_location: checkLocationTool,
  get_order_edit_state: getOrderEditStateTool,
  get_renter_context: getRenterContextTool,
  get_listing_context: getListingContextTool,
  lookup_pricing: lookupPricingTool,
  check_availability: checkAvailabilityTool,
  search_knowledge: searchKnowledgeTool,
  get_negotiation_stance: getNegotiationStanceTool,
  get_template: getTemplateTool,
  check_vacation: checkVacationTool,
  get_active_vacations: getActiveVacationsTool,
} as const;
