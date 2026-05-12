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
import type * as accounts from "../accounts.js";
import type * as ai_insights from "../ai_insights.js";
import type * as bundles from "../bundles.js";
import type * as calendar from "../calendar.js";
import type * as dashboard from "../dashboard.js";
import type * as dashboard_chat from "../dashboard_chat.js";
import type * as dashboard_chat_context from "../dashboard_chat_context.js";
import type * as denial_records from "../denial_records.js";
import type * as health from "../health.js";
import type * as historical_revenue from "../historical_revenue.js";
import type * as hygglo from "../hygglo.js";
import type * as insurance_claims from "../insurance_claims.js";
import type * as items from "../items.js";
import type * as memories from "../memories.js";
import type * as pricing_catalog from "../pricing_catalog.js";
import type * as reservations from "../reservations.js";
import type * as revenue from "../revenue.js";
import type * as rules from "../rules.js";
import type * as seed_account_profiles from "../seed/account_profiles.js";
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
  accounts: typeof accounts;
  ai_insights: typeof ai_insights;
  bundles: typeof bundles;
  calendar: typeof calendar;
  dashboard: typeof dashboard;
  dashboard_chat: typeof dashboard_chat;
  dashboard_chat_context: typeof dashboard_chat_context;
  denial_records: typeof denial_records;
  health: typeof health;
  historical_revenue: typeof historical_revenue;
  hygglo: typeof hygglo;
  insurance_claims: typeof insurance_claims;
  items: typeof items;
  memories: typeof memories;
  pricing_catalog: typeof pricing_catalog;
  reservations: typeof reservations;
  revenue: typeof revenue;
  rules: typeof rules;
  "seed/account_profiles": typeof seed_account_profiles;
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
