# Phase 2 — Dead Code Cleanup: Shipped Runbook

**Branch**: `phase2-cleanup` stacked on `phase1c-snapshot-writers` → `phase1-tool-router-hydration`
**Worktree**: `/tmp/rmv2-phase2/` (isolated from background automation on primary checkout)
**Net LOC removed**: ~3261 (16 files, +326 insertions / −3587 deletions)
**Flag flip required**: none — Phase 2 is pure removal + refactor

> Phase 1 + 1c shipped: 12 router tools on a 3-tier HydrationLayer with 4 R2 snapshot writers.
> Phase 2 delivers the cleanup promise: delete the legacy 68-tool `dashboard-tools.ts` wrapper,
> remove orphan Convex queries, gate hot-path logs, and rewrite `getContextBundle` to prefer R2 snapshots.

---

## 1. TL;DR

| Item | Detail |
|---|---|
| `dashboard-tools.ts` | Deleted (1141 LOC). 13 mutation `execute()` bodies were 1-line delegates; inlined to direct `data.*` calls in `router-tools.ts`. |
| `MASTRA_ROUTER_TOOLS` flag | Removed from `dashboard-chat.ts` + `index.ts`. Router tools now unconditional. |
| Orphan Convex queries | 11 from `intel.ts`, 13 from `items.ts`, `getSummary` from `dashboard.ts` — all deleted. 4 functions initially targeted were RESTORED when live callers found (see §3). |
| `convex/ai_insights.ts` | Targeted for deletion, then PRESERVED — live caller at `AIInvestmentInsights.tsx:19`. Audit B's "orphan" grep missed UI components. |
| `src/trigger/export-v1-to-r2.ts` | Deleted (263 LOC). V1 → R2 migration complete per user. |
| Leaked test exports | `__test`, `__clearSyncStateCache`, `getCurrentBriefing` alias — all removed. |
| Hot-path `console.log` | 1 deleted (`chat/route.ts:217`). 3 gated behind `process.env.DEBUG` (`item_resolver.ts:338`, `denial_resolver.ts:102/104`). |
| `getContextBundle` | Rewritten to prefer R2 snapshots (`daily_briefing` + `inventory_overview` + `top_renters` + `by_month`) with full legacy 5-scan fallback preserved when any snapshot is null. |

---

## 2. Commit Chain

Commits on `phase2-cleanup` since `phase1c-snapshot-writers`:

```
3620418  refactor(router): inline 13 mutations to data.* direct calls
2e2742c  refactor(chat): getContextBundle prefers R2 snapshots with legacy fallback
2cd3d7a  refactor(mastra): drop dashboard-tools.ts + MASTRA_ROUTER_TOOLS flag
11af55c  chore: remove leaked test exports, gate hot-path logs, drop exportV1ToR2
ee156ec  chore(convex): drop dead helpers/section dividers post-orphan-deletion
```

Branch tip: `ee156ec` (or confirm with `git -C /tmp/rmv2-phase2 log --oneline -5`)

---

## 3. Deletions

### Files deleted

| File | LOC | Reason |
|---|---|---|
| `src/mastra/tools/dashboard-tools.ts` | 1141 | All 13 mutation bodies were 1-line `data.*` delegates; wrapper eliminated entirely |
| `src/trigger/export-v1-to-r2.ts` | 263 | One-off migration task; V1 → R2 migration complete (user-confirmed) |

### `convex/ai_insights.ts` — PRESERVED (audit correction)

Audit B flagged this file as a whole-file orphan. Pre-deletion grep found a live caller:
- `src/components/dashboard/AIInvestmentInsights.tsx:19` — `useQuery(api.ai_insights.getInsights, {...})`
- Registered via `src/lib/dashboard/widget-registry.ts:58` as the `ai-insights` widget

File preserved (237 lines, 8234 bytes). Deletion would have broken the dashboard widget.

### Orphan Convex functions deleted

**From `convex/intel.ts`** (11 deleted, 4 restored):

