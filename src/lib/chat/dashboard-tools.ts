/**
 * Shared dashboard chat grounding — single source of truth for BOTH chat
 * surfaces:
 *   - src/app/api/chat/route.ts        ("AI Assistant" widget)
 *   - src/app/api/walle/chat/route.ts  (WallE bot widget)
 *
 * WHY THIS EXISTS (2026-05-31):
 *   The two routes had drifted: the assistant exposed 10 read-only Convex
 *   query tools and forced a tool call for every data question, while WallE
 *   exposed only 5 tools AND injected a pre-rendered metrics "snapshot" that
 *   it was told to prefer over fresh tool calls. Result: WallE answered
 *   headline questions from a stale, independently-computed blob and
 *   fabricated anything outside its 5 tools. Pulling the tool registry and
 *   the grounding contract into one module guarantees the two widgets answer
 *   from the same live data with the same discipline — and stops the surfaces
 *   diverging again.
 *
 * TOOL CONTRACT: every tool here is READ-ONLY (Convex `query` only — never
 * `mutation`/`action` that writes). Adding a write tool requires explicit
 * Daniel approval. Reviewers: reject PRs that introduce mutations here.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { api } from "../../../convex/_generated/api";

// The income-pie functions are recent additions that the committed
// `convex/_generated/api` lags behind (the perf-passes work keeps it stale), so
// referencing them through the typed `api` object breaks the local build. They
// are deployed on prod and power the dashboard income pie, so reference them by
// name — robust against generated-api drift, identical behaviour at runtime.
const getRentalVolumeByCategoryRef = makeFunctionReference<"query">(
  "dashboard:getRentalVolumeByCategory",
);
const getRentalVolumeKindBreakdownRef = makeFunctionReference<"query">(
  "dashboard:getRentalVolumeKindBreakdown",
);
// Inventory grounding (walle_inventory.ts) + knowledge corpus (knowledge.ts).
// Referenced by name for the same generated-api-drift reason as above: these
// modules are deployed but the committed `_generated/api` lags the perf passes.
const inventoryIndexRef = makeFunctionReference<"query">(
  "walle_inventory:index",
);
const inventoryLookupRef = makeFunctionReference<"query">(
  "walle_inventory:lookup",
);
const knowledgeSearchRef = makeFunctionReference<"query">("knowledge:search");
// Per-item availability for the chat (resolve item → free today / next free /
// upcoming confirmed bookings). New query, so referenced by name for the same
// generated-api-drift reason as the income-pie refs above.
const itemAvailabilityRef = makeFunctionReference<"query">(
  "calendar:getItemAvailabilityForChat",
);
// Master settings read/change (settings.ts). Referenced by name for the same
// generated-api-drift reason as the refs above.
const settingsGetRef = makeFunctionReference<"query">("settings:get");
const settingsUpdateRef = makeFunctionReference<"mutation">("settings:update");

/**
 * The grounding contract shared by both system prompts. Each widget prepends
 * its own persona/voice; this block carries the non-negotiable rules + the
 * authoritative tool list so neither widget can drift from the other.
 */
