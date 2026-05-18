/**
 * ──────────────────────────────────────────────────────────────────────────
 *  LLM-driven item resolver.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Replaces fuzzy substring matching ("a7 ii" matches "a7 iii") with a
 * Grok-driven structured classification. For each reservation:
 *
 *   Hygglo title (free-form, multi-item) + canonical inventory list
 *        ↓ Grok 4.3 with strict instructions to respect II/III/Mk2/Mk3 etc
 *   { resolved_items: [{ item_id, name, confidence }] }
 *
 * Results stored on the reservation row and consumed by:
 *   - dashboard.getStatsDrawerData (conflict detection)
 *   - calendar hold reconciliation
 *   - items.getItemRevenueRanking / getOutOfStockItems / getSellRecommendations
 *
 * Mastra agent integration: this action is the "tool" side; a future
 * agent could call `resolveReservation` as part of a larger reasoning
 * flow. For batch the simple call is enough.
 */

"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { gatedGenerateObject } from "./lib/gatedGenerate";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { titleHash, primaryBrand, brandMismatch } from "./listing_cache";
import { isWithinUkQuietHours } from "./lib/quiet_hours";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";

async function getVaultKey(service: string, keyName: string): Promise<string> {
  const envValue = process.env[keyName];
  if (envValue) return envValue;
  const res = await fetch(VAULT_URL + "/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "secrets:listByService", args: { service }, format: "json" }),
  });
  if (!res.ok) throw new Error("vault fetch failed: " + res.status);
  const data = (await res.json()) as { value?: Array<{ keyName: string; value: string }> };
  for (const s of data.value ?? []) if (s.keyName === keyName) return s.value;
  throw new Error(keyName + " not found in vault service=" + service);
}

// Convex-side LLM provider selector. Default: OpenRouter → DeepSeek-v4-flash
// ($0.112 / $0.224 per 1M tok). Set AI_PROVIDER=xai for the grok-4.3 fallback
// path ($1.25 / $2.50). Built lazily so module loads without env access.
//
// IMPORTANT — Convex actions can't cross-import from src/, so this helper is
// duplicated in listing_resolver.ts intentionally. All other "use node"
// resolver modules in this folder (denial_resolver, extract_booking_times)
// re-export from here.
let _xai: ReturnType<typeof createXai> | null = null;
let _openrouter: ReturnType<typeof createOpenRouter> | null = null;

export async function getActionLlmModel() {
  const useXai = (process.env.AI_PROVIDER ?? "openrouter").toLowerCase() === "xai";
  if (useXai) {
    if (!_xai) {
      const key = await getVaultKey("xai", "XAI_API_KEY");
      _xai = createXai({ apiKey: key });
    }
    return _xai(process.env.GROK_CHAT_MODEL ?? "grok-4.3");
  }
  if (!_openrouter) {
    const key = await getVaultKey("openrouter", "OPENROUTER_API_KEY");
    _openrouter = createOpenRouter({ apiKey: key });
  }
  return _openrouter(process.env.DEEPSEEK_MODEL ?? "deepseek/deepseek-v4-flash");
}

export const RESOLUTION_SCHEMA = z.object({
  resolved_items: z.array(z.object({
    item_id: z.string().describe("Convex Id of the inventory item exactly as supplied"),
    item_name_canonical: z.string(),
    qty: z.number().int().min(1).default(1).describe("Number of physical units rented. Look for 2x, 3x, (3x) etc. Default 1."),
    confidence: z.number().min(0).max(1).describe("How sure you are (1.0 = certain, 0.0 = guess)"),
    matched_phrase: z.string().describe("The phrase in the title that triggered this match — for audit"),
  })),
  unresolved_phrases: z.array(z.string()).describe("Phrases in the title that don't match any inventory item"),
  notes: z.string().optional().describe("Brief reasoning if the title is ambiguous"),
});

interface InventoryItem {
  _id: string;
  name_canonical: string;
  aliases?: string[];
  kind?: string;
  notes?: string;
}


