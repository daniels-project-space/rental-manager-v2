# Renter Bot Policy Index

Living index of what the renter-facing bot (`src/mastra/agents/renter_bot.ts`,
agent id `renter-bot-v1`) is and isn't told to do, and where each rule
actually lives in code today. This is a **map, not a ruleset copy** —
`docs/renter-bot-v2-plan.md` / `-appendix.md` stay as the historical decision
record; this file tracks current, verified reality and gets updated as the
test harness (`convex/renter_bot_harness.ts`) surfaces real gaps.

Accounts / personas (real `account_slug` values, confirmed in
`convex/lib/reservations/accounts.ts`): `dbcinema_web` ("Daniel"), `leo`
("Leo"), `diogo` ("Diogo"). Not "daniel"/"leo"/"diogo" — a wrong assumption
corrected during this build.

Scoring: `convex/lib/renter_bot_rubric.ts`, run via
`convex/renter_bot_harness.ts` against fixtures in `renter_bot_fixtures`.

## Categories

| Category | Where it's enforced today | Automated check | Open question |
|---|---|---|---|
| **Disclosure** (never reveal bot/AI/system, platform name, pickup address pre-confirmation) | System prompt `renter_bot.ts:31,70-113`; regex hard-filters `PLATFORM_LEAK`/`INTERNAL_PRICING_DISCLOSURE` (`renter_bot_filters.ts:54-59,128-134`); DB-seeded rules `renter_bot_rules.ts:97-106` (priority 10) | Rubric `disclosure` category | `DUAL_ACCOUNT` (cross-account leak) has a seeded rule but no regex backstop in the real filters — covered only by our new supplemental filter, not production |
| **Upselling** | System prompt `renter_bot.ts:105`; filter `UPSELL_LANGUAGE` (`renter_bot_filters.ts:92-99`, strip-class); seed rule "Upsell Opportunities" (`renter_bot_rules.ts:89-90`) | Rubric `upsell` category | **Confirmed inconsistency, not resolved**: the seed rule allows upsell "when interested," the filter strips it unconditionally. Needs a real fixture run to characterize before either side is treated as correct — do not silently pick one |
| **Gear knowledge** (what it may say about items) | `get_listing_context` and other Native tools separate listing claims from mapped physical stock; run receipts preserve listing and inventory sources | Selected technical/identity and supported-claim guards exist; broad gear-answer correctness is **unassessed** in the rubric | The catalogue still needs complete, owner-confirmed facts and scenario checks for answer completeness and compatibility |
| **Pricing / quoting** | Tool-grounded pricing + `FABRICATED_QUOTE`/`INTERNAL_PRICING_DISCLOSURE` filters | Rubric `pricing_quoting` (via supplemental `MADE_UP_PRICE` check against verified `factsClaimed`) | none found |
| **Negotiation** | Shared `computeNegotiationStance` in `convex/lib/renter_bot_negotiation.ts`, exposed as `get_negotiation_stance`; strategy uses scoped conversation history and is not financial approval | The strategy tool is available; overall negotiation quality remains **unassessed** by the per-reply rubric | Qualify the hold/alternative/escalation sequence through complete synthetic conversations and current Native quotes |
| **Discounts / retention** | Travel compensation is sequenced and capped in `convex/lib/travel_compensation.ts`; applying it changes only the isolated Lab order. Other price concessions still require current policy evidence and a Native quote | Travel-offer sequence, amount cap, and price evidence have deterministic checks; generic negotiation quality remains unassessed | Verify timing, one-off cap, and repricing after basket/date changes; do not infer discount authority from silence |
| **Follow-up / proactive texting** | `convex/renter_bot_lab_followups.ts` creates isolated drafts for missing exact times after the 24-hour confirmation window and qualifying location follow-up; stale drafts are suppressed | Follow-up timing and draft eligibility are checked by Lab workflow tests; the per-reply rubric marks this category **unassessed**. Drafts have no send path | This is Lab-only. No real renter follow-up or sending is enabled |
| **Cross-account consistency** | `renter_bot_rules.ts:47-50,59-60`; `renter_bot.ts:64-65` (per-account voice) | Rubric `cross_account_consistency` (supplemental `DUAL_ACCOUNT` check) | No seeded "Diogo voice" DB rule exists — only inline in the system prompt. Diogo postdates the V1→V2 rule port |
| **Location handling** | `renter_bot.ts:50,91-92` (never reveal address pre-confirmation); filters `VAGUE_CONFIRMED_LOCATION` (flag) / `PREMATURE_CONFIRMATION` (block) | Rubric `location_handling` | none found |
| **Anti-manipulation / rule adherence** | `renter_bot.ts:94-98`; filters `PHYSICAL_PRESENCE`, `FALSE_ACTION_CLAIM`, `INVALID_TIME_ACCEPTED`; escalation rules `renter_bot.ts:57-62` (complaint/damage/cancellation/blacklist/Swedish/uncertain → `needs_human=true`) | Rubric `anti_manipulation_rule_adherence` | V1's 7 `validation.service.ts` validators not individually inventoried against V2 yet — worth a follow-up read if the harness surfaces a gap here |
| **Problem solving** | Native tools handle item lookup, availability, quoting, and Lab-only order changes; escalation logic in `renter_bot.ts` routes defined high-risk cases for review | Tool/state safety is checked; end-to-end solution quality remains **unassessed** | Test that the bot resolves the renter's actual request, not merely that a safe tool call occurred |
| **Tone / language** | Per-account voice in `renter_bot.ts`; account-specific tone scorer in `convex/lib/renter_bot_tone_scorer.ts` | Scored for accounts with a tone rule; missing tone coverage is **unassessed**, not `n_a` | Diogo still has no tone rule; avoid claiming cross-account tone qualification until one is defined and tested |

## Known bugs/gotchas surfaced during this build (not policy gaps, but relevant)

- Historical Haiku/Sonnet model-comparison notes no longer describe the current Lab lane. The isolated Lab currently reports `google/gemini-3.7-flash`; keep that model fixed for MVP qualification and use each run's tool, source, guard, rubric, and token evidence to diagnose failures.
- `renter_bot_probe.ts`'s `cleanup()` did not sweep `renter_bot_drafts` before this build (only `conversations`/`hygglo_messages`) — a probe run could leave a phantom cached draft behind. Fixed as part of building the harness runner.
- `getReplyQueue` and `threadsNeedingDraft` in `convex/replyInbox.ts` did not exclude `__probe__`-prefixed threads before this build — fixed.

## Send-path safety (why the harness can never reach a real renter)

Verified directly against code, not memory, 2026-08-16:

1. `src/lib/hygglo-write.ts` `sendMessage()` (automated path) is hardcoded to always return `{status:"skipped"}` — no env var can lift it.
2. `convex/settings.ts` throws if `ALLOW_HYGGLO_SEND` is ever set `true`.
3. `sendManualRenterMessage` (the one real send path) fires only from Daniel's deliberate click in the Reply Inbox, gated by `ALLOW_MANUAL_RENTER_SEND`.
4. `ALLOW_MANUAL_ORDER_ACTIONS` / `ALLOW_RETURN_WRITES` separately gate approve/decline/close.
5. `hygglo-core`'s `HyggloCore.sendMessage()` is defined as `(): never => chatDisabled()` — throws unconditionally, by type signature, not just convention.

The harness (`renter_bot_harness.ts`) and importer (`renter_bot_fixture_import.ts`) call only `generateDraft` and `getOrder` respectively — neither imports `hygglo-write.ts` or any of the four gated functions above.