export const DASHBOARD_GROUNDING_RULES = `GROUNDING — read this before every answer.

The LIVE DASHBOARD SNAPSHOT below the persona is the ONLY data you have without calling a tool. It contains EXACTLY: the active-rentals count, the ongoing and upcoming rental list (each with renter, pickup + return date/time/method and £net), today's pickups/deliveries and returns, month-to-date NET revenue & earnings vs target, today's and this-week's earnings, overbooking conflicts, the count of pending requests, and stock / out-of-stock / untracked / insurance counts. QUOTE THESE DIRECTLY — never recompute, re-derive or override them. All money is NET take-home (after Hygglo ~36% fees).

For ANYTHING NOT in that list you MUST call the matching tool and answer ONLY from what it returns this turn. You do NOT know — and must NEVER guess, estimate, extrapolate, or recall from earlier — any of: per-item earnings, an item's utilization %, idle cost, inventory worth, what to buy or sell, revenue trends, the conversion funnel, missed/denied revenue, catalog / out-of-stock detail, due returns, recent activity, or tax/KPIs. Stating any such figure without having called its tool this turn is fabrication — the single worst thing you can do here. In particular there is NO utilization percentage anywhere except the value query_utilization returns for the handful of idle-ranked items; never invent an "X% rented" figure, and never quote a per-item £ amount from memory.

If a tool didn't give you a number, say you don't have it rather than inventing one. Cite every number with its unit (£, %, items, days) and the window it covers. Respect each tool's stated sort order and field meanings; don't re-rank or recompute (e.g. "Idle Inventory" is ranked by idle £/week, not utilization; per-item income is already cost-proportional; "best earner" = most NET income).

Sanity-check a figure before you state it. A percentage or rate is 0–100%; if a tool returns a rate above 100%, a negative count, or two metrics that should differ but come back essentially identical (e.g. missed vs denied revenue to the penny), that is almost certainly a DATA GLITCH — say so plainly and give the raw figure, do NOT present it as a real result or invent a business reason for it. Also treat "overdue returns" with care: the list can include old rentals that were physically returned but never marked, so describe a long overdue list as "may include unreconciled past rentals" rather than asserting that much gear is genuinely out.

Worked example — for "should I buy another X / is X worth getting / how is X doing / what should I buy", call query_item_earnings (window 30 or 365) for X's real NET income, query_utilization for its idle cost/utilization, and query_smart_buys for unmet-demand picks, THEN reason from those numbers. Never answer a buy/sell/performance question from the snapshot alone.

Drill-down tools:
  query_item_earnings    — per-item income, cost-proportional (the income pie's method; NET); 'best earner' / 'how much did item X make'; window 30/90/365
  query_income_distribution — income split across categories (the income pie; NET); window 30/90/365
  query_catalog          — inventory worth, out-of-stock items list, sell recommendations, qty drift
  query_issues           — missed/denied revenue, qty drift, capacity gaps, below-minimum, voluntary-deny
  query_utilization      — Idle Inventory: items costing the most while idle (sorted by idle £/week)
  query_due_returns      — items overdue or due-soon for return
  query_pending          — the full list of booking requests awaiting your accept/decline
  query_recent_activity  — last N rental events (newest first)
  query_funnel           — reservation conversion funnel for last N days
  query_calendar         — weekly calendar (booked/free/partial) for the WHOLE inventory
  query_availability     — is a SPECIFIC named item free today / when is it next free / what it's booked for; the ONLY source for per-item availability ("is the 16-35 free", "when's the FX3 back"). Returns every matching unit + current/upcoming confirmed bookings (past ones excluded)
  query_smart_buys       — NEW items to acquire (unmet demand, ROI-sorted)
  query_revenue_trend    — weekly NET revenue trend
  query_status           — UK tax estimate, business-intel KPIs, scanner, vacation, AI-Boost (£0 by design)
  query_inventory        — does Daniel OWN an item / its specs / "is the deck an RX2 or RX3" / "do we have a Blackmagic"; resolves a free-text name to the real item rows (kind, qty, lens_mount, compatibility, marketing-vs-master flag). Returns ALL matches, so two bodies or a duplicate row both show.
  query_compatibility    — gear-fit questions ("will an EF lens fit the BMPCC", "is X compatible with Y", mount/adapter/battery/card questions); returns the OWNED item's mount + compatible lenses/batteries/cards AND any matching gear FAQ from the knowledge base.
  query_rental_history   — historical / past completed rentals aggregated per item (net earnings, rent days, utilization) plus a recent rentals list and totals; call for any question about rental history, past/previous rentals, earnings over time, all-time per-item earnings, or "what did I rent in <period>".
  read_settings          — the rental manager's current master settings (pickup/collection hours, poll interval, delivery radius, toggles)
  change_settings        — CHANGE a master setting the operator asks for (pickup hours, poll interval, delivery radius, escalate-to-sonnet, count-pending toggle, AI boost). NOT the read-only-mode or Hygglo-send safety rails — for those tell them to use the Settings screen.

SETTINGS — when the operator asks to change a master setting (e.g. "set pickup hours to 10-12 and 7-9", "poll every 5 minutes", "raise the delivery radius to 25km", "count pending bookings in availability"), call change_settings with the fields to change and confirm what you changed. When adding to a list like pickup hours, call read_settings first and send the full new list. Never change the read-only-mode or Hygglo-send safety rails from chat.

INVENTORY & COMPATIBILITY — read before answering "do we have…", "is it an X or a Y", "what cameras/lenses do we own", or any gear-fit / mount / adapter / lens-compatibility question.
The INVENTORY INDEX below the snapshot (when present) is the COMPLETE master inventory — every item Daniel owns, active and non-marketing. NEVER claim he owns something that is not in that index, and NEVER tell him he doesn't own something that IS in it. Each lens line carries a focus tag ("AF" = autofocus, "manual focus") — use it directly for autofocus / manual-focus questions; if a line has no focus tag, call query_inventory and read its focus field + spec_description rather than guessing. For exact specs (focal length, aperture, sensor, weight, autofocus system, what card it takes, what's INCLUDED in the rental bundle), quantity, the master-vs-marketing distinction, or to resolve a fuzzy name, call query_inventory and answer ONLY from its returned spec_description / specs_long / focus / compatibility.included_with_rental — never recall an item's specs from memory. What "comes with" / is "included" in a rental is EXACTLY compatibility.included_with_rental and nothing else — never infer that an adapter, lens or accessory ships with an item because it appears in a compatible-with list. If a listed-compatible lens needs a mount adapter, only say the adapter is included when it is actually in included_with_rental (or owned as its own inventory row); otherwise say the adapter would be needed. For any gear-fit / mount / lens-compatibility question call query_compatibility and answer from the owned item's real mount + compatibility data and the returned FAQ; do not reason about optics from memory. If neither the index nor the tool shows the item, say it's not in the inventory rather than inventing it. Camera/lens optics facts (crop factor, vignetting, mount adapting) are easy to get backwards — if a tool/FAQ doesn't cover it and you are not certain, say so plainly instead of guessing.

AVAILABILITY — "is X free / available today", "when is X next free / back", "what's X booked for", "can I rent out X this weekend": ALWAYS call query_availability with the item name and answer ONLY from it. Never answer availability from the weekly snapshot, from query_calendar, or from memory, and NEVER state a renter name or a booking end-date you did not get from query_availability THIS turn (the old chat invented "booked with <renter> until <date>" from a rental that had already ended — do not do that). It returns every matching unit, so if the name is ambiguous (e.g. "16-35" = both the Canon EF and the Sony GM) name both and give each one's status. free_today=true with an empty upcoming_bookings means it is genuinely free; quote next_free_date for when a booked item frees up.`;

/**
 * Matches user questions whose answer is NOT in the headline snapshot (per-item
 * earnings, utilization/idle, buy/sell, trends, issues, catalog, funnel, tax…).
 * Both chat routes force `toolChoice:'required'` on the first step when this
 * matches, so DeepSeek-chat (toolChoice:auto) can't answer from the snapshot
 * alone and confabulate the numbers — it ignored the prompt's "never invent"
 * rule on a bad roll. Deliberately broad: a false positive costs one extra
 * grounded tool call; a false negative risks a fabricated figure. Shared here
 * so the two surfaces can't drift.
 */
export const ANALYTICAL_INTENT =
  /\b(buy|buying|bought|purchas|invest|acqui|sell|selling|sold|worth|earn|earning|income|profit|roi|return on|best|worst|top|how much (did|does|has)|per[- ]?item|utili[sz]|idle|unused|sitting|under[- ]?used|trend|growing|declin|missed|denied|lost|capacity|below[- ]?min|funnel|conver|catalog|inventor|out[- ]?of[- ]?stock|overdue|due (back|return)|tax|kpi|recommend|should i|history|previous rental|past rental|over time|all[- ]?time|earned the most)\b/i;

/**
 * EXISTENCE / SPEC intent — "do we have X", "is the deck an RX2 or RX3", "what
 * cameras do we own", "specs of the …". The headline snapshot can't answer
 * these; the INVENTORY INDEX usually can, and query_inventory always can. Both
 * routes force a grounded tool call when this matches so the model can't deny
 * owning gear it actually has (the "no Blackmagic" failure, 2026-06-02).
 */
export const INVENTORY_INTENT =
  /\b(do (we|you|i) have|have we got|do we own|we got|got any|is there|are there|in stock|in our|in the inventory|own a|owned|which (camera|lens|mic|light|deck|gear|item)|what (camera|lens|mic|light|deck|gear|item)|spec|specs|specification|model|version|how many .* (do|have)|rx2|rx3|blackmagic|bmpcc)\b/i;

