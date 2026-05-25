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
import { createHash } from "crypto";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Pass 9e (2026-05-25): deterministic short-name extractor — replaces the
 * 30K LLM calls/day + 0.98 GBh compute burn. The old SYSTEM_PROMPT
 * described mechanical rules (drop pipe-separated SEO, drop parenthetical
 * comparisons, drop "+" feature lists, keep brand+model+noun, max 60
 * chars) — exactly the kind of normalization a regex chain handles.
 *
 * Rules (mirror the prompt + curated examples):
 *   1. Drop everything after the first "|" (pipe-separated SEO tail).
 *   2. Drop parenthetical comparisons + body-only notes ("(like X / Y)",
 *      "(24MP, ...)", "(Body Only ...)").
 *   3. Drop "+ Y + Z ..." feature lists — keep only the head before
 *      the first "+".
 *   4. Strip marketing fluff words anywhere in the string.
 *   5. Collapse whitespace, capitalise model identifiers, truncate to
 *      60 chars.
 *
 * When the deterministic extractor returns an empty string (input was
 * pure fluff), we fall back to a 60-char truncation of the raw title —
 * never call the LLM.
 */
const MARKETING_FLUFF = [
  /\bportable\b/gi,
  /\bpremium\b/gi,
  /\bpro\s*quality\b/gi,
  /\bprofessional\b/gi,
  /\bfull\s+frame\b/gi,
  /\bfull-frame\b/gi,
  /\bmirrorless\b/gi,
  /\bcinema\s*camera\b/gi,
  /\bvideo\b/gi,
  /\bphotography\b/gi,
  /\bbluetooth\b/gi,
  /\b4k\d*p?\b/gi,
  /\b\d+mp\b/gi,
  /\bpair\b/gi,
  /\bset\b/gi,
  /\bbundle\b/gi,
  /\bkit\b/gi,
  /\blight\s+show\b/gi,
  /\brgb\b/gi,
  /\bbass\s+boost\b/gi,
  /\bweighs?\s+\d+(?:\.\d+)?\s*kg\b/gi,
  /\b\d+-section\b/gi,
];

export function deriveShortNameDeterministic(rawTitle: string): string {
  if (!rawTitle) return "";
  let s = rawTitle;
  // 1. Drop pipe-separated SEO ("X | Y | Z" → "X")
  s = s.split("|")[0];
  // 2. Drop parenthetical content entirely (comparisons, specs, notes)
  s = s.replace(/\([^)]*\)/g, " ");
  // 3. Drop "+ X + Y + ..." feature lists (keep only head before first "+")
  s = s.split("+")[0];
  // 4. Strip marketing fluff words
  for (const re of MARKETING_FLUFF) s = s.replace(re, " ");
  // 5. Collapse whitespace + tidy
  s = s.replace(/\s+/g, " ").trim();
  // 6. Truncate to 60 chars (hard ceiling per old prompt)
  if (s.length > 60) s = s.slice(0, 60).trimEnd();
  return s;
}

/** Derive a short_name for a single (account_slug, product_id, raw_title).
 *  Pass 9e: now uses the deterministic regex extractor (zero LLM calls).
 *  Still idempotent: if cache row exists with matching hash, no work.
 *  Cold-start fallback: if extractor returns empty, store the raw title
 *  truncated to 60 chars instead of calling an LLM. */
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
    const derived = deriveShortNameDeterministic(raw_title) ||
      raw_title.slice(0, 60).trim();
    await ctx.runMutation(internal.listing_short_names.upsert, {
      account_slug,
      product_id,
      raw_title,
      raw_title_hash: hash,
      short_name: derived,
      derivation_method: "deterministic",
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