| Function | Outcome | Reason |
|---|---|---|
| `getSmartSellRanking` | DELETED | No callers |
| `getBundleProfitRanking` | DELETED | No callers |
| `getForgottenAccessories` | DELETED | No callers |
| `getAtRiskRenters` | DELETED | No callers |
| `getNewVsRepeatRevenue` | DELETED | No callers |
| `getCashFlowForecast` | DELETED | No callers |
| `getOverdueReturns` | DELETED | No callers |
| `getItemSeasonality` | DELETED | No callers |
| `getItemYoYGrowth` | DELETED | No callers |
| `getDemandTrendSlope` | DELETED | No callers |
| `getPricingSignals` | DELETED | No callers |
| `getItemROIRanking` | **RESTORED** | `ItemROIPanel.tsx:39`, `snapshot-intel-rankings.ts:27,32` |
| `getSmartBuyRanking` | **RESTORED** | `LostRevenueBuyPanel.tsx:46` |
| `getTopSpenders` | **RESTORED** | `snapshot-top-renters.ts:90` |
| `getVerificationFunnel` | **RESTORED** | `VerificationFunnelPanel.tsx:68` |

**From `convex/items.ts`** (13 deleted, 0 restored):

`checkAvailability`, `upsertAliases`, `populateImageFromReservation`, `checkCompat`,
`backfillImagesFromResolved`, `getItemSchedule`, `getItemMonthlyEarnings`,
`setItemAcquisition`, `listItemsMissingAcquisition`, `getItemPayback`,
`getKitAffinity`, `getDustCollectors`, `getItemDamageHistory` — all confirmed zero callers before deletion.

**From `convex/dashboard.ts`**: `getSummary` — deleted (zero callers).

> Note: `data.catalog.checkAvailability` in the Mastra data layer (`src/mastra/data/catalog.ts:64`) is
> distinct from the deleted `api.items.checkAvailability` Convex query. Namespace separation correct.

### Surviving Convex exports (post-Phase-2)

| File | Surviving exports |
|---|---|
| `convex/intel.ts` | `getItemROIRanking`, `getSmartBuyRanking`, `getTopSpenders`, `getVerificationFunnel` |
| `convex/items.ts` | `getItemRevenueRanking`, `getItemCycles`, `getOutOfStockItems`, `getSellRecommendations`, `getPriceRecommendations`, `listActive`, `listForReconcile` |
| `convex/dashboard.ts` | `getStatsDrawerData`, `getNextRentals`, `getRentalVolumeByCategory`, `getRentalVolumeKindBreakdown`, `getRentalVolumeOtherSubKinds` |
| `convex/ai_insights.ts` | `getInsights` (preserved) |

### Leaked exports removed

| Export | File | Type |
|---|---|---|
| `__test` | `src/mastra/data/revenue.ts:497` | Test-only internal helper |
| `getCurrentBriefing` | `src/mastra/data/revenue.ts:158` | Alias for `getDashboardStats` (no longer needed) |
| `__clearSyncStateCache` | `src/mastra/data/envelope.ts:73` | Test-only cache reset |

### Hot-path `console.log` changes

| File | Location | Action |
|---|---|---|
| `src/app/api/chat/route.ts` | line 217 | Deleted |
| `convex/item_resolver.ts` | line 338 | Gated behind `process.env.DEBUG` |
| `convex/denial_resolver.ts` | lines 102/104 | Gated behind `process.env.DEBUG` |

---

## 4. Refactors

### 4a. 13 mutations inlined (commit `3620418`)

Replaced indirect dispatch in `router-tools.ts → mutate`:

**Before**: `dashboardTools[op].execute(args, _ctx)` (dynamic lookup, runtime error if op unknown)

**After**: exhaustive `switch(op)` with `default: never` — each case calls `data.<namespace>.<func>(args)` directly.

All wrapper-preserved details carried through:
- `leave_renter_review`: rating type narrowed to `1 | 2 | 3 | 4 | 5`
- `set_item_acquisition_cost`: `acquiredDate` arg renamed to `acquiredAtIso`
- `record_denial`: `source: "manual"` injected
- `approve_decision`: `actorSource: "dashboard_chat"` hardcoded for audit trail
- `send_correction`: routes to `data.feedback.sendCorrection` (not `data.uiActions` — preserved from actual wrapper routing)

Post-switch invalidation hooks (`hydrate.invalidate("items")` + `hydrate.invalidateSnapshot("inventory_overview")` for `set_item_acquisition_cost`) unchanged.

**Gate preservation**: `READ_ONLY_MODE`, `HYGGLO_UI_LIVE_*` flags, `accountSlug` validation, and `MASTER_INVENTORY` lock all live inside the `data.*` functions. The `dashboard-tools.ts` wrappers were 1-line passthroughs — removing them changes nothing about gate enforcement.

