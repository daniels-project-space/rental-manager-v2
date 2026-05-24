/**
 * derive-listing-info-pool — Trigger.dev port of the Convex listing-info-pool
 * derivation action (formerly convex/listing_info_pool_actions.ts).
 *
 * CLAUDE.md mandates LLM work belongs on Trigger.dev, not Convex actions.
 * Each (account_slug, product_id) derives ONCE at first sight; the row is
 * then a stable lookup table referenced by downstream services. Manual
 * forceReDerive (UI) nulls source_title_hash, which the cron picks up on
 * the next tick.
 *
 * Cadence: every 30 min (idles fast when nothing to derive).
 *
 * On-demand: poll-hygglo fires `tasks.trigger("derive-listing-info-pool-on-demand",
 * { targets: [{account_slug, product_id, raw_title}, ...] })` after a
 * fresh insert so new listings derive promptly.
 *
 * Hard rules (mirror docs/listing-info-pool-plan.md):
 *   - Structured output (zod schema), temperature 0.
 *   - Every bundle_component must carry a source_span verbatim from
 *     source_title; otherwise drop the component + log review_reason.
 *   - Canonical resolution is deterministic — LLM emits free-form names,
 *     we fuzzy-match against the inventory list using item_matcher. No
 *     match within threshold means item_id:null + needs_review:true.
 *     NEVER auto-create items rows.
 *   - Comparison parentheticals are stripped pre-prompt + LLM surfaces
 *     them in comparison_references[].
 */
import { schedules, logger, task } from "@trigger.dev/sdk/v3";
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { createHash } from "node:crypto";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { gatedGenerateObject } from "../lib/gated-generate";
import { getLlmModel, getLlmModelId } from "../lib/llm-client";
import { isWithinUkQuietHours } from "../lib/quiet-hours";
import { findBestMatchWithScore } from "../../convex/lib/item_matcher";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

// Default cron-batch size — keeps a single run bounded (drains backlog
// across successive ticks).
const DEFAULT_BATCH_LIMIT = 20;

// Per-listing inter-call delay to keep DeepSeek happy under burst load.
const INTER_CALL_DELAY_MS = 120;

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
  notes: z.string().optional().describe("Brief reasoning if ambiguous (<=200 chars)."),
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
  const n = (s: string) =>
    s.toLowerCase()
      .replace(/[\s\-_/]+/g, " ")
      .replace(/[^\p{L}\p{N} ]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
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
  // Pass {name, aliases} so the matcher scores against both name_canonical
  // and each alias and keeps the max (tie-break: canonical wins).
  const candidates = inventory.map((i) => ({
    name: i.name_canonical,
    aliases: i.aliases,
  }));
  const match = findBestMatchWithScore(phrase, candidates);
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
    const label = c.item_name_canonical ?? shortenPhrase(c.item_phrase);
    if (label) parts.push(label);
  }
  if (parts.length === 0) return null;
  return "+ " + parts.join(" + ");
}

function shortenPhrase(phrase: string): string {
  const t = phrase.replace(/\s+/g, " ").trim();
  if (t.length <= 30) return t;
  return t.slice(0, 28) + "..";
}

// ── Canonical-bundle-signature builder ─────────────────────────────────────
function buildSignature(components: Array<{ item_id: Id<"items"> | null; qty: number }>): string {
  const parts = components
    .filter((c) => !!c.item_id)
    .map((c) => `${c.item_id}x${c.qty}`)
    .sort();
  return parts.length > 0 ? `items|${parts.join("|")}` : "unresolved";
}

// ── Attribution-shares cascade ─────────────────────────────────────────────
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

// ── Prompt template (verbatim port from old Convex action) ────────────────
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
6. qty: only set > 1 when explicit (2x, 3x, "two ...", etc). Default 1.
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

// ── Per-listing derivation (core) ─────────────────────────────────────────

type DeriveTarget = {
  account_slug: string;
  product_id: number;
  raw_title: string;
};

type DeriveResult =
  | { status: "no_components"; needs_review: true; review_reasons: string[]; short_name: string }
  | { status: "derived"; needs_review: boolean; review_reasons: string[]; components_count: number; short_name: string; display_name: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string };

