/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Market search via SerpAPI (Google) — UK-localized.
 * ──────────────────────────────────────────────────────────────────────────
 *
 *  Used by the chat agent to gauge external demand for new gear ("is the
 *  Sony A1 II hot right now?", "what cinema cameras dropped this quarter?",
 *  "compare RED Komodo Maxx vs BMPCC 6K G2"). Returns raw organic + news
 *  results and related searches — the chat agent (also Grok) synthesizes
 *  them in its own response, no extra LLM hop needed here.
 *
 *  Note: an earlier version of this file used xAI's live-search parameter,
 *  which xAI deprecated mid-2026 in favor of Agent Tools. SerpAPI is more
 *  predictable + cheaper + we already have the key in the vault.
 *
 *  Vault: SERPAPI_KEY (service "serpapi").
 *  Cost: SerpAPI free tier covers 100 searches/month; paid is $50/5k.
 *  24h cache keyed on normalized query keeps repeat questions free.
 */

"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";

async function getSerpApiKey(): Promise<string> {
  if (process.env.SERPAPI_KEY) return process.env.SERPAPI_KEY;
  const vaultToken = process.env.VAULT_ACCESS_TOKEN;
  if (!vaultToken) throw new Error("VAULT_ACCESS_TOKEN is not configured");
  const res = await fetch(VAULT_URL + "/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service: "serpapi", vaultToken },
      format: "json",
    }),
  });
  if (!res.ok) throw new Error("vault fetch failed: " + res.status);
  const data = (await res.json()) as { value?: Array<{ keyName: string; value: string }> };
  for (const s of data.value ?? []) {
    if (s.keyName === "SERPAPI_KEY") return s.value;
  }
  throw new Error("SERPAPI_KEY not found in vault");
}

function normalizeQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 240);
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type Focus =
  | "cameras"
  | "lenses"
  | "audio"
  | "lighting"
  | "gimbal"
  | "monitor"
  | "transmission"
  | "general";

/** Bias the query slightly by category so generic phrases stay focused. */
function biasQuery(query: string, focus?: Focus): string {
  if (!focus || focus === "general") return query;
  const tags: Record<Exclude<Focus, "general">, string> = {
    cameras: "cinema camera mirrorless",
    lenses: "cinema lens",
    audio: "shotgun microphone wireless audio recorder",
    lighting: "LED light panel COB",
    gimbal: "gimbal stabilizer",
    monitor: "field monitor recorder",
    transmission: "wireless video transmitter",
  };
  return `${query} ${tags[focus]}`;
}

type SerpOrganic = {
  position?: number;
  title: string;
  snippet?: string;
  link: string;
  source?: string;
  date?: string;
};

type SerpNews = {
  title: string;
  source?: string;
  date?: string;
  link: string;
};

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
    biasedQuery?: string;
    organicResults?: SerpOrganic[];
    newsResults?: SerpNews[];
    relatedSearches?: string[];
    answerBox?: string | null;
    generatedAt?: number;
    error?: string;
  }> => {
    const biased = biasQuery(query, focus);
    const norm = normalizeQuery(focus ? `${focus}|${biased}` : biased);

    if (!bypass_cache) {
      const cached: { result_json: string } | null = await ctx.runQuery(
        internal.market_search_cache.getCached,
        { query_norm: norm },
      );
      if (cached) {
        const parsed = JSON.parse(cached.result_json) as {
          query: string;
          focus: string | null;
          biasedQuery: string;
          organicResults: SerpOrganic[];
          newsResults: SerpNews[];
          relatedSearches: string[];
          answerBox: string | null;
          generatedAt: number;
        };
        return { ok: true, cached: true, ...parsed };
      }
    }

    let key: string;
    try {
      key = await getSerpApiKey();
    } catch (err) {
      return { ok: false, error: String(err) };
    }

    const params = new URLSearchParams({
      engine: "google",
      q: biased,
      api_key: key,
      num: "10",
      gl: "uk",
      hl: "en",
      tbs: "qdr:y",                                // restrict to last year — "newest"
    });
    let res: Response;
    try {
      res = await fetch(`https://serpapi.com/search?${params}`);
    } catch (err) {
      return { ok: false, error: "fetch failed: " + String(err) };
    }
    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `SerpAPI ${res.status}: ${errText.slice(0, 240)}` };
    }
    const data = (await res.json()) as {
      organic_results?: Array<{
        position?: number;
        title?: string;
        snippet?: string;
        link?: string;
        source?: string;
        date?: string;
      }>;
      news_results?: Array<{
        title?: string;
        source?: string;
        date?: string;
        link?: string;
      }>;
      related_searches?: Array<{ query?: string }>;
      answer_box?: { snippet?: string; answer?: string };
      error?: string;
    };

    if (data.error) return { ok: false, error: "SerpAPI: " + data.error };

    const organicResults: SerpOrganic[] = (data.organic_results ?? [])
      .filter((r) => r.title && r.link)
      .slice(0, 10)
      .map((r) => ({
        position: r.position,
        title: r.title!,
        snippet: r.snippet ?? "",
        link: r.link!,
        source: r.source,
        date: r.date,
      }));
    const newsResults: SerpNews[] = (data.news_results ?? [])
      .filter((n) => n.title && n.link)
      .slice(0, 6)
      .map((n) => ({
        title: n.title!,
        source: n.source,
        date: n.date,
        link: n.link!,
      }));
    const relatedSearches = (data.related_searches ?? [])
      .map((r) => r.query)
      .filter((q): q is string => typeof q === "string")
      .slice(0, 8);
    const answerBox = data.answer_box?.snippet ?? data.answer_box?.answer ?? null;

    const result = {
      query,
      focus: focus ?? null,
      biasedQuery: biased,
      organicResults,
      newsResults,
      relatedSearches,
      answerBox,
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
