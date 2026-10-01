# Renter bot production readiness audit — 2026-10-01

Status: **in progress; production readiness is not established**. Customer sending remains under existing deliberate human approval. The model remains the configured Gemini 3.7 Flash lane; no quality or model downgrade is part of this work.

## Required end state

The lab and human reply inbox must run the same reliable reasoning and checks. Replies must be grounded in current owned inventory, exact listing identities, compatible specs and kit, correct account prices, physical stock quantities and requested dates. Marketing-only equipment must never be offered. The bot must follow the actual approval/payment/verification/collection/in-use/return/cancellation stage, retain conversational context, answer the question asked, make relevant sales recommendations, escalate actual consequential uncertainty, and give operators clear review evidence. Realistic multi-turn and historical replay tests must prove these behaviors, including failures, isolation and stale updates. A green build or a narrow fixture run cannot establish readiness.

## Reproduced causes and foundation changes

| Finding | Evidence / source | Change |
| --- | --- | --- |
| Marketing gear was reported available | Live `renter_bot_tools:check_availability` returned `available:true` for RED Komodo on 2026-10-02 through 2026-10-03. The old implementation only searched text-matched competing rentals. | Owned identity is checked first; explicit marketing/inactive stock is not rentable, unknown/ambiguous identity has no positive availability verdict. |
| One competing booking blocked every unit | Same availability implementation ignored owned/requested quantities, repairs, blackouts and vacation. It also scanned from 30 days before the request without an upper index bound. | New shared stock evaluator checks peak simultaneous physical quantity, extensions, repairs, owner blackouts, global vacation and buffered return times. Indexed reads use only active status pools. |
| Prior bot turns were absent in lab history | `sendTestMessage` appended renter messages and returned drafts without an owner message. | Successful simulated replies are persisted as test-only owner turns; empty/withheld results never reuse an older draft. |
| Loaded transcript never reached the primary prompt | `recentTranscript` in the draft route was assigned but never used. The same route told the model not to re-fetch context. | The primary prompt receives recent role-labeled history as quoted conversation data. |
| Past end date was treated as proof of return | Inline route stage branch labeled every `end_date < today` rental finished; guard also treated active `RETURNED` as completed. Hygglo stores the next action: `RETURNED` is awaiting return. | Operational stage is derived from authoritative status and active step, with explicit overdue handling and no assumption that a due pickup happened. |
| Evaluator counted infrastructure failure as success | Harness assigned every `status:skipped` a pass, including `subscription_unavailable`. | Only an explicitly expected human-review case can pass as an escalation; upstream/no-reply failures fail evaluation. |
| Model and fact metadata disappeared | The lab read `renter_bot_drafts` even though the active pipeline caches into the conversation. Recent runs showed `model:unknown`. | Route generation metadata is forwarded through the actual action to lab/harness records. Model claims remain unverified until independently checked. |
| Prompt contradictions impaired sales | Agent prohibited qualifying questions and all upsell language while route craft requested relevant additions; an unconditional afternoon ban contradicted configured pickup windows. | Allow minimal necessary clarification and relevant compatible owned additions; account configuration supplies the windows. |
| Lab date badge used another occupancy rule | `LiveChatSim` called any overlapping booking a conflict despite multiple owned units. | The badge uses the exact requested-window stock query used by the agent tool. |

## Evidence captured locally

- `/tmp/rental-bot-marketing-stock-before.json`: live marketing false positive.
- `/tmp/rental-bot-audit-baseline.txt`: fresh live lab replay, two FX3 cameras Friday through Sunday; it rejected the FX3 and substituted A7 III. This is a replay result, not proof of the correct current stock verdict.
- `/tmp/rental-bot-recent-runs.json`: 40 historical lab records. These are dated historical evidence, not a current production pass rate.
- New pure stock and lifecycle tests cover marketing gear, multi-unit demand, independent renters, extensions, disjoint hires, later conflicts, repairs, blackouts, vacation, handovers, invalid/long windows, privacy and the actual active-step semantics.

## Remaining readiness work

