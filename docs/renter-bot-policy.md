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
| **Gear knowledge** (what it may say about items) | Tool-grounded via `renter_bot_tools.ts`, `factsClaimed` cross-check | **Not implemented** — `n_a` in rubric | Would need factsClaimed cross-referenced against a real catalog source. Left as a gap, not guessed at |
| **Pricing / quoting** | Tool-grounded pricing + `FABRICATED_QUOTE`/`INTERNAL_PRICING_DISCLOSURE` filters | Rubric `pricing_quoting` (via supplemental `MADE_UP_PRICE` check against verified `factsClaimed`) | none found |
| **Negotiation** | `convex/lib/renter_bot_negotiation.ts` (full file — `HOLD_FIRM → OFFER_ALTERNATIVES → SOFT_YIELD` by objection count), exposed as tool `get_negotiation_stance`, near 1:1 port of V1 `prompt-manager.service.ts:254-259` | **Not implemented** — `n_a` in rubric | Correctness needs conversation-level state, not a single-draft check. Future work, not invented here |
| **Discounts / retention** | `renter_bot_rules.ts:67-80` (High-Value / Travel-Distance / Long-Rental tiers, "one discount only") | **Not implemented** — `n_a` in rubric | V1's first-time-renter £ discount flow (`prompt-manager.service.ts:393-396`) has **no confirmed V2 equivalent** — flagged, not ported without Daniel's say-so on whether it should exist |
| **Follow-up / proactive texting** | — | **Not implemented** — `n_a` in rubric | **Confirmed absent in V2 entirely.** V1 had proactive "Travel Discount Recovery" follow-up (`prompt-manager.service.ts:258`); V2 appears reply-only. This is a real product decision for Daniel, not an oversight to silently fix |
| **Cross-account consistency** | `renter_bot_rules.ts:47-50,59-60`; `renter_bot.ts:64-65` (per-account voice) | Rubric `cross_account_consistency` (supplemental `DUAL_ACCOUNT` check) | No seeded "Diogo voice" DB rule exists — only inline in the system prompt. Diogo postdates the V1→V2 rule port |
| **Location handling** | `renter_bot.ts:50,91-92` (never reveal address pre-confirmation); filters `VAGUE_CONFIRMED_LOCATION` (flag) / `PREMATURE_CONFIRMATION` (block) | Rubric `location_handling` | none found |
| **Anti-manipulation / rule adherence** | `renter_bot.ts:94-98`; filters `PHYSICAL_PRESENCE`, `FALSE_ACTION_CLAIM`, `INVALID_TIME_ACCEPTED`; escalation rules `renter_bot.ts:57-62` (complaint/damage/cancellation/blacklist/Swedish/uncertain → `needs_human=true`) | Rubric `anti_manipulation_rule_adherence` | V1's 7 `validation.service.ts` validators not individually inventoried against V2 yet — worth a follow-up read if the harness surfaces a gap here |
| **Problem solving** | Escalation logic (`renter_bot.ts:57-62`) routes hard cases to Daniel instead of improvising | **Not implemented** — `n_a` in rubric | Needs qualitative judgment (human pass or a separate LLM-judge call), not a regex check |
| **Tone / language** | Per-account voice `renter_bot.ts:64-89` (MIRROR THE RENTER, emoji limits) | Rubric `tone_language`, via ported V1 scorers (`convex/lib/renter_bot_tone_scorer.ts`) | **No tone rule exists for Diogo anywhere** — scorer returns `n_a` rather than a fabricated heuristic. Needs Daniel's input on what "Diogo voice" should sound like before a real scorer can be written |

## Known bugs/gotchas surfaced during this build (not policy gaps, but relevant)

- Haiku (the renter-bot's fixed model) is documented as under-calling its own tools (`src/app/api/renter-bot-draft/route.ts:62-63` comment) — when the harness shows reasoning/grounding failures, always test the same fixture on the existing Sonnet-escalation lane before concluding it's a model problem (see the plan's decision framework).
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