### 4b. `MASTRA_ROUTER_TOOLS` flag removed (commit `2cd3d7a`)

- `src/mastra/agents/dashboard-chat.ts`: removed `ROUTER_TOOLS_ON` IIFE + JSDoc (−19 lines); `tools:` binding changed to unconditional `routerTools`
- `src/mastra/index.ts`: removed flag-wiring comment block + `import { dashboardTools }` + `void dashboardTools;` (−9 lines)

### 4c. `getContextBundle` rewritten to prefer R2 snapshots (commit `2e2742c`)

File: `convex/dashboard_chat_context.ts` (+131 / −19)

New contract: accepts optional `snapshots` arg (`ContextBundleSnapshots` type) from any caller with R2 access (Next route, server actions, Trigger jobs). Convex V8 isolate cannot import `@aws-sdk/client-s3` directly — snapshot payloads are injected by callers.

**Three reachable states**:

| Caller passes | `allSnapshotsPresent` | `_source` | `_caveats` |
|---|---|---|---|
| nothing (legacy compat) | false | `"legacy"` | 4× `snapshot_unavailable_*` |
| 1–3 of 4 snapshots | false | `"hybrid"` | N× `snapshot_unavailable_*` for missing |
| all 4 snapshots | true | `"snapshots"` | `[]` |

Legacy 5-scan path (`reservations`, `renters`, `bundles`, `pricing_catalog`, `historical_revenue`) is preserved unconditionally. Snapshots override specific fields post-compute — they do NOT skip scans. A pure-skip optimisation is deferred until snapshots cover `todaySchedule`, `blacklist`, `upcomingBookings14d`, `businessIntelligence`.

---

## 5. Architecture After Phase 2

```
Chat route
  └── HydrationLayer (T1 static / T2 windowed / T3 R2 snapshot)
        └── router-tools.ts ONLY (12 tools)
              ├── reads  → data.* directly
              └── mutate → switch(op) → data.* directly
                           (no dashboardTools wrapper)
```

`convex/_generated/api.d.ts` was regenerated via `npx convex codegen` (Phase 23, using temp `CONVEX_DEPLOYMENT`). Deleted orphan names absent from generated types; `ai_insights` still present.

---

## 6. Verification Record

From `fixup_restore_orphans.md` (Wave 3.5, confirming tip `ee156ec` is green):

```
$ git rev-parse --abbrev-ref HEAD
phase2-cleanup

$ npx tsc --noEmit
(no output)
EXIT: 0

$ npx vitest run
Test Files  1 passed (1)
Tests       12 passed (12)
Duration    486ms

$ grep "ai_insights" convex/_generated/api.d.ts
import type * as ai_insights from "../ai_insights.js";
  ai_insights: typeof ai_insights;
```

**All live callers resolve**:

| Pattern | Expected | Actual |
|---|---|---|
| `api.intel.getItemROIRanking` in src+convex | >0 | 3 callers + 1 export |
| `api.intel.getSmartBuyRanking` | >0 | 1 caller + 1 export |
| `api.intel.getTopSpenders` | >0 | 1 caller + 1 export |
| `api.intel.getVerificationFunnel` | >0 | 1 caller + 1 export |
| `api.ai_insights.*` | >0 | 1 caller + file exists |
| `api.intel.{11 truly-deleted orphans}` | 0 each | 0 |
| `api.items.{13 truly-deleted orphans}` | 0 each | 0 |
| `api.dashboard.getSummary` | 0 | 0 |

**`dashboardTools` refs in `src/`**: 0 functional (doc-comment prose only in router-tools.ts + data layer comments)
**`MASTRA_ROUTER_TOOLS` in `src/`**: 1 match — JSDoc comment in `router-tools.ts:5`, not a runtime reference
**`convex/ai_insights.ts`**: present (237 lines), tracked in git index
**Net LOC removed**: −3261 (16 files, +326 ins / −3587 del)

Verifier Gate 9 (ai_insights absent) and Gate 13 (orphan API refs) reported as FAIL in `verify_phase2.md` were **false positives** — verifier ran against an intermediate state. Final tip `ee156ec` satisfies both gates.

---

## 7. Lessons from This Phase

### Lesson 1: Audit scope must cover ALL src subtrees

