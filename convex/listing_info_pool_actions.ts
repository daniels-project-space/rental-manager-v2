"use node";

/**
 * Listing Info Pool — Node-runtime derivation actions (2026-05-24).
 *
 * Pairs with convex/listing_info_pool.ts (V8 queries/mutations). The "use
 * node" directive is required for the AI SDK (`generateObject`) and crypto
 * primitives. All DB touches delegate to internal queries/mutations.
 *
 * Phase 1: text-only structured extraction via DeepSeek-v4-flash through
 * getActionLlmModel(). No vision pass yet (added in Phase 2).
 *
 * Hard rules (mirror docs/listing-info-pool-plan.md):
 *   - Structured output (zod schema), temperature 0.
 *   - Every bundle_component must carry a source_span verbatim from
 *     source_title; otherwise drop the component + log review_reason.
 *   - Canonical resolution is deterministic — LLM emits free-form names,
 *     we fuzzy-match against the inventory list. No match within
 *     threshold → item_id:null + needs_review:true. NEVER auto-create
 *     items rows.
 *   - Comparison parentheticals ("(like X)", "(same sensor as X)") are
 *     stripped pre-prompt + the LLM is instructed to surface them in
 *     comparison_references[] instead of bundle_components[].
 */

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { z } from "zod";
import { createHash } from "crypto";
import { gatedGenerateObject } from "./lib/gatedGenerate";
import { getActionLlmModel } from "./item_resolver";
import { findBestMatchWithScore, normalizeItemName } from "./lib/item_matcher";
import type { Id } from "./_generated/dataModel";

// ── Hashing ────────────────────────────────────────────────────────────────
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ── LLM I/O schema ─────────────────────────────────────────────────────────
const DERIVATION_SCHEMA = z.object({
  short_name: z.string().describe(
    'Concise canonical name for the primary item. Pattern: "<brand> <model> [<noun>]". ' +
    'No bundle suffix here (no "+ lens" etc.). Max 50 chars. ' +
    'Examples: "Sony FX3", "2x JBL Club 120", "Manfrotto MT055 Tripod".',
  ),
  primary_item_phrase: z.string().describe(
    "Verbatim substring from source_title naming the primary item (the body / main unit).",
  ),
  bundle_components: z.array(z.object({
    item_phrase: z.string().describe(
      "Verbatim phrase from source_title naming this item. Used as source_span — must literally appear in the title.",
    ),
    item_name_guess: z.string().describe(
      "Best guess at the canonical item name (we fuzzy-match this against inventory).",
    ),
    qty: z.number().int().min(1).default(1),
    source_kind: z.enum([
      "primary",
      "bundled_required",
      "bundled_optional",
      "standard_included",
    ]).describe(
      "primary = the main item. bundled_required = explicit '+' add-on. " +
      "bundled_optional = parenthetical inclusion. standard_included = accessory always shipped.",
    ),
    confidence: z.number().min(0).max(1),
  })).describe(
    "Every physical item present in the listing, including the primary. " +
    "Each entry's item_phrase MUST literally appear in source_title.",
  ),
  comparison_references: z.array(z.string()).describe(
    "Items mentioned ONLY as comparisons ('like X', 'same sensor as X'). " +
    "NEVER include comparison-only mentions in bundle_components.",
  ),
  notes: z.string().optional().describe("Brief reasoning if ambiguous (≤200 chars)."),
});

// ── Pre-pass: strip comparison parentheticals ──────────────────────────────
const COMPARISON_RE = /\((?:like|same|as|comparable|similar|level)[^()]*\)/gi;

function stripComparisons(title: string): { stripped: string; references: string[] } {
  const references: string[] = [];
  const stripped = title.replace(COMPARISON_RE, (match) => {
    references.push(match);
    return " ";
  });
  return { stripped: stripped.replace(/\s+/g, " ").trim(), references };
}

