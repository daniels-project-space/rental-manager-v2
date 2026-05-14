/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Market search via xAI Grok live browsing.
 * ──────────────────────────────────────────────────────────────────────────
 *
 *  The agent calls this to gauge external demand for new gear ("is the
 *  Sony A1 II hot right now?", "what cinema cameras dropped this quarter?",
 *  "compare RED Komodo Maxx vs BMPCC 6K G2 popularity"). Grok 4 native
 *  search_parameters does the browsing + citation collation; we cache
 *  results for 24h to keep cost bounded (~$0.25/search × N unique queries).
 *
 *  Vault: XAI_API_KEY (same key used by item_resolver).
 */

"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";

async function getXaiKey(): Promise<string> {
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
  const data = (await res.json()) as { value?: Array<{ keyName: string; value: string }> };
  for (const s of data.value ?? []) {
    if (s.keyName === "XAI_API_KEY") return s.value;
  }
  throw new Error("XAI_API_KEY not found in vault");
}

function normalizeQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 240);
}

const SYSTEM_PROMPT = `You are a market intelligence analyst for a UK film & video equipment rental business.
The user is the operator (Daniel or Leo) deciding what gear to buy or stock next.

For every query:
- Lead with WHAT'S NEW: items announced or released in the last 6-12 months.
- Quantify popularity signals where possible: review counts (DPReview, B&H, Cinema5D, Newsshooter),
  ShareGrid / KitSplit / Lensrentals listing counts, YouTube review view counts, forum thread density.
- Identify RENTER demand: is this gear being asked for on UK rental marketplaces (Hygglo, Fat Llama,
  Kit Hire UK)?
- UK availability + GBP price ranges. If only US prices exist, note that.
- Compare to incumbents already in the user's catalog (Sony FX3, BMPCC 6K Pro, DJI RS3, Aputure 600d
  etc.) when relevant.
- Note any model-disambiguator landmines (II vs III, Mk2 vs Mk3, G2 vs Pro).

Format:
- Tight bullet points, scannable.
- Every claim with a citation [n] keyed to the citations array.
- End with "VERDICT" line: one of "strong buy signal", "monitor", "skip", "need more data".`;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const marketSearch = action({
  args: {
    query: v.string(),
    focus: v.optional(
      v.union(
        v.literal("cameras"),
        v.literal("lenses"),
        v.literal("audio"),
        v.literal("lighting"),
        v.literal("gimbal"),
        v.literal("monitor"),
        v.literal("transmission"),
        v.literal("general"),
      ),
    ),
    bypass_cache: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { query, focus, bypass_cache },
  ): Promise<{
    ok: boolean;
    cached?: boolean;
    query?: string;
    focus?: string | null;
    answer?: string;
    citations?: Array<{ url?: string; title?: string }>;
    tokensIn?: number | null;
    tokensOut?: number | null;
    generatedAt?: number;
    error?: string;
  }> => {
    const norm = normalizeQuery(focus ? `${focus}|${query}` : query);

    if (!bypass_cache) {
      const cached: { result_json: string } | null = await ctx.runQuery(
        internal.market_search_cache.getCached,
        { query_norm: norm },
      );
      if (cached) {
        const parsed = JSON.parse(cached.result_json) as {
          query: string;
          focus: string | null;
          answer: string;
          citations: Array<{ url?: string; title?: string }>;
          tokensIn: number | null;
          tokensOut: number | null;
          generatedAt: number;
        };
        return { ok: true, cached: true, ...parsed };
      }
    }

    let key: string;
    try {
      key = await getXaiKey();
    } catch (err) {
      return { ok: false, error: String(err) };
    }

    const userMsg = focus
      ? `Focus area: ${focus}\nUser query: ${query}`
      : query;

    const body = {
      model: "grok-4",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      search_parameters: {
        mode: "on",
        max_search_results: 10,
        return_citations: true,
      },
      temperature: 0.2,
      max_tokens: 900,
    } as const;

    let res: Response;
    try {
      res = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { ok: false, error: "fetch failed: " + String(err) };
    }
    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `xAI ${res.status}: ${errText.slice(0, 240)}` };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      citations?: Array<{ url?: string; title?: string } | string>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const answer = data?.choices?.[0]?.message?.content ?? "";
    const rawCitations = data?.citations ?? [];
    const citations = rawCitations.map((c) =>
      typeof c === "string" ? { url: c } : c,
    );
    const usage = data?.usage ?? {};
    const result = {
      query,
      focus: focus ?? null,
      answer,
      citations,
      tokensIn: usage.prompt_tokens ?? null,
      tokensOut: usage.completion_tokens ?? null,
      generatedAt: Date.now(),
    };

    try {
      await ctx.runMutation(internal.market_search_cache.setCached, {
        query_norm: norm,
        result_json: JSON.stringify(result),
        ttl_ms: CACHE_TTL_MS,
      });
    } catch (err) {
      console.error("[market_search] cache write failed:", err);
    }

    return { ok: true, cached: false, ...result };
  },
});