/** Lightweight title-to-categories classifier. We don't need accuracy — any
 *  hit pulls items of that kind into the LLM prompt. Falls back to all items
 *  when no keywords match. Items with kind in the matched-or-broad set are
 *  always included. */
function classifyCategories(title: string): Set<string> {
  const lc = title.toLowerCase();
  const out = new Set<string>();
  const map: Record<string, RegExp> = {
    camera: /(camera|body|mirrorless|cine\s*camera|fx3|fx6|fx30|a7|a7s|a7\s*iii|a7\s*iv|a7\s*v|bmpcc|c70|c200|c300|c500|gh5|gh6|mavic|drone)/,
    lens: /(lens|lenses|mm|gmaster|g\s*master|gm|prime|zoom|anamorphic|wide|tele|fisheye|cine\s*lens|24-70|16-35|70-200|28-70|90mm|24mm|35mm|50mm|85mm)/,
    audio: /(mic|microphone|audio|recorder|zoom\s*h|sennheiser|rode|lav|wireless\s*mic|boom|shotgun|tascam|dji\s*wireless|dji\s*mic)/,
    lighting: /(light|lights|led|panel|softbox|forza|pavotube|aputure|nanlite|godox|c-stand|cstand|flag|silk|reflector|rgb\s*panel|rgb\s*led)/,
    grip: /(tripod|stand|c-stand|cstand|monopod|gimbal|stabili[sz]er|slider|dolly|rig|cage|smallrig|tilta|rs2|rs3|rs\s*pro|crane|weeble|weebill)/,
    audio_dj: /(dj|deck|controller|pioneer|rekordbox|serato|cdj|mixer|turntable|partybox|jbl|mackie|speaker|pa)/,
    power: /(battery|batteries|v-mount|vmount|npf|np-f|np\s*f|power\s*station|jackery|ecoflow|anker|f2000)/,
    monitor: /(monitor|atomos|ninja|small\s*hd|prores\s*recorder|recorder|hdmi|sdi\s*monitor)/,
    transmission: /(transmit|transmitter|teradek|hollyland|mars|pyro|wireless\s*video|live\s*stream)/,
    storage: /(card|cf\s*express|cfast|sd\s*card|ssd|tb\s*ssd|drive|samsung\s*t7|t9)/,
    effects: /(smoke|fog|haze|smoke\s*ninja|smoke\s*machine|atmosphere|vfx)/,
    projector: /(projector|viewsonic\s*projector|hdmi\s*projector|4k\s*projector)/,
  };
  for (const [cat, re] of Object.entries(map)) {
    if (re.test(lc)) out.add(cat);
  }
  return out;
}

/** Return inventory subset relevant to the title. Falls back to the full
 *  list when classifier finds no hits (safer than missing items). */
export function filterInventoryByCategory<T extends { kind?: string }>(inventory: T[], title: string): T[] {
  const cats = classifyCategories(title);
  if (cats.size === 0) return inventory; // no signal — send everything
  // Always include items with no kind set (defensive — newer entries may lack it).
  const filtered = inventory.filter((i) => !i.kind || cats.has(i.kind));
  // If filtering drops too aggressively (< 8 items), revert to full list.
  return filtered.length >= 8 ? filtered : inventory;
}

// ── Phase 15.1: trigram pre-rank ──────────────────────────────
export const KIT_RE = /[+&]|\b(kit|bundle|combo|set)\b|×\s*\d|\b\d+x\b/i;

function trigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  for (let i = 0; i <= t.length - 3; i++) out.add(t.slice(i, i + 3));
  return out;
}

function trigramSim(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const denom = a.size + b.size - inter;
  return denom > 0 ? inter / denom : 0;
}

/** Narrow inventory to the top-N closest matches by trigram similarity
 *  against the listing title. Kit titles widen the pool so decomposition
 *  still has options. Falls back to the input list if too small to rank. */
