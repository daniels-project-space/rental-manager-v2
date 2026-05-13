/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account_state from "../account_state.js";
import type * as ai_decisions from "../ai_decisions.js";
import type * as ai_insights from "../ai_insights.js";
import type * as bundles from "../bundles.js";
import type * as calendar from "../calendar.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as dashboard_chat from "../dashboard_chat.js";
import type * as dashboard_chat_context from "../dashboard_chat_context.js";
import type * as demand from "../demand.js";
import type * as denial_records from "../denial_records.js";
import type * as health from "../health.js";
import type * as historical_revenue from "../historical_revenue.js";
import type * as hygglo from "../hygglo.js";
import type * as hygglo_inbox from "../hygglo_inbox.js";
import type * as hygglo_poll_trigger from "../hygglo_poll_trigger.js";
import type * as hygglo_ui from "../hygglo_ui.js";
import type * as insurance_claims from "../insurance_claims.js";
import type * as items from "../items.js";
import type * as lost_revenue from "../lost_revenue.js";
import type * as memories from "../memories.js";
import type * as model_upgrade_scans from "../model_upgrade_scans.js";
import type * as mv__helpers from "../mv/_helpers.js";
import type * as mv_churn_risk from "../mv/churn_risk.js";
import type * as mv_constants from "../mv/constants.js";
import type * as mv_daily_briefing from "../mv/daily_briefing.js";
import type * as mv_purchase_signals from "../mv/purchase_signals.js";
import type * as mv_refresh_dispatch from "../mv/refresh_dispatch.js";
import type * as mv_top_earners from "../mv/top_earners.js";
import type * as mv_upcoming_returns from "../mv/upcoming_returns.js";
import type * as mv_utilization from "../mv/utilization.js";
import type * as mv_refresh_locks from "../mv_refresh_locks.js";
import type * as polling_runs from "../polling_runs.js";
import type * as pricing_catalog from "../pricing_catalog.js";
import type * as renters from "../renters.js";
import type * as reservations from "../reservations.js";
import type * as revenue from "../revenue.js";
import type * as rules from "../rules.js";
import type * as seed_data from "../seed/data.js";
import type * as seed_inventory from "../seed/inventory.js";
import type * as seed_settings from "../seed/settings.js";
import type * as settings from "../settings.js";
import type * as sync_state from "../sync_state.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account_state: typeof account_state;
  ai_decisions: typeof ai_decisions;
  ai_insights: typeof ai_insights;
  bundles: typeof bundles;
  calendar: typeof calendar;
  crons: typeof crons;
  dashboard: typeof dashboard;
  dashboard_chat: typeof dashboard_chat;
  dashboard_chat_context: typeof dashboard_chat_context;
  demand: typeof demand;
  denial_records: typeof denial_records;
  health: typeof health;
  historical_revenue: typeof historical_revenue;
  hygglo: typeof hygglo;
  hygglo_inbox: typeof hygglo_inbox;
  hygglo_poll_trigger: typeof hygglo_poll_trigger;
  hygglo_ui: typeof hygglo_ui;
  insurance_claims: typeof insurance_claims;
  items: typeof items;
  lost_revenue: typeof lost_revenue;
  memories: typeof memories;
  model_upgrade_scans: typeof model_upgrade_scans;
  "mv/_helpers": typeof mv__helpers;
  "mv/churn_risk": typeof mv_churn_risk;
  "mv/constants": typeof mv_constants;
  "mv/daily_briefing": typeof mv_daily_briefing;
  "mv/purchase_signals": typeof mv_purchase_signals;
  "mv/refresh_dispatch": typeof mv_refresh_dispatch;
  "mv/top_earners": typeof mv_top_earners;
  "mv/upcoming_returns": typeof mv_upcoming_returns;
  "mv/utilization": typeof mv_utilization;
  mv_refresh_locks: typeof mv_refresh_locks;
  polling_runs: typeof polling_runs;
  pricing_catalog: typeof pricing_catalog;
  renters: typeof renters;
  reservations: typeof reservations;
  revenue: typeof revenue;
  rules: typeof rules;
  "seed/data": typeof seed_data;
  "seed/inventory": typeof seed_inventory;
  "seed/settings": typeof seed_settings;
  settings: typeof settings;
  sync_state: typeof sync_state;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
