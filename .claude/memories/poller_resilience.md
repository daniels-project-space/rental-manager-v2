---
name: poller_resilience
description: Layered resilience model protecting the Hygglo poller after the 2026-05-13 silent-halt incident
type: project
---

# Hygglo Poller Resilience

> Rewritten 2026-08-22 during the Trigger.dev run-volume work. The previous
> version described a "5-layer" model in which **two layers had not existed
> since 2026-05-24** (`convex/backup_poll.ts` and the unconditional 15-min
> Convex cron), pointed at the wrong Convex deployment, and documented an auth
> scheme (`X-Internal-Token` / `INTERNAL_POLL_TOKEN`) the route stopped using.
> Anyone debugging a stalled poller against that doc was chasing files that had
> been deleted for three months. Layer descriptions below are verified against
> live code and the live deployment.

## Why this exists
On 2026-05-13 the Trigger.dev `poll-hygglo-inbox` schedule silently stopped
firing. No errors, `consecutiveFailures: 0`, just dead. 5.93 days passed before
anyone noticed (Michelle Crees' new booking didn't surface). Root cause: cloud
bundle frozen — no `trigger deploy` had run since the schedule registered, and a
CLI/SDK version mismatch (`^4.4.5` floated to 4.4.6 while the SDK stayed pinned
at 4.4.5) silently blocked redeploys.

Each layer below independently keeps polling alive when the others fail.

## Current deployment facts
- Convex deployment: **`hearty-oyster-600`** (`.env.local` labels it `dev:` — that
  label is misleading, it IS production). Not `exciting-lion-29`.
- Trigger.dev project: `proj_cdhxwycwcjdmxnsodsmc`.
- Convex deploy command: `./node_modules/.bin/convex dev --once` (NOT
  `convex deploy` — that targets the wrong deployment).
- ⚠️ `convex codegen` also **pushes functions to the deployment**, it is not a
  local-only type generation step. Do not run it casually against a working tree
  containing someone else's in-flight edits.

## L1 — Primary: Trigger.dev declarative cron
- File: `src/trigger/poll-hygglo.ts`, task `pollHyggloInbox` (id `poll-hygglo-inbox`)
- Cron: `HYGGLO_POLL_CRON` = `*/2,15,45 * * * *` (768 ticks/day) from `src/lib/quiet-hours.ts`
- Two internal gates decide whether a tick does real work:
  - **Gate A** `hyggloPollMode(now, manual)` → `full` | `operational` | `skip`
    (active window 08:00–23:00 London, hard 01:00–08:00 break, hourly overnight
    safety poll, full reconciliation on the :00/:15/:30/:45 quarters).
  - **Gate B** cadence — the human `settings.polling_interval_ms` dial (live
    value 300000 = 5 min, clamped to 2–60 min) widened by the adaptive
    `quietStreak` in `sync_state[source="hygglo_poller"]`. Shared helpers live in
    `src/lib/hygglo-poll-backoff.ts` (`resolveEffectivePollInterval`,
    `isPollIntervalElapsed`).
- Roughly half of the 768 daily ticks pass Gate A and then return
  `{ skipped: true }` at Gate B — **Trigger.dev bills a full run for each**. That
  waste is what L0 below is built to remove.
- `lastRunAt` is stamped **only by FULL polls** (`recordSyncRun` sits inside
  `if (isFullPoll)`), so Gate B measures "time since last FULL poll". Preserve
  this if you touch the gate — it is load-bearing for the observed cadence.

## L0 — Convex poll clock (BUILT, TYPECHECKED, DEPLOYED, **NOT YET ENABLED**)
- File: `convex/poll_clock.ts`, internalAction `tickPollClock`
- Intended registration: `convex/crons.ts` `crons.interval("hygglo poll clock", { minutes: 2 }, ...)`
  — currently **commented out**, with an ordered enable-checklist beside it.
- Idea: both gates are decidable from `settings` + `sync_state`, which Convex
  already holds. The clock evaluates them from **local reads only** and POSTs
  `/api/poll-hygglo` **only when work is genuinely due**, so Trigger.dev is never
  paid for a no-op. Cadence and freshness are unchanged; L1's cron then drops to
  a low-frequency self-gating backup (`HYGGLO_POLL_BACKUP_CRON` = `7 */2 * * *`).
- This is the **inverse** of the two Convex→Vercel pollers deleted 2026-05-24:
  those paid for an unconditional round-trip and only then found nothing to do.
- **Blocked on env vars — see "Known broken" below.** Enabling it before those
  are set just logs an enqueue failure every 2 minutes; enabling it after they
  are set but before L1 switches to the backup cron double-polls.

## L2 — Staleness alarm (auto-heal currently dead)
- Cron: `convex/crons.ts` "poller staleness check", `{ minutes: 20 }`
- Action: `convex/poller_health.ts` `runStalenessCheck`
- Threshold: `active`/`paused` accounts with `lastSuccessfulPollAt` older than 30 min
- Effect: Telegram alert (60-min per-account dedup via `poller_alerts`) **plus**
  an attempted auto-heal through `enqueueRecoveryPoll` → `/api/poll-hygglo`.
- Off-hours guard: skips London 23:00–07:00 so an intentionally idle overnight
  poller is not reported as a stall.
