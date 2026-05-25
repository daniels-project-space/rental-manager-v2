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
import type * as admin_backfill_hygglo_signals from "../admin_backfill_hygglo_signals.js";
import type * as admin_backfill_hygglo_signals_data from "../admin_backfill_hygglo_signals_data.js";
import type * as admin_backfill_net from "../admin_backfill_net.js";
import type * as admin_backfill_qty_resolution from "../admin_backfill_qty_resolution.js";
import type * as admin_backfill_renter_links from "../admin_backfill_renter_links.js";
import type * as admin_backfill_stale_completed from "../admin_backfill_stale_completed.js";
import type * as admin_backfill_status_from_step from "../admin_backfill_status_from_step.js";
import type * as admin_backfill_weekly_metrics from "../admin_backfill_weekly_metrics.js";
import type * as admin_backfill_weekly_metrics_5b from "../admin_backfill_weekly_metrics_5b.js";
import type * as admin_bootstrap_pidindex from "../admin_bootstrap_pidindex.js";
import type * as admin_debug_steps from "../admin_debug_steps.js";
import type * as admin_item_attribution from "../admin_item_attribution.js";
import type * as admin_migrate from "../admin_migrate.js";
import type * as admin_reclassify from "../admin_reclassify.js";
import type * as admin_reset_account_state from "../admin_reset_account_state.js";
import type * as ai_decisions from "../ai_decisions.js";
import type * as ai_insights from "../ai_insights.js";
import type * as archive_to_r2 from "../archive_to_r2.js";
import type * as archive_to_r2_helpers from "../archive_to_r2_helpers.js";
import type * as audit_capacity_gap_diagnostic from "../audit_capacity_gap_diagnostic.js";
import type * as audit_data_quality from "../audit_data_quality.js";
import type * as audit_listings from "../audit_listings.js";
import type * as audit_listings_data from "../audit_listings_data.js";
import type * as audit_qty_drift from "../audit_qty_drift.js";
import type * as audit_qty_drift_data from "../audit_qty_drift_data.js";
import type * as audit_reclassification from "../audit_reclassification.js";
import type * as audit_snapshot from "../audit_snapshot.js";
import type * as audit_thread_join from "../audit_thread_join.js";
import type * as backfill_hygglo_images from "../backfill_hygglo_images.js";
import type * as bundles from "../bundles.js";
import type * as bundles_seed from "../bundles_seed.js";
import type * as calendar from "../calendar.js";
import type * as conflict_dismissals from "../conflict_dismissals.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as dashboardLayout from "../dashboardLayout.js";
import type * as dashboard_attribution_preview from "../dashboard_attribution_preview.js";
import type * as dashboard_chat from "../dashboard_chat.js";
import type * as dashboard_insights from "../dashboard_insights.js";
import type * as dashboard_invariants from "../dashboard_invariants.js";
import type * as demand from "../demand.js";
import type * as demand_loss from "../demand_loss.js";
import type * as denial_canonicalizer_queries from "../denial_canonicalizer_queries.js";
import type * as denial_records from "../denial_records.js";
import type * as denial_resolutions from "../denial_resolutions.js";
import type * as denial_resolver from "../denial_resolver.js";
import type * as extract_booking_times from "../extract_booking_times.js";
import type * as extract_booking_times_q from "../extract_booking_times_q.js";
import type * as feature_flags from "../feature_flags.js";
import type * as health from "../health.js";
import type * as historical_revenue from "../historical_revenue.js";
import type * as http from "../http.js";
import type * as hygglo from "../hygglo.js";
import type * as hygglo_inbox from "../hygglo_inbox.js";
import type * as hygglo_ui from "../hygglo_ui.js";
import type * as insurance_claims from "../insurance_claims.js";
import type * as intel from "../intel.js";
import type * as item_resolver from "../item_resolver.js";
import type * as item_resolver_queries from "../item_resolver_queries.js";
import type * as items from "../items.js";
import type * as knowledge from "../knowledge.js";
import type * as lib_ai_attribution from "../lib/ai_attribution.js";
import type * as lib_availability from "../lib/availability.js";
import type * as lib_capacity_gap from "../lib/capacity_gap.js";
import type * as lib_co_occurrence from "../lib/co_occurrence.js";
import type * as lib_customer_metrics from "../lib/customer_metrics.js";
import type * as lib_denial_classifier from "../lib/denial_classifier.js";
import type * as lib_double_booking from "../lib/double_booking.js";
import type * as lib_feature_flags_helper from "../lib/feature_flags_helper.js";
import type * as lib_gatedGenerate from "../lib/gatedGenerate.js";
import type * as lib_hygglo_minimal from "../lib/hygglo_minimal.js";
import type * as lib_imageResolution from "../lib/imageResolution.js";
import type * as lib_inventory_categories from "../lib/inventory_categories.js";
import type * as lib_item_matcher from "../lib/item_matcher.js";
import type * as lib_item_taxonomy from "../lib/item_taxonomy.js";
import type * as lib_knowledge_search from "../lib/knowledge_search.js";
import type * as lib_listing_equivalence from "../lib/listing_equivalence.js";
import type * as lib_listing_photo_reference from "../lib/listing_photo_reference.js";
import type * as lib_missed_revenue from "../lib/missed_revenue.js";
import type * as lib_quiet_hours from "../lib/quiet_hours.js";
import type * as lib_renter_bot_filters from "../lib/renter_bot_filters.js";
import type * as lib_renter_bot_intents from "../lib/renter_bot_intents.js";
import type * as lib_renter_bot_negotiation from "../lib/renter_bot_negotiation.js";
import type * as lib_reservations_accounts from "../lib/reservations/accounts.js";
import type * as lib_reservations_monthRevenue from "../lib/reservations/monthRevenue.js";
import type * as lib_reservations_predicates from "../lib/reservations/predicates.js";
import type * as lib_reservations_views from "../lib/reservations/views.js";
import type * as lib_revenue_attribution from "../lib/revenue_attribution.js";
import type * as lib_telegram_convex from "../lib/telegram_convex.js";
import type * as lib_weekly_metrics_compute from "../lib/weekly_metrics_compute.js";
import type * as listing_cache from "../listing_cache.js";
import type * as listing_equivalence_admin from "../listing_equivalence_admin.js";
import type * as listing_images from "../listing_images.js";
import type * as listing_info_pool from "../listing_info_pool.js";
import type * as listing_resolver from "../listing_resolver.js";
import type * as listing_resolver_data from "../listing_resolver_data.js";
import type * as listing_short_names from "../listing_short_names.js";
import type * as listing_short_names_actions from "../listing_short_names_actions.js";
import type * as lost_revenue from "../lost_revenue.js";
import type * as market_search from "../market_search.js";
import type * as market_search_cache from "../market_search_cache.js";
import type * as memories from "../memories.js";
import type * as migrations_backfill_hygglo_items from "../migrations/backfill_hygglo_items.js";
import type * as migrations_backfill_image_hints from "../migrations/backfill_image_hints.js";
import type * as model_upgrade_scans from "../model_upgrade_scans.js";
import type * as mv__helpers from "../mv/_helpers.js";
import type * as mv_churn_risk from "../mv/churn_risk.js";
import type * as mv_constants from "../mv/constants.js";
import type * as mv_daily_briefing from "../mv/daily_briefing.js";
import type * as mv_earnings_by_period from "../mv/earnings_by_period.js";
import type * as mv_item_roi_rankings from "../mv/item_roi_rankings.js";
import type * as mv_master from "../mv/master.js";
import type * as mv_missed_revenue from "../mv/missed_revenue.js";
import type * as mv_purchase_signals from "../mv/purchase_signals.js";
import type * as mv_refresh_dispatch from "../mv/refresh_dispatch.js";
import type * as mv_stats_drawer from "../mv/stats_drawer.js";
import type * as mv_top_earners from "../mv/top_earners.js";
import type * as mv_upcoming_returns from "../mv/upcoming_returns.js";
import type * as mv_utilization from "../mv/utilization.js";
import type * as mv_refresh_locks from "../mv_refresh_locks.js";
import type * as order_step_semantics from "../order_step_semantics.js";
import type * as poller_health from "../poller_health.js";
import type * as polling_runs from "../polling_runs.js";
import type * as pricing_catalog from "../pricing_catalog.js";
import type * as rate_limit_config from "../rate_limit_config.js";
import type * as refresh_hygglo_orders from "../refresh_hygglo_orders.js";
import type * as renter_bot_batch from "../renter_bot_batch.js";
import type * as renter_bot_drafts from "../renter_bot_drafts.js";
import type * as renter_bot_seed from "../renter_bot_seed.js";
import type * as renter_bot_tools from "../renter_bot_tools.js";
import type * as renters from "../renters.js";
import type * as reservation_vision from "../reservation_vision.js";
import type * as reservation_vision_backfill from "../reservation_vision_backfill.js";
import type * as reservations from "../reservations.js";
import type * as revenue from "../revenue.js";
import type * as rules from "../rules.js";
import type * as seed_data from "../seed/data.js";
import type * as seed_inventory from "../seed/inventory.js";
import type * as seed_renter_bot_memories from "../seed/renter_bot_memories.js";
import type * as seed_renter_bot_rules from "../seed/renter_bot_rules.js";
import type * as seed_settings from "../seed/settings.js";
import type * as settings from "../settings.js";
import type * as snapshot_jobs from "../snapshot_jobs.js";
import type * as sync_account_profiles from "../sync_account_profiles.js";
import type * as sync_state from "../sync_state.js";
import type * as tax from "../tax.js";
import type * as telegram_inbound from "../telegram_inbound.js";
import type * as vacation from "../vacation.js";
import type * as walle_ratelimits from "../walle_ratelimits.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account_state: typeof account_state;
  accounts: typeof accounts;
  admin_backfill_hygglo_signals: typeof admin_backfill_hygglo_signals;
  admin_backfill_hygglo_signals_data: typeof admin_backfill_hygglo_signals_data;
  admin_backfill_net: typeof admin_backfill_net;
  admin_backfill_qty_resolution: typeof admin_backfill_qty_resolution;
  admin_backfill_renter_links: typeof admin_backfill_renter_links;
  admin_backfill_stale_completed: typeof admin_backfill_stale_completed;
  admin_backfill_status_from_step: typeof admin_backfill_status_from_step;
  admin_backfill_weekly_metrics: typeof admin_backfill_weekly_metrics;
  admin_backfill_weekly_metrics_5b: typeof admin_backfill_weekly_metrics_5b;
  admin_bootstrap_pidindex: typeof admin_bootstrap_pidindex;
  admin_debug_steps: typeof admin_debug_steps;
  admin_item_attribution: typeof admin_item_attribution;
  admin_migrate: typeof admin_migrate;
  admin_reclassify: typeof admin_reclassify;
  admin_reset_account_state: typeof admin_reset_account_state;
  ai_decisions: typeof ai_decisions;
  ai_insights: typeof ai_insights;
  archive_to_r2: typeof archive_to_r2;
  archive_to_r2_helpers: typeof archive_to_r2_helpers;
  audit_capacity_gap_diagnostic: typeof audit_capacity_gap_diagnostic;
  audit_data_quality: typeof audit_data_quality;
  audit_listings: typeof audit_listings;
  audit_listings_data: typeof audit_listings_data;
  audit_qty_drift: typeof audit_qty_drift;
  audit_qty_drift_data: typeof audit_qty_drift_data;
  audit_reclassification: typeof audit_reclassification;
  audit_snapshot: typeof audit_snapshot;
  audit_thread_join: typeof audit_thread_join;
  backfill_hygglo_images: typeof backfill_hygglo_images;
  bundles: typeof bundles;
  bundles_seed: typeof bundles_seed;
  calendar: typeof calendar;
  conflict_dismissals: typeof conflict_dismissals;
  crons: typeof crons;
  dashboard: typeof dashboard;
  dashboardLayout: typeof dashboardLayout;
  dashboard_attribution_preview: typeof dashboard_attribution_preview;
  dashboard_chat: typeof dashboard_chat;
  dashboard_insights: typeof dashboard_insights;
  dashboard_invariants: typeof dashboard_invariants;
  demand: typeof demand;
  demand_loss: typeof demand_loss;
  denial_canonicalizer_queries: typeof denial_canonicalizer_queries;
  denial_records: typeof denial_records;
  denial_resolutions: typeof denial_resolutions;
  denial_resolver: typeof denial_resolver;
  extract_booking_times: typeof extract_booking_times;
  extract_booking_times_q: typeof extract_booking_times_q;
  feature_flags: typeof feature_flags;
  health: typeof health;
  historical_revenue: typeof historical_revenue;
  http: typeof http;
  hygglo: typeof hygglo;
  hygglo_inbox: typeof hygglo_inbox;
  hygglo_ui: typeof hygglo_ui;
  insurance_claims: typeof insurance_claims;
  intel: typeof intel;
  item_resolver: typeof item_resolver;
  item_resolver_queries: typeof item_resolver_queries;
  items: typeof items;
  knowledge: typeof knowledge;
  "lib/ai_attribution": typeof lib_ai_attribution;
  "lib/availability": typeof lib_availability;
  "lib/capacity_gap": typeof lib_capacity_gap;
  "lib/co_occurrence": typeof lib_co_occurrence;
  "lib/customer_metrics": typeof lib_customer_metrics;
  "lib/denial_classifier": typeof lib_denial_classifier;
  "lib/double_booking": typeof lib_double_booking;
  "lib/feature_flags_helper": typeof lib_feature_flags_helper;
  "lib/gatedGenerate": typeof lib_gatedGenerate;
  "lib/hygglo_minimal": typeof lib_hygglo_minimal;
  "lib/imageResolution": typeof lib_imageResolution;
  "lib/inventory_categories": typeof lib_inventory_categories;
  "lib/item_matcher": typeof lib_item_matcher;
  "lib/item_taxonomy": typeof lib_item_taxonomy;
  "lib/knowledge_search": typeof lib_knowledge_search;
  "lib/listing_equivalence": typeof lib_listing_equivalence;
  "lib/listing_photo_reference": typeof lib_listing_photo_reference;
  "lib/missed_revenue": typeof lib_missed_revenue;
  "lib/quiet_hours": typeof lib_quiet_hours;
  "lib/renter_bot_filters": typeof lib_renter_bot_filters;
  "lib/renter_bot_intents": typeof lib_renter_bot_intents;
  "lib/renter_bot_negotiation": typeof lib_renter_bot_negotiation;
  "lib/reservations/accounts": typeof lib_reservations_accounts;
  "lib/reservations/monthRevenue": typeof lib_reservations_monthRevenue;
  "lib/reservations/predicates": typeof lib_reservations_predicates;
  "lib/reservations/views": typeof lib_reservations_views;
  "lib/revenue_attribution": typeof lib_revenue_attribution;
  "lib/telegram_convex": typeof lib_telegram_convex;
  "lib/weekly_metrics_compute": typeof lib_weekly_metrics_compute;
  listing_cache: typeof listing_cache;
  listing_equivalence_admin: typeof listing_equivalence_admin;
  listing_images: typeof listing_images;
  listing_info_pool: typeof listing_info_pool;
  listing_resolver: typeof listing_resolver;
  listing_resolver_data: typeof listing_resolver_data;
  listing_short_names: typeof listing_short_names;
  listing_short_names_actions: typeof listing_short_names_actions;
  lost_revenue: typeof lost_revenue;
  market_search: typeof market_search;
  market_search_cache: typeof market_search_cache;
  memories: typeof memories;
  "migrations/backfill_hygglo_items": typeof migrations_backfill_hygglo_items;
  "migrations/backfill_image_hints": typeof migrations_backfill_image_hints;
  model_upgrade_scans: typeof model_upgrade_scans;
  "mv/_helpers": typeof mv__helpers;
  "mv/churn_risk": typeof mv_churn_risk;
  "mv/constants": typeof mv_constants;
  "mv/daily_briefing": typeof mv_daily_briefing;
  "mv/earnings_by_period": typeof mv_earnings_by_period;
  "mv/item_roi_rankings": typeof mv_item_roi_rankings;
  "mv/master": typeof mv_master;
  "mv/missed_revenue": typeof mv_missed_revenue;
  "mv/purchase_signals": typeof mv_purchase_signals;
  "mv/refresh_dispatch": typeof mv_refresh_dispatch;
  "mv/stats_drawer": typeof mv_stats_drawer;
  "mv/top_earners": typeof mv_top_earners;
  "mv/upcoming_returns": typeof mv_upcoming_returns;
  "mv/utilization": typeof mv_utilization;
  mv_refresh_locks: typeof mv_refresh_locks;
  order_step_semantics: typeof order_step_semantics;
  poller_health: typeof poller_health;
  polling_runs: typeof polling_runs;
  pricing_catalog: typeof pricing_catalog;
  rate_limit_config: typeof rate_limit_config;
  refresh_hygglo_orders: typeof refresh_hygglo_orders;
  renter_bot_batch: typeof renter_bot_batch;
  renter_bot_drafts: typeof renter_bot_drafts;
  renter_bot_seed: typeof renter_bot_seed;
  renter_bot_tools: typeof renter_bot_tools;
  renters: typeof renters;
  reservation_vision: typeof reservation_vision;
  reservation_vision_backfill: typeof reservation_vision_backfill;
  reservations: typeof reservations;
  revenue: typeof revenue;
  rules: typeof rules;
  "seed/data": typeof seed_data;
  "seed/inventory": typeof seed_inventory;
  "seed/renter_bot_memories": typeof seed_renter_bot_memories;
  "seed/renter_bot_rules": typeof seed_renter_bot_rules;
  "seed/settings": typeof seed_settings;
  settings: typeof settings;
  snapshot_jobs: typeof snapshot_jobs;
  sync_account_profiles: typeof sync_account_profiles;
  sync_state: typeof sync_state;
  tax: typeof tax;
  telegram_inbound: typeof telegram_inbound;
  vacation: typeof vacation;
  walle_ratelimits: typeof walle_ratelimits;
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