export function rankInventory<T extends { name_canonical: string; aliases?: string[] }>(
  title: string,
  candidates: T[],
  topN = 8,
): T[] {
  if (candidates.length <= topN) return candidates;
  const titleTri = trigrams(title);
  const scored = candidates.map((c) => {
    const blob = [c.name_canonical, ...(c.aliases ?? [])].join(" ");
    return { c, score: trigramSim(titleTri, trigrams(blob)) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map((x) => x.c);
}

export function modelPrompt(): string {
  return `You are a precise camera/photo equipment cataloguer for a film-rental business.

Identify which inventory items the Hygglo listing title represents.

RULES:
1. RESPECT MODEL DISAMBIGUATORS. "A7 II" ≠ "A7 III". "Mk2" ≠ "Mk3". "FX3" ≠ "FX6".
2. Only return items physically in the title's bundle.
3. If a title item is NOT in inventory, add to unresolved_phrases — never substitute.
4. QUANTITY: extract integer qty. "2x" / "3×" / "(2x)" → qty:2/3/2. Default 1.
5. Confidence: 1.0 unambiguous, 0.6-0.9 partial, <0.5 skip.
6. Use the exact item_id supplied (Convex Id, round-trip verbatim).`;
}

export function buildUserMessage(title: string, inv: InventoryItem[]): string {
  const inventoryBlock = inv
    .map((i) => {
      const aliases = (i.aliases ?? []).length > 0 ? ` | aliases: ${i.aliases!.join(", ")}` : "";
      const kind = i.kind ? ` [${i.kind}]` : "";
      const notes = i.notes ? ` — ${i.notes.slice(0, 80)}` : "";
      return `- item_id: ${i._id} | name: ${i.name_canonical}${kind}${aliases}${notes}`;
    })
    .join("\n");
  // INVENTORY first (stable prefix → DeepSeek auto-cache hit); TITLE last.
  return `INVENTORY (the only items we own):\n${inventoryBlock}\n\nLISTING TITLE:\n"${title}"`;
}

function inputHash(items: Array<{ item_name: string }>): string {
  return items.map((i) => i.item_name).sort().join("|");
}

/**
 * Resolve a single reservation's items[] against master inventory.
 * Idempotent — if resolution_input_hash matches current items, no-ops.
 */
export const resolveReservation = action({
  args: { reservation_id: v.id("reservations") },
  handler: async (ctx, { reservation_id }): Promise<{ ok: boolean; resolved?: number; skipped?: string }> => {
    const res = await ctx.runQuery(internal.item_resolver_queries.getReservationForResolve, {
      reservation_id,
    });
    if (!res) return { ok: false, skipped: "not found" };
    const accountSlug = (res as { account_slug?: string | null }).account_slug ?? null;
    const hyggloListingId = (res as { hygglo_listing_id?: string | null }).hygglo_listing_id ?? null;
    // Decide what title to resolve against. Poller-synced reservations carry
    // items[] with each item's listing title. v1-imported rows came in with
    // items=[] but a rich `notes` field that carries the bundle description.
    // Fall back to notes so historic revenue can be attributed (the v1
    // imports represent £150k+ of unresolved revenue otherwise stuck at £0
    // for every per-item query).
    type ResolverItem = { item_name: string; qty?: number };
    const itemsFromDb = (res.items ?? []) as ResolverItem[];
    const notes = (res as { notes?: string | null }).notes ?? "";
    const items: ResolverItem[] = itemsFromDb.length > 0
      ? itemsFromDb
      : (notes.trim().length > 0
          ? [{ item_name: notes.trim(), qty: 1 }]
          : []);
    if (items.length === 0) {
      await ctx.runMutation(internal.item_resolver_queries.setResolution, {
        reservation_id,
        resolved_items: [],
        method: "exact_match",
        input_hash: "",
      });
      return { ok: true, resolved: 0 };
    }
    const newHash = inputHash(items);
    if (res.resolution_input_hash === newHash && res.resolved_items !== undefined) {
      return { ok: true, skipped: "fresh" };
    }

    const tHash = titleHash(items);

    // ── Manual override (highest-priority tier) ────────────────────
    // If the owner has manually mapped this listing to a specific items
    // list, use it verbatim. No cache check, no LLM call, no vision pass.
    const override = await ctx.runQuery(internal.listing_cache.lookupOverride, {
      title_hash: tHash,
    });
    if (override) {
      // Owner-supplied override does not carry a confidence — set to 1.0.
      const overrideResolved = override.items.map((x) => ({
        item_id: x.item_id,
        item_name_canonical: x.item_name_canonical,
        confidence: 1.0,
        qty: x.qty,
      }));
      // Expand bundles from override too.
      const bundlesData = await ctx.runQuery(internal.item_resolver_queries.getBundlesWithItems, {});
      type ExpandedItem = { item_id: string; item_name_canonical: string; qty: number; via_bundle?: string };
      const expandedOverride: ExpandedItem[] = [];
      const addOv = (id: string, name: string, qty: number, viaBundle?: string) => {
        const ex = expandedOverride.find((e) => e.item_id === id);
        if (ex) ex.qty += qty;
        else expandedOverride.push({ item_id: id, item_name_canonical: name, qty, via_bundle: viaBundle });
      };
      for (const r of overrideResolved) {
        const bundleHit = bundlesData.find(
          (b: { bundle_name: string; bundle_id: string; items: Array<{ item_id?: string; item_name_canonical: string; qty: number }> }) =>
            b.bundle_name === r.item_name_canonical,
        );
        if (bundleHit) {
          for (const bi of bundleHit.items) {
            if (!bi.item_id) continue;
            addOv(bi.item_id, bi.item_name_canonical, bi.qty * r.qty, bundleHit.bundle_id);
          }
        } else {
          addOv(r.item_id, r.item_name_canonical, r.qty);
        }
      }
      await ctx.runMutation(internal.item_resolver_queries.setResolution, {
        reservation_id,
        resolved_items: overrideResolved as unknown as Array<{
          item_id: never; item_name_canonical: string; confidence: number; qty: number;
        }>,
        expanded_items: expandedOverride as unknown as Array<{
          item_id: never; item_name_canonical: string; qty: number; via_bundle?: never;
        }>,
        method: "manual",
        input_hash: newHash,
      });
      return { ok: true, resolved: overrideResolved.length, skipped: "override" };
    }

    // ── Listing-resolution cache ───────────────────────────────────
    // Phase 15.1: prefer (account_slug, hygglo_listing_id) — survives title
    // edits. Fall back to title_hash for legacy rows lacking listing_id.
    let cached: Awaited<ReturnType<typeof ctx.runQuery>> = null;
    let cacheHitByListing = false;
    if (accountSlug && hyggloListingId) {
      cached = await ctx.runQuery(internal.listing_cache.lookupByListing, {
        account_slug: accountSlug,
        hygglo_listing_id: hyggloListingId,
      });
      if (cached) cacheHitByListing = true;
    }
    if (!cached) {
      cached = await ctx.runQuery(internal.listing_cache.lookupByHash, { title_hash: tHash });
    }
    if (cached) {
      const c = cached as {
        resolved_items: Array<{ item_id: string; item_name_canonical: string; confidence: number; qty?: number }>;
        expanded_items: Array<{ item_id: string; item_name_canonical: string; qty: number; via_bundle?: string }>;
        resolution_method: string;
      };
      await ctx.runMutation(internal.item_resolver_queries.setResolution, {
        reservation_id,
        resolved_items: c.resolved_items as unknown as Array<{
          item_id: never; item_name_canonical: string; confidence: number; qty: number;
        }>,
        expanded_items: c.expanded_items as unknown as Array<{
          item_id: never; item_name_canonical: string; qty: number; via_bundle?: never;
        }>,
        method: c.resolution_method,
        input_hash: newHash,
      });
      if (cacheHitByListing && accountSlug && hyggloListingId) {
        await ctx.runMutation(internal.listing_cache.incrementHitByListing, {
          account_slug: accountSlug,
          hygglo_listing_id: hyggloListingId,
        });
      } else {
        await ctx.runMutation(internal.listing_cache.incrementHit, { title_hash: tHash });
      }
      return { ok: true, resolved: c.resolved_items.length, skipped: "cache hit" };
    }

    const inventory = await ctx.runQuery(internal.item_resolver_queries.getInventoryForResolve, {});

    // Combine all titles in this reservation into a single prompt — Hygglo
    // titles already describe the bundle, and the LLM is better at one
    // multi-item resolution than many one-by-ones.
    const combinedTitle = items.map((i: { item_name: string; qty?: number }) =>
      i.qty && i.qty > 1 ? `${i.qty}× ${i.item_name}` : i.item_name,
    ).join("\n");

    // Phase 15.1: trigram pre-rank narrows inventory to top-N candidates so
    // the LLM prompt stays small (~300 tokens vs ~3k). For kit/bundle titles
    // we widen the candidate pool so decomposition still has options.
    const isKitTitle = KIT_RE.test(combinedTitle);

    let resolved: Array<{ item_id: string; item_name_canonical: string; confidence: number; qty: number }> = [];
    try {
      const gated = await gatedGenerateObject({
        model: await getActionLlmModel(),
        schema: RESOLUTION_SCHEMA,
        messages: [
          { role: "system", content: modelPrompt() },
          { role: "user", content: buildUserMessage(
              combinedTitle,
              rankInventory(
                combinedTitle,
                filterInventoryByCategory(inventory, combinedTitle),
                isKitTitle ? 15 : 8,
              ),
            ) },
        ],
        // Typical: 1-5 items × ~100 tok; 600 caps hallucinated long lists.
        maxOutputTokens: 600,
        context: { source: "convex:item_resolver", tag: "item-resolver" },
      });
      if (gated.skipped) return { ok: false, skipped: "uk_quiet_hours" };
      const result = gated.result;
      // Validate item_ids against the inventory we sent (defensive — model can hallucinate)
      const validIds = new Set(inventory.map((i: InventoryItem) => i._id));
      resolved = result.object.resolved_items
        .filter((r) => validIds.has(r.item_id) && r.confidence >= 0.5)
        .map((r) => {
          let qty = Math.max(1, Math.floor(r.qty ?? 1));
          // Fallback qty: scan the combined title for "Nx phrase" near the matched phrase.
          if (qty === 1 && r.matched_phrase) {
            const phrase = r.matched_phrase.toLowerCase();
            const idx = combinedTitle.toLowerCase().indexOf(phrase);
            if (idx > 0) {
              const before = combinedTitle.slice(Math.max(0, idx - 8), idx);
              const m = /(\d+)\s*[x×]/i.exec(before);
              if (m) qty = Math.max(qty, parseInt(m[1], 10));
            }
          }
          return {
            item_id: r.item_id,
            item_name_canonical: r.item_name_canonical,
            confidence: r.confidence,
            qty,
          };
        });
      // Brand-integrity gate: drop any resolved item carrying a different
      // brand than the title's primary brand. Catches AI cross-brand
      // hallucinations (e.g. title=Canon, resolved=Sony GM lens).
      const primary = primaryBrand(combinedTitle);
      if (primary) {
        const before = resolved.length;
        resolved = resolved.filter((x) => {
          if (brandMismatch(primary, x.item_name_canonical)) {
            console.warn(
              "[brand-gate] rejected",
              x.item_name_canonical,
              "because primary=" + primary,
            );
            return false;
          }
          return true;
        });
        if (resolved.length !== before) {
          if (process.env.DEBUG) console.log("[brand-gate] dropped", before - resolved.length, "item(s); primary=" + primary);
        }
      }
    } catch (err) {
      console.error("[item-resolver] LLM call failed:", err);
      return { ok: false, skipped: "llm error" };
    }

    // Bundle expansion — if a resolved item matches a bundle's bundle_name,
    // replace it with its component bundle_items so conflict / out-of-stock /
    // sell-reco can reason at the physical-item level.
    const bundlesData = await ctx.runQuery(internal.item_resolver_queries.getBundlesWithItems, {});
    type ExpandedItem = { item_id: string; item_name_canonical: string; qty: number; via_bundle?: string };
    const expanded: ExpandedItem[] = [];
    function addExpanded(itemId: string, name: string, qty: number, viaBundleId?: string) {
      const existing = expanded.find((e) => e.item_id === itemId);
      if (existing) existing.qty += qty;
      else expanded.push({
        item_id: itemId,
        item_name_canonical: name,
        qty,
        via_bundle: viaBundleId,
      });
    }
    for (const r of resolved) {
      const bundleHit = bundlesData.find(
        (b: { bundle_name: string; bundle_id: string; items: Array<{ item_id?: string; item_name_canonical: string; qty: number }> }) =>
          b.bundle_name === r.item_name_canonical,
      );
      if (bundleHit) {
        for (const bi of bundleHit.items) {
          if (!bi.item_id) continue;
          addExpanded(bi.item_id, bi.item_name_canonical, bi.qty * r.qty, bundleHit.bundle_id);
        }
      } else {
        addExpanded(r.item_id, r.item_name_canonical, r.qty);
      }
    }

    await ctx.runMutation(internal.item_resolver_queries.setResolution, {
      reservation_id,
      resolved_items: resolved as unknown as Array<{
        item_id: never;
        item_name_canonical: string;
        confidence: number;
        qty: number;
      }>,
      expanded_items: expanded as unknown as Array<{
        item_id: never;
        item_name_canonical: string;
        qty: number;
        via_bundle?: never;
      }>,
      method: "llm",
      input_hash: newHash,
    });

    // Write-through to the listing-resolution cache so subsequent reservations
    // for the same listing skip the LLM entirely. Phase 15.1: dual-key.
    await ctx.runMutation(internal.listing_cache.upsertResolution, {
      title_hash: tHash,
      account_slug: accountSlug ?? undefined,
      hygglo_listing_id: hyggloListingId ?? undefined,
      sample_title: items[0]?.item_name?.slice(0, 200) ?? "",
      resolved_items: resolved as unknown as Array<{
        item_id: never;
        item_name_canonical: string;
        confidence: number;
        qty?: number;
      }>,
      expanded_items: expanded as unknown as Array<{
        item_id: never;
        item_name_canonical: string;
        qty: number;
        via_bundle?: never;
      }>,
      resolution_method: "llm",
    });
    return { ok: true, resolved: resolved.length };
  },
});

/**
 * Batch resolver — used by the cron and manual backfill.
 * Resolves up to `limit` reservations whose resolution is missing or stale.
 */
export const resolveBatch = internalAction({
  args: { limit: v.optional(v.number()), include_notes_only: v.optional(v.boolean()) },
  handler: async (
    ctx,
    { limit, include_notes_only },
  ): Promise<{ ids: number; resolved: number; skipped: number }> => {
    if (isWithinUkQuietHours()) {
      console.log("[quiet-hours] skip resolveBatch");
      return { ids: 0, resolved: 0, skipped: 0 };
    }
    const ids: Array<string> = await ctx.runQuery(
      internal.item_resolver_queries.listUnresolved,
      { limit: limit ?? 15, include_notes_only },
    );
    let resolved = 0;
    let skipped = 0;
    for (const id of ids) {
      try {
        const res: { ok: boolean; reason?: string } = await ctx.runAction(
          api.item_resolver.resolveReservation,
          { reservation_id: id as never },
        );
        if (res.ok) resolved++;
        else skipped++;
      } catch (err) {
        console.error("[item-resolver batch] failed for", id, err);
        skipped++;
      }
    }
    return { ids: ids.length, resolved, skipped };
  },
});