1. Independently validate every factual claim against successful tool results for the exact item, quantity, dates, price basis and kit. A tool being called is not evidence that it succeeded, and one checked item must not authorize claims about others.
2. Audit full listing/bundle resolution and partial mappings. The generic `reservationItemUnits` legacy union can still retain stale LLM components beside deterministic mappings; listing ownership cannot be inferred from one primary body when a kit contains other equipment.
3. Unify all draft paths and catalog readers, including scheduled Mastra workflow and the fallback. Remove or repair divergent availability and policy logic; do not let an outage silently select a weaker or different route.
4. Verify pricing and negotiation over quantity changes, mixed baskets, tiered durations, discounts, booking modifications and per-account listings. Minimum-value nudges must respect stage and prior refusal.
5. Verify recommendations using real specs, lens mounts, adapters, compatibility, kit inclusions and requested use/budget; date-check alternatives and additions, and prohibit marketing-only or unpriced kit components.
6. Make successful tool-result receipts, authoritative stage, model, failures, latency and cost inspectable in the human review UI. Do not present unverified model `factsClaimed` as verified.
7. Harden evaluation: fresh rolling dates, actual live ground truth, whole conversations, realistic stage transitions and historical replays. Cover reasonable escalations versus lost-sales silence, repetitive replies, long-context drift, prompt injection, parallel-thread isolation and stale operator actions.
8. Complete lab isolation: simulation orders must never affect real stock or queues, cleanup must target the requesting session, simulated edits must not imply real Hygglo changes, and edited date controls must update the actual simulated order.
9. Inspect deployed lab and human inbox on desktop/mobile and verify exact production alias/backend/Trigger versions. Run repeatable realistic live scenarios through the actual production drafting path before proposing readiness for human-supervised sales.

Completion requires evidence against every requirement above; this foundation release is not a declaration that the bot is ready.

## Second audit pass

- Exact production alias verified at foundation SHA `48329ee515ccf461f868bcab78a1f02b83d42278`; live backend is still `hearty-oyster-600`.
- Fresh real Lab turns correctly distinguished two unavailable FX3s from one available FX3, retained 2–4 October in the follow-up, and recommended Sony GM 16–35mm f2.8. Live pricing independently returned £42/day and £126 for three days; the proposed camera/lens total was £186. These examples alone do not establish broad sales readiness.
- The evaluator falsely failed the replies because **unverified model claims were treated as contradictory price facts**, not because a real price check refuted them. It also concatenated all digits in a compound price claim. Both defects are fixed; unknown claims receive review flags instead of fabricated-fact failures.
- New tool evidence accepts successful result payloads only, distinguishes positive and negative stock verdicts, and retains item, quantity, dates and check time. Tool-call counts cannot authorize a claim. Stock receipts are persisted to the actual conversation and Lab run, and exposed in human review; model `factsClaimed` remain unverified.
- The human action read the **first** 40 messages and negotiation tool the first 50. Both now take recent chronological messages; late historical imports cannot become the latest inbound. Draft caching rechecks that the same inbound is still latest.
- Closing one Lab no longer deletes other sessions; its own simulated order is removed too. Session/account mismatch is rejected, ids have collision resistance, and date controls persist through the real simulated-order mutation. Simulated additions cannot silently clamp the requested quantity or add stock unavailable for the dates.
- The registered legacy workflow has no current cron caller. It now calls the canonical action instead of its own differently grounded agent; the obsolete alternate model/calendar fallback was removed from the human action. Existing send gates remain in place.
- Alternatives can be date/quantity filtered, exclude unknown lens mounts when a mount was requested, respect authoritative single-unit mappings, and take tiers from the same cheapest listing that supplied the price. Date-less ownership and adapters are explicitly not evidence of availability.
- Product-id-linked listing context now receives the same real card, battery, dimensions, kit, replacement value and specification fields as name-resolved inquiries.

Still open: per-claim identity/date/quantity enforcement across free prose; full and partial kit-resolution authority; complete basket/tier/negotiation coverage; adapter and kit inclusion accuracy; realistic stages, historical replay, injection and long-turn sales quality; final deployed UI and provider verification. The original end state above remains unchanged.

## Third audit pass

