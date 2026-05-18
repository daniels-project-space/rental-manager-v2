"use node";

/**
 * Listing resolver — Node-runtime cascade orchestrator (Phase 4 W2).
 *
 * Ported from v1 src/item-resolver/item-resolver.service.ts. Walks a 7-tier
 * cascade trying to map a Hygglo listing title (plus optional description and
 * detail payload) to MASTER_INVENTORY items.
 *
 *   Tier 1: catalog (cached resolution row)            confidence 1.0
 *   Tier 2: photo_ref (manually verified)              confidence 0.95
 *   Tier 3: pattern (regex bank)                       confidence 0.87
 *   Tier 4: detail_api (Hygglo detail.items)           confidence 0.80
 *   Tier 5: ai (OpenRouter → DeepSeek-v4-flash by default,            confidence 0.70
 *           xAI → grok-4.3 when AI_PROVIDER=xai; see getTier5Model)
 *   Tier 6: fuzzy (last-resort fuzzy match)            confidence 0.50
 *   Tier 7: pending_review (write candidates, no items)
 *
 * Lives in a "use node" module because Tier 5 streams generateText through
 * `ai`, which needs the Node runtime. All Convex DB touches are delegated
 * to internal queries/mutations in convex/listing_resolver_data.ts
 * (regular V8 module).
 */

import { internalAction, action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  MASTER_INVENTORY,
  findBestMatch,
  findBestMatchWithScore,
  findTopNMatches,
  detectBrandMismatch,
  extractPrimaryBrand,
} from "./lib/item_matcher";
import { CANONICAL_MAP, getRelevantItems } from "./lib/inventory_categories";
import { lookupPhotoReference } from "./lib/listing_photo_reference";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";

