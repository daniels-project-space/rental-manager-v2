# Conventions

- Double quotes and semicolons; strict TypeScript types at external/DB/UI boundaries.
- React dashboard components use function components and Convex useQuery/useMutation; keep frequent reactive query payloads small and stable.
- Convex exports declare validators in args and use indexed queries for hot paths; expensive derivations belong in bounded refresh/materialized-view writes.
- Trigger tasks define retry/maxDuration explicitly where behavior differs from defaults; preserve idempotency across retries and overlapping schedules.
- Europe/London is the business timezone for handoff dates/times; do not compare local browser/server timezone implicitly.
- Preserve honest financial fields (gross, delivery fees, net-to-owner) as distinct values and test transitions with real-shaped records.
- Keep automated sends safety-gated; UI manual send actions must remain deliberate and test/dry-run aware.