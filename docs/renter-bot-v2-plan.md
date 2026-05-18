# Renter-Facing Bot — V2 plan (READ-ONLY through Phase 3)

> Bring the V1 NestJS bot's intelligence into V2's Convex+Mastra+Trigger stack
> without losing the read-only safety net. Daniel reviews every draft until
> we've earned auto-send.

**Status:** planning · **Owner:** Daniel · **Target start:** 2026-05-19
**Companion docs:** [[architecture_rmv2_ai_provider]] · [[architecture_rmv2_dashboard_perf]]

---

## 1. What V1 actually did (audit results)

`/home/ubuntu/rental-manager/` is a NestJS app inactive on the VPS. The bot
core lives across ~30 modules; the load-bearing ones for V2 portability are:

| V1 module | Role | V2 equivalent |
|---|---|---|
| `autonomous.service.ts` | The main `processMessage` orchestrator + 30+ `@Cron`s. ~5,500 lines. | Trigger.dev tasks + Mastra workflow |
| `pipeline/*.ts` | **10-layer message pipeline** (classify → think → gather → fence → talk → filter → contract → ground → check → state) | New Mastra agent (Phase 1) |
| `prompts/prompt-manager.service.ts` | System-prompt assembly | `convex/lib/renter_bot_prompts.ts` (new) |
| `rules/rules.service.ts` | DB-stored rules with 5-min TTL cache | `convex/rules` (table exists, empty) |
| `conversation-tree/` | 7-stage state machine (INQUIRY → DEAD) | `conversation_stage` column on `conversations` (add) |
| `verification/` | Verification flow | Phase 3 |
| `delivery/` | Delivery negotiation | Phase 3 |
| `blacklist/` | Per-renter blacklist | `renters.blacklisted` (exists) |
| `renter-profile/` | Cross-rental renter DNA | `renters` + new `renter_dna` columns |
| `follow-up/` | Re-engagement reminders | Phase 3 |
| `telegram/` | Operator approval loop | Convex `renter_bot_draft` row + dashboard widget |

**14 message intents** drove the contract layer:
`PRICING_INQUIRY · AVAILABILITY_CHECK · LOGISTICS · EQUIPMENT_QUESTION · BOOKING_ACTION · GREETING · NEGOTIATION · ACKNOWLEDGMENT · COMPLAINT · CANCELLATION · DAMAGE_REPORT · RETURN_CONFIRMATION · GOODBYE · GENERAL`

**Renter DNA** (5 axes, evolves per message): style · expertise · driver · energy · decisionSpeed

**Conversation stages** (gate which prompts/actions fire):
`INQUIRY → INTERESTED → READY_TO_BOOK → BOOKED → CONFIRMED → COMPLETED` (+ `DEAD`)

**Hard filters** (regex-enforced, never reach renter): physical-presence claims, fabricated quotes, internal-action leaks, "Hygglo" platform leaks, time-logic errors, upsell language, qualifying questions, AI chain-of-thought leakage.

**Operator review flow:** every inbound triggered `processMessage` → AI draft → filter/contract checks → either `hyggloService.sendMessage()` directly (autonomous) OR `DecisionPromptConfig` to Telegram (manual approval). Most production traffic ran auto-send.

## 2. V2 infrastructure inventory (what we can build on)

| Surface | Status | Notes |
|---|---|---|
| **`hygglo_messages` table** | ✅ live | Every inbound + outbound message ingested by `poll-hygglo.ts`; indexed by `thread_id`, `fetched_at`. `listByThread` query returns last 50 in chronological order. |
| **`conversations` table** | ✅ scaffolded, empty | Stores `thread_id`, `renter_id`, `last_msg_at`. Need to start populating + add `conversation_stage`. |
| **`conv_extracted_facts` table** | ✅ scaffolded, empty | Per-conversation extracted facts (rental dates, intent, project type) — keyed by renter_id / item_id. |
| **`renters` table** | ✅ live | Has `blacklisted`, `blacklist_reason`, `hygglo_rating`, `total_rentals_count`, `total_spend_gbp`. No DNA columns yet. |
| **`ai_decision` table + audit** | ✅ live (read-only mode field) | Existing precedent for our advisory pattern — `hygglo.attempted=false` means READ_ONLY. Reuse the same approval flow for renter drafts. |
| **`rules` table** | ✅ scaffolded, empty | Same shape as V1; needs seeding from V1's `Rule` Postgres table. |
| **`pricing_catalog`** | ✅ live + complete | 80-90% of V1 hard-coded pricing already imported. |
| **`listing_photo_reference`** | ✅ live | 101 manually-verified entries (the V1 photo bank, ported). |
| **`bundles` + `bundle_items`** | ✅ live | Bundle-decomposition logic for resolved_items. |
| **Polling** | ✅ live | `poll-hygglo.ts` Trigger.dev task ingests messages every cycle, calls `upsertMessages` mutation. |
| **Mastra workflow** | ✅ live | `hygglo_poll.ts` runs the order-decision flow. Renter-bot can be a sibling workflow OR a new step. |
| **LLM provider** | ✅ live | `getLlmModel()` routes to OpenRouter→DeepSeek by default. Renter-bot gets it for free. |
| **Rules-based decision engine** | ✅ live | `decideRules` step in `hygglo_poll.ts` — pattern can be reused for renter-bot's deterministic gates (blacklist short-circuit etc). |

