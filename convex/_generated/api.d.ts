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
import type * as admin_backfill_net from "../admin_backfill_net.js";
import type * as admin_migrate from "../admin_migrate.js";
import type * as ai_decisions from "../ai_decisions.js";
import type * as ai_insights from "../ai_insights.js";
import type * as archive_to_r2 from "../archive_to_r2.js";
import type * as archive_to_r2_helpers from "../archive_to_r2_helpers.js";
import type * as audit_listings from "../audit_listings.js";
import type * as audit_listings_data from "../audit_listings_data.js";
import type * as audit_snapshot from "../audit_snapshot.js";
import type * as backfill_hygglo_images from "../backfill_hygglo_images.js";
import type * as bundles from "../bundles.js";
import type * as bundles_seed from "../bundles_seed.js";
import type * as calendar from "../calendar.js";
import type * as conflict_dismissals from "../conflict_dismissals.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as dashboardLayout from "../dashboardLayout.js";
import type * as dashboard_chat from "../dashboard_chat.js";
import type * as dashboard_chat_context from "../dashboard_chat_context.js";
import type * as dashboard_invariants from "../dashboard_invariants.js";
import type * as demand from "../demand.js";
import type * as demand_loss from "../demand_loss.js";
import type * as denial_canonicalizer from "../denial_canonicalizer.js";
import type * as denial_canonicalizer_queries from "../denial_canonicalizer_queries.js";
import type * as denial_records from "../denial_records.js";
import type * as denial_resolutions from "../denial_resolutions.js";
import type * as denial_resolver from "../denial_resolver.js";
import type * as extract_booking_times from "../extract_booking_times.js";
import type * as extract_booking_times_q from "../extract_booking_times_q.js";
import type * as health from "../health.js";
import type * as historical_revenue from "../historical_revenue.js";
import type * as hygglo from "../hygglo.js";
import type * as hygglo_inbox from "../hygglo_inbox.js";
import type * as hygglo_poll_trigger from "../hygglo_poll_trigger.js";
import type * as hygglo_ui from "../hygglo_ui.js";
import type * as insurance_claims from "../insurance_claims.js";
import type * as intel from "../intel.js";
import type * as item_embeddings from "../item_embeddings.js";
import type * as item_embeddings_data from "../item_embeddings_data.js";
import type * as item_resolver from "../item_resolver.js";
import type * as item_resolver_queries from "../item_resolver_queries.js";
import type * as items from "../items.js";
import type * as lib_gatedGenerate from "../lib/gatedGenerate.js";
import type * as lib_imageResolution from "../lib/imageResolution.js";
import type * as lib_quiet_hours from "../lib/quiet_hours.js";
import type * as lib_reservations_predicates from "../lib/reservations/predicates.js";
import type * as lib_reservations_views from "../lib/reservations/views.js";
import type * as listing_cache from "../listing_cache.js";
import type * as listing_images from "../listing_images.js";
import type * as listing_resolver from "../listing_resolver.js";
import type * as listing_resolver_data from "../listing_resolver_data.js";
import type * as lost_revenue from "../lost_revenue.js";
import type * as market_search from "../market_search.js";
import type * as market_search_cache from "../market_search_cache.js";
import type * as memories from "../memories.js";
import type * as migrations_backfill_hygglo_items from "../migrations/backfill_hygglo_items.js";
import type * as migrations_backfill_image_hints from "../migrations/backfill_image_hints.js";
import type * as migrations_backfill_phash from "../migrations/backfill_phash.js";
import type * as model_upgrade_scans from "../model_upgrade_scans.js";
import type * as mv__helpers from "../mv/_helpers.js";
import type * as mv_churn_risk from "../mv/churn_risk.js";
import type * as mv_constants from "../mv/constants.js";
import type * as mv_daily_briefing from "../mv/daily_briefing.js";
import type * as mv_master from "../mv/master.js";
import type * as mv_purchase_signals from "../mv/purchase_signals.js";
import type * as mv_refresh_dispatch from "../mv/refresh_dispatch.js";
import type * as mv_top_earners from "../mv/top_earners.js";
import type * as mv_upcoming_returns from "../mv/upcoming_returns.js";
import type * as mv_utilization from "../mv/utilization.js";
import type * as mv_refresh_locks from "../mv_refresh_locks.js";
import type * as order_step_semantics from "../order_step_semantics.js";
import type * as polling_runs from "../polling_runs.js";
import type * as pricing_catalog from "../pricing_catalog.js";
import type * as rate_limit_config from "../rate_limit_config.js";
import type * as refresh_hygglo_orders from "../refresh_hygglo_orders.js";
import type * as renters from "../renters.js";
import type * as reservation_vision from "../reservation_vision.js";
import type * as reservation_vision_backfill from "../reservation_vision_backfill.js";
import type * as reservations from "../reservations.js";
import type * as resolve_item_from_image from "../resolve_item_from_image.js";
import type * as resolve_item_from_image_data from "../resolve_item_from_image_data.js";
import type * as revenue from "../revenue.js";
import type * as rules from "../rules.js";
import type * as seed_data from "../seed/data.js";
import type * as seed_inventory from "../seed/inventory.js";
import type * as seed_settings from "../seed/settings.js";
import type * as settings from "../settings.js";
import type * as snapshot_jobs from "../snapshot_jobs.js";
import type * as sync_account_profiles from "../sync_account_profiles.js";
import type * as sync_state from "../sync_state.js";
import type * as tax from "../tax.js";
import type * as vision_resolver from "../vision_resolver.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account_state: typeof account_state;
  accounts: typeof accounts;
  admin_backfill_net: typeof admin_backfill_net;
  admin_migrate: typeof admin_migrate;
  ai_decisions: typeof ai_decisions;
  ai_insights: typeof ai_insights;
  archive_to_r2: typeof archive_to_r2;
  archive_to_r2_helpers: typeof archive_to_r2_helpers;
  audit_listings: typeof audit_listings;
  audit_listings_data: typeof audit_listings_data;
  audit_snapshot: typeof audit_snapshot;
  backfill_hygglo_images: typeof backfill_hygglo_images;
  bundles: typeof bundles;
  bundles_seed: typeof bundles_seed;
  calendar: typeof calendar;
  conflict_dismissals: typeof conflict_dismissals;
  crons: typeof crons;
  dashboard: typeof dashboard;
  dashboardLayout: typeof dashboardLayout;
  dashboard_chat: typeof dashboard_chat;
  dashboard_chat_context: typeof dashboard_chat_context;
  dashboard_invariants: typeof dashboard_invariants;
  demand: typeof demand;
  demand_loss: typeof demand_loss;
  denial_canonicalizer: typeof denial_canonicalizer;
  denial_canonicalizer_queries: typeof denial_canonicalizer_queries;
  denial_records: typeof denial_records;
  denial_resolutions: typeof denial_resolutions;
  denial_resolver: typeof denial_resolver;
  extract_booking_times: typeof extract_booking_times;
  extract_booking_times_q: typeof extract_booking_times_q;
  health: typeof health;
  historical_revenue: typeof historical_revenue;
  hygglo: typeof hygglo;
  hygglo_inbox: typeof hygglo_inbox;
  hygglo_poll_trigger: typeof hygglo_poll_trigger;
  hygglo_ui: typeof hygglo_ui;
  insurance_claims: typeof insurance_claims;
  intel: typeof intel;
  item_embeddings: typeof item_embeddings;
  item_embeddings_data: typeof item_embeddings_data;
  item_resolver: typeof item_resolver;
  item_resolver_queries: typeof item_resolver_queries;
  items: typeof items;
  "lib/gatedGenerate": typeof lib_gatedGenerate;
  "lib/imageResolution": typeof lib_imageResolution;
  "lib/quiet_hours": typeof lib_quiet_hours;
  "lib/reservations/predicates": typeof lib_reservations_predicates;
  "lib/reservations/views": typeof lib_reservations_views;
  listing_cache: typeof listing_cache;
  listing_images: typeof listing_images;
  listing_resolver: typeof listing_resolver;
  listing_resolver_data: typeof listing_resolver_data;
  lost_revenue: typeof lost_revenue;
  market_search: typeof market_search;
  market_search_cache: typeof market_search_cache;
  memories: typeof memories;
  "migrations/backfill_hygglo_items": typeof migrations_backfill_hygglo_items;
  "migrations/backfill_image_hints": typeof migrations_backfill_image_hints;
  "migrations/backfill_phash": typeof migrations_backfill_phash;
  model_upgrade_scans: typeof model_upgrade_scans;
  "mv/_helpers": typeof mv__helpers;
  "mv/churn_risk": typeof mv_churn_risk;
  "mv/constants": typeof mv_constants;
  "mv/daily_briefing": typeof mv_daily_briefing;
  "mv/master": typeof mv_master;
  "mv/purchase_signals": typeof mv_purchase_signals;
  "mv/refresh_dispatch": typeof mv_refresh_dispatch;
  "mv/top_earners": typeof mv_top_earners;
  "mv/upcoming_returns": typeof mv_upcoming_returns;
  "mv/utilization": typeof mv_utilization;
  mv_refresh_locks: typeof mv_refresh_locks;
  order_step_semantics: typeof order_step_semantics;
  polling_runs: typeof polling_runs;
  pricing_catalog: typeof pricing_catalog;
  rate_limit_config: typeof rate_limit_config;
  refresh_hygglo_orders: typeof refresh_hygglo_orders;
  renters: typeof renters;
  reservation_vision: typeof reservation_vision;
  reservation_vision_backfill: typeof reservation_vision_backfill;
  reservations: typeof reservations;
  resolve_item_from_image: typeof resolve_item_from_image;
  resolve_item_from_image_data: typeof resolve_item_from_image_data;
  revenue: typeof revenue;
  rules: typeof rules;
  "seed/data": typeof seed_data;
  "seed/inventory": typeof seed_inventory;
  "seed/settings": typeof seed_settings;
  settings: typeof settings;
  snapshot_jobs: typeof snapshot_jobs;
  sync_account_profiles: typeof sync_account_profiles;
  sync_state: typeof sync_state;
  tax: typeof tax;
  vision_resolver: typeof vision_resolver;
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

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