async function deriveOne(
  convex: ConvexHttpClient,
  target: DeriveTarget,
  inventory: InventoryItem[],
  modelId: string,
): Promise<DeriveResult> {
  const title = target.raw_title;
  const hash = sha256Hex(title);
  const { stripped, references: regexComparisons } = stripComparisons(title);

  // Build a short list of inventory hints to anchor the LLM.
  const inventoryHint = inventory
    .map((i) => `- ${i.name_canonical}${i.kind ? ` (${i.kind})` : ""}`)
    .join("\n");

  let parsed: z.infer<typeof DERIVATION_SCHEMA>;
  try {
    const gated = await gatedGenerateObject({
      model: await getLlmModel(),
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
      context: { source: "trigger:derive-listing-info-pool", tag: "info-pool" },
      // Backfill / poller-driven; not user-facing. Pass through quiet-hours
      // gate so cron sweeps don't stall overnight when the schedule misses
      // an earlier window. The cron itself is gated upstream, but on-demand
      // payloads from poll-hygglo bypass that.
      bypass: true,
    });
    if (gated.skipped) {
      return { status: "skipped", reason: gated.reason };
    }
    parsed = gated.result.object as z.infer<typeof DERIVATION_SCHEMA>;
  } catch (err) {
    return { status: "error", error: String(err) };
  }

  // Validate each emitted component has a source_span actually present in
  // the raw title. Drop violators + record review reasons.
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
    const shortNamePassthrough = (parsed.short_name || title).slice(0, 60).trim();
    await convex.mutation(api.listing_info_pool.admin_upsertDerivation, {
      account_slug: target.account_slug,
      product_id: target.product_id,
      source_title: title,
      source_title_hash: hash,
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
  const explicitPrimary = validatedComponents.find((c) => c.source_kind === "primary");
  const primary = explicitPrimary ?? validatedComponents[0];
  if (!explicitPrimary) reviewReasons.push("no_explicit_primary");

  // Guard: "+ token after primary noun" — if title has "+" or "with" but
  // only one component survived, that's a strong signal we missed a bundle.
  const titleHasPlus = /\s\+\s|\swith\s/i.test(title);
  if (titleHasPlus && validatedComponents.length === 1) {
    reviewReasons.push("plus_token_unparsed");
  }

  const summary = buildBundleSummary(validatedComponents.map((c) => ({
    item_name_canonical: c.item_name_canonical,
    item_phrase: c.item_phrase,
    source_kind: c.source_kind,
  })));

  const shortName = (parsed.short_name || (primary.item_name_canonical ?? primary.item_phrase))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

  const displayName = summary
    ? `${shortName} ${summary}`.replace(/\s+/g, " ").trim()
    : shortName;

  const signature = buildSignature(
    validatedComponents.map((c) => ({ item_id: c.item_id, qty: c.qty })),
  );

  const attribution = buildAttributionShares(
    validatedComponents.map((c) => ({
      item_id: c.item_id,
      item_name_canonical: c.item_name_canonical,
      qty: c.qty,
      source_kind: c.source_kind,
    })),
    inventory,
  );

  // Confidence: min across components (weakest link). Drag down if any
  // review reasons fired.
  const minConf = validatedComponents.reduce(
    (m, c) => Math.min(m, c.confidence, c.item_id ? Math.max(c.resolution_score, 0.6) : 0.4),
    1,
  );
  const needsReview = reviewReasons.length > 0 || minConf < 0.6;

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

  await convex.mutation(api.listing_info_pool.admin_upsertDerivation, {
    account_slug: target.account_slug,
    product_id: target.product_id,
    source_title: title,
    source_title_hash: hash,
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
  });

  return {
    status: "derived",
    short_name: shortName,
    display_name: displayName,
    needs_review: needsReview,
    review_reasons: reviewReasons,
    components_count: validatedComponents.length,
  };
}

// ── Batch runner ──────────────────────────────────────────────────────────

type DerivePayload = {
  /** On-demand targets. When provided, only these are processed. Cron leaves empty. */
  targets?: Array<{ account_slug: string; product_id: number; raw_title?: string }>;
  /** Max per-run candidate count (cron path). */
  limit?: number;
  /** Force-rederive even when source_title_hash matches. */
  force?: boolean;
};

async function runBatch(
  runId: string,
  payload: DerivePayload | undefined,
): Promise<{
  ok: boolean;
  candidate_count: number;
  derived: number;
  cached: number;
  no_components: number;
  needs_review: number;
  errors: number;
  skipped: number;
}> {
  const convex = new ConvexHttpClient(CONVEX_URL);
  const limit = payload?.limit ?? DEFAULT_BATCH_LIMIT;
  const force = !!payload?.force;

  // Pull batch + inventory from Convex in a single round-trip.
  const batch = await convex.query(api.listing_info_pool.admin_getDerivationBatch, {
    limit,
    targets: payload?.targets,
    force,
  });
  const targets: DeriveTarget[] = batch.targets;
  const inventory: InventoryItem[] = batch.inventory;

  if (targets.length === 0) {
    logger.info("derive-listing-info-pool: queue idle", { runId });
    return {
      ok: true,
      candidate_count: 0,
      derived: 0,
      cached: 0,
      no_components: 0,
      needs_review: 0,
      errors: 0,
      skipped: 0,
    };
  }

  const modelId = getLlmModelId();
  let derived = 0;
  let cached = 0;
  let noComponents = 0;
  let needsReview = 0;
  let errors = 0;
  let skipped = 0;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    try {
      const res = await deriveOne(convex, t, inventory, modelId);
      if (res.status === "derived") {
        derived++;
        if (res.needs_review) needsReview++;
      } else if (res.status === "no_components") {
        noComponents++;
        needsReview++;
      } else if (res.status === "skipped") {
        skipped++;
      } else if (res.status === "error") {
        errors++;
        logger.warn("derive-listing-info-pool: derivation errored", {
          account_slug: t.account_slug,
          product_id: t.product_id,
          error: res.error,
        });
      }
    } catch (err) {
      errors++;
      logger.error("derive-listing-info-pool: unexpected exception", {
        account_slug: t.account_slug,
        product_id: t.product_id,
        err: String(err),
      });
    }
    if (i + 1 < targets.length && INTER_CALL_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, INTER_CALL_DELAY_MS));
    }
  }

  logger.info("derive-listing-info-pool: done", {
    runId,
    candidate_count: targets.length,
    derived,
    cached,
    no_components: noComponents,
    needs_review: needsReview,
    errors,
    skipped,
  });

  return {
    ok: true,
    candidate_count: targets.length,
    derived,
    cached,
    no_components: noComponents,
    needs_review: needsReview,
    errors,
    skipped,
  };
}