/**
 * COMPATIBILITY / OPTICS intent — "will an EF lens fit", "is X compatible with
 * Y", mount / adapter / battery / card fit, crop-factor / vignetting reasoning.
 * Forces query_compatibility AND routes the turn to CHAT_MODEL_SMART (Sonnet):
 * Haiku inverted the APS-C vs full-frame fact answering from memory.
 */
export const COMPAT_INTENT =
  /\b(compatib|compatible|work(s)? with|fit(s)?|fit on|mount|adapter|adapt|metabones|mc[- ]?11|ef[- ]?mount|e[- ]?mount|l[- ]?mount|rf[- ]?mount|pl[- ]?mount|aps[- ]?c|full[- ]?frame|crop factor|vignett|speed booster|lens(es)? (for|on|with))\b/i;

/**
 * AVAILABILITY / SPEC intent — "is the 16-35 free today", "when's the FX3 back",
 * "what's X booked for", "does it autofocus", "what card / what comes with it".
 * These have a single correct answer in the data (query_availability /
 * query_inventory) and were the bulk of the "everything he says is wrong"
 * failures, so the WallE route sends them to CHAT_MODEL_SMART (Sonnet) — Haiku
 * was electing to answer from memory instead of calling the tool.
 */
export const AVAILABILITY_INTENT =
  /\b(available|availabilit|free (today|tomorrow|this|next|on|right now)|is .* free|booked|booking|reserved|when('?s| is) .* (free|back|available|returned)|next free|can i (rent|hire|book)|out (today|tomorrow)|autofocus|auto-?focus|\baf\b|manual focus|what card|sd card|cf ?express|comes with|come with|included|in the (kit|bundle|box))\b/i;

// ── Module-scoped 60s TTL cache (Phase 7b, 2026-05-24) ──────────────────────
// Saves re-fetching aggregated data within a single multi-step LLM turn AND
// across concurrent chat turns landing within 60s of each other. Applied only
// to read-only aggregates that don't change minute-to-minute. Live state
// (pending, due_returns) is intentionally uncached so Daniel sees the freshest
// action queue. Shared across both chat routes — same Convex aggregates, so a
// shared cache is correct and cheaper.
type CacheEntry = { value: unknown; exp: number };
const TOOL_CACHE = new Map<string, CacheEntry>();
const TOOL_CACHE_TTL_MS = 60_000;

/** Hygglo take-home ≈ 64% of gross. The income-pie queries
 *  (getRentalVolumeByCategory / getRentalVolumeKindBreakdown) return
 *  GROSS-attributed revenue, so per-item / per-category figures are × this to
 *  report NET take-home (the distribution / ranking is identical either way). */
const OWNER_SHARE = 0.64;

async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = TOOL_CACHE.get(key);
  if (hit && hit.exp > now) return hit.value as T;
  const fresh = await fetcher();
  TOOL_CACHE.set(key, { value: fresh, exp: now + TOOL_CACHE_TTL_MS });
  // Opportunistic GC: drop the oldest 25% of entries once the map crosses 200.
  if (TOOL_CACHE.size > 200) {
    const oldest = [...TOOL_CACHE.entries()]
      .sort((a, b) => a[1].exp - b[1].exp)
      .slice(0, 50);
    for (const [k] of oldest) TOOL_CACHE.delete(k);
  }
  return fresh;
}

/**
 * The dashboard's "Active Rentals" tile AND every revenue/earnings tile render
 * from ONE Convex query: `dashboard.getStatsDrawerData`. The chat tools read
 * that exact query (cached 60s) so the chatbot's numbers match the tiles by
 * construction — NET take-home, pickup-gated, deduped — instead of the older
 * `dashboard_insights` gross / start-date logic that drifted from reality.
 */
type DrawerData = {
  active?: {
    total?: number;
    ongoing_count?: number;
    upcoming_count?: number;
    pending_count?: number;
    pending_value_gbp?: number;
  };
  // Live getStatsDrawerData(_bypassMv) returns the rental lists inline (the MV
  // strips them into a separate, staler row). Read them here so the snapshot's
  // list and counts always come from the same live computation.
  ongoing?: { count?: number; rentals?: RentalRow[] };
  upcoming?: { count?: number; rentals?: RentalRow[] };
  monthly?: {
    confirmed_revenue?: number;
    current_earnings?: number;
    projected?: number;
    target_gbp?: number;
    pct_of_target?: number;
    avg_daily_rate?: number;
    days_remaining?: number;
  };
  earnings?: { today?: number; week?: number };
  confirmed?: { month_revenue?: number; month_label?: string };
  conflicts?: Array<{
    item_canonical?: string;
    qty?: number;
    overlap_count?: number;
    conflict_start?: string;
    conflict_end?: string;
    reservations?: unknown[];
  }>;
  untracked?: { count?: number; total_value_gbp?: number };
  out_of_stock?: { count?: number; items?: Array<Record<string, unknown>> };
  inventory_worth?: { total_gbp?: number; by_category?: Array<Record<string, unknown>> };
  sell_reco?: { recommendations?: Array<Record<string, unknown>> };
  qty_drift_count?: number;
  qty_drift_sample?: Array<Record<string, unknown>>;
  missed_revenue?: { total_gbp?: number; items?: unknown[] };
  denied_revenue?: { total_gbp?: number; items?: unknown[] };
  insurance?: {
    open_count?: number;
    open_amount_gbp?: number;
    settled_count_ytd?: number;
    total_count?: number;
  };
  business_intel?: { kpis?: Array<Record<string, unknown>> };
  tax?: { years?: Array<{ year?: number; estimated_tax?: number; gross?: number }> };
  scanner?: {
    last_run_succeeded?: boolean;
    last_scan_source?: string;
    rows_upserted_last?: number;
  };
  vacation?: { active_blocks?: unknown[] };
  ai_boost?: {
    breakdown?: Array<{ label?: string; gbp?: number; weight?: number }>;
    confidence?: string;
  };
};

/** One rental row from the Active Rentals drawer (mv.stats_drawer.getRentals). */
type RentalRow = {
  item_names_summary?: string;
  renter_name?: string;
  account_slug?: string;
  start_date?: string;
  end_date?: string;
  pickup_date?: string;
  pickup_time?: string;
  pickup_method?: string;
  return_date?: string;
  return_time?: string;
  return_method?: string;
  net_gbp?: number;
};

function fetchDrawer(convex: ConvexHttpClient): Promise<DrawerData> {
  // _bypassMv:true → LIVE compute, NOT the hourly `mv_stats_drawer` cache. That
  // cache goes stale for hours: its dirty-probe only scans the 50 most-recent
  // reservations by future start_date, so a status change on a past/ongoing
  // rental (ended/cancelled) never marks it dirty and the rebuild is skipped.
  // The chat MUST reflect the live reservations table (≤5 min behind Hygglo),
  // not an old snapshot. Chat is low-volume so the live compute cost is fine.
  return cached("drawer:live", () =>
    convex.query(api.dashboard.getStatsDrawerData, {
      accountSlug: null,
      _bypassMv: true,
    } as { accountSlug: string | null }),
  ) as Promise<DrawerData>;
}

/**
 * v1-style compute-then-phrase: build ONE live snapshot of the headline
 * dashboard figures as plain text, injected into the chat system prompt so the
 * model quotes trusted numbers instead of choosing among tools and re-deriving
 * them. Everything here is the dashboard's own LIVE value (matches the tiles).
 */
export async function buildLiveSnapshot(convex: ConvexHttpClient): Promise<string> {
  const [d, pendingRaw] = await Promise.all([
    fetchDrawer(convex),
    cached("pending:inbox", () =>
      convex.query(api.reservations.listPendingWithoutDecision, { limit: 500 }),
    ),
  ]);
  const pendingInbox = Array.isArray(pendingRaw) ? pendingRaw.length : 0;
  const a = d.active ?? {};
  const m = d.monthly ?? {};
  const e = d.earnings ?? {};
  const c = d.confirmed ?? {};
  const asOf = new Date().toISOString().slice(0, 16).replace("T", " ");
  const today = asOf.slice(0, 10);
  // net_gbp is NET-to-owner (after Hygglo fees); the per-rental gross/listing
  // price is not in this payload. Each line carries pickup AND return date+time+
  // method so the model never guesses "out today / back today" from start/end.
  const fmt = (x: RentalRow) => {
    const pick = `${x.pickup_date ?? x.start_date ?? "?"}${x.pickup_time ? " " + x.pickup_time : ""}${x.pickup_method ? " (" + x.pickup_method + ")" : ""}`;
    const ret = `${x.return_date ?? x.end_date ?? "?"}${x.return_time ? " " + x.return_time : ""}${x.return_method ? " (" + x.return_method + ")" : ""}`;
    return `${x.item_names_summary ?? "item"} — ${x.renter_name ?? "renter"}${x.account_slug ? ` [${x.account_slug}]` : ""}: pickup ${pick} → return ${ret}, £${x.net_gbp ?? "?"} net`;
  };
  // Lists from the SAME live payload as the counts → always consistent.
  const ongoing = (d.ongoing?.rentals ?? []).map(fmt);
  const upcoming = (d.upcoming?.rentals ?? []).map(fmt);
  // Today's actual pickups/deliveries and returns, keyed off pickup_date /
  // return_date (NOT order_step — every row reads "DELIVERED" so it's useless).
  // A rental whose start_date == today is collected/delivered TODAY (it is NOT
  // "already out" — check pickup_time vs the as-of time above).
  const allActive = [...(d.ongoing?.rentals ?? []), ...(d.upcoming?.rentals ?? [])];
  const ev = (x: RentalRow, t?: string, meth?: string) =>
    `${x.item_names_summary ?? "item"} — ${x.renter_name ?? "renter"}${x.account_slug ? ` [${x.account_slug}]` : ""}, ${t ?? "time TBC"}${meth ? ` via ${meth}` : ""}, £${x.net_gbp ?? "?"} net`;
  const pickupsToday = allActive
    .filter((x) => (x.pickup_date ?? x.start_date) === today)
    .map((x) => ev(x, x.pickup_time, x.pickup_method));
  const returnsToday = allActive
    .filter((x) => (x.return_date ?? x.end_date) === today)
    .map((x) => ev(x, x.return_time, x.return_method));
  const conflicts = Array.isArray(d.conflicts) ? d.conflicts : [];
  return [
    `LIVE DASHBOARD SNAPSHOT (the dashboard's own current figures as of ${asOf} UTC — quote these directly, never recompute or override them):`,
    `- Active rentals: ${a.total ?? 0} total = ${a.ongoing_count ?? 0} ongoing + ${a.upcoming_count ?? 0} upcoming.`,
    ongoing.length ? `  Ongoing (out or going out within their window): ${ongoing.join(" | ")}.` : `  Ongoing: nothing.`,
    upcoming.length ? `  Upcoming: ${upcoming.join(" | ")}.` : `  Upcoming: none.`,
    pickupsToday.length
      ? `- PICKUPS / DELIVERIES TODAY (${today}) — items being collected/delivered today (NOT necessarily out yet; compare the pickup time to the as-of time): ${pickupsToday.join(" | ")}.`
      : `- Pickups/deliveries today: none.`,
    returnsToday.length
      ? `- RETURNS TODAY (${today}) — items coming back today: ${returnsToday.join(" | ")}.`
      : `- Returns today: none.`,
    `- Month-to-date confirmed revenue (NET take-home): £${c.month_revenue ?? m.confirmed_revenue ?? "?"}. Earned so far this month (pickup-gated): £${m.current_earnings ?? "?"}. Target £${m.target_gbp ?? "?"} (${m.pct_of_target ?? "?"}% of target).`,
    `- Earnings: today £${e.today ?? 0} net, this week £${e.week ?? 0} net.`,
    conflicts.length
      ? `- Overbooking conflicts (REAL, qty-aware): ${conflicts.length} — ${conflicts.map((x) => `${x.item_canonical} (qty ${x.qty}, ${x.overlap_count} overlapping) on ${x.conflict_start}`).join("; ")}.`
      : `- Overbooking conflicts: 0.`,
    `- New booking requests awaiting your accept/decline: ${pendingInbox}. Out of stock: ${d.out_of_stock?.count ?? 0}. Untracked rentals: ${d.untracked?.count ?? 0}. Open insurance claims: ${d.insurance?.open_count ?? 0}.`,
  ].join("\n");
}

/**
 * Build the MASTER INVENTORY INDEX — one compact line per owned (active,
 * non-marketing) item — injected into the chat system prompt. This is the
 * bounded, always-relevant half of the grounding split: at ~80 items it is a
 * few hundred tokens, cheap enough to carry every turn, and it lets WallE
 * answer "do we own X / is it an RX2 or RX3" straight from context without a
 * tool call — closing the "no Blackmagic" confabulation. Deep specs and
 * compatibility stay lazy (query_inventory / query_compatibility).
 */
export async function buildInventoryIndex(
  convex: ConvexHttpClient,
): Promise<string> {
  const rows = (await cached("inventory:index", () =>
    convex.query(inventoryIndexRef, {}),
  )) as unknown as Array<{
    name?: string;
    kind?: string;
    sub_kind?: string | null;
    qty?: number;
    lens_mount?: string | null;
    focus?: "autofocus" | "manual_focus" | "fixed" | null;
  }>;
  if (!Array.isArray(rows) || rows.length === 0) return "";
  // Group by kind for a scannable list; carry qty (>1), mount, and the focus
  // tag (AF/MF) where known so "which lenses autofocus" answers straight from
  // this index — no tool hop, no guessing.
  const byKind = new Map<string, string[]>();
  for (const r of rows) {
    const kind = r.kind ?? "other";
    const mount =
      r.lens_mount && r.lens_mount !== "N/A" ? `, ${r.lens_mount}` : "";
    const qty = r.qty && r.qty > 1 ? ` x${r.qty}` : "";
    const focus =
      r.focus === "autofocus" ? ", AF"
      : r.focus === "manual_focus" ? ", manual focus"
      : "";
    const line = `${r.name ?? "item"}${qty}${mount}${focus}`;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(line);
  }
  const sections = [...byKind.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, items]) => `  ${kind}: ${items.join("; ")}.`);
  return [
    `MASTER INVENTORY INDEX (${rows.length} items Daniel owns — the COMPLETE active, non-marketing set. This IS the inventory: never claim he owns anything not listed here, and never tell him he lacks something that is. Quantities shown as xN; "marketing-only" listings are deliberately excluded. For exact specs / compatibility call query_inventory / query_compatibility):`,
    ...sections,
  ].join("\n");
}

