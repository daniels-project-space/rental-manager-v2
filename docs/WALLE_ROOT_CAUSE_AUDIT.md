# WallE Chat — Root-Cause Audit & Structural Fix Plan
_2026-06-02. Triggered by 4 confabulated answers on thread `walle` (11:43–11:45 UTC)._

## Observed failures
1. "rx2 dj deck" → answered **XDJ-RX2**; real flagship is **XDJ-RX3**.
2. "blackmagic compatible with canon lenses" → "no Blackmagic in inventory"; owner has **two BMPCC** bodies.
3. "EF mount cameras compatible with E mount lenses?" → free-form optics, reasoning wrong.
4. "APS-C camera + full-frame lens?" → **factually inverted** (claimed APS-C+FF vignettes; it does not).

## Confirmed live data (Convex hearty-oyster-600, `items` table)
- DJ decks: BOTH `"DJ RX3 Pioneer controller"` (slug `dj-rx3-pioneer-controller`) AND `"Pioneer XDJ-RX2"` (slug `pioneer-xdj-rx2`) are `status: active`, `is_marketing_only: false`. → phantom/duplicate RX2 row.
- Blackmagic: `BMPCC 6K Full Frame` (lens_mount Leica L, `compatibility.lenses` = Canon EF 24-105 / EF 16-35), `BMPCC 6K Pro` (lens_mount Canon EF, same EF lenses), + `BMPCC battery pack`. All active.
- **The data to answer all 4 questions correctly already exists in `items` (incl. `compatibility.lenses`, `lens_mount`, `aliases`). No chat tool exposes it.**

---

## V2 WallE — request flow
1. `WallEChat.tsx:138` `useChat` → POST `/api/walle/chat`.
2. `walle/chat/route.ts:130-132` model = OpenRouter `CHAT_MODEL` = `anthropic/claude-haiku-4.5` (`ai-models.ts:35-36`). No temperature. `maxOutputTokens:1800`, `stopWhen: stepCountIs(4)`.
3. `route.ts:140-146` system = `WALLE_CHAT_SYSTEM` + date + `buildLiveSnapshot()`.
4. `route.ts:147` tools = `buildDashboardTools()` (13 tools).
5. `route.ts:154,190-193` `needsForcedTool = ANALYTICAL_INTENT.test(msg)`; forces `toolChoice:"required"` on step 0 ONLY when regex matches.

