# Phase 1c R2 Snapshot Spec

Stub created during Phase 2 worktree setup (phase2-cleanup branch).

## Snapshots Written to R2
- `intel_rankings` — item ROI + top spenders, written by snapshot-intel-rankings.ts
- `daily_briefing` — daily summary, written by snapshot-daily-briefing.ts
- `top_renters` — top renter profiles, written by snapshot-top-renters.ts
- `inventory_overview` — inventory state, written by snapshot-inventory-overview.ts

## Key Files
- src/trigger/snapshot-*.ts — Trigger.dev cron writers
- src/mastra/lib/hydration.ts — T3 hydration + invalidation helpers
- src/mastra/lib/r2-client.ts — R2 read/write client
- convex/intel.ts, convex/items.ts, convex/dashboard.ts — data sources
