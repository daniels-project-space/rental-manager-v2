"use node";

/**
 * Phase 3c / Wave 3b — 4-tier vision-elimination pipeline.
 *
 *   Tier 1: pHash exact-ish match (Hamming distance < 5, conf ≥ 0.9) → free
 *   Tier 2: vectorIndex cosine > 0.85 over item_embeddings        → Gemini embed only
 *   Tier 3: Gemini Flash multimodal extraction + fuzzy match      → free tier 1500/day
 *   Tier 4: Grok Vision (legacy, last resort)                     → paid, LOGGED
 *
 * Every successful resolution learns back into Tier 1 (pHash row) and
 * Tier 2 (image-embedding row) so the next encounter of the same image
 * collapses to a free hash lookup.
 *
 * GRACEFUL DEGRADATION:
 *   - Missing GEMINI_API_KEY  → Tier 2 + Tier 3 skipped, falls through to Tier 4
 *   - Missing XAI_API_KEY     → Tier 4 returns { item_id: null, tier: 4, … }
 *   - Image download failure  → returns { item_id: null, tier: 0, error }
 *
 * NO push, NO inline credentials. All keys read from process.env at runtime.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

const EMBEDDING_MODEL = "text-embedding-004";
const EMBEDDING_DIMENSIONS = 768;
// M9 fix: Hamming<5 (was 8) — tighter to cut false-positives on solid-bg photos.
// Tier 2 vectorIndex catches anything we miss between 5 and 8 bits of drift.
const PHASH_HAMMING_THRESHOLD = 5;        // Tier 1 cutoff
// Confidence floor — sub-0.9 pHash hits fall through to Tier 2 even if Hamming<5.
// Trades a small extra embedding call for far fewer wrong-item resolutions.
const PHASH_CONFIDENCE_FLOOR = 0.9;
const VECTOR_SIM_THRESHOLD = 0.85;        // Tier 2 cutoff
const GEMINI_FLASH_MODEL = "gemini-1.5-flash";

// ────────────────────────────────────────────────────────────────────────────
// pHash helpers (64-bit perceptual hash via 32x32 greyscale + DCT signs)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute a 64-bit pHash hex string for an image buffer.
 * Algorithm: greyscale → 32x32 → DCT (approximated via row/col mean trick) →
 * sign vs median produces 64-bit hash. Sharp is the only image lib already
 * in deps; we don't need a full DCT — the 8x8 mean-block hash ("dHash"-ish)
 * gives a stable similarity signal sufficient for cache matching.
 */
export async function computePHash(buf: ArrayBuffer | Buffer): Promise<string> {
  // Dynamic import so a missing optional binary doesn't break the bundle.
  const sharpMod = await import("sharp");
  const sharp = (sharpMod as any).default ?? sharpMod;

  // 9x8 greyscale → 8x8 diff hash = 64 bits. Cheap, robust to JPEG noise.
  const raw = await sharp(Buffer.from(buf as ArrayBuffer))
    .greyscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer();

  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = raw[y * 9 + x];
      const right = raw[y * 9 + x + 1];
      bits += left < right ? "1" : "0";
    }
  }
  // bits is 64 chars of "0"/"1" → 16-char hex
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/** Hamming distance between two equal-length hex strings (16 chars each). */
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    // popcount 4 bits
    dist += ((x & 1) >> 0) + ((x & 2) >> 1) + ((x & 4) >> 2) + ((x & 8) >> 3);
  }
  return dist;
}

// Queries + mutations moved to ./resolve_item_from_image_data.ts (this
// module is "use node"). References below use
// internal.resolve_item_from_image_data.* accordingly.

