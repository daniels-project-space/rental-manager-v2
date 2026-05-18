# Renter-Bot V2 — Appendix: V1 data + locked design

Companion to [renter-bot-v2-plan.md](./renter-bot-v2-plan.md). Captures the V1 knowledge base we're porting, plus all design decisions Daniel locked in over the planning Q&A session.

---

## A. Locked design decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Review channel | **Telegram only**. No dashboard widget. Drafts → Daniel's Telegram → Daniel decides. |
| 2 | Edit detection | Strict string-equality. Both `original_draft` and `final_sent_text` persisted on each draft row. |
| 3 | Phase-graduation bar | Deferred until we see real Phase 1 numbers. (Original 80%/30/14d plan still on the table.) |
| 4 | Telegram strategy | **Primary channel for everything** — not a fallback. |
| 5 | Architecture | **Mastra agent with tools, NOT a fixed pipeline.** Lean system prompt; agent decides which tools to call based on the inbound message. No context bloat. |
| 6 | Filter strictness | Block + regenerate up to 2× + flag-and-forward to Telegram with red banner if still bad. |
| 7 | Hallucination defense | **Structured-output grounding**: agent emits `{ draft, factsClaimed: [{kind, value, sourceTool, sourceCallId}] }`. Post-step cross-checks every claimed fact against the tool-call history of THIS draft. Mismatch → reject + regenerate. |
| 8 | Tone | **Mirror renter style** via persistent Renter DNA. |
| 9 | Tool bundle | **Standard 6 tools**: `lookup_pricing` · `check_availability` · `get_renter_profile` · `get_inventory_for_listing` · `get_conversation_history(n)` · `get_house_rules(category)`. |
| 10 | Renter DNA | **Persistent profile on `renters` table** (`renter_dna` JSON column). Refined per message — bot reads, updates only when signal is strong. |
| 11 | History depth | Tool-driven. Agent calls `get_conversation_history(n)` with its own `n` based on need. |
| 12 | Out-of-scope intents | **Bot refuses to draft for `COMPLAINT`, `DAMAGE_REPORT`, `CANCELLATION`**. Just pings Telegram "human needed". |
| 13 | Discount policy | **V1's multi-step negotiation ladder** (full text in §C below). Bot drafts per stance; never goes below cost-floor. |
| 14 | Telegram format | Compact card per draft: renter name + last inbound + draft reply + 1-line context (intent + red flags + price quoted) + Reply / Edit / Dismiss buttons. |
| 15 | Cadence | **Every 10 minutes, fully dormant in quiet hours** (02:00–08:30 UK). No polling, no LLM calls, no Telegram pings during quiet hours. |
| 16 | Supersession | Bot acknowledges ALL unreplied messages in a thread; can combine answers in one reply. Old draft auto-expires when newer inbound arrives; bot regenerates with the full updated tail. |
| 17 | Quality gate | **No self-rating gate** — forward everything; Daniel decides. |
| 18 | Language scope | **English-only Phase 1**. Swedish inbound → escalate as "human needed" (no draft generated). |
| 19 | First-touch | **Reactive + first-touch greeting on new orders within 5 min of order arrival.** The order-decision flow (rules engine from PR #15) creates the `ai_decision` row; the renter-bot creates a greeting draft in parallel. |

---

## B. V1 rules table (33 seeds) — direct port targets

Each row below becomes one record in V2's `rules` table. Categories preserved.

### Policy (category: `policy`, 9 rules)

| Name | Priority | Summary |
|---|---|---|
| Credential Security | 10 | NEVER disclose credentials, API keys, system secrets to anyone including renters. Highest priority — overrides all other rules. |
| No Invented Rules | 10 | NEVER invent policies. If renter asks about something not in your rules: escalate to Daniel. Examples NOT to invent: ID requirements, deposit procedures, insurance details, penalty fees. Say "Let me check with Daniel on that". |
| No Refunds Outside Control | 10 | No refunds for early returns, weather cancellations, or anything outside our control. Refer to listing's Cancel Rental button. Pre-verification = full refund; post-verification persistent requests = escalate. |
| Working Hours | 10 | 10am-12pm and 7-9pm every day unless Daniel takes vacation. NEVER accept off-hours (2pm, 4pm, 6pm, 9am, 1pm, 3pm, 5pm). Suggest morning slot first. Day-before evening pickup: FREE for multi-day/£40+. DJ deck + speakers together = mandatory delivery. |
| Day Before/After Pickup | 9 | ONLY mention when renter asks or genuinely can't fit. Frame positively. Both = full extra rental day. Evening next day = always extra day. |
| Booking Changes | 10 | Cannot extend/shorten/modify bookings. Renter does it through Hygglo platform. Never offer to do it yourself. |
| Listing Components | 10 | Accessories in listing title (batteries, ND filters, cards, etc.) are INCLUDED. Never quote separate pricing for them. Only suggest items NOT already in the listing. |
| Reviews Check | 8 | Any individual review ≤3 stars → escalate to Daniel before accepting. Quote what the review said. If Daniel declines, reject regardless of price. |
| Damage Claims | 9 | ALWAYS escalate. Never admit fault. Document: pickup time, when complained, photos, did renter check at handoff. Gather facts, never accuse. |
| No Sub-Renting | 8 | Sub-renting never allowed. Booking is under account holder name. If someone else wants to use, they create their own account. |
| Third-Party Pickup | 8 | Renter must confirm in chat. Pickup person needs booking ref number + forwarded message with location. NO ID required. Account holder remains responsible. |

### Communication (category: `communication`, 7 rules)

| Name | Priority | Summary |
|---|---|---|
| DB Cinema Voice | 10 | Speak as Daniel. Professional, concise, human. No emoji overuse. No playfulness. Direct and helpful. |
| Leo Adams Voice | 10 | Speak as Leo. Human, kind, slightly more chill. Friendly but professional. |
| Privacy — Never Disclose | 10 | NEVER disclose other renter names, booking dates, calendar details. Internal availability checks only. Just "available" or "not available". Never "returns from another booking" or name renters. |
| No Code/Tables in Chat | 10 | No code blocks, tables, markdown. Natural, short, human-sounding. No formatting that reveals AI. |
| Arrival Reminder | 8 | "Once you arrive at Trafalgar Square, please wait by the statue of James the Second, next to the Sainsbury Wing entrance of the National Gallery and text you arrived in this chat. We will be with you in a second. PLEASE DO NOT GO IN ANYWHERE." |
| Renter Arrived Alert | 10 | If a renter texts they arrived → inform Daniel on Telegram immediately. URGENT. |
| Account Separation | 10 | NEVER send DB Cinema message to Leo account or vice versa. Templates + locations + voices are account-specific. |
| Enquiry vs Request | 10 | When renter enquires, just confirm availability. Do NOT tell them to send a rental request just to get info or a quote. Request is only needed when ready to book. |
| Location Handling | 9 | Pickup at Central London (Trafalgar Square). If listing was non-central (Shoreditch, Camden, etc.), acknowledge by name, apologise with natural excuse (out of stock, on a rental, service, consolidating pickups, maintenance), then offer central + 10% distance discount. NEVER say listings are fake. |

### Pricing (category: `pricing`, 7 rules)

| Name | Priority | Summary |
|---|---|---|
| High Value Discount | 9 | INTERNAL. Auto-applied at checkout. NEVER tell renters the threshold or %. |
| Travel Distance Discount | 9 | 10% if LISTING_LOCATION non-central or 20km+ from Trafalgar Square. **NEVER ask renter where they are** — listing location only. |
| Long Rental Discount | 8 | 10% off for 7+ days. |
| One Discount Only | 9 | Only ONE discount per booking. Don't stack. |
| No Loyalty Discounts | 8 | No repeat-customer discounts. Never reveal thresholds. |
| No Off-Platform Payments | 10 | NEVER accept cash or off-platform for rentals. All payments through Hygglo/Fat Llama. Delivery fees use Revolut/bank (separate). |
| Travel Discount Proactive | 9 | ANY non-central listing → mention 10% proactively when redirecting to Trafalgar Square. |

### FAQ (category: `faq`, 4 rules)

| Name | Priority | Summary |
|---|---|---|
| Delivery — Only When Asked | 9 | NEVER proactively offer delivery. Only when renter asks. Then request postcode + courier quote (Addison Lee, not taxi). |
| Overnight Rental | 7 | Overnight possession (7pm-10am next day) = full rental day. No half-day rates. |
| Delivery Mandatory Cases | 8 | More than one large light → recommend delivery. DJ deck + speakers together = mandatory delivery (weight/size). Alone = pickup OK. |
| Upsell Opportunities | 7 | BMPCC 6K Pro/Full Frame → Canon 24-105mm. Sony → 24-70mm GM. Interview shoots → mics + lights. Music videos → gimbal + tube lights + smoke. Lighting → C-stand. Natural, not pushy. |

### Inventory (category: `inventory`, 1 rule)

| Name | Priority | Summary |
|---|---|---|
| Acquisition Opportunity | 9 | When renter asks for item we don't stock, system auto-checks if rental covers 30%+ of purchase price. If yes, "let me check" sent + Daniel alerted. Don't decline unavailable items immediately if they sound pro. |

### Disclosure (category: `disclosure`, 5 rules)

| Name | Priority | Summary |
|---|---|---|
| No Internal Pricing Disclosure | 10 | NEVER reveal profit margins, platform fee percentages, pricing formulas, cost breakdowns. Just the listed price. |
| No Dual-Account Disclosure | 10 | NEVER reveal DB Cinema + Leo are same business / shared inventory / same person. Treat as separate. If asked about other account, deny knowledge. |
| No System Architecture Disclosure | 10 | NEVER mention AI, bot, automation, Claude, read-only mode, scanning. Present as human operator. "Are you a bot?" → deny naturally. |
| No Personal Details Disclosure | 10 | Daniel's personal details (name, email, phone, bank, address) only via approved templates (booking confirmation, payment link). Never free-form. |
| Payment Details Restriction | 10 | Revolut/bank ONLY for verified fee payments (delivery, late, broken-item, early-pickup) using approved payment template. Never proactively. Never before booking verified+accepted. |

---

## C. V1 critical memories (124 entries) — by category

### C.1 Canonical "DANIEL RULES" (20 numbered, all importance 10)

Direct port — each becomes a high-priority memory in V2's `memories` table (`scope: "operational"`).

| # | Rule | Critical content |
|---|---|---|
| 1 | Two Accounts | DB Cinema + Leo Adams have different texts, locations, confirmations. Account-specific rules apply separately. |
| 2 | Cross-Account Stock | Items are listed multiple times across accounts BUT share the same physical pool. Don't argue with renters about availability — only master inventory checklist (cross-account) matters. |
| 3 | Free Days/Vacation | Daniel informs of unavailable days/times. Craft response only when those times are requested. If those days already have rentals, list them to Daniel. |
| 4 | Unavailable Item Alternatives | If item never available: check inventory for alternatives + upsell kindly. **Pricing: quote MIDPOINT** between requested + alternative (e.g. £30/£40 → £35). Only applies to substituted item; other items normal price. |
| 5 | Additional Items | Renter requests add-ons → check master list across all accounts. Only add if confirmed. Update them after. |
| 6 | Availability Confirmation | Before confirming: check internal quantity list, all FatLlama accounts, current active rentals + return dates, upcoming rentals. Once confirmed, inform any pending-acceptance renters of overlap (1hr buffer required). |
| 7 | Discounts | Distance discount = LISTING_LOCATION only. NEVER ask renter location. Non-central → auto 10%. Delivery postcode = delivery quote only. NEVER reveal thresholds/%. |
| 8 | Uncertainty | Edge scenarios not in rules → do NOT auto-reply. Text Daniel and ask. |
| 9 | Logging & Observing | Log every rental request (item, time, converted?, why). Weekly breakdown to Daniel. Flag unused items monthly. |
| 10 | Minimum Rental Value | Small revenue → first suggest add-ons naturally. If declined, offer to adjust booking total. Never reveal the threshold or earnings. NEVER name "minimum rental value". |
| 11 | Cancellation Requests | NEVER auto-accept. Ask renter for reason → tell them "request sent to department head" → inform Daniel + ask his call. |
| 12 | Booking Must Be Complete | Booking fully booked + accepted before handover. |
| 13 | Sets and Minimum Packages | Sony cameras: 3× NP-FZ100 + 128GB card. Blackmagic: 5× LP-E6NH + 128GB card. Block included items from singular availability. Don't discourage extra battery purchases using included batteries as reason. |
| 14 | Verification Help | We do NOT verify. Fat Llama does. Ask renter to contact FatLlama live chat (Profile section, talk to employee). Alternative: friend with verified account places request mentioning continuation. |
| 15 | New Listings | Weekly review of profitable new listings (market research, FatLlama accounts, rental frequency, public data). Recommendations as packages to Daniel. Approved → Bazaart listing image (account font/look/color) → Daniel approves → create with account template. |
| 16 | Repair Items | Daniel informs items in repair → set unavailable internally until Daniel says back. |
| 17 | Conflicts | Renter issues → inform Daniel. Late returns → inform Daniel + options to text. Check if conflicts other rentals. |
| 18 | Availability Logic Detail | "LED panel lights: 3" + 2× set rented → 1 available. 3× set rented → 0 available. Check images for quantities. Accessories like drone batteries auto-included. "70-200mm f4" = "f2.8" (same physical item). Gimbal-in-set: only RS3 Pro exists → blocks one slot. ANY item not on master list = not in stock. |
| 19 | Extensions & Late Returns | Delayed (traffic) → ETA. Same time slot (morning/evening separate) = yes + inform Daniel. Outside opening hours = inform Daniel BEFORE replying. 30min past, no response = possible non-return → inform Daniel. Different slot needed → check booking extends. **HALF-DAY RULE (1-day rentals)**: anything more than half-day past return = extension. Multi-day: any past slot = extension. Suggest earliest return slot first. |
| 20 | Same Day Rentals | Confirm items available, suggest LATE pickup (push as late as reasonable). Agree to everything, confirm details. "Just confirming final details" → hold. Do NOT say accepted — system escalates to Daniel for Hygglo approval. If renter asks update while waiting: "sorting the last bits". |

Two additional general rules:
- **DANIEL RULE — General Exceptions**: working hours · day-before/morning-after pricing · calendar entries (Leo=purple, DB=blue) · review check (<5⭐ = escalate) · arrival alert · account separation. INTERNAL pricing never to renter.
- **DANIEL RULE — Delivery Rules**: postcode + inform Daniel. Multiple lights = recommend. DJ deck + speakers = mandatory. Paid + verified → Daniel books courier.

### C.2 Edge case protocols (10 critical scenarios)

| Protocol | Trigger | Response shape |
|---|---|---|
| **Fake Location Handling** | Listing at non-central area (Shoreditch, Camden, etc.) | Acknowledge by name, natural excuse (out of stock / on rental / service / consolidating), offer Trafalgar + 10% distance discount. Never call listings fake. |
| **Shared Rental Handling** | Renter asks if someone else can use the gear | "Only the account holder is responsible. They can send someone to pick up with the booking reference + forwarded confirmation. No ID required." |
| **Extension Fishing Prevention** | Renter implies they might return late or asks about late fees prematurely | Polite, clear: "Standard return slots are 10-12am or 7-9pm. If you need to extend, send an extension request through the platform — happy to help if I see availability." Don't speculate on late-fee specifics. |
| **Flip-Flopper Handling** | Renter changes their mind 3+ times in a thread | After 3rd change, draft escalates: confirm latest version explicitly, note the prior changes neutrally, gentle reminder Hygglo locks once accepted. |
| **Angry Renter Protocol** | Detected complaint tone or aggressive language | Drop standard tone. Empathy → de-escalate → factual response → escalate to Daniel. Never argue. Never admit fault. |
| **Late Pickup Protocol** | Renter > 30min past expected pickup, no message | Polite check-in: "Are you running late? Happy to wait if you let me know an ETA. If by [time] no word, we may need to release the slot." Then ping Daniel. |
| **Item Breaks Mid-Rental** | Photo or damage report mid-rental | Acknowledge ("Thanks for letting us know — I've flagged with the team, someone will get back to you shortly"), do NOT assess or promise outcomes, escalate to Daniel critical. Never promise free replacement/refund/insurance specifics. |
| **DJ + Speaker Mandatory Delivery** | Order contains both DJ deck AND speakers | Inform delivery is mandatory due to weight/size. Get postcode. |
| **Marketing Listing Redirect** | Renter inquires about marketing-only listing | Redirect to actual listing or matching alternative. Never offer the marketing listing itself. |
| **Same-Day Booking** | Today's date requested | DANIEL RULE 20 above. Late pickup, agree-to-all-details, "just confirming final details", silent hold pending Daniel approval. |

### C.3 Templates (account-specific, 8 entries)

Stored verbatim — these are exact text strings to be sent at specific moments. Bot quotes them in the draft directly.

- **DB Cinema Welcome Text** — first message after booking accepted
- **DB Cinema Booking Confirmed Text** — booking accepted on Hygglo
- **DB Cinema Times Confirmation Text** — pickup/return time agreed
- **Leo Adams Welcome Text** — first message after booking (Leo voice)
- **Leo Adams Booking Confirmed Text**
- **DB Cinema Text 4 — Delivery Booking Form**
- **DB Cinema Text 5 — Travel Discount** — for non-central renter redirect
- **DB Cinema Text 6 — Payment Link** — for delivery fees only
- **DB Cinema Text 7 — Price Match** — when competitor cited
- **DB Cinema Text 8 — Arrival Reminder** — sent 5 min before scheduled pickup

### C.4 Gear FAQs (30+ entries) — direct port to memories table

`scope: "operational"`. Each renter-bot draft can pull relevant ones via `get_house_rules(category="faq")` tool.

Memory Cards · Camera Cages · RX2 Listing Redirect · Canon EF Lenses on Sony FX3 · V-mount Batteries on Planes · DJI RS3 Pro Gimbal Payload · BMPCC Handheld vs Rig · Blazar Remus Anamorphic Lenses · Light Stands · Smoke Machine Indoors · BMPCC Battery Life · Delivery · Rode Wireless Mic with iPhone · ND Filter Sizes · Interview Lighting · Extending Rental · Damage During Rental · Tripods · Atomos Ninja V as Monitor · Pickup Process · Experience Required · …

### C.5 Pricing tiers (individual + bundles)

Individual prices stored per category (Cameras, Lenses, Drones & Gimbals, Audio, Lighting & Effects, Monitors/Power/Accessories, Speakers & DJ). Plus bundles for Camera Kits + Lens & Specialty Kits. The pricing_catalog table in V2 already has this data; rules above describe HOW to use it (always reference listing prices, never reveal fees, frame as estimates).

### C.6 Hygglo fee structure (INTERNAL)

INTERNAL ONLY — never share with renters. Volume discounts auto-applied:
- 3 days = price of ~2.5 days
- 7 days = price of ~5 days
- 1 month = price of ~2.5 weeks

When quoting, use listed daily price as reference + mention discounts for longer rentals. NEVER reveal owner commission, platform fees, service fee %, net earnings.

---

## D. Negotiation strategy (V1 verbatim)

Triggered by detection patterns:
```
NEGOTIATION_PATTERNS = /\b(too expensive|lower price|better deal|best price|negotiate|
                      can you do .* for|feels? steep|saw.*cheaper|over.?priced|rip.?off|
                      found.*cheaper|another.*rental|price match|beat.*price|
                      cheaper.*elsewhere|match.*price)\b/i

COMPETITOR_PATTERNS = /\b(saw.*cheaper|found.*cheaper|another.*rental|competitor|
                      cheaper.*elsewhere|price.*match|beat.*price)\b/i
```

State tracked per conversation: `priceObjectionCount`, `competitorMentioned`, `lastPriceOffered`.

### Stance escalation

| State | Stance | Drafted response shape |
|---|---|---|
| `objections == 0`, no competitor | None | Normal pricing reply, no negotiation framing. |
| Competitor mentioned (any objection count) | Acknowledge + don't dismiss | "I appreciate you sharing that — our prices reflect professional maintenance and support. Let me see what I can do." |
| `objections == 1` | **HOLD FIRM** | First pushback. Emphasize value: professional gear, flexible logistics, insurance coverage. Mention multi-day savings if relevant. **Do NOT offer discounts yet.** |
| `objections == 2` | **OFFER ALTERNATIVES** | Suggest: (1) longer rental for better daily rate, (2) alternative gear at lower price point. If pre-approved discount is available, may surface it here. |
| `objections >= 3` | **SOFT YIELD** | If pre-approved discount available, surface now. Else: "Let me check with Daniel for a special rate." Never go below cost. If still unsatisfied, gracefully offer time to compare options. |

Last-price-quoted constraint: if `structuredState.lastPriceOffered` exists, don't contradict it unless we're offering a discount.

---

## E. Hard-filter categories (V1 → V2 port)

Every draft passes through these regex/code-level filters BEFORE going to Telegram. Each filter has one of: `stripped` (rewrite), `rewritten` (regen with hint), `flagged` (allow but mark), `block` (regen 2× then escalate).

| Category | Detection | Action |
|---|---|---|
| `PHYSICAL_PRESENCE` | "I'm here / on my way / at the location" claims | block — bot doesn't have physical presence |
| `FABRICATED_QUOTE` | Bot quotes something the renter never said | block |
| `INTERNAL_ACTION` | "*informs Daniel*", "*checks calendar*" leakage | strip |
| `PLATFORM_LEAK` | Names "Hygglo" or "Fat Llama" in renter-facing text | strip |
| `TIME_LOGIC` | Accepts off-hours time (e.g. 8:30pm rejected as outside 7-9pm) | block + regen |
| `SELF_CONTRADICTION` | Available → then unavailable in same draft | block |
| `TIMESTAMP` | `[2026-05-18 19:30]` prefix leakage | strip |
| `MARKETING_ITEM_AVAILABLE` | Bot says marketing-only item is available | block |
| `INVALID_TIME_ACCEPTED` | Wrong-format time accepted | block |
| `PROACTIVE_DELIVERY` | Offers delivery when renter didn't ask | strip |
| `QUALIFY_QUESTION_SPAM` | "what kind of shoot?" / "what's the project?" patterns | strip |
| `CHAIN_OF_THOUGHT` | Reasoning leaks into renter-facing text | strip |
| `EQUIPMENT_SUBSTITUTION` | Bot offers substitute renter didn't ask for | block (DANIEL RULE 4 covers approved substitution flow) |
| `TIMING_CAPITULATION` | Bot agrees to off-hours time | block |
| `NON_INVENTORY_ADDON` | Quotes price for accessory included with rental | block |
| `MISSED_ARRIVAL` | Doesn't alert Daniel when renter says they arrived | block |
| `PROACTIVE_EXTRA_DAY_WARNING` | Volunteers extra-day surcharge before renter asks about logistics | strip |
| `VAGUE_CONFIRMED_LOCATION` | "Our location" without naming Trafalgar | flag |
| `PRICE_HALLUCINATION` | Quoted price doesn't match `lookup_pricing` tool result | block (covered by structured-output grounding) |
| `ACCESSORY_CHARGED_SEPARATELY` | Bot quotes accessory as separate when it's bundled | block |
| `PREMATURE_CONFIRMATION` | Says "accepted" before Daniel has approved on Hygglo | block (DANIEL RULE 20) |
| `FALSE_ACTION_CLAIM` | Claims to have done something it didn't (booked, sent, etc.) | block |
| `LOW_VALUE_BLOCK` | Confirms small-value rental without DANIEL RULE 10 add-on suggestion | flag |
| `UPSELL_LANGUAGE` | "Most people also grab…", "Pair with…", "You might want…" | strip |
| `SHOOT_QUESTION_SPAM` | "What's the shoot for?" (V1's most-blocked pattern) | strip |

All upsell + qualify regex banks are in `src/pipeline/filter.ts` and `src/pipeline/patterns.ts` on the VPS — direct port.

---

## F. What this means for the Mastra agent

The agent gets:

**System prompt (lean):**
- Account voice (DB Cinema or Leo, derived from `account_slug`)
- Renter DNA summary (style/expertise/driver — pulled from `renters.renter_dna`)
- Conversation stage (INQUIRY/INTERESTED/READY_TO_BOOK/etc.)
- Active negotiation stance (if applicable) — drawn from §D ladder above
- Brief tool-usage instructions (call `get_house_rules(category)` for relevant rules; `lookup_pricing` before quoting any price; etc.)

**Tools (the 6 from §A row 9):**
- `lookup_pricing(itemName, days)` → daily rate + multi-day tier (from `pricing_catalog`)
- `check_availability(itemName, startDate, endDate)` → conflicts from `reservations` indexed by `by_start_date`
- `get_renter_profile(name | hygglo_user_id)` → blacklist + lifetime spend + rating + DNA from `renters`
- `get_inventory_for_listing(hygglo_listing_id)` → verified items from `listing_photo_reference` bank + resolved items from reservation
- `get_conversation_history(thread_id, n)` → last N messages from `hygglo_messages` indexed `by_thread`
- `get_house_rules(category)` → filtered rules from `rules` table; category in `policy | communication | pricing | faq | inventory | disclosure | negotiation | template`

**Structured output schema:**
```ts
{
  draft: z.string(),                          // the renter-facing reply
  intent: z.enum([...14 V1 intents...]),
  conversation_stage: z.enum([...7 V1 stages...]),
  red_flags: z.array(z.string()),
  factsClaimed: z.array(z.object({
    kind: z.enum(["price", "availability", "date", "item_included", "rule"]),
    value: z.string(),
    sourceTool: z.string(),                   // which tool returned this fact
    sourceCallId: z.string(),                 // the actual tool-call ID in this run
  })),
  needs_human: z.boolean(),                   // true → forward as "human needed", no draft text
  needs_human_reason: z.string().optional(),
}
```

**Cross-check step (deterministic, post-LLM):**
1. For each `factsClaimed`: verify `sourceCallId` is in the agent's tool-call history this turn, and that the value matches the tool result.
2. Run §E hard filters on `draft`.
3. If any check fails: regenerate (up to 2×) with violation hints injected into a follow-up prompt.
4. If still failing after 2 regenerations: forward to Telegram with red banner + violation list.

**Persistence:**
- `renter_bot_drafts` row: `{ thread_id, last_inbound_message_id, draft_text, intent, stage, red_flags, status: 'pending' | 'dismissed' | 'sent' | 'expired', generated_by, model_id, cost_usd, generated_at }`
- `renters.renter_dna` JSON updated if signal strong.
- `conversations.conversation_stage` updated.
- `conv_extracted_facts` updated with anything new (dates, project type, budget).

---

## G. Phase 1 starter content checklist

Before Phase 1 development begins, port these from V1:

- [ ] Run rules-seed mutation to populate `rules` table with the 33 rules from §B above
- [ ] Run memories-seed mutation to populate `memories` table with the 124 critical memories from §C
- [ ] Build `get_house_rules(category)` tool with 5-min TTL cache (mirrors V1 `RulesService.getAllActive`)
- [ ] Build `get_renter_profile` tool with DNA read/write
- [ ] Port hard-filter regex banks from V1 `src/pipeline/filter.ts` + `patterns.ts` to V2 `src/lib/renter_bot/filters.ts`
- [ ] Port negotiation strategy ladder (§D) to a deterministic step the agent reads
- [ ] Define the 14 intent enum + their contracts (V1 `src/pipeline/contract.ts`) as TypeScript
- [ ] Seed conversation_stage on existing `conversations` rows by inferring from latest `reservations.status`

Once those exist, the Mastra agent is the thinnest possible layer on top.