## Root causes (v2)
**RC-1 — No inventory-lookup tool exists (primary; explains #1, #2).**
All 13 tools (`dashboard-tools.ts:289-613`) return aggregates/metrics. None query `items` / `name_canonical` / `aliases` / `kind` / `lens_mount` / `compatibility`. `query_catalog` returns only worth/out-of-stock/sell-recs. `items.listActive` (`convex/items.ts:614`) exists but is never wired to chat. → existence/spec questions have no grounded path.

**RC-2 — `ANALYTICAL_INTENT` regex misses inventory/compatibility phrasing (primary; explains all 4).**
`dashboard-tools.ts:82-83`. All four failing prompts tested → NO MATCH. So `toolChoice` stays `auto` → Haiku answers with no tool call → pure training-data confabulation.

**RC-3 — Snapshot-first contract discourages tool calls (amplifier; #1, #2).**
`DASHBOARD_GROUNDING_RULES` (:45-70) says the snapshot "is the ONLY data you have without calling a tool" and lists only metric drill-downs. No instruction to look up an item, no tool to do so. Grounds *numbers*, not *inventory existence/specs*.

**RC-4 — Domain-knowledge confabulation is wholly ungrounded (explains #3, #4).**
Optics questions have no tool and no source consulted; with `toolChoice:auto` Haiku free-forms and got #4 inverted. Even a perfect inventory tool won't fix this unless compatibility is grounded in the `compatibility`/`lens_mount` fields OR ungrounded optics claims are refused.

**RC-5 — Name ambiguity + phantom row (explains the specific wrong answer in #1).**
Two DJ rows exist; canonical naming inconsistent ("DJ RX3 Pioneer controller" vs "Pioneer XDJ-RX2"); `aliases` + `marketing_redirects` (`schema.ts:124-131`) not surfaced to chat. Without fuzzy/alias resolution returning a canonical match, "rx2 deck" snaps to the literal phantom row.

**RC-6 — Model downgrade.** WallE is **Haiku-4.5 only**. V1 routed hard questions to **Sonnet** (below). Haiku confabulates more on ungrounded reasoning.

### Key files (v2)
`src/app/api/walle/chat/route.ts` · `src/lib/chat/dashboard-tools.ts` (snapshot :222-279, tools :289-613, regex :82-83, rules :45-70) · `src/mastra/agents/walle.ts:39-59` · `src/lib/ai-models.ts:35-36` · `convex/schema.ts` (items :47-91, marketing_redirects :124-131) · `convex/items.ts:614`.

---

## V1 chat — why it was accurate (the architecture to port)
Model: complex = `claude-sonnet-4-20250514` (4096), routine = `claude-haiku-4-5` (1200), routed at `app.controller.ts:1035-1058`. Official Anthropic SDK, prompt caching.

**Triple-layer grounding (not prompt text alone):**
- **(a) Full deterministic context injection** every call (`app.controller.ts:706-788`): live stats, bookings, BI, and the **full per-item earnings list naming every owned item**. System prompt carries INVENTORY ENFORCEMENT (`prompt-manager:240`): "not in catalog = unavailable; never fabricate price/availability."
- **(b) Tools = only source of truth** (`ai.service.ts:101-257`): `check_availability`, `lookup_pricing`, `check_compatibility`, `get_rental_details`, etc., each running real Prisma/catalog queries returning structured strings.
- **(c) Canonical-name resolver under every tool** — `findBestMatch(input, MASTER_INVENTORY)` (`item-matcher.ts:120`): normalize → exact → contains → token-scored fuzzy, with **variant-word guard** (classic/pro/plus/max) and `detectBrandMismatch` (:604). Returns the resolved `matchedItem`, so the model echoes the canonical name, not the user's typo. `MASTER_INVENTORY` (102 items, :406) + `PRICING_CATALOG` (244 items) are the authoritative registries.

Net: even if the model skips a tool, injected context grounds it; even if context is stale, the tool corrects it. Closed-world, deterministic, auditable.

---

## What to CHANGE in v2 (structural — not new rules on top)
> v2 already has a *better* registry than v1: the Convex `items` table carries `aliases`, `lens_mount`, and `compatibility.lenses`. The defect is that **none of it is wired into chat.** Port v1's _architecture_, not its hardcoded arrays.

1. **Inventory lookup tool over `items`** — returns name + aliases + kind + lens_mount + compatibility, with a ported `findBestMatch` (fuzzy + alias + variant/brand guard). Returns the resolved canonical name (and candidate list on ambiguity). Fixes RC-1, RC-5.
2. **Compatibility/optics tool grounded in `compatibility.lenses` + `lens_mount`** (data already exists). Fixes RC-4 for owned gear; for general optics, prompt must refuse ungrounded claims.
3. **Inject a compact full inventory list** (71 items: name·kind·mount) into the WallE snapshot. It's tiny and cheap; makes existence questions answerable by default. Fixes RC-3.
4. **Never-fabricate contract** in `WALLE_CHAT_SYSTEM`: not in inventory ⇒ does not exist; never invent specs/compatibility; route compat/optics to the tool or say "not sure." Fixes RC-4.
5. **Replace the brittle `ANALYTICAL_INTENT` regex gate.** Either always inject inventory (so grounded by default) or force tool use for any existence/spec/compatibility intent. Fixes RC-2.
6. **Route hard questions to Sonnet** (v1 pattern); keep Haiku for trivial. Fixes RC-6.
7. **Data hygiene**: investigate the phantom active `Pioneer XDJ-RX2` row; reconcile canonical naming; surface `aliases` + `marketing_redirects` to the resolver. Fixes RC-5 at the source.

### Band-aid vs structural
- Band-aid (insufficient alone): widen the regex (RC-2) — still no tool to call.
- Structural (the fix): (1)+(2) tools backed by `items` + resolver, (3) inventory injection, (4) never-fabricate contract, (6) model routing, (7) data cleanup.
