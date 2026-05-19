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
    "Look up the daily rate + multi-day total for an item. Call BEFORE quoting any price. Returns the listed daily rate, multi-day adjusted total, and whether a distance discount applies. NEVER quote a price without calling this first.",
  inputSchema: z.object({
    item_name: z.string(),
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

// ── Aggregate export ──────────────────────────────────────────

export const RENTER_BOT_TOOLS = {
  get_renter_context: getRenterContextTool,
  get_listing_context: getListingContextTool,
  lookup_pricing: lookupPricingTool,
  check_availability: checkAvailabilityTool,
  search_knowledge: searchKnowledgeTool,
  get_negotiation_stance: getNegotiationStanceTool,
  get_template: getTemplateTool,
} as const;