- A third real follow-up exposed a £186 → £197 drift after adding the lens: Lab seeds omitted the camera's tier table. New seeds carry the actual listing tiers. Live FX3 quote, alternatives and seeded order now agree: £49 one-day, £42/day for three days, £126 total.
- A shared base-listing identity helper allows standard bundled cards/batteries but excludes independent lenses, multi-body sets, unknown components and empty marketing overrides. It is used by direct pricing, listing context, alternatives, adapters and simulated-order prices. This fixes both stale bundle rates and dropping a genuine base camera listing just because it includes a card.
- Removed the catalog fallback's invented 0.7/0.5/0.4 multi-day discount curve. Unknown duration tiers produce no exact total; catalog identity must resolve to owned active inventory.
- The time guard falsely flagged an explicit refusal of 8am because a later sentence mentioned conditional booking confirmation. It now examines time-local acceptance/refusal, with tests for both direct and implicit bad agreements.
- Browser inspection confirmed Lab date changes persist, but mobile had horizontal overflow and the fixed chat height put its input over recent runs. Responsive wrapping, minimum-width constraints and growing chat height fix that surface. The listing card now uses the same account/date-specific price query as the bot rather than a stale catalog range.
- Probe seeding lacked its own prefix gate and could accept a real conversation id. It now refuses real ids before any writes; simulated-send learning also refuses real thread ids. Learning storage isolation still needs inspection before calling that simulation helper.

## Fourth audit pass

- Live raw evidence showed duplicate/partial Mastra result events being mistaken for stock receipts; a partial `{call_id}` entry caused draft persistence validation to fail. Receipts now require the complete stock shape and are deduplicated, with a second validation boundary in Convex. The real follow-up now saves successfully.
- Current direct quote and seeded/modified order agree on £176 for one FX3 (£126) plus Sony GM 16–35mm f2.8 (£50) for 2–4 October. The earlier £186/£197 results are historical reproduction evidence; they are not the validated current total.
- An overdue-return probe reports `RETURN_OVERDUE` but is withheld for a competitor referral. This is an unresolved sales/policy behavior, not a successful readiness case. Probe results now expose status/reason/model/stock evidence and probe-only rejected candidate text so withholding cannot masquerade as a pass.
- Server tool scope binds account and conversation identity across query/action/mutation calls, including retries. The model cannot switch to a different conversation/account via its arguments. Parallel asynchronous scope isolation has a regression test.
- The route cache keys now use Convex function names; simulated-order reads bypass caching so mutations are followed by a fresh proof/read of the order. Successful additions return their stock proof as well.
- Source audit confirmed simulated learning could upsert the **production** lesson set. Test threads now stop before learning; the simulation helper explicitly returns `scheduled:false`. Genuine manual-send learning remains as before.
- Probe cleanup uses thread-id indexes for conversations, reservations and orders. It never needs to scan all live reservations to close one test.
- Deployed desktop/mobile Lab checks at SHA `573f898cdf0763042d9e1e6fc794278080b021a3` verified date persistence, no browser errors and no mobile horizontal overflow. The current order now supplies the item/date banner, and overlapping commitments are no longer mislabeled as proof that all units are unavailable.

Next evidence to collect: final alias/UI for this pass; inspect the overdue candidate and fix its root cause; fresh marketing/recommendation/price/stage/negotiation/long-context/injection replays; complete listing/kit and per-item claim authority. Sending remains gated and readiness remains unproven.

## Fifth audit pass

- Fourth-pass release is verified on the exact production alias at SHA `3c15d64e6bf731b5e922a1d3cefcb1ba802cff96`.
- Independent lens pricing still disagreed with the basket after earlier apparent agreement. Root cause: two published, currently synced Leo listings both charge £20 for one day but charge **£50 versus £60 for three days**. Different DB iteration orders picked different equal-price rows. The shared selector now breaks equal-day-price ties by product id; all canonical item quotes select the same base listing. An explicitly selected listing retains its own price. Live direct lens pricing now returns £50 for three days, matching the basket's £176 total.
- A further overdue replay returned a useful same-account return plan and no competitor, with physical-presence wording removed by the guard. This is one stochastic success following a failure, not proof the behavior is reliable; retain the failed case in the suite.
- Stage audit found the explicit `awaiting_owner_action` flag was omitted from the new lifecycle helper. It now takes precedence over `APPROVED` when the owner's approval is still required; a regression test covers that source-state combination.


## Sixth audit pass — simulation storage

