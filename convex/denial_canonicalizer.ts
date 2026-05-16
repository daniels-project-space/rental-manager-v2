/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Denial title canonicalizer.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * denial_records.item_name carries the raw Hygglo listing title:
 *
 *   "Sony fx 3 fx3 full frame cinema camera + 70-200 mm f2.8 gmaster g-master gm Tele zoom"
 *
 * The smart-buy ranking aggregates by item_name, so each SEO-stuffed
 * variant ends up its own bucket. This action asks Grok to extract a
 * clean "Brand Model" canonical for each denial — e.g. "Sony FX3" —
 * which the ranking then groups by.
 *
 * Cost discipline: batch 20 titles per LLM call. Idempotent — skips
 * rows whose canonical_product is already set.
 */

"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { generateObject } from "ai";
import { createXai } from "@ai-sdk/xai";
import { z } from "zod";
import { GROK_NARROW_MODEL } from "../src/lib/ai-models";
import { isWithinUkQuietHours } from "./lib/quiet_hours";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";

async function getXaiKeyFromVault(): Promise<string> {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  const res = await fetch(VAULT_URL + "/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service: "xai" },
      format: "json",
    }),
  });
  if (!res.ok) throw new Error("vault fetch failed: " + res.status);
  const data = (await res.json()) as {
    value?: Array<{ keyName: string; value: string }>;
  };
  for (const s of data.value ?? []) {
    if (s.keyName === "XAI_API_KEY") return s.value;
  }
  throw new Error("XAI_API_KEY not found in vault");
}

let _xai: ReturnType<typeof createXai> | null = null;
async function getXai() {
  if (_xai) return _xai;
  const key = await getXaiKeyFromVault();
  _xai = createXai({ apiKey: key });
  return _xai;
}

const KIND_ENUM = z.enum([
  "camera",
  "lens",
  "audio",
  "lighting",
  "gimbal",
  "monitor",
  "tripod",
  "drone",
  "speaker",
  "accessory",
  "other",
]);

const BATCH_SCHEMA = z.object({
  results: z.array(
    z.object({
      index: z.number().int().min(0),
      canonical_product: z
        .string()
        .describe(
          "Clean Brand + Model, e.g. 'Sony FX3', 'Canon C70', " +
            "'Nanlite Pavotube 30X II'. Strip kit descriptors, accessory " +
            "lists, fluff. Title-case the model."
        ),
      brand: z.string().describe("Just the brand, e.g. 'Sony', 'Canon', 'Nanlite'"),
      kind: KIND_ENUM,
    })
  ),
});

const SYSTEM_PROMPT = `You normalise camera-rental listing titles into clean canonical product names.

Rules:
1. canonical_product = "<Brand> <Model>" only. Strip kit contents, accessory lists, SEO keyword soup.
2. Preserve the disambiguating model number/letter exactly: II vs III, Mk2 vs Mk3, 6K vs 6K Pro, A7 III vs A7 IV.
3. For multi-item kits, pick the HEADLINE item (usually the camera body or the most expensive single item).
4. If the title is clearly a bundle/set of identical items ("2x Nanlite Pavotube"), drop the count and return the canonical product alone.
5. Common brands: Sony, Canon, Nikon, Fujifilm, Panasonic, Blackmagic, RED, Atomos, DJI, Hollyland, Aputure, Nanlite, Godox, Rode, Sennheiser, DJI, Shure, JBL, SmallRig, Sirui, Tilta, Zhiyun, Pioneer, Aputure, Astera, GoPro, Insta360, Profoto, Aladdin.
6. Output exactly ONE entry per input index. Use the same index supplied.
7. Output strict JSON matching the schema.`;

function buildUserMessage(titles: Array<{ index: number; title: string }>): string {
  const lines = titles.map((t) => `[${t.index}] ${t.title.slice(0, 240)}`);
  return `Normalise each listing title to its canonical product:\n\n${lines.join("\n")}`;
}

export const canonicalizeDenialBatch = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    if (isWithinUkQuietHours()) {
      console.log("[quiet-hours] skip canonicalizeDenialBatch");
      return { ok: true as const, processed: 0, idle: true };
    }
    const batchSize = limit ?? 20;
    const todo = (await ctx.runQuery(internal.denial_canonicalizer_queries.listUnresolvedDenials, {
      limit: batchSize,
    })) as Array<{ id: string; item_name: string }>;
    if (todo.length === 0) return { ok: true as const, processed: 0, idle: true };

    let result: { object: { results: Array<{ index: number; canonical_product: string; brand: string; kind: string }> } };
    try {
      result = await generateObject({
        model: (await getXai())(GROK_NARROW_MODEL),
        schema: BATCH_SCHEMA,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: buildUserMessage(
              todo.map((t, idx) => ({ index: idx, title: t.item_name }))
            ),
          },
        ],
      });
    } catch (err) {
      console.error("[denial-canonicalizer] LLM call failed:", err);
      return { ok: false as const, error: String(err) };
    }

    let patched = 0;
    for (const r of result.object.results) {
      const row = todo[r.index];
      if (!row) continue;
      await ctx.runMutation(internal.denial_canonicalizer_queries.setDenialCanonical, {
        denial_id: row.id as never,
        canonical_product: r.canonical_product.trim(),
        canonical_brand: r.brand.trim(),
        canonical_kind: r.kind,
      });
      patched++;
    }
    return { ok: true as const, processed: patched, batch: todo.length };
  },
});