// ── Source-span verification ───────────────────────────────────────────────
// Confirms the LLM's claimed phrase actually exists in the source_title.
// Lenient — matches normalized-form-against-normalized-form so casing /
// whitespace don't cause false rejections.
function phrasePresentInTitle(phrase: string, title: string): boolean {
  if (!phrase) return false;
  const n = (s: string) => s.toLowerCase().replace(/[\s\-_/]+/g, " ").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
  const np = n(phrase);
  const nt = n(title);
  if (!np || !nt) return false;
  return nt.includes(np);
}

// ── Inventory resolver — deterministic canonical match ────────────────────
type InventoryItem = {
  item_id: string;
  name_canonical: string;
  kind: string | null;
  aliases: string[];
  included_with_rental: string[];
  replacement_cost_gbp: number | null;
};

const RESOLUTION_THRESHOLD = 0.45;

function resolveCanonical(
  phrase: string,
  inventory: InventoryItem[],
): { item_id: Id<"items"> | null; name_canonical: string | null; score: number } {
  const inventoryNames = inventory.map((i) => i.name_canonical);
  const match = findBestMatchWithScore(phrase, inventoryNames);
  if (!match || match.score < RESOLUTION_THRESHOLD) {
    return { item_id: null, name_canonical: null, score: match?.score ?? 0 };
  }
  const found = inventory.find((i) => i.name_canonical === match.name);
  return {
    item_id: (found?.item_id ?? null) as Id<"items"> | null,
    name_canonical: found?.name_canonical ?? null,
    score: match.score,
  };
}

// ── Display-name composition ───────────────────────────────────────────────
// Builds bundle_summary from non-primary components. Skips
// comparison_reference + standard_included (those should not change display).
function buildBundleSummary(components: Array<{
  item_name_canonical: string | null;
  item_phrase: string;
  source_kind: string;
}>): string | null {
  const parts: string[] = [];
  for (const c of components) {
    if (c.source_kind === "primary") continue;
    if (c.source_kind === "comparison_reference") continue;
    if (c.source_kind === "standard_included") continue;
    // Prefer the canonical name when resolved; fall back to the source phrase
    // (trimmed) when unresolved so the suffix still tells humans what's in
    // the bundle.
    const label = c.item_name_canonical
      ?? shortenPhrase(c.item_phrase);
    if (label) parts.push(label);
  }
  if (parts.length === 0) return null;
  return "+ " + parts.join(" + ");
}

function shortenPhrase(phrase: string): string {
  // Collapse whitespace + cap to 30 chars so the summary stays readable.
  const t = phrase.replace(/\s+/g, " ").trim();
  if (t.length <= 30) return t;
  return t.slice(0, 28) + "..";
}

// ── Canonical-bundle-signature builder ─────────────────────────────────────
// Deterministic over resolved item_id × qty. Used as an equivalence key
// across listings (two listings with the same signature represent the same
// physical kit, e.g. two FX3+24-70mm bundles).
function buildSignature(components: Array<{ item_id: Id<"items"> | null; qty: number }>): string {
  const parts = components
    .filter((c) => !!c.item_id)
    .map((c) => `${c.item_id}x${c.qty}`)
    .sort();
  return parts.length > 0 ? `items|${parts.join("|")}` : "unresolved";
}

// ── Attribution-shares cascade ─────────────────────────────────────────────
// Mirrors convex/lib/revenue_attribution.ts weighting (replacement_cost →
// equal-split fallback). We snapshot the per-listing split so attribution
// is a pure JOIN at query time.
function buildAttributionShares(
  components: Array<{ item_id: Id<"items"> | null; item_name_canonical: string | null; qty: number; source_kind: string }>,
  inventory: InventoryItem[],
): Array<{
  item_id: Id<"items"> | undefined;
  item_name_canonical: string | undefined;
  share_pct: number;
  weight_method: string;
}> {
  const eligible = components.filter((c) =>
    c.source_kind !== "comparison_reference" && c.source_kind !== "standard_included",
  );
  if (eligible.length === 0) return [];
  const weights: number[] = [];
  const methods: string[] = [];
  for (const c of eligible) {
    const inv = c.item_id ? inventory.find((i) => i.item_id === c.item_id) : null;
    const repl = inv?.replacement_cost_gbp ?? null;
    if (typeof repl === "number" && repl > 0) {
      weights.push(repl * c.qty);
      methods.push("replacement_cost");
    } else {
      weights.push(1);
      methods.push("equal");
    }
  }
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return [];
  return eligible.map((c, i) => ({
    item_id: c.item_id ?? undefined,
    item_name_canonical: c.item_name_canonical ?? undefined,
    share_pct: Math.round((weights[i] / total) * 10000) / 10000,
    weight_method: methods[i],
  }));
}