Audit B's "orphan" grep scoped to `src/` matched only the Convex API surface (query/mutation definitions), missing:
- UI components using `useQuery(api.X.Y, ...)` — found in `src/components/`
- Phase 1c snapshot writers that call Convex queries to produce R2 payloads — found in `src/trigger/`

**Recommendation**: future dead-code audits must grep ALL of:
`src/components/`, `src/trigger/`, `src/app/`, `src/mastra/`, `src/lib/`
AND look for both `api.X.Y` call patterns AND direct symbol imports (`import { Y } from`).

### Lesson 2: Worktree isolation blocks background automation drift

The worktree at `/tmp/rmv2-phase2/` isolated Phase 2 from background automation that was continuously writing to `/home/ubuntu/rental-manager-v2/` on `main`. Without isolation, branch-checkout conflicts blocked Wave 0 entirely (see `branch_prep.md`). Recommend this pattern for any future multi-wave work on rental-manager-v2.

### Lesson 3: Verifier state must match final tip

The verifier (Wave 3a) ran against an intermediate state and reported two blocking failures. The fixup agent (Wave 3.5) confirmed the final tip `ee156ec` was already correct — no code changes needed. Future verification tasks should explicitly `git log --oneline -1` and confirm the commit hash before running gates.

---

## 8. Deployment Notes

**Before merging Phase 2 to main:**

1. Run `npx convex deploy --yes` against the target Convex deployment. The committed `convex/_generated/api.d.ts` is consistent with this branch's source, but if CI/dev clones re-run codegen against a stale server-side deployment (one that still has the deleted orphan functions), it will reintroduce them to the generated types.

2. No flag flip required. Phase 2 is pure cleanup — router tools are now unconditional and `dashboard-tools.ts` is gone.

3. Background automation stashes on the primary checkout (`stash@{0..4}`) contain unrelated work from concurrent automation on `main`. These require user triage before resuming primary-checkout work — they are NOT part of Phase 2.

4. `convex/ai_insights.ts` is preserved. No schema changes needed for that file.

---

## 9. Rollback

Revert the 5 Phase 2 commits on `phase2-cleanup`:

```bash
git -C /tmp/rmv2-phase2 revert ee156ec 11af55c 2cd3d7a 2e2742c 3620418 --no-edit
```

Or reset to `phase1c-snapshot-writers` tip:

```bash
git -C /tmp/rmv2-phase2 reset --hard phase1c-snapshot-writers
```

All deletions are reversible. `getContextBundle` fallback is opt-in within the function body — even partial rollback works (pass no snapshots and the legacy 5-scan path activates automatically).

---

## 10. Deferred (Not in This Phase)

| Item | Priority | Notes |
|---|---|---|
| `intelligence.ts` vs `intel.ts` dedup | Medium | Needs Phase 0 cross-check to avoid breaking callers |
| `feedback.ts` / `cost_guards.ts` / `envelope.ts` Phase 0 scaffolding cleanup | Low | Leave for Phase 3 |
| `demand_loss.ts` orphan check | Low | May be called by trigger/script — verify before deleting |
| `reservations.updated_at` schema field | Low | Phase 3 candidate |
| Renter-facing bot | Low | Phase 4 |
| `intelligence.ts` vs `intel.ts` JSDoc references to deleted `dashboard-tools.ts` | Low | 1-line sweep in follow-up commit |
| `CLAUDE.md` references to deleted `src/trigger/export-v1-to-r2.ts` | Low | Update to point at `src/lib/r2-cold-storage.ts` |
| `send_correction` routing — `data.feedback` vs `data.uiActions` consolidation | Low | Flagged in `inline_mutations.md:169`; acceptable as-is |
| `getContextBundle` pure-skip optimisation (drop 5 scans on snapshot path) | Medium | Blocked until `inventory_overview` covers per-reservation activity |

---

## 11. Cross-References

- `docs/phase1c-shipped.md` — Phase 1c delivered R2 snapshot writers. Phase 2 builds on that: `getContextBundle` now prefers those snapshots.
- `docs/phase1c-r2-snapshot-spec.md` — R2 snapshot schema consumed by the new `getContextBundle` args.
- Plan: `/root/.claude/plans/tidy-crunching-blanket.md`
- Wave reports: `/tmp/wfo-phase2/{branch_prep,inline_mutations,rewrite_context_bundle,delete_dashboard_tools,delete_orphan_queries,delete_leaked_exports,verify_phase2,adversarial_phase2,fixup_restore_orphans}.md`
