# Renter Bot Lab — deploy checklist (do this only when Daniel says go)

Everything below is additive/inert until run. Nothing in this feature can
send to a real renter regardless of deploy state — see
docs/renter-bot-policy.md's "Send-path safety" section.

## 1. Before pushing

- [ ] Daniel has confirmed the real Vercel-side access perimeter for
      `/renter-bot-lab` (no in-app auth exists anywhere else in this repo —
      confirm what actually protects the deployed app today).
- [ ] Set `RENTER_BOT_LAB_SECRET` (a real passphrase, not committed anywhere)
      in Vercel's env config. Without it, `hasLabAccess()` fails closed —
      the page is unusable, not "open by default."

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

## 4. Only then

- Open `/renter-bot-lab` directly (not yet linked from anywhere) and confirm
  the passphrase gate works.
- Try a live scenario end-to-end, then click "End session" and re-check the
  Reply Inbox is still clean.
- Last: add the HeaderBar nav button (the one remaining build step,
  intentionally not done yet) so it's reachable from the dashboard.

## 5. If anything looks wrong

Everything here is reversible — no data was deleted, only new tables/rows
added. Worst case, delete the new Convex tables and the `renter_bot_*`
files; nothing else in the app depends on them.
