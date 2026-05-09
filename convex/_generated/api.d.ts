/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as bundles from "../bundles.js";
import type * as calendar from "../calendar.js";
import type * as chat from "../chat.js";
import type * as dashboard from "../dashboard.js";
import type * as health from "../health.js";
import type * as items from "../items.js";
import type * as reservations from "../reservations.js";
import type * as revenue from "../revenue.js";
import type * as seed_account_profiles from "../seed/account_profiles.js";
import type * as seed_data from "../seed/data.js";
import type * as seed_inventory from "../seed/inventory.js";
import type * as seed_settings from "../seed/settings.js";
import type * as settings from "../settings.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  bundles: typeof bundles;
  calendar: typeof calendar;
  chat: typeof chat;
  dashboard: typeof dashboard;
  health: typeof health;
  items: typeof items;
  reservations: typeof reservations;
  revenue: typeof revenue;
  "seed/account_profiles": typeof seed_account_profiles;
  "seed/data": typeof seed_data;
  "seed/inventory": typeof seed_inventory;
  "seed/settings": typeof seed_settings;
  settings: typeof settings;
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
