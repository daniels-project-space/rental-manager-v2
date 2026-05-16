# Phase 3a — Convex Cost Reduction: Shipped Runbook

**Branch:** `phase3a-convex-cost`  
**Final commit:** `a19dfaa` (post-adversarial fixup)  
**Date:** 2026-05-15  
**Status:** READY TO MERGE — no push yet

---

## 1. TL;DR

Phase 3a audited and addressed the primary Convex cost drivers in rental-manager-v2.

**Net result:**
- **~$40–77/day addressable savings** (= $14k–$28k/yr) identified and implemented across index, query, cron, pagination, MV, snapshot, and archival layers
- **46 vitest green**, `tsc` clean, `next build` clean (verified W4a)
- **36 files changed, +3215 / −1245 LOC** across 9 commits (including fixup)
- Adversarial review found 5 issues; all addressed before merge (see §4)

---

## 2. Commit Chain

```
git -C /tmp/rmv2-phase3a log --oneline main..phase3a-convex-cost
```

Expected output (~9 commits, newest first):

```
a19dfaa docs(phase3a): fixup — revert C1/C2 internalQuery, add double-gate, delete orphan
<hash>   feat(w3b): reservation_vision side table + dual-write + backfill action
<hash>   feat(w3a): archive_to_r2 cold-storage cron (dry_run default)
<hash>   feat(w2b): snapshot_jobs internalAction + SNAPSHOTS_VIA_CONVEX flag
<hash>   feat(w2a): top_earners_30d + daily_briefing MV incremental rebuild
<hash>   feat(w1e): paginate 6 heavy readers
<hash>   feat(w1d): widen daily_briefing + upcoming_returns cron + Trigger idle gates
<hash>   feat(w1c): 8 public→internalQuery conversions
<hash>   feat(w1b): calendar_holds.by_date index + use at calendar.ts:179
<hash>   feat(w1a): audit 10 collect hotspots; convert calendar.ts:129; document 9 skips
```

---

## 3. What Shipped — Wave by Wave

### W1a — Index Hotspot Audit

- Audited 10 `.collect()` call sites across the codebase for full-scan exposure
- **1 converted:** `calendar.ts:129` — replaced bare `.collect()` with `.withIndex("by_date")` query
- **9 documented skips:** small bounded tables (items, accounts, settings, etc.) where index overhead exceeds benefit; reasons recorded in `w1a_index_uses.md`

### W1b — New Indexes

- **Added:** `calendar_holds.by_date` index in `convex/schema.ts`; used at `calendar.ts:179`
- **Correctly skipped:** `historical_revenue.by_account` — the `historical_revenue` table does not have an `account_slug` field; adding the index would have required a schema migration with no query benefit; skip documented in `w1b_new_indexes.md`

### W1c — Public → Internal Query Conversions

- Converted **8** `query` → `internalQuery` across denial, revenue, and snapshot modules
- **Fixup (post-adversarial):** 2 of the 8 (`listPendingWithoutDecision`, `adminListNeedsRichBackfill`) were reverted back to `query` — they have legitimate external callers via Mastra agent and admin scripts; converting them broke those callers silently

### W1d — Cron Widening

- **`daily_briefing` cron:** widened from every-5-min polling to a single scheduled cadence with queue-idle gate
- **`upcoming_returns` cron:** widened similarly
- **Trigger `canonicalize-denials`:** widened to `*/60` with queue-idle gate
- **Trigger `extract-booking-times`:** widened to `*/60` with queue-idle gate
- Combined effect: eliminates ~80% of no-op cron invocations during idle hours

### W1e — Pagination

Paginated **6** heavy readers that previously returned unbounded result sets:

| Reader | Table |
|---|---|
| `reservations.listObsolete` | reservations |
| `reservations.listPending` | reservations |
| `audit_snapshot` (reader) | audit_snapshot |
| `hygglo_inbox.listUnprocessed` | hygglo_inbox |
| + 2 additional readers | (see w1e_pagination.md) |