**Key gap:** V2 currently has NO automatic action on inbound messages — `hygglo_messages` accumulate, the dashboard shows them via `HyggloInbox`, but nothing classifies / drafts / responds.

**Key strength:** V2's READ-ONLY-MODE is already the default. The whole `ai_decision` flow is built around "AI proposes, owner disposes". The renter-bot fits the same mold.

---

## 3. Design principles

1. **READ-ONLY through Phase 3.** Bot writes drafts to Convex; never calls `hyggloService.sendMessage()`. Daniel manually copies/edits each reply or one-clicks Send from the dashboard (which is itself a Stagehand UI-action — still not autonomous from the bot's perspective).
2. **Hard filters as code, not prompt.** The 14-intent contract + the regex hard-filter list from V1 port verbatim. Tested as pure functions. The LLM's output is rewritten or rejected, not just prompted-against.
3. **DeepSeek-v4-flash via existing `getLlmModel()`.** No new provider plumbing. Reasoning tokens already budgeted.
4. **Per-thread cache.** Each conversation thread has a stable cache key (`thread_id`). Pre-render `system + rules + factPack` once per thread; mutate only the new-message tail.
5. **Mastra workflow per inbound.** Each new inbound message kicks off a Mastra run identical in shape to `hygglo_poll`'s order-decision flow. Step output is a `renter_bot_draft` row.
6. **No new schema until needed.** Reuse `ai_decision` row shape mentally; add a separate `renter_bot_draft` table only when the renter-bot diverges materially (it will, by Phase 2).
7. **Idempotency by message hash.** A drafted reply is keyed to a `(thread_id, last_inbound_message_id)` pair — re-running the workflow on the same input does NOT create a new draft.
8. **Quiet hours respected.** Reuses `gatedGenerateText` so the bot never burns LLM tokens between 02:00-08:30 UK time.

---

## 4. Phased rollout

### Phase 0 — Land this plan (1 day)
- This document committed.
- Open a tracking issue per phase.
- No code.

### Phase 1 — Skeleton draft generator (1 week, READ-ONLY)

**Goal:** every new inbound message gets a draft reply Daniel can read.

**Deliverables:**

```
src/mastra/workflows/renter_bot_draft.ts   # new workflow
src/mastra/agents/renter_bot.ts            # new agent (DeepSeek)
convex/lib/renter_bot_prompts.ts           # system prompt + intent contracts
convex/renter_bot_drafts.ts                # new table + mutations + queries
src/trigger/draft-renter-replies.ts        # Trigger.dev cron + on-demand
src/components/dashboard/RenterBotInbox.tsx # widget — drafts list + approve/edit/dismiss
```

**Schema additions** (in `convex/schema.ts`):

```ts
renter_bot_drafts: defineTable({
  thread_id: v.string(),
  account_slug: v.string(),
  // Trigger: the last inbound message we drafted in response to.
  last_inbound_message_id: v.string(),
  last_inbound_at: v.number(),
  // The draft.
  draft_text: v.string(),
  draft_intent: v.string(),                  // one of 14 intents
  draft_confidence: v.number(),
  draft_red_flags: v.array(v.string()),
  // Owner action.
  status: v.union(
    v.literal("pending"),
    v.literal("dismissed"),                  // Daniel said no, archive
    v.literal("sent"),                       // owner manually sent (or future auto-send)
    v.literal("expired"),                    // newer message came in; this draft stale
  ),
  // Audit.
  generated_by: v.string(),                  // "renter-bot-v1"
  model_id: v.string(),                      // "deepseek/deepseek-v4-flash" etc
  generated_at: v.number(),
  cost_usd: v.optional(v.number()),
})
  .index("by_thread", ["thread_id"])
  .index("by_thread_status", ["thread_id", "status"])
  .index("by_status_pending", ["status"]),
```

**Workflow shape:**

```
1. openRun                 — polling_runs row
2. fetchPendingMessages    — inbound messages without a pending draft
3. enrichContext           — per thread: factPack (rental, renter, items, pricing,
                              listing_photo, last 20 messages, conversation_stage,
                              blacklist, recent denials)
4. classifyIntent          — code-only (mirror V1 classify.ts patterns)
5. blacklistShortCircuit   — if renter blacklisted → emit "decline politely" template;
                              skip LLM call entirely
6. draftReply              — DeepSeek call w/ system + rules + factPack + intent
                              contract; quiet-hours-gated
7. filterAndContract       — V1's filter.ts + contract.ts ports run on output;
                              block or rewrite as needed
8. writeDraft              — Convex mutation, status="pending"
9. completeRun
```

**Dashboard:**

- New `RenterBotInbox` widget in `widget-registry.ts` — lists threads with pending drafts. Each row shows:
  - Last inbound message (with sender name + timestamp)
  - Draft reply
  - Intent label + confidence + red flags
  - Buttons: **Send** (copies to clipboard, marks `sent`), **Dismiss**, **Edit** (inline editor)
- Wraps in `<DeferredMount>` so the inbox doesn't fire at cold paint if Daniel's not looking at it.

**Acceptance criteria for Phase 1 (all must hold for 7 days before Phase 2):**

- [ ] Every inbound message in `hygglo_messages` (last 7d) has a `renter_bot_draft` row within 5 minutes of arrival.
- [ ] Zero outbound messages on `hygglo_messages` table written by the bot.
- [ ] Daniel reviews ≥ 30 drafts. Mark each `sent` / `dismissed` / `edited`.
- [ ] Audit: out of those 30, ≥ 80% were either `sent` verbatim or `sent` after minor edit. If < 80%, the prompt + contracts need tuning before progressing.

### Phase 2 — Renter DNA + stage state machine (1 week, still READ-ONLY)

**Goal:** make the bot smarter, not autonomous.

- **Add `renter_dna` JSON column to `renters`** (5-axis profile from V1).
- **Add `conversation_stage` to `conversations`** + a derived setter that runs on every workflow run.
- **Port V1's `conv_extracted_facts` extractor** — extracts dates/items/budget/project-type from each new message and persists.
- **Stage-gated prompts** — different system prompt per `conversation_stage` (e.g. INQUIRY = welcoming + open-ended; READY_TO_BOOK = confirming details, no upsell).
- **Negotiation strategy block** — port V1's `buildNegotiationStrategy` (price-objection escalation: hold firm → offer alternatives → soft yield).
- **Rules seeding** — port the V1 `Rule` Postgres table to the V2 `rules` table. Bot reads rules once per workflow run with a 5-min TTL cache.

**Acceptance:**
- [ ] Drafts match the conversation stage (no upsell at READY_TO_BOOK, no over-friendly tone at COMPLAINT).
- [ ] Daniel logs ≥ 50 drafts with the new pipeline; ≥ 90% sent-verbatim-or-light-edit.
- [ ] No new filter violations introduced (regression tested against Phase 1 corpus).

### Phase 3 — Verification + delivery + follow-up workflows (2 weeks, READ-ONLY)

**Goal:** the bot drafts replies for the operational flows V1 had: verification handholding, delivery T&Cs, post-rental follow-up.

- Port `verification.service.ts` → Convex query + Mastra step. Bot sends verification guidance template when stage = BOOKED and not yet verified.
- Port `delivery.service.ts` → handles distance + courier ETA + cost; draft includes delivery quote.
- Port `follow-up.service.ts` → cron that drafts re-engagement messages for cold INQUIRYs after N days.
- Add `renter_bot_drafts.kind` field: `"reply" | "verification" | "delivery_quote" | "followup" | "blacklist_decline"`.

**Acceptance:**
- [ ] All four draft kinds appear in the inbox widget with their kind label.
- [ ] Daniel sees zero false-positive verifications (drafting a verification reply for an already-verified renter).
- [ ] Follow-up draft rate ≤ 1 per cold thread per 14 days (avoids spam).

### Phase 4 — Opt-in auto-send for a single intent (2 weeks)

**Goal:** flip auto-send on for the LOWEST-RISK intent first.

- Candidate intents in order of safety: `ACKNOWLEDGMENT` → `GOODBYE` → `GREETING` → `PRICING_INQUIRY` (with sanity check) → others gated longer.
- Add `auto_send_enabled` boolean per intent in `settings`.
- Add a 30-second "undo" window in the dashboard: when bot auto-sends, draft row stays in `sent_pending_undo` for 30s; Daniel can rage-click undo to retract via Stagehand-driven Hygglo message-delete.
- Audit: every auto-sent reply writes an `ai_decision_audit` row with `hygglo.attempted=true` for the first time on the renter-bot side.

**Acceptance:**
- [ ] First intent runs auto-send for 7 days without a single retraction.
- [ ] Renter satisfaction signal: no complaint thread opened that traces back to an auto-sent reply.

### Phase 5 — Expand auto-send (ongoing)

- One intent at a time, with a 7-day soak between each expansion.
- Daniel can revoke auto-send per-intent at any time via dashboard toggle.
- Long-tail intents (`COMPLAINT`, `DAMAGE_REPORT`, `CANCELLATION`) likely STAY draft-only forever.

---

## 5. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Bot drafts something embarrassing and Daniel sends without reading | Filter layer (V1's `filter.ts` port) blocks the worst categories at code level. Dashboard widget shows red-flag chips prominently. |
| DeepSeek hallucinates a price or availability | Code-level fact-check step ports V1's `ground.ts` — re-runs structured-output against pricing table, blocks if mismatch. |
| Bot drafts the same reply on stale inbound | Idempotency by `(thread_id, last_inbound_message_id)`; new inbound supersedes — old draft auto-expires. |
| Cost runaway from reasoning tokens | Existing `maxOutputTokens` caps + quiet-hours gate. Per-thread cost capped at $0.001/turn typical. |
| Memory leak: `renter_bot_drafts` grows without bound | TTL cron drops drafts > 90 days old that were never `sent`. |
| Convex `collect()` violations as schema grows | Every query in this plan must use `withIndex` — explicit in the schema definitions above. |

## 6. What this plan does NOT do

- ❌ No auto-send before Phase 4. **Strict.**
- ❌ No Hygglo write API calls before Phase 4.
- ❌ No Telegram operator channel — Daniel uses the dashboard widget instead.
- ❌ No DSPy / fine-tuning / custom model — DeepSeek as-is.
- ❌ No re-implementation of V1's `playwright` browser-driven send path. When auto-send turns on, it uses the existing Stagehand `hygglo-ui-action` Trigger task that's already in V2.
- ❌ No port of V1's 30+ background crons. Bot logic runs on inbound-message trigger, not timer.

## 7. Cost model (Phase 1, projected)

Same DeepSeek-v4-flash pricing as the live LLM surfaces. Per-draft estimate:

- Input: ~3,000 tok (system prompt + rules + 20-message history + factPack)
  - With prefix caching after first turn in a thread: drops to ~600 fresh tok
- Output: ~150-500 tok visible + ~600-1,500 reasoning tokens
- Per draft: ~$0.0003 - $0.0008
- At ~20 inbound messages/day, ~4 drafts per: **~$0.50/mo new spend**

Sits comfortably under the existing $3.62/mo total LLM budget from PR #15.

## 8. Open decisions for Daniel

1. **Where does the draft inbox live?** New top-level page (e.g. `/inbox`), OR a dashboard widget? Plan assumes widget; let me know if you want a dedicated page.
2. **What signals "edited" vs "sent verbatim"?** Pure string-equality check, OR a Levenshtein threshold (small whitespace edits don't count as "edited")? Plan assumes string-equality.
3. **For Phase 1 acceptance, who tracks the 80% threshold?** Plan assumes Daniel marks each draft on action; we infer from row mutations. Could automate via a "edit" event log.
4. **Telegram fallback in Phase 1?** V1 used Telegram for high-stakes drafts. Phase 1 plan deliberately drops it — happy to add back if you'd want certain red-flag drafts pinged to Telegram too.

Open these in the PR review.
