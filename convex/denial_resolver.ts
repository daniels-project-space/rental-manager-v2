/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Phase 9.2 — Denial → items._id resolver (Node runtime, LLM-driven).
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Reuses the exact same Grok-driven resolver pipeline as item_resolver.ts:
 *   denial_records.item_name (free text)
 *        ↓ filterInventoryByCategory + Grok 4.3 with disambiguator-respecting prompt
 *   { resolved_items: [{ item_id, confidence }] }
 *        ↓ pick top match above CONFIDENCE_THRESHOLD
 *   patch denial_records.item_id
 *
 * Scheduled by createDenial (mutation cannot call action directly) and by
 * backfillResolveAll. Idempotent: once item_resolved_at is set, never re-runs
 * for that row.
 *
 * Cost: one Grok call per *new* denial. Cached title-hash lookups via
 * listing_cache aren't reused here (denial item_name is usually a clean
 * product string, not a Hygglo listing title — different shape) but the
 * brand-mismatch gate is reused to drop cross-brand hallucinations.
 */

"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { generateObject } from "ai";
import {
  getXai,
  RESOLUTION_SCHEMA,
  filterInventoryByCategory,
  modelPrompt,
  buildUserMessage,
} from "./item_resolver";
import { primaryBrand, brandMismatch } from "./listing_cache";

const CONFIDENCE_THRESHOLD = 0.7;

/** Resolve a single denial row's item_name → items._id via the existing LLM
 *  resolver. Writes the FK on the row, or marks it as resolved-but-unmatched
 *  if the LLM finds no confident match. */
export const resolveItemFor = internalAction({
  args: { id: v.id("denial_records") },
  handler: async (ctx, { id }): Promise<{ ok: boolean; matched: boolean; confidence?: number; reason?: string }> => {
    const row = await ctx.runQuery(internal.denial_records.getById, { id });
    if (!row) return { ok: false, matched: false, reason: "row not found" };
    if (row.item_id) return { ok: true, matched: true, reason: "already resolved" };
    const itemName = (row.item_name ?? "").trim();
    if (!itemName) {
      // No name to resolve against; mark as attempted so we don't loop.
      await ctx.runMutation(internal.denial_records.patchItemId, { id, item_id: undefined, confidence: undefined });
      return { ok: true, matched: false, reason: "empty item_name" };
    }

    const inventory = await ctx.runQuery(internal.item_resolver_queries.getInventoryForResolve, {});
    if (!Array.isArray(inventory) || inventory.length === 0) {
      console.warn("[denial-resolver] empty inventory; cannot resolve", id);
      return { ok: false, matched: false, reason: "empty inventory" };
    }

    let bestId: string | undefined;
    let bestConfidence = 0;
    let bestName: string | undefined;
    try {
      const result = await generateObject({
        model: (await getXai())("grok-4.3"),
        schema: RESOLUTION_SCHEMA,
        messages: [
          { role: "system", content: modelPrompt() },
          { role: "user", content: buildUserMessage(itemName, filterInventoryByCategory(inventory, itemName)) },
        ],
      });

      // Validate item_ids against the inventory we sent (defensive — model can hallucinate).
      const validIds = new Set(inventory.map((i: { _id: string }) => i._id));
      const primary = primaryBrand(itemName);
      let candidates = result.object.resolved_items.filter((r) => validIds.has(r.item_id));
      if (primary) {
        candidates = candidates.filter((c) => !brandMismatch(primary, c.item_name_canonical));
      }
      candidates.sort((a, b) => b.confidence - a.confidence);
      const top = candidates[0];
      if (top && top.confidence >= CONFIDENCE_THRESHOLD) {
        bestId = top.item_id;
        bestConfidence = top.confidence;
        bestName = top.item_name_canonical;
      }
    } catch (err) {
      console.error("[denial-resolver] LLM call failed for", id, err);
      // Don't mark as resolved — let a future retry (manual or cron) try again.
      return { ok: false, matched: false, reason: "llm error" };
    }

    // Patch outcome: matched (item_id set) or attempted-but-unmatched (item_id undefined, item_resolved_at set).
    await ctx.runMutation(internal.denial_records.patchItemId, {
      id,
      item_id: bestId as never,
      confidence: bestConfidence > 0 ? bestConfidence : undefined,
    });
    if (bestId) {
      console.log("[denial-resolver] resolved", id, "→", bestName, "(conf", bestConfidence.toFixed(2) + ")");
    } else {
      console.log("[denial-resolver] unmatched", id, "item_name=", itemName);
    }
    return { ok: true, matched: !!bestId, confidence: bestConfidence > 0 ? bestConfidence : undefined };
  },
});