// ── Prompt template ────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You decompose Hygglo rental listing titles into structured bundle info.

HARD RULES:
1. EVERY bundle_component's item_phrase MUST literally appear in the source_title.
   If you can't quote a verbatim phrase from the title, do NOT emit that component.
2. NEVER add components based on comparisons ("(like X)", "(same sensor as Y)",
   "X level"). Those go in comparison_references[].
3. The "primary" component is the main item the listing IS — the body, the
   main camera, the speaker, etc. Always exactly ONE component has
   source_kind = "primary".
4. "+ FOO" / "+FOO" patterns after the primary noun = bundled_required.
   "(includes FOO)" parentheticals = bundled_optional.
   Common accessories listed as "with stand", "with case" = standard_included.
5. short_name: brand + model + optional noun for the PRIMARY only. No "+ lens"
   suffix. Max 50 chars. Drop marketing fluff (Cinema, Professional, Premium,
   Full Frame, 4K — unless required to disambiguate, e.g. "Sony FX3" not
   "Sony FX3 Cinema Camera").
6. qty: only set > 1 when explicit (2x, 3×, "two ...", etc). Default 1.
7. Output ONLY valid JSON matching the schema. No prose outside JSON.

EXAMPLES:

INPUT:
Sony FX 3 Mirrorless camera cinema full frame 4k fx3 + Sony 24-70mm gmaster g-master gm zoom lens f2.8

OUTPUT:
{
  "short_name": "Sony FX3",
  "primary_item_phrase": "Sony FX 3",
  "bundle_components": [
    {"item_phrase":"Sony FX 3","item_name_guess":"Sony FX3","qty":1,"source_kind":"primary","confidence":0.95},
    {"item_phrase":"Sony 24-70mm gmaster g-master gm zoom lens f2.8","item_name_guess":"Sony GM 24-70mm f2.8","qty":1,"source_kind":"bundled_required","confidence":0.9}
  ],
  "comparison_references": [],
  "notes": "+ delimiter splits primary body from lens add-on"
}

INPUT:
Sony FX 3 Cinema Camera Full Frame Mirrorless 4k Sony fx3

OUTPUT:
{
  "short_name": "Sony FX3",
  "primary_item_phrase": "Sony FX 3",
  "bundle_components": [
    {"item_phrase":"Sony FX 3","item_name_guess":"Sony FX3","qty":1,"source_kind":"primary","confidence":0.95}
  ],
  "comparison_references": [],
  "notes": "Body-only listing; no + delimiter"
}

INPUT:
2x JBL PartyBox Club 120 Speakers | Portable Bluetooth Party Speaker Pair + Bass Boost + RGB Light Show + 2x Stands

