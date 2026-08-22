import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

/**
 * Minimal vitest config — Wave 1 unit tests only.
 *
 * Node environment (no jsdom, no Convex test runtime). Targets the
 * mastra/lib units that are pure TS + injectable stubs.
 *
 * CSS / PostCSS pipeline is disabled — the project's `postcss.config.mjs`
 * uses Tailwind v4's async plugin loader, which the CJS Vite shipped with
 * vitest 1.x can't evaluate. Unit tests don't touch CSS, so we short-circuit.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  css: { postcss: { plugins: [] } },
  test: {
    environment: "node",
    globals: false,
    include: [
      "src/mastra/**/*.test.ts",
      "convex/lib/item_matcher.test.ts",
      "convex/lib/item_name_match.test.ts",
      "convex/lib/bundle_description_parse.test.ts",
      "convex/lib/renter_bot_conversation_rubric.test.ts",
      "convex/lib/listing_equivalence.test.ts",
      "convex/lib/revenue_attribution.test.ts",
      "convex/lib/denial_classifier.test.ts",
      "convex/lib/availability.test.ts",
      "convex/lib/weekly_metrics_compute.test.ts",
      "convex/lib/capacity_gap.test.ts",
      "convex/lib/double_booking.test.ts",
      "convex/lib/per_listing_merge.test.ts",
      "convex/lib/return_presence.test.ts",
      "convex/lib/message_reconciliation.test.ts",
      "convex/lib/imminent_handoffs.test.ts",
      "convex/lib/notification_events.test.ts",
      "convex/lib/telegram_convex.test.ts",
      "convex/lib/draft_listing_grounding.test.ts",
      "convex/lib/draft_guard.test.ts",
      "convex/lib/knowledge_search.test.ts",
      "convex/lib/channel_response_rates.test.ts",
      "convex/lib/poller_window.test.ts",
      "convex/lib/response_rate_alerts.test.ts",
      "convex/dashboard_insights.spec.ts",
      "convex/dashboard_chat.walle.spec.ts",
      "src/lib/dashboard/edit-mode-context.spec.ts",
      "src/trigger/catalog-sync.map.test.ts",
      "src/lib/hygglo-write.test.ts",
      "src/lib/hygglo/listings.test.ts",
      "src/lib/chat/dashboard-tools.schema.test.ts",
      "src/lib/renter-bot-policy.test.ts",
      "convex/lib/renter_bot_rubric.test.ts",
      "src/lib/booking-time-transcript.test.ts",
      "src/lib/booking-time-extraction.test.ts",
      "src/lib/calendar-bar-geometry.test.ts",
      "src/lib/revenue/leo-takeover.test.ts",
      "src/lib/item-resolution.test.ts",
      "src/lib/quiet-hours.test.ts",
      "src/lib/pickup-hours.test.ts",
      "src/lib/hygglo-poll-backoff.test.ts",
      "src/lib/ai-models.chat-lanes.test.ts",
      "src/trigger/hygglo-ui-action.gate.test.ts",
      "src/hygglo-core/__tests__/competitor-aggregate.test.ts",
      "src/hygglo-core/__tests__/shape.test.ts",
      "src/hygglo-core/__tests__/poll.test.ts",
      "convex/migrations/backfill_inclusive_duration.test.ts",
    ],
    css: false,
  },
});