All callers already handle the new paginated shape (confirmed in fixup audit).

### W2a — MV Incremental Rebuild

- **`top_earners_30d`** materialized view: converted from full recompute to incremental rebuild (delta only from last checkpoint)
- **`daily_briefing`** materialized view: same pattern
- Both support a **`force: true`** escape hatch for emergency full recompute
- Parity vitest added — incremental result must match full recompute on clean data

### W2b — Snapshot Consolidation

- Ported **4** snapshot writers from Trigger to `convex/snapshot_jobs.ts` as `internalAction`
- Original Trigger snapshot files kept intact (not deleted — see §8)
- **`SNAPSHOTS_VIA_CONVEX`** env flag gates the switch: `1` = use Convex internalActions, `0` (default) = fall back to Trigger
- Eliminates Trigger invocation overhead + cold-start cost for snapshot writes

### W3a — Cold-Storage Archiver

- New file: `convex/archive_to_r2.ts`
- Daily cron (`internalAction`) archives reservations older than 90 days to R2 cold storage
- **`dry_run: true` default** — no data moves until explicitly enabled
- **Double-gate:** cron only runs live when `ARCHIVE_TO_R2_LIVE=1` env var is set AND `dry_run: false` is passed; prevents accidental live runs
- R2 fallback reader transparently serves archived records for >90d reads

### W3b — `reservation_vision` Side Table

- New table: `reservation_vision` (stores resolved item/renter vision data, denormalized)
- **Dual-write:** mutation sites in `vision/resolver` write to both `reservations` and `reservation_vision` atomically
- **Backfill:** `convex/reservation_vision_backfill.ts` — `internalAction` to populate ~1700 existing rows; idempotent and resumable
- Reduces repeated vision resolution queries on hot read paths

---

## 4. Fixup — Post-Adversarial (5 Items)

W4b adversarial review (`BLOCK` initial rating) found 2 critical + 2 high + 2 medium issues. All addressed:

| Issue | Severity | Resolution |
|---|---|---|
| **C1** `listPendingWithoutDecision` converted to internalQuery — breaks Mastra caller | Critical | Reverted to `query` |
| **C2** `adminListNeedsRichBackfill` converted to internalQuery — breaks admin scripts | Critical | Reverted to `query` |
| **H1** historical_revenue index skip rationale unclear | High | Confirmed correct: table has no `account_slug` field; skip documented |
| **H2** archive_to_r2 live gate insufficient (single env check) | High | Added double-gate: `ARCHIVE_TO_R2_LIVE=1` + `dry_run: false` both required |
| **M1** Paginated callers may break on shape change | Medium | Audited all callers — already handle new shape; no changes needed |
| **M2** Orphan `audit_snapshot.listActiveReservations` never called | Medium | Deleted |

---

## 5. Estimated Savings

From the Convex cost audit (see `branch_prep.md`):

| Driver | Addressable Daily Saving |
|---|---|
| Full-scan collect hotspots (W1a/W1b) | ~$5–10/day |
| Idle cron invocations (W1d) | ~$8–15/day |
| Unbounded reads (W1e) | ~$6–12/day |
| MV full recompute (W2a) | ~$8–18/day |
| Trigger→Convex snapshot overhead (W2b) | ~$5–10/day |
| R2 archival (W3a, post-activation) | ~$8–12/day |
| **Total addressable** | **~$40–77/day** |
| **Annualized** | **~$14k–$28k/yr** |

W3a savings activate only after `ARCHIVE_TO_R2_LIVE=1` and 90-day data reaches threshold.

---

## 6. Deployment Notes

### Order of operations

1. **CONVEX DEPLOY FIRST** — schema additions must land before code:
   - New table: `reservation_vision`
   - New index: `calendar_holds.by_date`
   - New functions: `archive_to_r2`, `snapshot_jobs`, `reservation_vision_backfill`

   ```bash
   npx convex deploy
   ```

