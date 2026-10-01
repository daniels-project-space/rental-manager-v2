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