// ── Scheduled task (cron drain) ───────────────────────────────────────────

export const deriveListingInfoPoolTask = schedules.task({
  id: "derive-listing-info-pool",
  // Half-hourly cadence — new-listing latency dominated by poll-hygglo's
  // on-demand trigger (see below); cron is a backstop for forceReDerive +
  // any listings the on-demand path missed.
  cron: "*/30 * * * *",
  maxDuration: 240,
  run: async (payload, { ctx }) => {
    if (isWithinUkQuietHours()) {
      logger.info("[quiet-hours] skipped", { task: "derive-listing-info-pool" });
      return { skipped: true, reason: "uk_quiet_hours" };
    }
    return await runBatch(ctx.run.id, payload as DerivePayload | undefined);
  },
});

// ── On-demand task (poll-hygglo hand-off) ─────────────────────────────────
//
// Triggered by `tasks.trigger("derive-listing-info-pool-on-demand", { targets })`
// from src/trigger/poll-hygglo.ts after a fresh insert. Same runBatch code
// path, but bypasses the quiet-hours gate so newly-inserted listings still
// derive overnight (the LLM call itself uses bypass:true).

export const deriveListingInfoPoolOnDemandTask = task({
  id: "derive-listing-info-pool-on-demand",
  maxDuration: 240,
  run: async (payload: DerivePayload, { ctx }) => {
    return await runBatch(ctx.run.id, payload);
  },
});