2. **Merge branch** — no-ff merge required (main has further automation work since branch point):

   ```bash
   git checkout main
   git merge --no-ff phase3a-convex-cost -m "feat(phase3a): convex cost reduction"
   ```

3. **Push** — Vercel auto-deploy will trigger on push to main.

4. **Run backfill** — manually invoke from Convex dashboard:
   - Function: `reservation_vision_backfill:backfillReservationVision`
   - ~1700 rows, idempotent, resumable (safe to re-run if interrupted)

5. **Monitor archive cron** — leave in `dry_run: true` for 24–48h after deploy:
   - Review Convex logs for dry-run output
   - Confirm correct records selected (>90d, correct statuses)
   - Then: set `ARCHIVE_TO_R2_LIVE=1` in Convex env + change cron arg to `dry_run: false`

6. **Flip snapshot flag** — only after 7-day Convex snapshot parity confirmed:
   - Set `SNAPSHOTS_VIA_CONVEX=1` in Trigger env

### Environment variables required

| Var | Where | Value to activate |
|---|---|---|
| `ARCHIVE_TO_R2_LIVE` | Convex env | `1` |
| `SNAPSHOTS_VIA_CONVEX` | Trigger env | `1` |

---

## 7. Rollback

| Component | Rollback action |
|---|---|
| Full merge | `git revert -m 1 <merge-commit>` on main |
| Snapshots | Set `SNAPSHOTS_VIA_CONVEX=0` (Trigger versions untouched) |
| Archiver | Leave `dry_run: true` (default) — no data moved until explicitly enabled |
| `reservation_vision` dual-write | Additive — revert reader paths only; source `reservations` table unchanged |
| Paginated readers | Callers already handle both shapes; revert pagination code in readers |
| internalQuery conversions | Already partially reverted in fixup; remaining 6 are safe internal-only |

---

## 8. Known Limitations / Deferred Items

- **Old Trigger snapshot files NOT deleted** — `src/trigger/snapshot-*.ts` kept until Convex snapshots prove 7-day parity; delete after confidence window
- **`reservations.resolved_items` column NOT nulled** — defer until `reservation_vision` proves stable for 7 days; nulling frees significant storage
- **Audit items 4–10 not yet addressed** — cold-storage for `audit_log` lifetime data and remaining audit findings are out of scope for Phase 3a; schedule as Phase 3d if needed
- **Phase 3b** (Grok structural refactor) — pending; no dependency on 3a
- **Phase 3c** (OSS library adoptions) — pending; no dependency on 3a

---

## 9. Cross-Links

| Document | Location |
|---|---|
| Phase 1 shipped | `docs/phase1c-shipped.md` |
| Phase 1c R2 snapshot spec | `docs/phase1c-r2-snapshot-spec.md` |
| W1a index audit | `/tmp/wfo-phase3a/w1a_index_uses.md` |
| W1b new indexes | `/tmp/wfo-phase3a/w1b_new_indexes.md` |
| W1c internal queries | `/tmp/wfo-phase3a/w1c_internal_queries.md` |
| W1d cron widening | `/tmp/wfo-phase3a/w1d_cron_widening.md` |
| W1e pagination | `/tmp/wfo-phase3a/w1e_pagination.md` |
| W2a MV incremental | `/tmp/wfo-phase3a/w2a_mv_incremental.md` |
| W2b snapshot consolidation | `/tmp/wfo-phase3a/w2b_snapshot_consolidation.md` |
| W3a archiver | `/tmp/wfo-phase3a/w3a_archiver.md` |
| W3b side table | `/tmp/wfo-phase3a/w3b_side_table.md` |
| W4a verification | `/tmp/wfo-phase3a/w4a_verify.md` |
| W4b adversarial | `/tmp/wfo-phase3a/w4b_adversarial.md` |
| Fixup log | `/tmp/wfo-phase3a/fixup.md` |
| Branch prep / cost audit | `/tmp/wfo-phase3a/branch_prep.md` |