- The old L2 (`convex/backup_poll.ts` + `convex/lib/hygglo_minimal.ts`) was
  **deleted 2026-05-24**. Those files do not exist; ignore any doc that cites them.

## L3 — External uptime
- Route: `src/app/api/health/poller/route.ts` (GET 200/503/500)
- Query: `convex/poller_health.ts` `checkPollerHealth` — aggregate counters only,
  never account names, so it is safe for unauthenticated probes.
- UptimeRobot pings every ~5 min, pages Daniel on non-200.

## Known broken (found 2026-08-22, NOT yet fixed)
`POLL_TRIGGER_SECRET` is unset in **both** Vercel production and the Convex
deployment, and `POLL_TRIGGER_URL` is unset in Convex. Consequences:
- `/api/poll-hygglo` fails closed with 503 `server_missing_POLL_TRIGGER_SECRET`
  for **every** caller — the manual incident-response escape hatch does not work.
- L2's `enqueueRecoveryPoll` returns `"POLL_TRIGGER_URL or POLL_TRIGGER_SECRET is
  not configured"` on every stale account. **The staleness auto-heal has been
  dead, not merely unused** — only the Telegram alert half of L2 works.
- L0 cannot be enabled until this is provisioned.

Fix = set `POLL_TRIGGER_SECRET` (same value) in Vercel prod + Convex, and
`POLL_TRIGGER_URL` (`https://<prod-domain>/api/poll-hygglo`) in Convex, then
redeploy Vercel so the route sees the secret.

## Required env vars

### Convex deployment (`hearty-oyster-600`)
| Var | Used by | Status |
|---|---|---|
| TELEGRAM_BOT_TOKEN | L2 alerts | set |
| TELEGRAM_CHAT_ID_DANIEL | L2 alerts | set |
| POLL_TRIGGER_URL | L0 + L2 auto-heal | **MISSING** |
| POLL_TRIGGER_SECRET | L0 + L2 auto-heal | **MISSING** |

### Vercel production
| Var | Status |
|---|---|
| TRIGGER_SECRET_KEY | set |
| POLL_TRIGGER_SECRET | **MISSING** |

Set Convex: `./node_modules/.bin/convex env set <NAME> <value>`.
Auth shape is `Authorization: Bearer <POLL_TRIGGER_SECRET>` — the old
`X-Internal-Token` / `INTERNAL_POLL_TOKEN` scheme is gone.

### Gate-parity caveat
`hyggloPollMode` reads `BYPASS_QUIET_HOURS`, `POLL_ACTIVE_START_MIN` and
`POLL_ACTIVE_END_MIN`. None are set in either runtime today (so defaults apply).
If you ever set one, set it in **both** the Convex deployment and the Trigger.dev
environment — otherwise L0 and L1 disagree about what "due" means and L0 pays to
enqueue runs L1 immediately discards.

## DO NOT
- Break the `order_step` skip-gate in `src/trigger/poll-hygglo.ts` (the
  `getStoredActivity` / `getLatestActivityBatch` batched lookup around the
  `corePoll` call, ~line 267-277). It skips the per-order detail GET only when
  Hygglo's list-endpoint activity stamp matches the stored value **and** the row
  already has `order_step`. Any ambiguity must fall through to a real fetch —
  loosening it re-introduces the 79/79 null `order_step` bug.
- Let Gate B and the L0 clock compute the interval from two separate copies of
  the logic. They share `src/lib/hygglo-poll-backoff.ts` precisely so they cannot
  drift; a drift makes L0 either starve the poller or hand Trigger.dev runs it
  discards.
- Float the `trigger.dev` CLI version in package.json with `^` — must be an EXACT
  pin matching the SDK trio. As of 2026-08-22 both are `4.4.5`. If a deploy
  aborts on version mismatch, use `npx trigger.dev@4.4.5 deploy`.
- Remove `--yes` from any non-interactive `convex deploy` — piped `echo y` blocks
  in a non-TTY.
- Add new `?? ""` env-fallback patterns to trigger.config.ts.
- Skip the failover test when modifying L2 — use `test_setStaleAccount` /
  `test_restoreAccount` in `convex/poller_health.ts`.

## Verification commands
```bash
# poller freshness (what /api/health/poller wraps)
./node_modules/.bin/convex run poller_health:checkPollerHealth '{}'
# last FULL poll + adaptive backoff state
./node_modules/.bin/convex run sync_state:get '{"source":"hygglo_poller"}'
# live public probe
curl -i https://<vercel-prod>/api/health/poller
# staleness failover drill
./node_modules/.bin/convex run poller_health:test_setStaleAccount '{"account":"dbcinema","staleMinutes":60}'
# is a function actually live on the deployment?
./node_modules/.bin/convex function-spec | grep poll_clock
```

## History
- 2026-05-19 — original layers shipped: 4a565ce (order_step + CLI pin), 7ce9fb3
  (`/api/poll-hygglo`), af3a519 (`/api/health/poller`), 1a91dd1 (backup_poll),
  2386130 (staleness cron + Telegram dedup).
- 2026-05-24 — cost audit deleted `backup_poll` and the unconditional 15-min
  Convex cron (~96 + ~192 wasted invocations/day for zero downstream effect).
- 2026-08-22 — `convex/poll_clock.ts` + shared backoff helpers added; doc
  rewritten; missing `POLL_TRIGGER_*` env vars discovered.
