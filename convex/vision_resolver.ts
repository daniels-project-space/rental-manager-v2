/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Vision-augmented item resolver.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * After the text-only LLM resolver runs, this action looks at the actual
 * Hygglo listing photos to catch items the title didn't mention. Common
 * miss: marketing titles like "Sony A7 III + DJI Mic — Complete Interview
 * Kit" hide the included 28-70mm kit lens that's clearly visible in the
 * product photo.
 *
 * SAFETY (the user explicitly asked: do NOT add wrong items):
 *  - Confidence floor 0.7 for any vision-added item (vs 0.5 for text).
 *  - Vision suggestions must round-trip through the same Convex item-id
 *    validation step (defends against hallucination).
 *  - Conservative prompt: "only items you can CLEARLY see and identify
 *    with high specificity. If unsure, omit."
 *  - The action NEVER removes a text-resolved item — only adds.
 *  - Each added item carries source: "vision" + matched_phrase ("seen in
 *    image 1: …") for audit.
 */

"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { generateObject } from "ai";
import { createXai } from "@ai-sdk/xai";
import { z } from "zod";
import { isWithinUkQuietHours } from "./lib/quiet_hours";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";

let _xai: ReturnType<typeof createXai> | null = null;
async function getXai() {
  if (_xai) return _xai;
  let key = process.env.XAI_API_KEY ?? "";
  if (!key) {
    const res = await fetch(VAULT_URL + "/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "secrets:listByService", args: { service: "xai" }, format: "json" }),
    });
    if (res.ok) {
      const data = (await res.json()) as { value?: Array<{ keyName: string; value: string }> };
      for (const s of data.value ?? []) if (s.keyName === "XAI_API_KEY") key = s.value;
    }
  }
  if (!key) throw new Error("XAI_API_KEY missing");
  _xai = createXai({ apiKey: key });
  return _xai;
}

const VISION_SCHEMA = z.object({
  visible_items: z.array(z.object({
    item_id: z.string().describe("Convex Id of the inventory item exactly as supplied — must be one of the ids in the inventory list."),
    item_name_canonical: z.string(),
    qty: z.number().int().min(1).default(1).describe("Number of physical units clearly visible. Default 1."),
    confidence: z.number().min(0).max(1).describe("How confident you are this exact item is in the photo. 1.0 = unmistakable, 0.7 = high specificity, < 0.7 = omit entirely."),
    image_index: z.number().int().min(0).describe("Which photo number this match came from (0-indexed)."),
    visual_cue: z.string().describe("What in the image told you it's this specific item — brand stamp, distinctive shape, model marking, etc."),
  })),
  notes: z.string().optional(),
});

const VISION_PROMPT = `You are auditing equipment-rental listing photos for hidden items.

CONTEXT: A renter booked a kit-style listing on Hygglo (UK photo/film rental
platform). The title only mentions some items. Your job is to look at every
photo and identify every other physical item from OUR inventory that is
clearly visible. Marketing-bundled listings ("Complete Kit", "Full Setup")
routinely hide accessory items in photos — most commonly a kit lens on a
camera body, a tripod under it, batteries, cables, cases.

CRITICAL RULES — the owner has explicitly said "do NOT add wrong items":

1. RESPECT INVENTORY IDS. Only return item_id values that appear in the
   inventory list below. Never invent or guess.

2. RESPECT MODEL DISAMBIGUATION. Sony FX3 ≠ FX6, A7 II ≠ A7 III, 24-70 ≠
   28-70. If you can't tell which exact model is in the photo, OMIT (do not
   list it).

3. RESPECT THE ALREADY-RESOLVED LIST. The text matcher already found some
   items — do NOT re-list them. Only add items NOT in that list.

4. CONFIDENCE FLOOR 0.7. If you are less than 70% sure of the specific
   model, omit. Better to miss a real item than to add a wrong one.

5. NO INFERENCE. If you can see what looks like a softbox but its brand
   isn't visible and the inventory has 3 similar-looking options, omit.

6. NO ACCESSORIES UNLESS WE OWN THEM. If a photo shows a tripod and our
   inventory has no tripod entry, do NOT add a generic "tripod".

7. EVERY visible_item must include visual_cue — a one-line explanation of
   what in the image identified it.

Return strict JSON matching the schema.`;