/**
 * Builds the AI SDK v6 tool registry. Caller supplies a ConvexHttpClient so
 * each route can reuse one client per request. This is the ONE place the
 * dashboard tools are defined.
 *
 * NOTE: getPipelineCounts is an internalQuery (not callable from HTTP), so the
 * "pipeline" surface is exposed via getConversionFunnel instead.
 */
export function buildDashboardTools(convex: ConvexHttpClient): Record<string, Tool> {
  return {
    read_settings: tool({
      description:
        "Read the rental manager's current MASTER SETTINGS — pickup/collection hours, polling interval, " +
        "delivery radius (hub_max_km / hub_heavy_max_km) and the operational toggles (escalate_to_sonnet, " +
        "availability_include_pending, ai_boost_rate, ai_active_from). Use before changing a setting, or when " +
        "the operator asks what a setting currently is.",
      inputSchema: z.object({}),
      execute: async () => {
        const s = await convex.query(settingsGetRef, {});
        return JSON.stringify(s ?? {});
      },
    }),
    change_settings: tool({
      description:
        "Change the rental manager's MASTER SETTINGS when the operator asks (e.g. 'set pickup hours to 10-12 and " +
        "7-9', 'poll every 5 minutes', 'raise the delivery radius to 25km', 'count pending in availability'). You " +
        "CAN set: pickup_hours, polling_interval_ms, escalate_to_sonnet, availability_include_pending, hub_max_km, " +
        "hub_heavy_max_km, ai_boost_rate, ai_active_from. You CANNOT change the read-only-mode or Hygglo-send " +
        "safety rails from chat — if asked, tell the operator to use the Settings screen for those. When editing " +
        "part of a list (e.g. ADDING one pickup window), call read_settings first and send the full new list. " +
        "Confirm the change back to the operator in plain language.",
      inputSchema: z.object({
        pickup_hours: z
          .array(z.object({ start: z.string(), end: z.string() }))
          .optional()
          .describe("Full replacement list of pickup/collection windows, London time, 24h HH:MM."),
        polling_interval_ms: z.number().optional().describe("Poll interval in ms (60000-3600000)."),
        escalate_to_sonnet: z.boolean().optional(),
        availability_include_pending: z.boolean().optional(),
        hub_max_km: z.number().optional().describe("Max delivery radius, km."),
        hub_heavy_max_km: z.number().optional().describe("Max delivery radius for heavy items, km."),
        ai_boost_rate: z.number().optional(),
        ai_active_from: z.string().optional().describe("HH:MM the AI becomes active."),
      }),
      execute: async (input) => {
        const fields = Object.fromEntries(
          Object.entries(input).filter(([, v]) => v !== undefined),
        );
        if (Object.keys(fields).length === 0) return "No settings were provided to change.";
        try {
          await convex.mutation(settingsUpdateRef, fields);
          return `Done — updated: ${Object.keys(fields).join(", ")}.`;
        } catch (e) {
          return `Couldn't update settings: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),
    query_utilization: tool({
      description:
        "Idle Inventory — the items COSTING the most money while sitting unused (the dashboard 'Idle Inventory' " +
        "card). Sorted by idle_cost_per_week_gbp DESC (biggest money-drain first); top items only. Each: " +
        "{ name, utilization (0-1 = fraction of time rented), idle_cost_per_week_gbp, replacement_cost_gbp }. " +
        "The top row is the biggest idle-money drain (expensive AND under-used) — it is NOT necessarily the " +
        "single lowest-utilization item. Don't re-rank; report in the order given.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = (await cached("util:ranking", () =>
          convex.query(api.dashboard_insights.getItemUtilizationRanking, { accountSlug: null }),
        )) as unknown as Array<{
          name?: string;
          utilization?: number;
          idle_cost_per_week?: number;
          replacement_cost_gbp?: number;
        }>;
        return {
          items: (Array.isArray(rows) ? rows : []).map((r) => ({
            name: r.name,
            utilization: r.utilization,
            idle_cost_per_week_gbp: r.idle_cost_per_week,
            replacement_cost_gbp: r.replacement_cost_gbp,
          })),
        };
      },
    }),

    query_catalog: tool({
      description:
        "Inventory / catalog snapshot, matching the dashboard cards. Returns { inventory_worth_gbp, " +
        "inventory_by_category, out_of_stock_count, out_of_stock_items, sell_recommendations, qty_drift_count }. " +
        "out_of_stock = items currently held >= their quantity; sell_recommendations = items the dashboard " +
        "suggests selling (low utilization / aged).",
      inputSchema: z.object({}),
      execute: async () => {
        const d = await fetchDrawer(convex);
        return {
          inventory_worth_gbp: d.inventory_worth?.total_gbp,
          inventory_by_category: (d.inventory_worth?.by_category ?? []).slice(0, 25),
          out_of_stock_count: d.out_of_stock?.count,
          out_of_stock_items: (d.out_of_stock?.items ?? []).slice(0, 25),
          sell_recommendations: (d.sell_reco?.recommendations ?? []).slice(0, 25),
          qty_drift_count: d.qty_drift_count,
          qty_drift_sample: (d.qty_drift_sample ?? []).slice(0, 10),
        };
      },
    }),

    query_issues: tool({
      description:
        "Operational issues / alerts, matching the dashboard alert cards. Use for 'what needs attention / any " +
        "problems'. Returns overbooking conflicts, untracked rentals, out-of-stock, qty drift, denied revenue " +
        "(NET £ of requests explicitly DECLINED) and missed revenue (NET £ theoretical idle-capacity opportunity " +
        "— gear sitting unused), open insurance claims, and capacity-gap / below-minimum / voluntary-deny alerts. " +
        "denied_revenue and missed_revenue are DISTINCT, NOT additive: one is turned-away demand, the other is idle " +
        "capacity. NOTE: denied_revenue is a LIFETIME total — the denial history was backfilled on a single import " +
        "date and the records carry no per-event date, so describe it as all-time declined demand, NEVER as 'this " +
        "month' or 'last 30 days'. All other counts are the true dashboard figures.",
      inputSchema: z.object({}),
      execute: async () => {
        const [d, capacityGaps, belowMin, voluntaryDeny] = await Promise.all([
          fetchDrawer(convex),
          cached("cap:gap", () =>
            convex.query(api.dashboard_insights.getCapacityGapAlert, { accountSlug: null }),
          ),
          cached("below:min", () =>
            convex.query(api.dashboard_insights.getBelowMinimumCounter, { accountSlug: null }),
          ),
          cached("vol:deny", () =>
            convex.query(api.dashboard_insights.getVoluntaryDenyHotList, { accountSlug: null }),
          ),
        ]);
        const conflicts = Array.isArray(d.conflicts) ? d.conflicts : [];
        return {
          overbooking_conflicts: conflicts.length,
          untracked_rentals: d.untracked?.count,
          out_of_stock_count: d.out_of_stock?.count,
          qty_drift_count: d.qty_drift_count,
          missed_revenue_gbp: d.missed_revenue?.total_gbp,
          denied_revenue_gbp: d.denied_revenue?.total_gbp,
          open_insurance_claims: d.insurance?.open_count,
          open_insurance_amount_gbp: d.insurance?.open_amount_gbp,
          capacity_gap_count: Array.isArray(capacityGaps) ? capacityGaps.length : capacityGaps,
          below_minimum: belowMin,
          voluntary_deny_count: Array.isArray(voluntaryDeny) ? voluntaryDeny.length : voluntaryDeny,
        };
      },
    }),
    query_pending: tool({
      description:
        "Daniel's DECISION INBOX — new booking requests awaiting his accept/decline (status 'pending_review', " +
        "no AI decision row yet). This is NOT the 'Active Rentals' tile's pending count (that is pending-verification, " +
        "available via query_active_rentals). Returns { total_awaiting_decision, items }. ALWAYS report " +
        "total_awaiting_decision as THE count; `items` is only a capped preview, never the count.",
      inputSchema: z.object({
        sample: z
          .number()
          .min(1)
          .max(50)
          .optional()
          .describe("How many rows to include in the preview list; default 10. Does NOT affect total_awaiting_decision."),
      }),
      execute: async ({ sample }: { sample?: number }) => {
        // Fetch the full pending set (high cap) so total_awaiting_decision is the
        // TRUE count, not a limit artifact. This tool previously returned a bare,
        // limit-capped array with no total — so models reported the cap (e.g. 10)
        // or miscounted (5) while the real number was 17. Returning an explicit
        // total makes both chat widgets report the same correct count.
        const all = await convex.query(api.reservations.listPendingWithoutDecision, { limit: 500 });
        const items = Array.isArray(all) ? all : [];
        return { total_awaiting_decision: items.length, items: items.slice(0, sample ?? 10) };
      },
    }),
    query_funnel: tool({
      description:
        "Reservation conversion funnel for the last N days. Returns bookings / declines / cancellations.",
      inputSchema: z.object({
        days: z.number().min(1).max(180).optional().describe("Lookback days; default 30."),
      }),
      execute: async ({ days }: { days?: number }) => {
        const d = days ?? 30;
        return cached(`funnel:${d}`, () =>
          convex.query(api.reservations.getConversionFunnel, {
            accountSlug: null,
            days: d,
          }),
        );
      },
    }),
    query_calendar: tool({
      description: "Weekly calendar — items booked / partial / free over the next 7 days.",
      inputSchema: z.object({}),
      execute: async () => {
        const weekStartDate = new Date().toISOString().slice(0, 10);
        return cached(`calendar:${weekStartDate}`, () =>
          convex.query(api.calendar.getWeeklyCalendar, {
            accountSlug: null,
            weekStartDate,
          }),
        );
      },
    }),
    query_availability: tool({
      description:
        "Is a SPECIFIC item free today / when is it next free / what's it booked for. ALWAYS use this for any " +
        "'is X available', 'is X free', 'can I rent out X', 'when is X back/free', 'what's booked' question about a " +
        "named item — NEVER answer availability from memory or the weekly query_calendar grid. Resolves the free-text " +
        "name to the real OWNED unit(s) and returns EVERY match (so the two 16-35s — Canon EF and Sony GM — both come " +
        "back; disambiguate them for Daniel). Each match: { name, qty, owned, free_today (bool), free_units_today, " +
        "next_free_date (YYYY-MM-DD or null if booked solid through the horizon), free_whole_horizon, upcoming_bookings:" +
        "[{ renter, pickup, return, account }] }. ONLY confirmed rentals appear and ONLY current/upcoming ones (past " +
        "rentals are excluded) — if upcoming_bookings is empty the item is genuinely free. State the renter/date ONLY " +
        "from upcoming_bookings; if owned=false it's a marketing listing with no stock of its own.",
      inputSchema: z.object({
        item: z.string().describe("The item the user asked about, e.g. '16-35', 'fx3', 'gm 24-70'."),
        horizon_days: z
          .number()
          .min(1)
          .max(60)
          .optional()
          .describe("How far ahead to look for bookings / next-free. Default 21."),
      }),
      execute: async ({ item, horizon_days }: { item: string; horizon_days?: number }) =>
        convex.query(itemAvailabilityRef, {
          query: item,
          accountSlug: null,
          ...(horizon_days ? { horizonDays: horizon_days } : {}),
        }),
    }),
    query_due_returns: tool({
      description: "Items overdue or due-soon for return.",
      inputSchema: z.object({}),
      execute: async () => convex.query(api.reservations.getDueReturns, { accountSlug: null }),
    }),
    query_recent_activity: tool({
      description: "Newest rental events (status changes, new bookings, etc).",
      inputSchema: z.object({
        limit: z.number().min(1).max(50).optional(),
      }),
      execute: async ({ limit }: { limit?: number }) =>
        convex.query(api.reservations.getRecentActivity, {
          accountSlug: null,
          limit: limit ?? 15,
        }),
    }),
    query_item_earnings: tool({
      description:
        "Per-item income using the dashboard's COST-PROPORTIONAL attribution — the SAME method the income pie " +
        "uses: each rental's income is split across the items in that rental in proportion to each item's " +
        "value/cost (so an expensive camera in a set earns most of that rental, a cheap accessory little). NET " +
        "take-home. This is the CORRECT source for 'who earns the most / how much did item X make' — items are " +
        "sorted by net_gbp desc, each { name, kind, rentals, net_gbp, share_pct }. Args: window_days 30/90/365 " +
        "(default 365 = last 12 months). For 'last month' use 30. There is no exact calendar-month or >365-day " +
        "figure, so state the window you used (e.g. 'over the last year').",
      inputSchema: z.object({
        window_days: z.number().optional().describe("30, 90, or 365. Default 365."),
      }),
      execute: async ({ window_days }: { window_days?: number }) => {
        const days = window_days === 30 || window_days === 90 ? window_days : 365;
        const cat = (await cached(`pie:${days}`, () =>
          convex.query(getRentalVolumeByCategoryRef, { accountSlug: null, days }),
        )) as unknown as { slices?: Array<{ kind?: string }> };
        const kinds = (cat.slices ?? [])
          .map((s) => s.kind)
          .filter((k): k is string => typeof k === "string");
        const breakdowns = await Promise.all(
          kinds.map((kind) =>
            cached(`brk:${days}:${kind}`, () =>
              convex.query(getRentalVolumeKindBreakdownRef, {
                accountSlug: null,
                days,
                kind,
              }),
            ),
          ),
        );
        type Brk = { items?: Array<{ name?: string; count?: number; revenue?: number }> };
        const items: Array<{ name?: string; kind: string; rentals?: number; net_gbp: number }> = [];
        breakdowns.forEach((bRaw, i) => {
          const b = bRaw as unknown as Brk;
          (b.items ?? []).forEach((it) => {
            items.push({
              name: it.name,
              kind: kinds[i],
              rentals: it.count,
              net_gbp: Math.round((it.revenue ?? 0) * OWNER_SHARE * 100) / 100,
            });
          });
        });
        items.sort((a, b) => b.net_gbp - a.net_gbp);
        const totalNet = items.reduce((s, it) => s + it.net_gbp, 0);
        return {
          window_days: days,
          window_note: days === 30 ? "last 30 days" : days === 90 ? "last 90 days" : "last 12 months",
          total_net_gbp: Math.round(totalNet * 100) / 100,
          items: items.map((it) => ({
            name: it.name,
            kind: it.kind,
            rentals: it.rentals,
            net_gbp: it.net_gbp,
            share_pct: totalNet > 0 ? Math.round((it.net_gbp / totalNet) * 1000) / 10 : 0,
          })),
        };
      },
    }),

    query_income_distribution: tool({
      description:
        "Income distribution across CATEGORIES — the dashboard income pie. Uses cost-proportional attribution " +
        "(each rental's income split across its items by item value), NET take-home. Returns categories sorted " +
        "by income (£) DESC: { category, net_gbp, share_pct, rentals }. NOTE: the on-screen pie orders its " +
        "slices by rental COUNT, so the visual slice order can differ — use the £ here for 'which category earns " +
        "most'. Args: window_days 30/90/365 (default 30, matching the pie). For per-ITEM breakdown use " +
        "query_item_earnings.",
      inputSchema: z.object({
        window_days: z.number().optional().describe("30, 90, or 365. Default 30 (matches the pie)."),
      }),
      execute: async ({ window_days }: { window_days?: number }) => {
        const days = window_days === 90 || window_days === 365 ? window_days : 30;
        const cat = (await cached(`pie:${days}`, () =>
          convex.query(getRentalVolumeByCategoryRef, { accountSlug: null, days }),
        )) as unknown as {
          slices?: Array<{ kind?: string; label?: string; revenue?: number; count?: number }>;
        };
        const slices = (cat.slices ?? []).map((s) => ({
          category: s.label ?? s.kind,
          net_gbp: Math.round((s.revenue ?? 0) * OWNER_SHARE * 100) / 100,
          rentals: s.count,
        }));
        const totalNet = slices.reduce((sum, s) => sum + s.net_gbp, 0);
        return {
          window_days: days,
          total_net_gbp: Math.round(totalNet * 100) / 100,
          categories: slices
            .sort((a, b) => b.net_gbp - a.net_gbp)
            .map((s) => ({
              category: s.category,
              net_gbp: s.net_gbp,
              rentals: s.rentals,
              share_pct: totalNet > 0 ? Math.round((s.net_gbp / totalNet) * 1000) / 10 : 0,
            })),
        };
      },
    }),
    query_smart_buys: tool({
      description:
        "Smart-Buy ranking — NEW items to acquire (driven by unmet demand for gear Daniel does NOT already own), " +
        "sorted by first-year ROI DESC. Each: { itemName, recommendation, requestCount, estAnnualNetGbp, " +
        "estDailyRateGbp, firstYearROIPct, estAcquisitionCostGbp }. Use for 'what should I buy'. For 'should I " +
        "buy ANOTHER X' (already owned), use query_item_earnings + query_utilization instead.",
      inputSchema: z.object({
        limit: z.number().min(1).max(30).optional(),
      }),
      execute: async ({ limit }: { limit?: number }) => {
        const l = limit ?? 10;
        return cached(`smart_buys:${l}`, () =>
          convex.query(api.intel.getSmartBuyRanking, { limit: l }),
        );
      },
    }),

    query_revenue_trend: tool({
      description:
        "Weekly NET revenue trend — the revenue sparkline. Returns recent weeks oldest→newest, each " +
        "{ week_start, net_gbp }. Use for 'how is revenue trending / weekly revenue / the last few weeks'.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = (await cached("spark:weekly", () =>
          convex.query(api.dashboard_insights.getWeeklyRevenueSparkline, { accountSlug: null }),
        )) as unknown as Array<{ week_start?: string; revenue_net_gbp?: number }>;
        return {
          weeks: (Array.isArray(rows) ? rows : []).map((r) => ({
            week_start: r.week_start,
            net_gbp: r.revenue_net_gbp,
          })),
        };
      },
    }),

    query_status: tool({
      description:
        "Misc dashboard status: estimated UK tax per year (tax_years: { year, estimated_tax_gbp, gross_gbp }), " +
        "business-intel KPIs (e.g. top unmet demand, renter churn risk), the data-scanner state, vacation " +
        "blocks, and AI-Boost credit. AI Boost is £0 by design (the AI-approval pipeline is unbuilt in dev) — " +
        "report it honestly as £0; do NOT explain it away or inflate it.",
      inputSchema: z.object({}),
      execute: async () => {
        const d = await fetchDrawer(convex);
        const aiCredit = (d.ai_boost?.breakdown ?? []).reduce((s, b) => s + (b.gbp ?? 0), 0);
        return {
          tax_years: (d.tax?.years ?? []).map((y) => ({
            year: y.year,
            estimated_tax_gbp: y.estimated_tax,
            gross_gbp: y.gross,
          })),
          business_intel_kpis: d.business_intel?.kpis ?? [],
          scanner: d.scanner
            ? {
                healthy: d.scanner.last_run_succeeded,
                source: d.scanner.last_scan_source,
                rows_upserted_last_run: d.scanner.rows_upserted_last,
              }
            : undefined,
          vacation_active_blocks: d.vacation?.active_blocks?.length ?? 0,
          ai_boost_credit_gbp: Math.round(aiCredit * 100) / 100,
        };
      },
    }),

    query_inventory: tool({
      description:
        "Resolve a free-text item reference to the REAL item rows Daniel owns, with FULL specs. Use for 'do we have X', " +
        "'what's the deck — an RX2 or RX3', 'specs of the BMPCC', 'does it autofocus', 'what card does the FX3 take', " +
        "'what comes with the rental', 'how many X'. Fuzzy-matches name/aliases against live inventory and returns ALL " +
        "matches (so two camera bodies, or a duplicate/phantom row, both surface — never collapsed to one guess). Each " +
        "match: { name, kind, qty, status, is_marketing_only, lens_mount, battery_type, card_type, focus " +
        "('autofocus' | 'manual_focus' | 'fixed' | null — answer AF/MF questions from THIS, not memory; null = uncertain, " +
        "read spec_description and say you're not sure), compatibility (incl. included_with_rental = what ships in the " +
        "rental bundle), spec_description + specs_long (the real hand-written/researched spec sheet — focal length, " +
        "aperture, sensor, weight, AF system, etc. — quote from here for any spec question), notes }. resolved_canonical " +
        "is the single best master-inventory match. is_marketing_only=true means a marketing listing, NOT owned master " +
        "stock — say so. match_count=0 means Daniel does NOT own it; say that, don't invent.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("The item the user referred to, e.g. 'blackmagic', 'rx3 deck', 'a7 iv'."),
        include_marketing: z
          .boolean()
          .optional()
          .describe("Include marketing-only listings (flagged) as well as owned master stock. Default false."),
      }),
      execute: async ({ query, include_marketing }: { query: string; include_marketing?: boolean }) =>
        convex.query(inventoryLookupRef, {
          query,
          ...(include_marketing ? { include_marketing: true } : {}),
        }),
    }),

    query_compatibility: tool({
      description:
        "Answer a gear-FIT question grounded in real data: 'will an EF lens fit the BMPCC', 'is X compatible with Y', " +
        "mount / adapter / battery / card / lens fit. Returns the OWNED item's resolved rows (with lens_mount and " +
        "compatibility.{lenses,batteries,cards,accessories,included_with_rental}) AND any matching gear FAQ from the " +
        "knowledge base (the v1 compatibility corpus — adapters, mounts, anamorphic, cages, etc.). Answer from the " +
        "item's real mount + the FAQ; do NOT reason about optics (crop factor, vignetting, adapting) from memory. If " +
        "the data doesn't cover it and you're not certain, say so.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("The full compatibility question, e.g. 'can I use Canon EF lenses on the FX3'."),
      }),
      execute: async ({ query }: { query: string }) => {
        const [inventory, faqs] = await Promise.all([
          convex.query(inventoryLookupRef, { query }),
          cached(`knowledge:${query}`, () =>
            convex.query(knowledgeSearchRef, { query, scope: "faq", limit: 5 }),
          ).catch(() => null),
        ]);
        return { inventory, gear_faqs: faqs };
      },
    }),

    query_rental_history: tool({
      description:
        "Historical / past COMPLETED rentals aggregated per item and as a recent-rentals list. Returns { per_item, " +
        "rentals, totals } where per_item is sorted by net_gbp DESC: each { name, net_gbp, rent_days, rental_count, " +
        "utilization }; rentals is a recent-rentals list each { start, end, items:[string], net_gbp, days }; totals " +
        "is { rentals, net_gbp, span:{ first, last } }. net_gbp is canonical NET take-home (after Hygglo fees). " +
        "Call this for ANY question about rental history, past or previous rentals, earnings over time, all-time " +
        "per-item earnings, or 'what did I rent in <period>'. Optional since/until dates (YYYY-MM-DD) narrow the window.",
      inputSchema: z.object({
        since: z
          .string()
          .optional()
          .describe("ISO YYYY-MM-DD start of window (inclusive). Omit for all-time."),
        until: z
          .string()
          .optional()
          .describe("ISO YYYY-MM-DD end of window (inclusive). Omit for all-time."),
      }),
      execute: async ({ since, until }: { since?: string; until?: string }) =>
        cached(`history:${since ?? ""}:${until ?? ""}`, () =>
          convex.query(api.dashboard_insights.getRentalHistory, {
            accountSlug: null,
            ...(since ? { sinceIso: since } : {}),
            ...(until ? { untilIso: until } : {}),
          }),
        ),
    }),
  };
}