// ────────────────────────────────────────────────────────────────────────────
// Fuzzy match for Tier 3 (Gemini → canonical item)
// ────────────────────────────────────────────────────────────────────────────

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fuzzyMatchItem(
  candidateName: string,
  items: Array<{ _id: Id<"items">; name_canonical: string; name_input: string; aliases: string[] }>,
): { item_id: Id<"items">; score: number } | null {
  const target = normalizeName(candidateName);
  if (!target) return null;
  let best: { item_id: Id<"items">; score: number } | null = null;
  for (const it of items) {
    const candidates = [it.name_canonical, it.name_input, ...it.aliases]
      .filter(Boolean)
      .map(normalizeName);
    for (const c of candidates) {
      if (!c) continue;
      let score = 0;
      if (c === target) score = 1;
      else if (c.includes(target) || target.includes(c)) score = 0.85;
      else {
        // token overlap
        const ct = new Set(c.split(" "));
        const tt = new Set(target.split(" "));
        const inter = [...ct].filter((x) => tt.has(x)).length;
        const uni = new Set([...ct, ...tt]).size;
        score = uni > 0 ? inter / uni : 0;
      }
      if (!best || score > best.score) {
        best = { item_id: it._id, score };
      }
    }
  }
  return best && best.score >= 0.55 ? best : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 3: Gemini Flash multimodal
// ────────────────────────────────────────────────────────────────────────────

async function callGeminiFlash(imageBytes: Buffer): Promise<{
  name: string | null;
  rateLimited: boolean;
}> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { name: null, rateLimited: false };
  try {
    const mod = await import("@google/generative-ai");
    const genAI = new mod.GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: GEMINI_FLASH_MODEL });
    const b64 = imageBytes.toString("base64");
    const result = await model.generateContent([
      { text: "What rental item is shown in this photo? Return ONLY the canonical product name (brand + model), nothing else." },
      { inlineData: { mimeType: "image/jpeg", data: b64 } },
    ]);
    const text = (result?.response?.text?.() ?? "").trim();
    return { name: text || null, rateLimited: false };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/429|quota|rate/i.test(msg)) {
      console.warn("[resolve_item_from_image] Gemini Flash rate-limited:", msg);
      return { name: null, rateLimited: true };
    }
    console.warn("[resolve_item_from_image] Gemini Flash failed:", msg);
    return { name: null, rateLimited: false };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 4: Grok Vision (last resort)
// ────────────────────────────────────────────────────────────────────────────

