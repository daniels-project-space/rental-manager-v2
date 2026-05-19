---
name: poller_resilience
description: 5-layer resilience model protecting the Hygglo poller after the 2026-05-13 silent-halt incident
type: project
---

# Hygglo Poller Resilience — 5 Layers

## Why this exists
On 2026-05-13 the Trigger.dev `poll-hygglo-inbox` schedule silently stopped firing. No errors, `consecutiveFailures: 0`, just dead. 5.93 days passed before anyone noticed (Michelle Crees' new booking didn't surface). Root cause: cloud bundle frozen — no `trigger deploy` had run since the schedule registered, and CLI/SDK version mismatch (^4.4.5 floated to 4.4.6 while SDK pinned to 4.4.5) silently blocked redeploys.

Each layer below independently keeps polling alive when the others fail.

## L1 — Primary: Trigger.dev cron
- File: `src/trigger/poll-hygglo.ts`
- Task: `pollHyggloInbox` cron `*/5 * * * *`
- Writes via `api.hygglo.upsertOrderAsReservation`

## L2 — Secondary: Convex backup poller
- File: `convex/backup_poll.ts` (internalAction `runBackupPoll`)
- Helper: `convex/lib/hygglo_minimal.ts` (light Hygglo client, 60s budget)
- Invoked by L4 staleness alarm OR manual: `npx convex run --prod backup_poll:runBackupPoll '{}'`

## L3 — Tertiary: 15-min Convex cron pokes Vercel route
- Cron: `convex/crons.ts` `hygglo_poll workflow`
- Route: `src/app/api/poll-hygglo/route.ts`
- Auth: `X-Internal-Token` header == `INTERNAL_POLL_TOKEN` env
- Effect: enqueues one-shot Trigger.dev run

## L4 — Staleness alarm + auto-heal
- Cron: `convex/crons.ts` "poller staleness check" every 10 min
- Action: `convex/poller_health.ts` `runStalenessCheck`
- Threshold: `active` accounts with `lastSuccessfulPollAt > now - 30min`
- Effect: Telegram alert + auto-invoke L2 backup. 60-min per-account dedup via `poller_alerts` table.

## L5 — External uptime
- Route: `src/app/api/health/poller/route.ts` (GET 200/503/500)
- Query: `convex/poller_health.ts` `checkPollerHealth`
- Set up UptimeRobot pinging every 5 min, paging Daniel on non-200

## Required env vars

### Convex prod (`exciting-lion-29`)
| Var | Used by |
|---|---|
| TELEGRAM_BOT_TOKEN | L4 |
| TELEGRAM_CHAT_ID_DANIEL | L4 |
| INTERNAL_POLL_TOKEN | L3 (must match Vercel) |
| POLL_TRIGGER_URL | L3 (Vercel route URL) |

### Vercel prod
| Var |
|---|
| INTERNAL_POLL_TOKEN |
| TRIGGER_SECRET_KEY |

Set Convex: `npx convex env set --prod <NAME> <value>`. Set Vercel via dashboard.

## DO NOT
- Remove `--yes` from `npx convex deploy --yes` — piped `echo y` blocks in non-TTY; `--yes` is the only non-interactive option that works.
- Break the `has_order_step` skip-gate in `src/trigger/poll-hygglo.ts:369-384` — re-introduces the 79/79 null `order_step` bug.
- Float `trigger.dev` CLI version in package.json with `^` — must be EXACT pin matching SDK trio. As of 2026-05-19 = `4.4.5`.
- Add new `?? ""` env-fallback patterns to trigger.config.ts.
- Skip the failover test when modifying L4 — use `test_setStaleAccount` / `test_restoreAccount` mutations in `convex/poller_health.ts`.

## Verification commands
```
curl -i https://<vercel-prod>/api/health/poller
npx convex run --prod backup_poll:runBackupPoll '{}'
npx convex run --prod poller_health:test_setStaleAccount '{"account":"dbcinema","staleMinutes":60}'
```

## Commits that shipped this (2026-05-19)
- 4a565ce: order_step end-to-end + pin trigger.dev CLI
- 7ce9fb3: /api/poll-hygglo route + cron header
- af3a519: /api/health/poller + checkPollerHealth query
- 1a91dd1: backup_poll internalAction + hygglo_minimal lib
- 2386130: staleness cron + Telegram client + dedup table