- Probe seeding wrote confirmed/ongoing test rentals to the production `reservations` table. The new stock helper excluded them, but every other calendar/revenue/return/notification reader needed its own filter. This is a structural isolation defect.
- Lifecycle snapshots now live in `renter_bot_lab_bookings`, using the identical reservation validator. Only the shared bot-context reader can select this table, and only for a prefix-tagged simulation. Real conversations always read real reservations. Production storage and reader indexes remain unchanged.
- The prefix-bounded atomic migration moved one legacy overdue test rental; a repeat moved zero. Live inspection found zero simulation rows remaining in real reservations. The bot still reads the migrated snapshot as `RETURN_OVERDUE`; no genuine booking was migrated.
- Simulated date edits also update the isolated lifecycle snapshot, so context/stage/date tools cannot retain the old window after the operator applies new dates. Session cleanup removes only its own snapshot and simulated basket.
- Validation and final deployment evidence are recorded after the live isolation replay. Full bundle and per-claim authority, realistic repeated sales conversations and broader readiness qualification remain open. Human sending remains under deliberate operator control.

- Repeatable live qualification (`node scripts/check-lab-isolation.mjs`) passed: no synthetic rows in production storage, unchanged stock, edited dates agreed in both bot readers, `CONFIRMED_UPCOMING` stage, a real Gemini 3.7 Flash collection reply with the Leo pickup address, and targeted cleanup preserving the earlier overdue scenario. Receipt: `/tmp/rental-bot-isolation-live-proof.json`.
- Full Next production build and Convex typecheck/deployment passed. The relevant stock, lifecycle, extension, identity, pricing selector, evidence and scope tests passed (104); the simulated basket arithmetic suite is checked separately. These prove this isolation change, not the full readiness standard.


## Seventh audit pass — complete listing quantities

- Reproduced a live full-kit false positive: Leo product **1172559** is two FX3 bodies plus two GM 24–70mm lenses, but `get_listing_context` selected its lens `masterItemId` and the old prefetch checked **one lens**. That lens was available; independent stock proof showed **two FX3s unavailable**, with only one free after real bookings/repair. Receipts: `/tmp/rental-bot-bundle-before.json`, `/tmp/rental-bot-bundle-camera-stock.json`, `/tmp/rental-bot-bundle-old-stock.json`.
- Full listing checks now use the account/product component mapping and multiply each physical component by requested kit count. Every independent camera/lens/etc must pass; standard bundled cards/batteries are not separate capacity limits. Missing/partial identity remains unverified; one primary item cannot prove whole-kit ownership or availability. Returned component receipts retain exact requested units and dates.
- Listing context selects camera metadata from the mapped camera instead of an accidentally linked lens. The prompt labels those specs/dimensions/replacement values as **per individual item**, lists all mapped inclusions, suppresses charging again for included lenses, and checks every requested line rather than only the first three.
- Corrected a verified missing lens in **Leo 1172945 / DB Cinema 1011866**: both exact titles include one Sony 28–70mm, the current Leo included-items text confirms it, and active owned inventory has two. The earlier body/card-only override omitted it. Added the lens while preserving the camera/card mapping. Live ground truth and update receipts: `/tmp/rental-bot-missing-kit-groundtruth.json`, `/tmp/rental-bot-missing-kit-correction.json`.
- The output guard previously fabricated `available:true` from owned identity on fresh inquiries and used an older calendar calculation that omitted repairs. It now receives actual stock receipts only. Contradiction checking compares each item's local clause, so an unrelated unavailable lens cannot hide a false available-camera claim.
- Regression tests include primary-only mappings, camera and lens bottlenecks, requested kit count, duplicate components, standard accessories, marketing/unknown components, invalid quantities, independent receipts and correct/incorrect mixed availability replies. Broader partial legacy reservation mappings, per-claim model/date/price/spec verification and repeated realistic sales qualification remain open; no claim of full readiness is made here.

- Existing fully mapped reservations also omitted the raw listing quantity multiplier: two reserved two-camera kits could hold only two bodies in the shared stock calculation. It now holds four; four regression tests distinguish built-in title counts from separately requested kit count and stale LLM decomposition.
- Live corrected kit proof now reports **not available**, requiring two FX3s (one free) and two GM lenses (two free); primary metadata is correctly the FX3 camera. The fixed 28–70mm kit checks both its one body and one lens. Receipts: `/tmp/rental-bot-bundle-stock-proof.json`, `/tmp/rental-bot-corrected-kit-stock-proof.json`.
- `node scripts/check-renter-kit-stock.mjs` is the repeatable live qualification: rolling dates, exact real listing, independent component queries, real draft path and both component receipts, with its own session always cleaned up. The 199 relevant regression tests passed; final live draft and production alias evidence follow after release.
