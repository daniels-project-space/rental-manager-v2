# Renter Bot Lab — deploy checklist (historical record; the deploy below already happened 2026-08-17)

Everything below is additive/inert until run. Nothing in this feature can
send to a real renter regardless of deploy state — see
docs/renter-bot-policy.md's "Send-path safety" section.

**Status update, 2026-08-17:** the passphrase gate (`test-lab-gate.ts`,
`LabGateForm`, `/api/renter-bot-lab-auth`) was removed at Daniel's request —
`/renter-bot-lab` is now reachable by anyone with the URL, no login. The
`RENTER_BOT_LAB_SECRET` Vercel env var is orphaned (no longer read by any
code) — harmless to leave, safe to delete whenever convenient. This does not
change the send-path safety guarantee, which was never gated by this and is
enforced structurally instead (see docs/renter-bot-policy.md).

## 1. Before pushing (historical — already done)

- [x] Convex schema/functions deployed to `hearty-oyster-600`.
- [x] ~~Passphrase gate~~ — removed, no longer applicable.

## 2. Push

```bash
npm run dev:convex
```

This pushes the new schema tables (`renter_bot_fixtures`,
`renter_bot_harness_runs`) and all `renter_bot_*` functions to the live
Convex deployment. No existing table/function is modified — this is purely
additive except the two `__probe__`-exclusion filters in `replyInbox.ts`
(which only ever *remove* rows that shouldn't have been visible anyway).

## 3. Smoke test, smallest blast radius first

Via the Convex dashboard or CLI, NOT the Lab UI yet:

1. Run `renter_bot_fixture_seed_v1_scenarios:seedV1Scenarios` once — inserts
   the 20 ported fixtures.
2. Run `renter_bot_harness:runFixture` on ONE fixture id. Confirm a row
   appears in `renter_bot_harness_runs` with a real draft + rubric result.
3. Check the real Reply Inbox in the dashboard — confirm no `__probe__`
   thread is visible (the exclusion filter should make this a non-event,
   but worth eyeballing the first time).
4. Run `renter_bot_harness:runBatch` (no args = all active fixtures).

## 4. Only then (also done)

- [x] Opened `/renter-bot-lab` — no gate now, loads straight to the workspace.
- Try a live scenario end-to-end, then click "End session" and re-check the
  Reply Inbox is still clean.
- [x] HeaderBar nav button added — 🧪 icon, reachable from the dashboard.

## 5. If anything looks wrong

Everything here is reversible — no data was deleted, only new tables/rows
added. Worst case, delete the new Convex tables and the `renter_bot_*`
files; nothing else in the app depends on them.
