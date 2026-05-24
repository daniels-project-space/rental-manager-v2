"use node";

/**
 * Listing short-name derivation actions (2026-05-23).
 *
 * Node-runtime side of listing_short_names.ts. The "use node" directive is
 * required because we call the AI SDK (`generateText`). All DB touches are
 * delegated to the V8 module via internal queries/mutations.
 *
 * Uses the project-standard provider helper (`getActionLlmModel` from
 * item_resolver.ts) - DeepSeek-v4-flash via OpenRouter by default,
 * grok-4.3 when AI_PROVIDER=xai.
 */

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { generateText } from "ai";
import { getActionLlmModel } from "./item_resolver";
import { createHash } from "crypto";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const SYSTEM_PROMPT = `You extract the canonical item name from a Hygglo rental listing title.

Rules:
- Output pattern: "<quantity>x <brand> <model> <generic noun>"
- If no explicit quantity in the title, omit the prefix (no "1x ...")
- Drop: pipe-separated SEO ("| ..."), "+" feature lists, parenthetical comparisons ("(like X / Y)"), marketing words ("Portable", "Premium", "Pro Quality", "Pair", "Set")
- Keep: brand name, model number/name, what the thing IS
- Output ONLY the cleaned name. No quotes. No explanation. No trailing punctuation.
- Max 50 characters.

Examples:

Input: 2x JBL PartyBox Club 120 Speakers | Portable Bluetooth Party Speaker Pair + Bass Boost + RGB Light Show + 2x Stands (like JBL PartyBox 310 / PartyBox 710)
Output: 2x JBL Club 120 Speakers

Input: Sony A7 IV Full Frame Mirrorless Camera Body (24MP, 4K60p, Body Only - Lens NOT Included)
Output: Sony A7 IV Camera Body

Input: Manfrotto MT055CXPRO4 Carbon Fiber Tripod | Pro Photography & Video | 4-Section | Weighs 2kg
Output: Manfrotto MT055 Carbon Tripod

Input: Sony fx 3 fx3 full frame 4k cinema camera + 24-70 mm f2.8 zoom lens gmaster gm g-master  + tripod + rode shotgun video mic pro plus
Output: Sony FX3 Cinema Camera

Input: Atomos ninja v 5 inch 4k monitor + 1 tb ssd
Output: Atomos Ninja V Monitor

Input: 3x Sony 24-70mm F2.8 G Master Lens Set | Full Frame Zoom Lens Kit for Sony E-Mount Cameras (like "Sony GM 24-70 2.8 / Sony FE 24-70mm G-Master / Sony full-frame zoom lens")
Output: 3x Sony 24-70mm GM Lens`;

function cleanOutput(raw: string): string {
  // Strip stray quotes / leading "Output:" prefixes / surrounding whitespace.
  let s = raw.trim();
  s = s.replace(/^output\s*[:\-]\s*/i, "");
  s = s.replace(/^["'`]+|["'`]+$/g, "");
  // Collapse internal whitespace, trim to 60 chars hard ceiling.
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 60) s = s.slice(0, 60).trimEnd();
  return s;
}

/** Derive a short_name for a single (account_slug, product_id, raw_title).
 *  Idempotent: if cache row exists with matching hash, no LLM call. */
export const deriveOne = internalAction({
  args: {
    account_slug: v.string(),
    product_id: v.number(),
    raw_title: v.string(),
    force: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { account_slug, product_id, raw_title, force },
  ): Promise<{
    status: "cached" | "derived" | "no_provider" | "empty" | "error";
    short_name: string | null;
    error?: string;
  }> => {
    const hash = sha256Hex(raw_title);
    if (!force) {
      const existing: { raw_title_hash: string; short_name: string } | null =
        await ctx.runQuery(internal.listing_short_names.get, {
        account_slug,
        product_id,
      });
      if (existing && existing.raw_title_hash === hash) {
        return { status: "cached", short_name: existing.short_name };
      }
    }
    let model;
    try {
      model = await getActionLlmModel();
    } catch (err) {
      console.warn("[listing_short_names] provider unavailable", String(err));
      return { status: "no_provider", short_name: null };
    }
    let derived: string;
    try {
      const result = await generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: `Input: ${raw_title}\nOutput:`,
        temperature: 0,
        maxOutputTokens: 80,
      });
      derived = cleanOutput(result.text);
    } catch (err) {
      console.warn("[listing_short_names] LLM error", String(err));
      return { status: "error", short_name: null, error: String(err) };
    }
    if (!derived) {
      return { status: "empty", short_name: null };
    }
    await ctx.runMutation(internal.listing_short_names.upsert, {
      account_slug,
      product_id,
      raw_title,
      raw_title_hash: hash,
      short_name: derived,
      derivation_method: "llm",
    });
    return { status: "derived", short_name: derived };
  },
});

/** Backfill short_names for every (account_slug, product_id) currently
 *  surfaced in active rentals. Sequential with a short delay between calls
 *  to keep provider-side rate-limiting happy. */
export const backfillActive = action({
  args: { force: v.optional(v.boolean()), delay_ms: v.optional(v.number()) },
  handler: async (ctx, { force, delay_ms }): Promise<{
    listings: number;
    derived: number;
    cached: number;
    errors: number;
    samples: Array<{ account_slug: string; product_id: number; raw: string; short: string }>;
  }> => {
    const tuples: Array<{ account_slug: string; product_id: number; raw_title: string }> =
      await ctx.runQuery(internal.listing_short_names.listActiveDistinctProducts, {});
    const cached: Array<{
      account_slug: string;
      product_id: number;
      raw_title_hash: string;
      short_name: string;
    }> = await ctx.runQuery(internal.listing_short_names.getAllCached, {});
    const cacheMap = new Map<string, { hash: string; short_name: string }>();
    for (const c of cached) {
      cacheMap.set(`${c.account_slug}#${c.product_id}`, {
        hash: c.raw_title_hash,
        short_name: c.short_name,
      });
    }
    let derived = 0;
    let cachedHits = 0;
    let errors = 0;
    const samples: Array<{
      account_slug: string;
      product_id: number;
      raw: string;
      short: string;
    }> = [];
    const wait = typeof delay_ms === "number" ? delay_ms : 120;
    for (const t of tuples) {
      const hash = sha256Hex(t.raw_title);
      const cur = cacheMap.get(`${t.account_slug}#${t.product_id}`);
      if (!force && cur && cur.hash === hash) {
        cachedHits++;
        if (samples.length < 10) {
          samples.push({
            account_slug: t.account_slug,
            product_id: t.product_id,
            raw: t.raw_title,
            short: cur.short_name,
          });
        }
        continue;
      }
      const res: any = await ctx.runAction(internal.listing_short_names_actions.deriveOne, {
        account_slug: t.account_slug,
        product_id: t.product_id,
        raw_title: t.raw_title,
        force: !!force,
      });
      if (res?.status === "derived" || res?.status === "cached") {
        if (res.status === "derived") derived++;
        else cachedHits++;
        if (samples.length < 10 && res.short_name) {
          samples.push({
            account_slug: t.account_slug,
            product_id: t.product_id,
            raw: t.raw_title,
            short: res.short_name,
          });
        }
      } else {
        errors++;
      }
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    console.log(
      `[listing_short_names] backfill complete: listings=${tuples.length} derived=${derived} cached=${cachedHits} errors=${errors}`,
    );
    return {
      listings: tuples.length,
      derived,
      cached: cachedHits,
      errors,
      samples,
    };
  },
});