// Convex-side LLM provider selector (mirrors src/lib/llm-client.ts; can't
// cross-import between convex/ and src/). Default OpenRouter + DeepSeek;
// rollback to xAI direct via AI_PROVIDER=xai.
function getTier5Model() {
  const useXai = (process.env.AI_PROVIDER ?? "openrouter").toLowerCase() === "xai";
  if (useXai) {
    const apiKey = process.env.XAI_API_KEY ?? process.env.GROK_API_KEY;
    if (!apiKey) return null;
    return createXai({ apiKey })(process.env.GROK_CHAT_MODEL ?? "grok-4.3");
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  return createOpenRouter({ apiKey })(
    process.env.DEEPSEEK_MODEL ?? "deepseek/deepseek-v4-flash",
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

type ResolverSource =
  | "catalog"
  | "photo_ref"
  | "pattern"
  | "detail_api"
  | "ai"
  | "fuzzy"
  | "manual";

interface ResolvedItem {
  item_name: string;
  qty: number;
  confidence: number;
  source: ResolverSource;
}

interface Candidate {
  item_name: string;
  score: number;
  reason: string;
}

/**
 * Response shape returned by `resolveListing`. Declared explicitly because
 * TypeScript can't infer it through `ctx.runQuery` / `ctx.runMutation` —
 * those reference `internal.*` from the generated api.d.ts, which in turn
 * references this module, producing a circular inference. The explicit
 * annotation breaks the cycle.
 */
type ResolveResponse =
  | {
      listing_id: string;
      status: "resolved";
      source: ResolverSource;
      items: ResolvedItem[];
      attempted_tiers: string[];
    }
  | {
      listing_id: string;
      status: "pending_review";
      candidates: Candidate[];
      attempted_tiers: string[];
    };

const INVENTORY_NAMES = Object.keys(MASTER_INVENTORY);

// ────────────────────────────────────────────────────────────────────────────
// Tier helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strip SEO comparison clauses from the title — these confuse pattern + AI
 * matchers. Same regex bank as v1 stripSeoNoise.
 */
function stripSeoNoise(title: string): string {
  return title
    .trim()
    .replace(
      /\(\s*(?:like|similar to|comparable to|replaces|vs|or|same\s+(?:sensor|chip|quality|level|class)\s+as|equivalent to|alternative to|beats|better than|compared to|upgrade from)\s[^)]+\)/gi,
      "",
    )
    .replace(
      /\(\s*(?:same\s+as|works\s+like|competes\s+with|rival\s+to|matching)\s[^)]+\)/gi,
      "",
    )
    .trim();
}

/**
 * Canonicalize a raw name: CANONICAL_MAP first, then MASTER_INVENTORY exact,
 * then fuzzy match. Mirrors v1 canonicalize().
 */
function canonicalize(name: string): string | null {
  if (CANONICAL_MAP[name]) return CANONICAL_MAP[name];
  if (MASTER_INVENTORY[name] !== undefined) return name;
  return findBestMatch(name, INVENTORY_NAMES);
}

/**
 * Tier 3 — Pattern matcher. Hand-built regex bank for titles the AI tier
 * historically fumbled (V-mount capacity, audio kits, drone batteries, LED
 * panels). Copied verbatim from v1 patternMatch().
 */
function patternMatch(title: string): ResolvedItem[] {
  const lower = title.toLowerCase();

  // V-mount batteries
  if (/v[\s-]?mount.*batter/i.test(lower) || /batter.*v[\s-]?mount/i.test(lower)) {
    const qtyMatch =
      lower.match(/(\d+)x\s*v[\s-]?mount/i) ||
      lower.match(/(\d+)x\s.*v[\s-]?mount/i);
    const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
    const is95 = /95\s*w/i.test(lower);
    return [
      {
        item_name: is95 ? "V-mount 95mAh" : "V-mount 150mAh",
        qty,
        confidence: 0.9,
        source: "pattern",
      },
    ];
  }

  // Audio boom mic + DJI combo listings
  if (
    /audio\s*boom\s*mic/i.test(lower) ||
    /boom\s*mic.*shotgun/i.test(lower) ||
    /shotgun.*boom/i.test(lower)
  ) {
    const items: ResolvedItem[] = [
      { item_name: "Audio boom mic Sennheiser", qty: 1, confidence: 0.9, source: "pattern" },
    ];
    if (/dji/i.test(lower) && /livelier|lavalier|lav|wireless\s*mic/i.test(lower)) {
      items.push({ item_name: "DJI Wireless Mics", qty: 1, confidence: 0.9, source: "pattern" });
    }
    return items;
  }

  // Pro Boom Mic Kit + DJI Wireless Mics
  if (/boom\s*mic\s*kit/i.test(lower) && /dji/i.test(lower)) {
    const djiQtyMatch = lower.match(/dji.*?(\d+)x/i) || lower.match(/(\d+)x.*dji/i);
    const djiQty = djiQtyMatch ? parseInt(djiQtyMatch[1], 10) : 1;
    return [
      { item_name: "Audio boom mic Sennheiser", qty: 1, confidence: 0.9, source: "pattern" },
      { item_name: "DJI Wireless Mics", qty: djiQty, confidence: 0.9, source: "pattern" },
    ];
  }

  // Nanlite 500B
  if (/nanlite\s*500/i.test(lower) || /nanlite.*bi\s*color/i.test(lower)) {
    return [{ item_name: "Nanlite 500B", qty: 1, confidence: 0.9, source: "pattern" }];
  }

  // 7Artisans 7.5mm fisheye
  if (/7\s*artisans/i.test(lower) && /fisheye|7\.5mm/i.test(lower)) {
    return [
      { item_name: "7Artisans 7.5mm f2.8 Fisheye", qty: 1, confidence: 0.9, source: "pattern" },
    ];
  }

  // Sony A7 III (+ optional GM 24-70)
  if (
    /a7s?\s*iii/i.test(lower) ||
    /a7s3/i.test(lower) ||
    /a73/i.test(lower) ||
    /a7\s*3/i.test(lower)
  ) {
    const items: ResolvedItem[] = [
      { item_name: "Sony A7 III", qty: 1, confidence: 0.9, source: "pattern" },
    ];
    if (/24-70/i.test(lower) && /gm|gmaster|g\s*master/i.test(lower)) {
      items.push({
        item_name: "Sony GM 24-70mm f2.8",
        qty: 1,
        confidence: 0.9,
        source: "pattern",
      });
    }
    return items;
  }

  // LED panels with quantity
  if (
    /\bled\b.*panel/i.test(lower) ||
    /gvm\s*\d*\s*led/i.test(lower) ||
    /led.*\blight\b/i.test(lower)
  ) {
    const qtyMatch =
      lower.match(/(\d+)x?\s*(?:rgb\s*)?(?:led|gvm|panel)/i) ||
      lower.match(/(\d+)x?\s+\w+\s+(?:led|gvm|panel)/i) ||
      lower.match(/(?:led|gvm|panel).*?(\d+)x/i);
    const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
    if (qty >= 1 && qty <= 3) {
      return [
        { item_name: "LED light panels RGB", qty, confidence: 0.85, source: "pattern" },
      ];
    }
  }

  return [];
}

/**
 * Tier 4 — Detail API extraction. Hygglo's listing detail endpoint returns
 * an `items` array with type='PRODUCT' entries; canonicalize each and group
 * by name with qty counting.
 */
function resolveDetailApiItems(detailPayload: unknown): ResolvedItem[] {
  if (!detailPayload || typeof detailPayload !== "object") return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const detail = detailPayload as any;
  if (!Array.isArray(detail.items)) return [];

  const rawNames: string[] = detail.items
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((it: any) => it && it.name && it.type === "PRODUCT")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((it: any) =>
      String(it.name)
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'"),
    );

  const qtyMap = new Map<string, number>();
  for (const raw of rawNames) {
    const canonical = canonicalize(raw);
    if (canonical) qtyMap.set(canonical, (qtyMap.get(canonical) ?? 0) + 1);
  }

  return Array.from(qtyMap.entries()).map(([item_name, qty]) => ({
    item_name,
    qty,
    confidence: 0.8,
    source: "detail_api" as const,
  }));
}

/**
 * Tier 5 — Constrained AI resolution via OpenRouter→DeepSeek (default) or
 * xAI→grok-4.3 (when AI_PROVIDER=xai). See getTier5Model above.
 *
 * Sends only the 15-30 category-relevant inventory items (via getRelevantItems)
 * to keep the prompt small and the model honest. Applies brand-mismatch gate
 * to every parsed candidate before accepting it. Mirrors v1 aiResolve().
 */
async function aiResolve(
  title: string,
  _description?: string,
  detail?: unknown,
): Promise<ResolvedItem[]> {
  const model = getTier5Model();
  if (!model) return [];

  const relevantItems = getRelevantItems(title, detail);
  if (relevantItems.length === 0) return [];
  const inventoryList = relevantItems.join("\n");

  const titleBrand = extractPrimaryBrand(title);
  const brandRule = titleBrand
    ? `- BRAND RULE: The listing is for a ${titleBrand.toUpperCase()} product. Do NOT match to a different brand (e.g., do NOT match Canon to Sony or vice versa). If no same-brand item exists in the inventory, return [].`
    : "";

  // Order matters for DeepSeek's automatic prefix cache: invariant blocks
  // (intro + INVENTORY + Rules) come BEFORE the variable TITLE so the
  // stable prefix can be served from cache on every batch.
  const prompt = `Match this rental listing title to items from the inventory below.

INVENTORY (only match from this list):
${inventoryList}

Rules:
- Return ONLY items from the inventory list above
- Match the SPECIFIC model/variant mentioned in the title
${brandRule}
- Extract quantity from "2x", "(3x)", etc. Default qty is 1
- If title has "+" separators, each segment is usually a different item
- Do NOT add items not clearly indicated by the title
- Return JSON array: [{"item": "exact inventory name", "qty": 1}]
- If nothing matches, return []

TITLE: "${title}"

JSON:`;

  try {
    const { text } = await generateText({
      model,
      prompt,
      maxOutputTokens: 512,
      temperature: 0,
    });

    if (!text) return [];

    // Extract the first balanced JSON array
    let jsonStr: string | null = null;
    const start = text.indexOf("[");
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === "[") depth++;
        else if (text[i] === "]") {
          depth--;
          if (depth === 0) {
            jsonStr = text.slice(start, i + 1);
            break;
          }
        }
      }
    }
    if (!jsonStr) return [];

    const parsed = JSON.parse(jsonStr) as Array<{ item?: string; qty?: number }>;
    if (!Array.isArray(parsed)) return [];

    const seen = new Set<string>();
    const results: ResolvedItem[] = [];
    for (const p of parsed) {
      if (!p || typeof p.item !== "string") continue;
      const qty = typeof p.qty === "number" ? p.qty : 1;
      if (qty <= 0) continue;
      const matched = findBestMatch(p.item, INVENTORY_NAMES);
      if (!matched || seen.has(matched)) continue;
      const brandCheck = detectBrandMismatch(title, matched);
      if (brandCheck.isMismatch) continue;
      seen.add(matched);
      results.push({
        item_name: matched,
        qty: Math.max(1, Math.round(qty)),
        confidence: 0.7,
        source: "ai",
      });
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Top-n fuzzy candidates without confidence threshold. Powers Tier 7 review
 * queue — Daniel needs near-misses even when no tier produced a confident hit.
 */
function topNCandidates(title: string, n: number): Candidate[] {
  // Use findTopNMatches which scores the FULL pool with the same rule
  // as findBestMatch, then returns the top-N (no winner-removal degradation).
  const matches = findTopNMatches(title, INVENTORY_NAMES, n);
  return matches.map((m) => ({
    item_name: m.name,
    score: m.score,
    reason: `coverage=${m.coverage.toFixed(2)} overlap=${m.overlap.toFixed(2)}`,
  }));
}

/**
 * Convex action context type. We avoid pulling the full GenericActionCtx
 * generic here because internalAction handlers already get a strongly-typed
 * ctx; this alias keeps the helper signature readable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ActionCtx = any;

interface ResolveArgs {
  hygglo_listing_id: string;
  hygglo_account: string;
  hygglo_title: string;
  hygglo_description?: string;
  hygglo_detail_payload?: unknown;
  image_url?: string;
}

/**
 * Persist a successful resolution and return the response payload. Wraps
 * the data-layer upsert so each tier doesn't have to duplicate the
 * runMutation call shape.
 */
async function writeAndReturn(
  ctx: ActionCtx,
  args: ResolveArgs,
  items: ResolvedItem[],
  source: ResolverSource,
  _confidence: number,
  attemptedTiers: string[],
): Promise<ResolveResponse> {
  await ctx.runMutation(internal.listing_resolver_data.upsertListingResolution, {
    hygglo_listing_id: args.hygglo_listing_id,
    hygglo_account: args.hygglo_account,
    hygglo_title: args.hygglo_title,
    hygglo_description: args.hygglo_description,
    hygglo_detail_payload: args.hygglo_detail_payload,
    resolved_items: items,
    status: "resolved" as const,
    image_url: args.image_url,
    attempted_tiers: attemptedTiers,
  });
  return {
    listing_id: args.hygglo_listing_id,
    status: "resolved" as const,
    source,
    items,
    attempted_tiers: attemptedTiers,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Public action — cascade entry point
// ────────────────────────────────────────────────────────────────────────────

export const resolveListing = internalAction({
  args: {
    hygglo_listing_id: v.string(),
    hygglo_account: v.string(),
    hygglo_title: v.string(),
    hygglo_description: v.optional(v.string()),
    hygglo_detail_payload: v.optional(v.any()),
    image_url: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResolveResponse> => {
    const attemptedTiers: string[] = [];
    const strippedTitle = stripSeoNoise(args.hygglo_title);

    // Tier 1 — catalog
    attemptedTiers.push("catalog");
    const cached = await ctx.runQuery(internal.listing_resolver_data.lookupCatalog, {
      hygglo_listing_id: args.hygglo_listing_id,
      hygglo_account: args.hygglo_account,
    });
    if (cached && cached.resolved_items && cached.resolved_items.length > 0) {
      return {
        listing_id: args.hygglo_listing_id,
        status: "resolved" as const,
        source: "catalog" as const,
        items: cached.resolved_items,
        attempted_tiers: attemptedTiers,
      };
    }

    // Tier 2 — photo reference
    attemptedTiers.push("photo_ref");
    const photoRef = lookupPhotoReference(args.hygglo_listing_id);
    if (photoRef && photoRef.length > 0) {
      const items: ResolvedItem[] = photoRef.map((p) => ({
        item_name: p.item_name,
        qty: p.qty,
        confidence: 0.95,
        source: "photo_ref" as const,
      }));
      return writeAndReturn(ctx, args, items, "photo_ref", 0.95, attemptedTiers);
    }

    // Tier 3 — pattern
    attemptedTiers.push("pattern");
    const patternResults = patternMatch(strippedTitle);
    if (patternResults.length > 0) {
      return writeAndReturn(ctx, args, patternResults, "pattern", 0.87, attemptedTiers);
    }

    // Tier 4 — detail API
    attemptedTiers.push("detail_api");
    const detailItems = resolveDetailApiItems(args.hygglo_detail_payload);
    if (detailItems.length > 0) {
      return writeAndReturn(ctx, args, detailItems, "detail_api", 0.8, attemptedTiers);
    }

    // Tier 5 — AI
    attemptedTiers.push("ai");
    const aiResults = await aiResolve(
      strippedTitle,
      args.hygglo_description,
      args.hygglo_detail_payload,
    );
    if (aiResults.length > 0) {
      return writeAndReturn(ctx, args, aiResults, "ai", 0.7, attemptedTiers);
    }

    // Tier 6 — fuzzy fallback (with brand gate)
    attemptedTiers.push("fuzzy");
    const fuzzyResult = findBestMatchWithScore(strippedTitle, INVENTORY_NAMES);
    if (
      fuzzyResult &&
      fuzzyResult.score >= 0.5 &&
      !detectBrandMismatch(args.hygglo_title, fuzzyResult.name).isMismatch
    ) {
      const items: ResolvedItem[] = [
        {
          item_name: fuzzyResult.name,
          qty: 1,
          confidence: 0.5,
          source: "fuzzy" as const,
        },
      ];
      return writeAndReturn(ctx, args, items, "fuzzy", 0.5, attemptedTiers);
    }

    // Tier 7 — pending_review (park for human triage)
    attemptedTiers.push("pending_review");
    const candidates = topNCandidates(strippedTitle, 3);
    await ctx.runMutation(internal.listing_resolver_data.upsertListingResolution, {
      hygglo_listing_id: args.hygglo_listing_id,
      hygglo_account: args.hygglo_account,
      hygglo_title: args.hygglo_title,
      hygglo_description: args.hygglo_description,
      hygglo_detail_payload: args.hygglo_detail_payload,
      resolved_items: [],
      status: "pending_review" as const,
      candidates,
      image_url: args.image_url,
      attempted_tiers: attemptedTiers,
    });
    return {
      listing_id: args.hygglo_listing_id,
      status: "pending_review" as const,
      candidates,
      attempted_tiers: attemptedTiers,
    };
  },
});

/**
 * Public wrapper around resolveListing so external callers (e.g. Trigger.dev
 * via ConvexHttpClient) can invoke the internal action. ConvexHttpClient only
 * supports public functions, so this thin shim delegates to the internal one.
 */
export const resolveListingPublic = action({
  args: {
    hygglo_listing_id: v.string(),
    hygglo_account: v.string(),
    hygglo_title: v.string(),
    hygglo_description: v.optional(v.string()),
    hygglo_detail_payload: v.optional(v.any()),
    image_url: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResolveResponse> => {
    return ctx.runAction(internal.listing_resolver.resolveListing, args);
  },
});
