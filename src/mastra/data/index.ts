/**
 * Public API for the shared data layer.
 *
 * Three Mastra consumers import from here:
 *   1. Dashboard chat tools  (apps/web/src/mastra/tools/dashboard-tools.ts) — Wave 1 (this PR)
 *   2. Polling agent         — Wave 4
 *   3. Renter-bot agent      — Wave 5
 *
 * Consumers do tool-scoping at the import level — there is no auth boundary.
 *
 * Usage:
 *   import * as data from "@/mastra/data";
 *   const pending = await data.rentals.getPendingRentals();
 *   const stats   = await data.revenue.getDashboardStats();
 */
import "server-only";

export * as rentals from "./rentals";
export * as revenue from "./revenue";
export * as catalog from "./catalog";
export * as rules from "./rules";
export * as memories from "./memories";
export * as conversations from "./conversations";
export * as feedback from "./feedback";
// Wave 2 additions
export * as lostRevenue from "./lost-revenue";
export * as renters from "./renters";
export * as demand from "./demand";
// Wave 3 — thick intelligence (MV-backed)
export * as intelligence from "./intelligence";
// Wave 4.5 — ai_decision approval orchestrator
export * as decisions from "./decisions";
// Wave 4.6 — Hygglo UI automation (browser-use + Trigger v4)
export * as uiActions from "./ui_actions";
export * as costGuards from "./cost_guards";
// Wave 4.7 — model auto-upgrade advisories
export * as modelUpgrades from "./model_upgrades";

export * from "./constants";
export { validateAccount, type AccountSlug } from "./account-scope";
export { hyggloDaysInclusive, elapsedDays } from "./date-math";
export { getConvex, toError } from "./client";
export {
  getSyncState,
  wrap,
  wrapWithSync,
  type ToolEnvelope,
  type SyncStateDoc,
} from "./envelope";