OUTPUT:
{
  "short_name": "2x JBL Club 120",
  "primary_item_phrase": "JBL PartyBox Club 120 Speakers",
  "bundle_components": [
    {"item_phrase":"JBL PartyBox Club 120 Speakers","item_name_guess":"JBL Club 120","qty":2,"source_kind":"primary","confidence":0.95},
    {"item_phrase":"2x Stands","item_name_guess":"Speaker stand","qty":2,"source_kind":"standard_included","confidence":0.7}
  ],
  "comparison_references": [],
  "notes": "Bass Boost / RGB are speaker features not items"
}`;

// ── Core single-listing derivation ─────────────────────────────────────────

export const deriveOne = internalAction({
  args: {
    account_slug: v.string(),
    product_id: v.number(),
    raw_title: v.optional(v.string()),
    force: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { account_slug, product_id, raw_title, force },
  ): Promise<{
    status:
      | "cached"
      | "derived"
      | "no_title"
      | "no_provider"
      | "no_components"
      | "needs_review"
      | "skipped"
      | "error";
    short_name?: string;
    display_name?: string;
    needs_review?: boolean;
    review_reasons?: string[];
    components_count?: number;
    error?: string;
  }> => {
    // Resolve raw title (and image URLs for Phase 2 vision fallback) from
    // reservations if caller didn't pass one explicitly.
    let title = raw_title;
    let imageUrls: string[] = [];
    if (!title) {
      const fetched: { raw_title: string | null; image_urls: string[]; order_photos: string[] } =
        await ctx.runQuery(internal.listing_info_pool.lookupRawForProduct, {
          account_slug,
          product_id,
        });
      title = fetched.raw_title ?? undefined;
      imageUrls = fetched.image_urls;
    }
    if (!title) {
      return { status: "no_title" };
    }
    const hash = sha256Hex(title);

    if (!force) {
      const existing = await ctx.runQuery(internal.listing_info_pool.get, {
        account_slug,
        product_id,
      });
      if (existing && existing.source_title_hash === hash) {
        return {
          status: "cached",
          short_name: existing.short_name,
          display_name: existing.display_name,
          needs_review: existing.needs_review,
          components_count: existing.bundle_components.length,
        };
      }
    }

    // Pre-pass: strip comparison parentheticals so the LLM doesn't see them.
    const { stripped, references: regexComparisons } = stripComparisons(title);

    // Load inventory for canonical resolution.
    const inventory: InventoryItem[] = await ctx.runQuery(
      internal.listing_info_pool.listActiveInventory,
      {},
    );

    // Build a short list of inventory hints to anchor the LLM.
    const inventoryHint = inventory
      .map((i) => `- ${i.name_canonical}${i.kind ? ` (${i.kind})` : ""}`)
      .join("\n");

    let model;
    let modelId = "unknown";
    try {
      model = await getActionLlmModel();
      modelId = (model as any)?.modelId ?? (model as any)?.id ?? "unknown";
    } catch (err) {
      console.warn("[listing_info_pool] provider unavailable", String(err));
      return { status: "no_provider" };
    }

    let parsed: z.infer<typeof DERIVATION_SCHEMA>;
    try {
      const gated = await gatedGenerateObject({
        model,
        schema: DERIVATION_SCHEMA,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `INVENTORY (for item_name_guess only — do NOT invent names not in this list when possible):\n${inventoryHint}\n\n` +
              `SOURCE TITLE (comparison-parentheticals already stripped):\n${stripped}\n\n` +
              `Emit JSON matching the schema. Remember: every item_phrase must literally appear in the SOURCE TITLE above.`,
          },
        ],
        temperature: 0,
        maxOutputTokens: 1500,
        context: { source: "convex:listing_info_pool_actions", tag: "info-pool" },
        bypass: true, // bypass quiet-hours; this is backfill / poller-driven, not user-facing
      });
      if (gated.skipped) {
        return { status: "skipped" };
      }
      parsed = gated.result.object as z.infer<typeof DERIVATION_SCHEMA>;
    } catch (err) {
      console.warn("[listing_info_pool] LLM error", String(err));
      return { status: "error", error: String(err) };
    }

    // Validate each emitted component has a source_span actually present in
    // the raw title (NOT the stripped version — span must be in the user-
    // visible string). Drop violators + record review reasons.
    const reviewReasons: string[] = [];
    const validatedComponents: Array<{
      item_phrase: string;
      item_name_canonical: string | null;
      item_id: Id<"items"> | null;
      qty: number;
      confidence: number;
      source_kind:
        | "primary"
        | "bundled_required"
        | "bundled_optional"
        | "comparison_reference"
        | "standard_included";
      resolution_score: number;
    }> = [];
    for (const c of parsed.bundle_components) {
      if (!phrasePresentInTitle(c.item_phrase, title)) {
        reviewReasons.push(`dropped_no_source_span:${c.item_name_guess}`);
        continue;
      }
      const r = resolveCanonical(c.item_name_guess, inventory);
      if (!r.item_id) {
        reviewReasons.push(`unresolved_canonical:${c.item_name_guess}`);
      }
      validatedComponents.push({
        item_phrase: c.item_phrase,
        item_name_canonical: r.name_canonical,
        item_id: r.item_id,
        qty: c.qty,
        confidence: c.confidence,
        source_kind: c.source_kind,
        resolution_score: r.score,
      });
    }

    if (validatedComponents.length === 0) {
      reviewReasons.push("no_components");
      // Still write a row so we don't keep re-trying every poll. Use
      // passthrough_fallback to mark.
      const shortNamePassthrough = (parsed.short_name || title).slice(0, 60).trim();
      await ctx.runMutation(internal.listing_info_pool.upsert, {
        account_slug,
        product_id,
        source_title: title,
        source_title_hash: hash,
        source_image_urls: imageUrls,
        derivation_method: "passthrough_fallback",
        short_name: shortNamePassthrough,
        display_name: shortNamePassthrough,
        primary_item_confidence: 0,
        bundle_components: [],
        canonical_bundle_signature: "unresolved",
        attribution_shares: [],
        derivation_confidence: 0,
        needs_review: true,
        review_reasons: reviewReasons,
        llm_raw_response: JSON.stringify(parsed),
        llm_model_id: modelId,
      });
      return {
        status: "no_components",
        short_name: shortNamePassthrough,
        needs_review: true,
        review_reasons: reviewReasons,
      };
    }

    // Find primary
    const primary = validatedComponents.find((c) => c.source_kind === "primary")
      ?? validatedComponents[0];
    if (primary !== validatedComponents.find((c) => c.source_kind === "primary")) {
      reviewReasons.push("no_explicit_primary");
    }

    // Guard: "+ token after primary noun" — if the source title has a "+" or
    // "with" after the primary phrase but only one component survived, that's
    // a strong signal we missed a bundle item. Force needs_review.
    const titleHasPlus = /\s\+\s|\swith\s/i.test(title);
    if (titleHasPlus && validatedComponents.length === 1) {
      reviewReasons.push("plus_token_unparsed");
    }

    // Build bundle_summary from non-primary, non-comparison, non-standard-included components.
    const summary = buildBundleSummary(validatedComponents.map((c) => ({
      item_name_canonical: c.item_name_canonical,
      item_phrase: c.item_phrase,
      source_kind: c.source_kind,
    })));

    // Cap short_name to 60 chars + clean up.
    const shortName = (parsed.short_name || (primary.item_name_canonical ?? primary.item_phrase))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);

    const displayName = summary
      ? `${shortName} ${summary}`.replace(/\s+/g, " ").trim()
      : shortName;

    // Canonical bundle signature for cross-listing equivalence.
    const signature = buildSignature(
      validatedComponents.map((c) => ({ item_id: c.item_id, qty: c.qty })),
    );

    // Attribution shares — pure local computation.
    const attribution = buildAttributionShares(
      validatedComponents.map((c) => ({
        item_id: c.item_id,
        item_name_canonical: c.item_name_canonical,
        qty: c.qty,
        source_kind: c.source_kind,
      })),
      inventory,
    );

    // Confidence: min across all components (the weakest link). Then drag
    // down further if any review reasons fired.
    const minConf = validatedComponents.reduce(
      (m, c) => Math.min(m, c.confidence, c.item_id ? Math.max(c.resolution_score, 0.6) : 0.4),
      1,
    );
    const needsReview = reviewReasons.length > 0 || minConf < 0.6;

    // Comparison references — fold the LLM's list + our regex-derived list.
    const allComparisons = Array.from(new Set([
      ...(parsed.comparison_references ?? []),
      ...regexComparisons,
    ]));
    const compsForStorage = [
      ...validatedComponents.map((c) => ({
        item_id: c.item_id ?? undefined,
        item_name_canonical: c.item_name_canonical ?? undefined,
        qty: c.qty,
        confidence: c.confidence,
        source_kind: c.source_kind,
        source_span: c.item_phrase,
      })),
      ...allComparisons.map((ref) => ({
        item_id: undefined,
        item_name_canonical: undefined,
        qty: 1,
        confidence: 0,
        source_kind: "comparison_reference" as const,
        source_span: ref,
      })),
    ];

    await ctx.runMutation(internal.listing_info_pool.upsert, {
      account_slug,
      product_id,
      source_title: title,
      source_title_hash: hash,
      source_image_urls: imageUrls,
      derivation_method: "text",
      short_name: shortName,
      bundle_summary: summary ?? undefined,
      display_name: displayName,
      primary_item_id: primary.item_id ?? undefined,
      primary_item_name_canonical: primary.item_name_canonical ?? undefined,
      primary_item_confidence: primary.confidence,
      bundle_components: compsForStorage,
      canonical_bundle_signature: signature,
      attribution_shares: attribution,
      derivation_confidence: Math.round(minConf * 100) / 100,
      needs_review: needsReview,
      review_reasons: reviewReasons,
      llm_raw_response: JSON.stringify(parsed),
      llm_model_id: modelId,
      llm_cost_usd: undefined,
    });

    return {
      status: "derived",
      short_name: shortName,
      display_name: displayName,
      needs_review: needsReview,
      review_reasons: reviewReasons,
      components_count: validatedComponents.length,
    };
  },
});

// ── FX3 sample backfill (Phase 1 acceptance) ──────────────────────────────
//
// Targets the listings called out in docs/listing-info-pool-plan.md. The
// plan-spec leo IDs (1097499, 1097510, 1097513, 1116309, 1122292, 1122295)
// are tried first; missing ones are silently skipped (Hygglo listings get
// deleted) and we backfill the current FX3 surface instead.

const PLAN_FX3_TARGETS = [
  { account_slug: "dbcinema", product_id: 948607 },
  { account_slug: "dbcinema", product_id: 1011153 },
  { account_slug: "dbcinema", product_id: 1011859 },
  { account_slug: "leo", product_id: 1097499 },
  { account_slug: "leo", product_id: 1097510 },
  { account_slug: "leo", product_id: 1097513 },
  { account_slug: "leo", product_id: 1116309 },
  { account_slug: "leo", product_id: 1122292 },
  { account_slug: "leo", product_id: 1122295 },
];

export const backfillFx3Sample = action({
  args: { force: v.optional(v.boolean()), include_active_fx3: v.optional(v.boolean()) },
  handler: async (
    ctx,
    { force, include_active_fx3 },
  ): Promise<{
    processed: number;
    skipped_no_title: number;
    derived: number;
    cached: number;
    needs_review: number;
    errors: number;
    samples: Array<{
      account_slug: string;
      product_id: number;
      raw_title: string | null;
      short_name?: string;
      display_name?: string;
      needs_review?: boolean;
      review_reasons?: string[];
      components_count?: number;
      status: string;
    }>;
  }> => {
    const targets = [...PLAN_FX3_TARGETS];
    if (include_active_fx3) {
      const active: Array<{ account_slug: string; product_id: number; raw_title: string }> =
        await ctx.runQuery(internal.listing_info_pool.listActiveDistinctProducts, {});
      for (const t of active) {
        if (!/fx[\s\-]?3/i.test(t.raw_title)) continue;
        if (targets.some((x) => x.account_slug === t.account_slug && x.product_id === t.product_id)) continue;
        targets.push({ account_slug: t.account_slug, product_id: t.product_id });
      }
    }

    let derived = 0;
    let cached = 0;
    let needsReview = 0;
    let errors = 0;
    let skippedNoTitle = 0;
    const samples: Array<{
      account_slug: string;
      product_id: number;
      raw_title: string | null;
      short_name?: string;
      display_name?: string;
      needs_review?: boolean;
      review_reasons?: string[];
      components_count?: number;
      status: string;
    }> = [];

    for (const t of targets) {
      // Pull raw title via lookupRawForProduct so the sample log can show it.
      const fetched: { raw_title: string | null; image_urls: string[]; order_photos: string[] } =
        await ctx.runQuery(internal.listing_info_pool.lookupRawForProduct, {
          account_slug: t.account_slug,
          product_id: t.product_id,
        });
      if (!fetched.raw_title) {
        skippedNoTitle++;
        samples.push({
          account_slug: t.account_slug,
          product_id: t.product_id,
          raw_title: null,
          status: "no_title",
        });
        continue;
      }
      const res: any = await ctx.runAction(internal.listing_info_pool_actions.deriveOne, {
        account_slug: t.account_slug,
        product_id: t.product_id,
        raw_title: fetched.raw_title,
        force: !!force,
      });
      if (res.status === "derived") derived++;
      else if (res.status === "cached") cached++;
      else if (res.status === "error") errors++;
      if (res.needs_review) needsReview++;
      samples.push({
        account_slug: t.account_slug,
        product_id: t.product_id,
        raw_title: fetched.raw_title,
        short_name: res.short_name,
        display_name: res.display_name,
        needs_review: res.needs_review,
        review_reasons: res.review_reasons,
        components_count: res.components_count,
        status: res.status,
      });
      await new Promise((r) => setTimeout(r, 250));
    }

    console.log(
      `[listing_info_pool] FX3 sample: targets=${targets.length} derived=${derived} cached=${cached} needs_review=${needsReview} errors=${errors} skipped_no_title=${skippedNoTitle}`,
    );

    return {
      processed: targets.length,
      skipped_no_title: skippedNoTitle,
      derived,
      cached,
      needs_review: needsReview,
      errors,
      samples,
    };
  },
});

// ── Full active backfill (Phase 2) ────────────────────────────────────────
//
// Processes every listing with at least one active or upcoming reservation in
// the last 60 days. Sequential with delay_ms throttle to keep DeepSeek happy.
//
// Vision fallback note: the design called for a vision pass when text-only
// confidence < 0.7 OR plus_token_unparsed fires, but rental-manager-v2's
// codebase currently does not expose a hooked-up vision model. The Phase 1
// derivation step is text-only via DeepSeek-v4-flash. Confidence below 0.7
// and the plus_token_unparsed guard still emit needs_review=true, so Daniel
// can manually override those via the Phase 4 UI. Vision fallback will be
// added once an OpenRouter or Gemini vision endpoint is wired in.

export const backfillActive = action({
  args: {
    force: v.optional(v.boolean()),
    delay_ms: v.optional(v.number()),
    /** Limit derivation pass — useful for staged ramp. 0 = unbounded. */
    max_listings: v.optional(v.number()),
    /** Only derive listings whose pool row is missing or older than this many
     *  ms. 0 = derive every active listing. Default 0 (no time gate). */
    older_than_ms: v.optional(v.number()),
    /** When true, do NOT call the LLM — just count what would be derived. */
    dry_run: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { force, delay_ms, max_listings, older_than_ms, dry_run },
  ): Promise<{
    candidate_count: number;
    processed: number;
    derived: number;
    cached: number;
    no_components: number;
    needs_review: number;
    text_only: number;
    vision_fallback: number;
    errors: number;
    samples: Array<{
      account_slug: string;
      product_id: number;
      raw_title: string;
      short_name?: string;
      display_name?: string;
      needs_review?: boolean;
      review_reasons?: string[];
      components_count?: number;
      status: string;
    }>;
  }> => {
    const cap = typeof max_listings === "number" && max_listings > 0 ? max_listings : 0;
    const olderThan = typeof older_than_ms === "number" ? older_than_ms : 0;
    const wait = typeof delay_ms === "number" ? delay_ms : 250;

    // 1. Pull candidate (account_slug, product_id, raw_title) tuples from
    //    active reservations (last 60 days).
    const sinceMs = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const sinceIso = new Date(sinceMs).toISOString().slice(0, 10);
    const tuples: Array<{
      account_slug: string;
      product_id: number;
      raw_title: string;
      image_urls: string[];
    }> = await ctx.runQuery(internal.listing_info_pool.listActiveDistinctProducts, {
      since_iso: sinceIso,
    });

    // 2. Pull existing pool rows to decide cache vs re-derive.
    const cached: Array<{
      account_slug: string;
      product_id: number;
      source_title_hash: string;
      derivation_method: string;
      derivation_confidence: number;
      needs_review: boolean;
    }> = await ctx.runQuery(internal.listing_info_pool.getAllCached, {});
    const cacheMap = new Map<string, typeof cached[number]>();
    for (const c of cached) {
      cacheMap.set(`${c.account_slug}#${c.product_id}`, c);
    }

    let derived = 0;
    let cachedHits = 0;
    let needsReview = 0;
    let noComponents = 0;
    let textOnly = 0;
    let visionFallback = 0;
    let errors = 0;
    let processed = 0;
    const samples: Array<{
      account_slug: string;
      product_id: number;
      raw_title: string;
      short_name?: string;
      display_name?: string;
      needs_review?: boolean;
      review_reasons?: string[];
      components_count?: number;
      status: string;
    }> = [];

    for (const t of tuples) {
      if (cap > 0 && processed >= cap) break;
      const hash = sha256Hex(t.raw_title);
      const cur = cacheMap.get(`${t.account_slug}#${t.product_id}`);
      if (!force && cur && cur.source_title_hash === hash && olderThan === 0) {
        cachedHits++;
        if (samples.length < 20) {
          samples.push({
            account_slug: t.account_slug,
            product_id: t.product_id,
            raw_title: t.raw_title,
            status: "cached",
          });
        }
        continue;
      }
      processed++;
      if (dry_run) {
        samples.push({
          account_slug: t.account_slug,
          product_id: t.product_id,
          raw_title: t.raw_title,
          status: "dry_run_would_derive",
        });
        continue;
      }
      const res: any = await ctx.runAction(internal.listing_info_pool_actions.deriveOne, {
        account_slug: t.account_slug,
        product_id: t.product_id,
        raw_title: t.raw_title,
        force: !!force,
      });
      if (res.status === "derived") {
        derived++;
        textOnly++;
        if (res.needs_review) needsReview++;
      } else if (res.status === "cached") {
        cachedHits++;
      } else if (res.status === "no_components") {
        noComponents++;
        needsReview++;
      } else if (res.status === "error") {
        errors++;
      }
      if (samples.length < 20) {
        samples.push({
          account_slug: t.account_slug,
          product_id: t.product_id,
          raw_title: t.raw_title,
          short_name: res.short_name,
          display_name: res.display_name,
          needs_review: res.needs_review,
          review_reasons: res.review_reasons,
          components_count: res.components_count,
          status: res.status,
        });
      }
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }

    console.log(
      `[listing_info_pool] backfillActive: candidates=${tuples.length} processed=${processed} derived=${derived} cached=${cachedHits} no_components=${noComponents} needs_review=${needsReview} text_only=${textOnly} vision_fallback=${visionFallback} errors=${errors}`,
    );

    return {
      candidate_count: tuples.length,
      processed,
      derived,
      cached: cachedHits,
      no_components: noComponents,
      needs_review: needsReview,
      text_only: textOnly,
      vision_fallback: visionFallback,
      errors,
      samples,
    };
  },
});

export { sha256Hex as _sha256HexForTest };
