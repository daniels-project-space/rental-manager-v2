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
import { generateObject } from "ai";
import { createXai } from "@ai-sdk/xai";
import { z } from "zod";
import { titleHash, primaryBrand, brandMismatch } from "./listing_cache";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";

async function getXaiKeyFromVault(): Promise<string> {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  const res = await fetch(VAULT_URL + "/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "secrets:listByService", args: { service: "xai" }, format: "json" }),
  });
  if (!res.ok) throw new Error("vault fetch failed: " + res.status);
  const data = (await res.json()) as { value?: Array<{ keyName: string; value: string }> };
  for (const s of data.value ?? []) {
    if (s.keyName === "XAI_API_KEY") return s.value;
  }
  throw new Error("XAI_API_KEY not found in vault");
}

// Built lazily on first call so the module loads without env access.
let _xai: ReturnType<typeof createXai> | null = null;
async function getXai() {
  if (_xai) return _xai;
  const key = await getXaiKeyFromVault();
  _xai = createXai({ apiKey: key });
  return _xai;
}

const RESOLUTION_SCHEMA = z.object({
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

function modelPrompt(): string {
  return `You are a precise camera/photo equipment cataloguer for a film-rental business.

You will receive a Hygglo listing title (which often bundles multiple physical items)
and a list of every item we actually own (master inventory). Your job: identify
which inventory items the listing represents.

CRITICAL RULES:
1. RESPECT MODEL DISAMBIGUATORS. "Sony A7 II" ≠ "Sony A7 III". "Mk2" ≠ "Mk3". A
   listing for "A7 III" does NOT match an inventory entry for "A7 II" even if the
   strings share a prefix. If the title says "A7 III" only include the A7 III
   item — never both.
2. NO SUBSTRING SHORTCUTS. "Sony FX3" appearing in the title does not match
   inventory entry "Sony FX6" just because the brand+letter prefix overlaps.
3. ONLY return items that physically appear in the title's described bundle.
   A title saying "Sony A7 III + 24-70mm GM Lens + Atomos Ninja V" yields THREE
   resolved items: A7 III, 24-70mm GM, Atomos Ninja V (if present in inventory).
4. If an item mentioned in the title is NOT in inventory, add it to
   unresolved_phrases — do not invent or substitute a "close" inventory item.
5. QUANTITY: extract integer qty per item. "2x Sony A7" / "3× Pavotube" /
   "(2x) LED panels" → qty:2 / qty:3 / qty:2. Default qty:1 when not specified.
   IMPORTANT: never collapse two physical units into qty:1 by listing the item
   only once. Two of the same item = one resolved entry with qty:2.
6. Confidence: 1.0 only when the model number / disambiguator is unambiguous
   in the title. 0.6-0.9 for partial matches. < 0.5 means you're guessing —
   skip it.

Output strict JSON matching the schema. Use the exact item_id value supplied
for each inventory entry — these are Convex IDs and must round-trip verbatim.`;
}

function buildUserMessage(title: string, inv: InventoryItem[]): string {
  const inventoryBlock = inv
    .map((i) => {
      const aliases = (i.aliases ?? []).length > 0 ? ` | aliases: ${i.aliases!.join(", ")}` : "";
      const kind = i.kind ? ` [${i.kind}]` : "";
      const notes = i.notes ? ` — ${i.notes.slice(0, 80)}` : "";
      return `- item_id: ${i._id} | name: ${i.name_canonical}${kind}${aliases}${notes}`;
    })
    .join("\n");
  return `LISTING TITLE:\n"${title}"\n\nINVENTORY (the only items we own):\n${inventoryBlock}`;
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
    const items = res.items ?? [];
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

    // ── Listing-resolution cache ───────────────────────────────────
    // Same items[] → same Hygglo listing → reuse a previous resolution
    // without paying for another LLM call. The hash is title-only, so
    // any title-edit by the owner naturally invalidates.
    const tHash = titleHash(items);
    const cached = await ctx.runQuery(internal.listing_cache.lookupByHash, { title_hash: tHash });
    if (cached) {
      await ctx.runMutation(internal.item_resolver_queries.setResolution, {
        reservation_id,
        resolved_items: cached.resolved_items as unknown as Array<{
          item_id: never; item_name_canonical: string; confidence: number; qty: number;
        }>,
        expanded_items: cached.expanded_items as unknown as Array<{
          item_id: never; item_name_canonical: string; qty: number; via_bundle?: never;
        }>,
        method: cached.resolution_method,
        input_hash: newHash,
      });
      await ctx.runMutation(internal.listing_cache.incrementHit, { title_hash: tHash });
      return { ok: true, resolved: cached.resolved_items.length, skipped: "cache hit" };
    }

    const inventory = await ctx.runQuery(internal.item_resolver_queries.getInventoryForResolve, {});

    // Combine all titles in this reservation into a single prompt — Hygglo
    // titles already describe the bundle, and the LLM is better at one
    // multi-item resolution than many one-by-ones.
    const combinedTitle = items.map((i: { item_name: string; qty?: number }) =>
      i.qty && i.qty > 1 ? `${i.qty}× ${i.item_name}` : i.item_name,
    ).join("\n");

    let resolved: Array<{ item_id: string; item_name_canonical: string; confidence: number; qty: number }> = [];
    try {
      const result = await generateObject({
        model: (await getXai())("grok-4.3"),
        schema: RESOLUTION_SCHEMA,
        messages: [
          { role: "system", content: modelPrompt() },
          { role: "user", content: buildUserMessage(combinedTitle, inventory) },
        ],
      });
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
          console.log("[brand-gate] dropped", before - resolved.length, "item(s); primary=" + primary);
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
    // for the same listing skip the LLM entirely.
    await ctx.runMutation(internal.listing_cache.upsertResolution, {
      title_hash: tHash,
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
  args: { limit: v.optional(v.number()) },
  handler: async (
    ctx,
    { limit },
  ): Promise<{ ids: number; resolved: number; skipped: number }> => {
    const ids: Array<string> = await ctx.runQuery(
      internal.item_resolver_queries.listUnresolved,
      { limit: limit ?? 15 },
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
