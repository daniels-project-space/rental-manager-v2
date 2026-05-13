/**
 * Locked business constants shared across all Mastra consumers.
 *
 * Source citations point to V1 (`/home/ubuntu/rental-manager`) — V2 must
 * preserve these numbers exactly so revenue/lost-revenue figures match.
 */

/**
 * Hygglo platform fee rate.
 * V1: src/lost-revenue/lost-revenue.service.ts:290,1145-1154 (* 0.64 owner share)
 * V1 audit: /tmp/claude_scratchpad/v1_feature_inventory.md §6 line 235
 * Note: upsell.service.ts uses env var default 0.15 — that's a Fat Llama legacy
 *       value. V2 standardises on 0.36 for Hygglo.
 */
export const PLATFORM_FEE_RATE = 0.36;

/** Owner share = 1 - PLATFORM_FEE_RATE. V1: lost-revenue.service.ts:290 */
export const OWNER_SHARE = 0.64;

/**
 * Two-account model. Inventory shared; revenue/booking queries take optional account filter.
 * V1: src/bundles/bundle-intelligence.service.ts:13 ('dbcinema' | 'leo' | 'both')
 * V1 audit: §4 line 164, §6 line 244
 */
export const ACCOUNTS = ["dbcinema", "leo"] as const;
export type AccountSlug = (typeof ACCOUNTS)[number];

/**
 * READ_ONLY_MODE master safety rail.
 * V1: src/playwright/playwright.service.ts:18 gates all Hygglo outbound writes.
 * V1 audit: §3 "Bot toggle" + §3 send/accept/decline notes.
 */
export const READ_ONLY_MODE = process.env.READ_ONLY_MODE === "true";

/**
 * Hygglo poller sync-state source key. Used by every read-tool to attach
 * freshness metadata via tool-envelope.
 * V2: convex/sync_state.ts source field. Existing dashboard tools hard-code
 *     "hygglo_poller" inline — centralised here.
 */
export const HYGGLO_POLLER_SOURCE = "hygglo_poller";

/**
 * Multi-day pricing discount tiers (Hygglo "smart-day" pricing).
 * V1: matches pricing-catalog.ts and existing V2 lookup_pricing tool.
 *   - days >= 7  => total = rate * 5  (weekly cap)
 *   - days >= 3  => total = rate * 2.5
 *   - days <  3  => total = rate * days
 */
export const PRICING_WEEKLY_DAYS = 7;
export const PRICING_WEEKLY_MULTIPLIER = 5;
export const PRICING_MULTIDAY_THRESHOLD = 3;
export const PRICING_MULTIDAY_MULTIPLIER = 2.5;