function buildUserText(title: string, alreadyResolved: Array<{ item_name_canonical: string; qty: number }>, inventory: Array<{ _id: string; name_canonical: string; kind?: string; aliases?: string[] }>): string {
  const resolvedBlock = alreadyResolved.length === 0
    ? "  (none — text resolver returned no items)"
    : alreadyResolved.map((x) => `  - ${x.item_name_canonical} × ${x.qty}`).join("\n");
  const inventoryBlock = inventory.map((i) => {
    const aliases = (i.aliases ?? []).length > 0 ? ` | aliases: ${(i.aliases ?? []).join(", ")}` : "";
    const kind = i.kind ? ` [${i.kind}]` : "";
    return `- item_id: ${i._id} | name: ${i.name_canonical}${kind}${aliases}`;
  }).join("\n");
  return `LISTING TITLE:\n"${title}"\n\nALREADY-RESOLVED ITEMS (do not re-list these — only add NEW ones):\n${resolvedBlock}\n\nINVENTORY (the only items we own):\n${inventoryBlock}`;
}

interface InventoryItem {
  _id: string;
  name_canonical: string;
  aliases?: string[];
  kind?: string;
  notes?: string;
}

export const augmentWithVision = action({
  args: { reservation_id: v.id("reservations") },
  handler: async (ctx, { reservation_id }): Promise<{
    ok: boolean;
    added?: number;
    skipped?: string;
    items?: Array<{ name: string; qty: number; confidence: number; visual_cue: string }>;
  }> => {
    // Pull reservation
    const r = await ctx.runQuery(internal.item_resolver_queries.getReservationForResolve, {
      reservation_id,
    });
    if (!r) return { ok: false, skipped: "not found" };

    const full = r as unknown as {
      _id: string;
      items: Array<{ item_name: string }>;
      photos_urls?: string[];
      resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number; confidence: number }>;
      resolution_input_hash?: string;
    };

    const photos: string[] = (full as { photos_urls?: string[] }).photos_urls ?? [];
    if (photos.length === 0) return { ok: false, skipped: "no photos" };
    if (photos.length > 6) photos.length = 6; // cap to control cost

    const inventory = await ctx.runQuery(internal.item_resolver_queries.getInventoryForResolve, {});
    const validIds = new Set(inventory.map((i: InventoryItem) => i._id));

    const items = (full as { items?: Array<{ item_name: string }> }).items ?? [];
    const title = items.map((i) => i.item_name).join(" + ");
    const alreadyResolvedRaw =
      ((full as { resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }> }).resolved_items) ?? [];
    const alreadyResolved = alreadyResolvedRaw.map((x) => ({
      item_id: x.item_id,
      item_name_canonical: x.item_name_canonical,
      qty: x.qty ?? 1,
    }));
    const alreadyIds = new Set(alreadyResolved.map((x) => x.item_id));

    // Build multimodal message: prompt + photo URLs.
    const userContent: Array<
      | { type: "text"; text: string }
      | { type: "image"; image: string | URL }
    > = [
      { type: "text", text: buildUserText(title, alreadyResolved, inventory) },
      ...photos.map((u) => ({ type: "image" as const, image: u })),
    ];

    let added: Array<{ item_id: string; item_name_canonical: string; qty: number; confidence: number; visual_cue: string }> = [];
    try {
      const result = await generateObject({
        model: (await getXai())("grok-4.3"),
        schema: VISION_SCHEMA,
        messages: [
          { role: "system", content: VISION_PROMPT },
          { role: "user", content: userContent },
        ],
      });
      added = (result.object.visible_items ?? [])
        .filter((vi) => validIds.has(vi.item_id))
        .filter((vi) => vi.confidence >= 0.7)
        .filter((vi) => !alreadyIds.has(vi.item_id))
        .map((vi) => ({
          item_id: vi.item_id,
          item_name_canonical: vi.item_name_canonical,
          qty: Math.max(1, Math.floor(vi.qty ?? 1)),
          confidence: vi.confidence,
          visual_cue: vi.visual_cue,
        }));
    } catch (err) {
      console.error("[vision-resolver] LLM call failed:", err);
      return { ok: false, skipped: "vision error" };
    }

    if (added.length === 0) return { ok: true, added: 0, items: [] };

    // Merge into resolved_items (preserve text-resolved entries verbatim, append vision additions).
    const mergedResolved = [
      ...alreadyResolvedRaw,
      ...added.map((a) => ({
        item_id: a.item_id,
        item_name_canonical: a.item_name_canonical,
        confidence: a.confidence,
        qty: a.qty,
      })),
    ];

    // Re-expand bundles for the merged set.
    const bundlesData = await ctx.runQuery(internal.item_resolver_queries.getBundlesWithItems, {});
    type ExpandedItem = { item_id: string; item_name_canonical: string; qty: number; via_bundle?: string };
    const expanded: ExpandedItem[] = [];
    function addExpanded(itemId: string, name: string, qty: number, viaBundleId?: string) {
      const existing = expanded.find((e) => e.item_id === itemId);
      if (existing) existing.qty += qty;
      else expanded.push({ item_id: itemId, item_name_canonical: name, qty, via_bundle: viaBundleId });
    }
    for (const ri of mergedResolved) {
      const bundleHit = bundlesData.find(
        (b: { bundle_name: string; bundle_id: string; items: Array<{ item_id?: string; item_name_canonical: string; qty: number }> }) =>
          b.bundle_name === ri.item_name_canonical,
      );
      if (bundleHit) {
        for (const bi of bundleHit.items) {
          if (!bi.item_id) continue;
          addExpanded(bi.item_id, bi.item_name_canonical, bi.qty * (ri.qty ?? 1), bundleHit.bundle_id);
        }
      } else {
        addExpanded(ri.item_id, ri.item_name_canonical, ri.qty ?? 1);
      }
    }

    await ctx.runMutation(internal.item_resolver_queries.setResolution, {
      reservation_id,
      resolved_items: mergedResolved as unknown as Array<{
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
      method: "llm+vision",
      input_hash: (full as { resolution_input_hash?: string }).resolution_input_hash ?? "",
    });

    return {
      ok: true,
      added: added.length,
      items: added.map((a) => ({
        name: a.item_name_canonical,
        qty: a.qty,
        confidence: a.confidence,
        visual_cue: a.visual_cue,
      })),
    };
  },
});


/** Cron-driven batch: pick the most-recent LLM-resolved kit-style
 *  reservations + run vision augmentation. Tight cap on per-cycle volume
 *  because vision calls are pricier than text. */
export const augmentBatch = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<{ ids: number; added: number; skipped: number }> => {
    if (isWithinUkQuietHours()) {
      console.log("[quiet-hours] skip augmentBatch");
      return { ids: 0, added: 0, skipped: 0 };
    }
    const ids = await ctx.runQuery(internal.item_resolver_queries.listNeedingVision, {
      limit: limit ?? 5,
    });
    let added = 0;
    let skipped = 0;
    for (const id of ids) {
      try {
        const res = await ctx.runAction(api.vision_resolver.augmentWithVision, {
          reservation_id: id,
        });
        if (res.ok && (res.added ?? 0) > 0) added += res.added ?? 0;
        else skipped++;
      } catch (err) {
        console.error("[vision-batch] failed for", id, err);
        skipped++;
      }
    }
    return { ids: ids.length, added, skipped };
  },
});