async function callGrokVision(
  imageUrl: string,
  items: Array<{ _id: Id<"items">; name_canonical: string; name_input: string; aliases: string[] }>,
): Promise<{ item_id: Id<"items"> | null; confidence: number }> {
  const key = process.env.XAI_API_KEY;
  if (!key) {
    console.warn("[resolve_item_from_image] Tier 4: XAI_API_KEY missing — cannot fall back");
    return { item_id: null, confidence: 0 };
  }
  console.log("[vision] Tier 4 hit:", imageUrl);
  try {
    const inventory = items
      .map((i) => `- id: ${i._id} | ${i.name_canonical}`)
      .join("\n");
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-2-vision-1212",
        messages: [
          {
            role: "system",
            content:
              "Identify the rental item in the image and match it to ONE id from the inventory list. Respond with JSON: {\"item_id\":\"<id>\",\"confidence\":<0-1>}. Use null/0 if no match.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: `INVENTORY:\n${inventory}` },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      console.warn("[resolve_item_from_image] Tier 4 HTTP error:", res.status);
      return { item_id: null, confidence: 0 };
    }
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(text);
    const id = parsed?.item_id;
    const conf = Number(parsed?.confidence ?? 0);
    if (!id || conf <= 0) return { item_id: null, confidence: 0 };
    // verify id exists in inventory
    if (!items.some((it) => it._id === id)) return { item_id: null, confidence: 0 };
    return { item_id: id as Id<"items">, confidence: conf };
  } catch (err) {
    console.warn("[resolve_item_from_image] Tier 4 threw:", err);
    return { item_id: null, confidence: 0 };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public action: the 4-tier resolver
// ────────────────────────────────────────────────────────────────────────────

export type ResolveTier = 0 | 1 | 2 | 3 | 4;
export interface ResolveResult {
  item_id: Id<"items"> | null;
  tier: ResolveTier;
  confidence: number;
  phash?: string;
  reason?: string;
}

/**
 * Resolve an image URL to a canonical inventory item using the 4-tier
 * pipeline. Writes back to Tier 1 (pHash) on every successful resolution
 * so subsequent calls collapse to a free hash lookup.
 *
 * tier 0 = no resolution (download failed / nothing matched)
 */
export const resolveItemFromImage = internalAction({
  args: {
    imageUrl: v.string(),
    // Optional: skip the network fetch if caller already has the bytes
    // (e.g. unit tests or batched callers).
    imageBytesB64: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResolveResult> => {
    // ── Download / decode image ────────────────────────────────────────
    let buf: Buffer;
    if (args.imageBytesB64) {
      buf = Buffer.from(args.imageBytesB64, "base64");
    } else {
      try {
        const res = await fetch(args.imageUrl);
        if (!res.ok) {
          return { item_id: null, tier: 0, confidence: 0, reason: `download_${res.status}` };
        }
        const arr = await res.arrayBuffer();
        buf = Buffer.from(arr);
      } catch (err) {
        return { item_id: null, tier: 0, confidence: 0, reason: `download_threw: ${String(err)}` };
      }
    }

    // ── Compute pHash ──────────────────────────────────────────────────
    let phash: string;
    try {
      phash = await computePHash(buf);
    } catch (err) {
      return { item_id: null, tier: 0, confidence: 0, reason: `phash_threw: ${String(err)}` };
    }

    // ── Tier 1: pHash cache ────────────────────────────────────────────
    // Exact match first (cheap), then Hamming scan.
    const exact: Doc<"item_image_phash"> | null = await ctx.runQuery(
      internal.resolve_item_from_image_data.findByExactPhash,
      { phash },
    );
    // M9: even exact-phash hits must clear the confidence floor; otherwise
    // fall through so Tier 2 can re-confirm (cheap embedding call).
    if (exact && exact.confidence >= PHASH_CONFIDENCE_FLOOR) {
      await ctx.runMutation(internal.resolve_item_from_image_data.touchPhashRow, { id: exact._id });
      return {
        item_id: exact.canonical_item_id,
        tier: 1,
        confidence: exact.confidence,
        phash,
      };
    }
    const allRows: Doc<"item_image_phash">[] = await ctx.runQuery(
      internal.resolve_item_from_image_data.listAllPhashRows,
      {},
    );
    let bestNear: { row: Doc<"item_image_phash">; dist: number } | null = null;
    for (const row of allRows) {
      const d = hammingHex(row.phash, phash);
      if (d < PHASH_HAMMING_THRESHOLD && (!bestNear || d < bestNear.dist)) {
        bestNear = { row, dist: d };
      }
    }
    // M9: only short-circuit at Tier 1 if cached confidence is high enough.
    // Lower-confidence near-matches drop through to Tier 2 (vectorIndex).
    if (bestNear && bestNear.row.confidence >= PHASH_CONFIDENCE_FLOOR) {
      await ctx.runMutation(internal.resolve_item_from_image_data.touchPhashRow, { id: bestNear.row._id });
      // Writeback: store the new URL under its own pHash so next exact lookup hits.
      await ctx.runMutation(internal.resolve_item_from_image_data.upsertPhashCache, {
        image_url: args.imageUrl,
        phash,
        canonical_item_id: bestNear.row.canonical_item_id,
        confidence: bestNear.row.confidence,
        source: "vision_resolve",
      });
      return {
        item_id: bestNear.row.canonical_item_id,
        tier: 1,
        confidence: bestNear.row.confidence,
        phash,
      };
    }

    // ── Tier 2: vectorIndex similarity over image-source embeddings ────
    // Caption-based embedding (matches item_embeddings.ts image source_kind).
    // True multimodal embeddings will replace this in Phase 3c.2.
    const apiKeyPresent = !!process.env.GEMINI_API_KEY;
    if (apiKeyPresent) {
      try {
        const mod = await import("@google/generative-ai");
        const genAI = new mod.GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
        const embedModel = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
        // Use the URL as a stand-in caption (filename carries category info on Hygglo).
        const captionText = `Photo: ${args.imageUrl}`;
        const embRes = await embedModel.embedContent(captionText);
        const vec = embRes?.embedding?.values;
        if (Array.isArray(vec) && vec.length === EMBEDDING_DIMENSIONS) {
          const hits: Array<{ _id: Id<"item_embeddings">; _score: number }> = await ctx.runAction(
            internal.item_embeddings.searchSimilar,
            { embedding: vec as number[], topK: 3, source_kind: "image" },
          );
          if (hits.length > 0 && hits[0]._score >= VECTOR_SIM_THRESHOLD) {
            // Resolve embedding row → item_id
            const top: Doc<"item_embeddings"> | null = await ctx.runQuery(
              internal.resolve_item_from_image_data._getEmbeddingRow,
              { id: hits[0]._id },
            );
            if (top) {
              await ctx.runMutation(internal.resolve_item_from_image_data.upsertPhashCache, {
                image_url: args.imageUrl,
                phash,
                canonical_item_id: top.item_id,
                confidence: hits[0]._score,
                source: "vision_resolve",
              });
              return {
                item_id: top.item_id,
                tier: 2,
                confidence: hits[0]._score,
                phash,
              };
            }
          }
        }
      } catch (err) {
        console.warn("[resolve_item_from_image] Tier 2 threw, falling through:", err);
      }
    }

    // ── Tier 3: Gemini Flash multimodal ────────────────────────────────
    if (apiKeyPresent) {
      const flash = await callGeminiFlash(buf);
      if (flash.name) {
        const items = await ctx.runQuery(internal.resolve_item_from_image_data.listItemsForFuzzyMatch, {});
        const matched = fuzzyMatchItem(flash.name, items);
        if (matched) {
          await ctx.runMutation(internal.resolve_item_from_image_data.upsertPhashCache, {
            image_url: args.imageUrl,
            phash,
            canonical_item_id: matched.item_id,
            confidence: matched.score,
            source: "vision_resolve",
          });
          // Best-effort writeback into image-source embedding so Tier 2 hits next time.
          try {
            await ctx.runAction(internal.item_embeddings.generateEmbedding, {
              item_id: matched.item_id,
              source_kind: "image",
              content: `Photo of ${flash.name}: ${args.imageUrl}`,
              source_ref: args.imageUrl,
            });
          } catch {
            /* non-fatal */
          }
          return {
            item_id: matched.item_id,
            tier: 3,
            confidence: matched.score,
            phash,
          };
        }
      }
      // If Gemini was rate-limited, log + continue to Tier 4.
      if (flash.rateLimited) {
        console.warn("[resolve_item_from_image] Tier 3 rate-limited, falling through to Tier 4");
      }
    }

    // ── Tier 4: Grok Vision (last resort) ──────────────────────────────
    const items = await ctx.runQuery(internal.resolve_item_from_image_data.listItemsForFuzzyMatch, {});
    const grok = await callGrokVision(args.imageUrl, items);
    if (grok.item_id) {
      await ctx.runMutation(internal.resolve_item_from_image_data.upsertPhashCache, {
        image_url: args.imageUrl,
        phash,
        canonical_item_id: grok.item_id,
        confidence: grok.confidence,
        source: "vision_resolve",
      });
      // Best-effort writeback into Tier 2.
      try {
        await ctx.runAction(internal.item_embeddings.generateEmbedding, {
          item_id: grok.item_id,
          source_kind: "image",
          content: `Photo: ${args.imageUrl}`,
          source_ref: args.imageUrl,
        });
      } catch {
        /* non-fatal */
      }
      return {
        item_id: grok.item_id,
        tier: 4,
        confidence: grok.confidence,
        phash,
      };
    }

    return { item_id: null, tier: 0, confidence: 0, phash, reason: "no_match_any_tier" };
  },
});

// _getEmbeddingRow + getVisionTierDistribution moved to
// ./resolve_item_from_image_data.ts (this module is "use node").
