/**
 * resolve-items — Trigger.dev port of the Convex item-resolver action.
 *
 * Was a Convex action firing every 5min, doing 15 LLM calls per batch
 * × 3-8s each = 45-120s of action time per run × 96 runs/day = ~2-3
 * hours of Convex action runtime/day.
 *
 * Lifted to Trigger.dev: Convex now sees only one batched query + one
 * batched mutation per run. LLM compute runs on Trigger's free tier.
 *
 * Cadence: 15 min (matches the post-Tier-1 Convex cron cadence).
 * Pool drains naturally once resolver catches up; LLM cost amortised
 * via category filtering + brand-integrity gate.
 *
 * SAFETY: When this task is enabled, REMOVE the matching Convex cron
 * (`item_resolver batch` in convex/crons.ts) to avoid double-work.
 * Both write paths use the same input_hash idempotency check so a race
 * would only waste LLM calls, not corrupt data.
 *
 * Drops the listing-cache layer for simplicity — same LLM call may
 * recur for similar titles. Acceptable trade-off because (a) cache hit
 * rate post-backfill is low, (b) brand gate + category filter cap LLM
 * cost. Can re-add cache later if hit rate proves valuable.
 */
import { schedules, logger } from "@trigger.dev/sdk/v3";
import { gatedGenerateObject } from "../lib/gated-generate";
import { z } from "zod";
import { isWithinUkQuietHours } from "../lib/quiet-hours";
import { getLlmModel } from "../lib/llm-client";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

// ── Convex HTTP helpers ────────────────────────────────────────────────

interface Item {
  item_name: string;
  qty?: number;
}
interface InventoryItem {
  _id: string;
  name_canonical: string;
  aliases?: string[];
  kind?: string;
  notes?: string;
}
interface Bundle {
  bundle_id: string;
  bundle_name: string;
  items: Array<{ item_id: string; item_name_canonical: string; qty: number }>;
}
interface BatchInputs {
  unresolved: Array<{
    id: string;
    items: Item[];
    notes: string | null;
    photos_urls: string[];
    account_slug?: string | null;
    hygglo_listing_id?: string | null;
  }>;
  inventory: InventoryItem[];
  bundles: Bundle[];
}

interface ResolutionResult {
  reservation_id: string;
  resolved_items: Array<{
    item_id: string;
    item_name_canonical: string;
    confidence: number;
    qty?: number;
  }>;
  expanded_items: Array<{
    item_id: string;
    item_name_canonical: string;
    qty: number;
    via_bundle?: string;
  }>;
  method: string;
  input_hash: string;
}

async function fetchBatch(
  limit: number,
  notesOnly: boolean,
  ids?: string[],
): Promise<BatchInputs> {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "item_resolver_queries:admin_getResolverBatchInputs",
      args: {
        limit,
        include_notes_only: notesOnly,
        ...(ids && ids.length > 0 ? { ids } : {}),
      },
      format: "json",
    }),
  });
  const data = (await res.json()) as {
    status: string;
    value?: BatchInputs;
    errorMessage?: string;
  };
  if (data.status !== "success") throw new Error(`batch fetch: ${data.errorMessage}`);
  return data.value!;
}

async function writeResults(results: ResolutionResult[]): Promise<void> {
  if (results.length === 0) return;
  const res = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "item_resolver_queries:admin_resolveBatchWrite",
      args: { results },
      format: "json",
    }),
  });
  const data = (await res.json()) as { status: string; errorMessage?: string };
  if (data.status !== "success") throw new Error(`batch write: ${data.errorMessage}`);
}

// ── LLM prompt + helpers (ported from convex/item_resolver.ts) ─────────

const RESOLUTION_SCHEMA = z.object({
  resolved_items: z.array(
    z.object({
      item_id: z.string(),
      item_name_canonical: z.string(),
      qty: z.number().int().min(1).default(1),
      confidence: z.number().min(0).max(1),
      matched_phrase: z.string(),
    }),
  ),
  unresolved_phrases: z.array(z.string()),
});

function inputHash(items: Item[]): string {
  return items.map((i) => i.item_name).sort().join("|");
}

/**
 * Collapse duplicate item_id entries in the LLM response. DeepSeek
 * occasionally emits "2x ITEM" as two qty:1 entries instead of one
 * qty:2. The matched_phrase regex bumps one of them; MAX picks the
 * bumped value and discards the unbumped duplicate. SUM would double-
 * count after the regex fires. Mirrors convex/item_resolver.ts:
 * mergeDuplicateItems — duplicated because src/ can't runtime-import
 * from convex/ modules.
 */
function mergeDuplicateItems<T extends { item_id: string; qty?: number; confidence?: number }>(
  items: T[],
): T[] {
  const map = new Map<string, T>();
  for (const it of items) {
    const qty = Math.max(1, Math.floor(it.qty ?? 1));
    const existing = map.get(it.item_id);
    if (!existing) {
      map.set(it.item_id, { ...it, qty });
    } else {
      existing.qty = Math.max(existing.qty ?? 1, qty);
      if ((it.confidence ?? 0) > (existing.confidence ?? 0)) {
        existing.confidence = it.confidence;
      }
    }
  }
  return Array.from(map.values());
}

const CATEGORY_MAP: Record<string, RegExp> = {
  camera: /(camera|body|mirrorless|cine\s*camera|fx3|fx6|fx30|a7|a7s|a7\s*iii|a7\s*iv|a7\s*v|bmpcc|c70|c200|c300|c500|gh5|gh6|mavic|drone)/,
  lens: /(lens|lenses|mm|gmaster|g\s*master|gm|prime|zoom|anamorphic|wide|tele|fisheye|cine\s*lens|24-70|16-35|70-200|28-70|90mm|24mm|35mm|50mm|85mm)/,
  audio: /(mic|microphone|audio|recorder|zoom\s*h|sennheiser|rode|lav|wireless\s*mic|boom|shotgun|tascam|dji\s*wireless|dji\s*mic)/,
  lighting: /(light|lights|led|panel|softbox|forza|pavotube|aputure|nanlite|godox|c-stand|cstand|flag|silk|reflector|rgb\s*panel|rgb\s*led)/,
  grip: /(tripod|stand|c-stand|cstand|monopod|gimbal|stabili[sz]er|slider|dolly|rig|cage|smallrig|tilta|rs2|rs3|rs\s*pro|crane|weeble|weebill)/,
  audio_dj: /(dj|deck|controller|pioneer|rekordbox|serato|cdj|mixer|turntable|partybox|jbl|mackie|speaker|pa)/,
  power: /(battery|batteries|v-mount|vmount|npf|np-f|np\s*f|power\s*station|jackery|ecoflow|anker|f2000)/,
  monitor: /(monitor|atomos|ninja|small\s*hd|prores\s*recorder|recorder|hdmi|sdi\s*monitor)/,
  transmission: /(transmit|transmitter|teradek|hollyland|mars|pyro|wireless\s*video|live\s*stream)/,
  storage: /(card|cf\s*express|cfast|sd\s*card|ssd|tb\s*ssd|drive|samsung\s*t7|t9)/,
  effects: /(smoke|fog|haze|smoke\s*ninja|smoke\s*machine|atmosphere|vfx)/,
  projector: /(projector|viewsonic\s*projector|hdmi\s*projector|4k\s*projector)/,
};

function filterInventoryByCategory(inv: InventoryItem[], title: string): InventoryItem[] {
  const lc = title.toLowerCase();
  const cats = new Set<string>();
  for (const [cat, re] of Object.entries(CATEGORY_MAP)) if (re.test(lc)) cats.add(cat);
  if (cats.size === 0) return inv;
  const filtered = inv.filter((i) => !i.kind || cats.has(i.kind));
  return filtered.length >= 8 ? filtered : inv;
}

// ── Phase 15.1: trigram pre-rank ──────────────────────────────
const KIT_RE = /[+&]|\b(kit|bundle|combo|set)\b|×\s*\d|\b\d+x\b/i;

function trigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  for (let i = 0; i <= t.length - 3; i++) out.add(t.slice(i, i + 3));
  return out;
}
function trigramSim(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const denom = a.size + b.size - inter;
  return denom > 0 ? inter / denom : 0;
}
function rankInventory(title: string, candidates: InventoryItem[], topN: number): InventoryItem[] {
  if (candidates.length <= topN) return candidates;
  const titleTri = trigrams(title);
  const scored = candidates.map((c) => {
    const blob = [c.name_canonical, ...(c.aliases ?? [])].join(" ");
    return { c, score: trigramSim(titleTri, trigrams(blob)) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map((x) => x.c);
}

const KNOWN_BRANDS = [
  "sony", "canon", "nikon", "fujifilm", "panasonic", "blackmagic", "red", "atomos",
  "dji", "hollyland", "aputure", "nanlite", "godox", "rode", "sennheiser", "shure",
  "jbl", "smallrig", "sirui", "tilta", "zhiyun", "pioneer", "astera", "gopro",
  "insta360", "profoto", "aladdin", "bmpcc",
];

function primaryBrand(title: string): string | null {
  const lc = title.toLowerCase();
  for (const b of KNOWN_BRANDS) if (lc.includes(b)) return b;
  return null;
}

function brandMismatch(primary: string, candidateName: string): boolean {
  const lc = candidateName.toLowerCase();
  if (lc.includes(primary)) return false;
  for (const b of KNOWN_BRANDS) {
    if (b === primary) continue;
    if (lc.includes(b)) return true; // candidate has different brand
  }
  return false;
}

function modelPrompt(): string {
  return `You are a precise camera/photo equipment cataloguer for a film-rental business.

Identify which inventory items the Hygglo listing title represents.

RULES:
1. RESPECT MODEL DISAMBIGUATORS. "A7 II" ≠ "A7 III". "FX3" ≠ "FX6". "Mk2" ≠ "Mk3".
2. Only return items physically in the title's bundle.
3. If a title item is NOT in inventory, add to unresolved_phrases — never substitute.
4. QUANTITY: extract integer qty. "2x" / "(2x)" / "2×" → qty:2. Default 1.
5. Confidence: 1.0 unambiguous, 0.6-0.9 partial, <0.5 skip.
6. Use the exact item_id supplied (Convex Id, round-trip verbatim).`;
}

function buildUserMessage(title: string, inv: InventoryItem[]): string {
  const lines = inv.map((i) => {
    const aliases = (i.aliases?.length ?? 0) > 0 ? ` | aliases: ${i.aliases!.join(", ")}` : "";
    const kind = i.kind ? ` [${i.kind}]` : "";
    const notes = i.notes ? ` — ${i.notes.slice(0, 80)}` : "";
    return `- item_id: ${i._id} | name: ${i.name_canonical}${kind}${aliases}${notes}`;
  });
  // INVENTORY block first: stable across the batch → DeepSeek's automatic
  // prefix cache hits the inventory portion (billed at cache-read rate).
  // TITLE last: variable per call, cannot be cached anyway.
  return `INVENTORY (the only items we own):\n${lines.join("\n")}\n\nLISTING TITLE:\n"${title}"`;
}

// ── Scheduled task ─────────────────────────────────────────────────────

export const resolveItemsTask = schedules.task({ // check-patterns:ok — maxDuration:180 set below (after cron comment block)
  id: "resolve-items",
  // Phase 18.2 — cron loosened 15m → 60m. New-listing latency is now covered by
  // on-demand triggers from poll-hygglo (which fires `tasks.trigger("resolve-items",
  // { ids:[...] })` immediately after inserting a fresh reservation), so the cron
  // only has to mop up retries + backfills.
  cron: "0 * * * *",
  maxDuration: 180,
  run: async (payload, { ctx }) => {
    if (isWithinUkQuietHours()) {
      logger.info("[quiet-hours] skipped", { task: "resolve-items" });
      return { skipped: true, reason: "uk_quiet_hours" };
    }
    // Accept BOTH shapes:
    //   • cron / scan-all: payload is the schedules SDK envelope, no `ids`/`limit`.
    //   • on-demand: `tasks.trigger("resolve-items", { ids: [...] })` from poll-hygglo.
    const p = payload as unknown as { ids?: string[]; limit?: number } | undefined;
    const targetIds = p?.ids;
    const limit = p?.limit ?? 15;
    return await runBatch(ctx.run.id, false, { ids: targetIds, limit });
  },
});

// Separate task for the slower notes-only backfill cohort.
// Loosened 2026-05-24 from hourly → weekly (Sunday 04:30 UTC). Backfill is
// of a historical cohort that drains by ~5-10 rows/day; hourly cadence was
// wasting 167 of 168 fires/week. Re-enable hourly only if the unresolved
// notes-only queue exceeds 100 (check via dashboard or convex query).
export const resolveItemsNotesBackfillTask = schedules.task({
  id: "resolve-items-notes-backfill",
  cron: "30 4 * * 0",
  maxDuration: 180,
  run: async (_payload, { ctx }) => {
    if (isWithinUkQuietHours()) {
      logger.info("[quiet-hours] skipped", { task: "resolve-items-notes-backfill" });
      return { skipped: true, reason: "uk_quiet_hours" };
    }
    return await runBatch(ctx.run.id, true, { limit: 10 });
  },
});

async function runBatch(
  runId: string,
  notesOnly: boolean,
  opts?: { ids?: string[]; limit?: number },
) {
  const limit = opts?.limit ?? (notesOnly ? 10 : 15);
  const batch = await fetchBatch(limit, notesOnly, opts?.ids);
  if (batch.unresolved.length === 0) {
    logger.info("resolve-items: pool empty", { runId, notesOnly, targeted: (opts?.ids?.length ?? 0) > 0 });
    return { ok: true, processed: 0, idle: true };
  }

  const results: ResolutionResult[] = [];
  let cacheHits = 0;

  // In-batch dedup: when the same hygglo_listing_id (or item set) appears
  // on multiple reservations in one batch, only call the LLM once. Saves
  // duplicate hits for kit listings co-booked by the same group.
  const inBatchByListing = new Map<string, ResolutionResult>();
  const inBatchByHash = new Map<string, ResolutionResult>();

  for (const r of batch.unresolved) {
    // For caching and KIT detection we still build a combined display string,
    // but resolution is now done per-listing so that N duplicate Hygglo listings
    // of the same SKU produce qty:N (not collapsed to qty:1 by LLM dedup).
    const combinedTitle = r.items
      .map((i) => (i.qty && i.qty > 1 ? `${i.qty}× ${i.item_name}` : i.item_name))
      .join("\n");
    const newHash = inputHash(r.items);

    // In-batch listing-id dedup.
    const listingKey =
      r.account_slug && r.hygglo_listing_id
        ? `${r.account_slug}:${r.hygglo_listing_id}`
        : null;
    if (listingKey) {
      const dup = inBatchByListing.get(listingKey);
      if (dup) {
        results.push({ ...dup, reservation_id: r.id, input_hash: newHash });
        cacheHits++;
        continue;
      }
    }

    // In-batch item-hash dedup (catches listings without a hygglo_listing_id).
    const hashDup = inBatchByHash.get(newHash);
    if (hashDup) {
      results.push({ ...hashDup, reservation_id: r.id, input_hash: newHash });
      cacheHits++;
      continue;
    }

    // Phase 15.1: persistent cache lookup keyed by (account_slug, hygglo_listing_id).
    // Cache stores the FINAL per-reservation resolution result, so per-listing
    // resolution upstream is invisible at this layer — cache key unchanged.
    if (r.account_slug && r.hygglo_listing_id) {
      const cached = await lookupCache(r.account_slug, r.hygglo_listing_id);
      if (cached) {
        const hit: ResolutionResult = {
          reservation_id: r.id,
          resolved_items: cached.resolved_items,
          expanded_items: cached.expanded_items,
          method: cached.resolution_method,
          input_hash: newHash,
        };
        results.push(hit);
        if (listingKey) inBatchByListing.set(listingKey, hit);
        inBatchByHash.set(newHash, hit);
        cacheHits++;
        continue;
      }
    }

    // ── Per-listing resolution loop ───────────────────────────────────
    // Bug fix (qty-extraction): previously titles were joined with "\n" and
    // sent in a single LLM call. When a Hygglo order had N listings of the
    // same SKU, the LLM treated them as one and emitted qty:1 — collapsing
    // N physical units to 1. Now each listing is resolved separately and
    // results merged via existing addExp (which sums same-item_id qty).
    const perListingResolved: Array<Array<{
      item_id: string;
      item_name_canonical: string;
      confidence: number;
      qty: number;
    }>> = [];

    let llmFailedAnyListing = false;
    for (const listing of r.items) {
      const oneTitle = listing.qty && listing.qty > 1
        ? `${listing.qty}× ${listing.item_name}`
        : listing.item_name;
      const isKit = KIT_RE.test(oneTitle);

      let resolvedOne: Array<{
        item_id: string;
        item_name_canonical: string;
        confidence: number;
        qty: number;
      }> = [];

      try {
        const gated = await gatedGenerateObject({
          model: await getLlmModel(),
          schema: RESOLUTION_SCHEMA,
          messages: [
            { role: "system", content: modelPrompt() },
            {
              role: "user",
              content: buildUserMessage(
                oneTitle,
                rankInventory(
                  oneTitle,
                  filterInventoryByCategory(batch.inventory, oneTitle),
                  isKit ? 15 : 8,
                ),
              ),
            },
          ],
          maxOutputTokens: 1500,
          context: { source: "trigger:resolve-items", tag: "resolve-items" },
        });
        if (gated.skipped) {
          logger.info("[quiet-hours] gated skip", { task: "resolve-items", reservation_id: r.id });
          llmFailedAnyListing = true;
          break;
        }
        const result = gated.result;
        const validIds = new Set(batch.inventory.map((i) => i._id));
        const rawItems = result.object.resolved_items
          .filter((x) => validIds.has(x.item_id) && x.confidence >= 0.5)
          .map((x) => {
            let qty = Math.max(1, Math.floor(x.qty ?? 1));
            if (qty === 1 && x.matched_phrase) {
              const phrase = x.matched_phrase.toLowerCase();
              const idx = oneTitle.toLowerCase().indexOf(phrase);
              if (idx > 0) {
                const before = oneTitle.slice(Math.max(0, idx - 8), idx);
                const m = /(\d+)\s*[x×]/i.exec(before);
                if (m) qty = Math.max(qty, parseInt(m[1], 10));
              }
            }
            return {
              item_id: x.item_id,
              item_name_canonical: x.item_name_canonical,
              confidence: x.confidence,
              qty,
              matched_phrase: x.matched_phrase,
            };
          });
        // Collapse duplicates WITHIN this single listing only (LLM "2x ITEM"
        // → two qty:1 quirk). Cross-listing summation happens later via addExp.
        resolvedOne = mergeDuplicateItems(rawItems).map((x) => ({
          item_id: x.item_id,
          item_name_canonical: x.item_name_canonical,
          confidence: x.confidence ?? 0,
          qty: x.qty ?? 1,
        }));
        // Brand-integrity gate, per listing.
        const primary = primaryBrand(oneTitle);
        if (primary) {
          const before = resolvedOne.length;
          resolvedOne = resolvedOne.filter((x) => !brandMismatch(primary, x.item_name_canonical));
          if (resolvedOne.length !== before) {
            logger.info("resolve-items: brand gate dropped", {
              dropped: before - resolvedOne.length,
              primary,
              reservation_id: r.id,
            });
          }
        }
      } catch (err) {
        logger.error("resolve-items: LLM failed", { reservation_id: r.id, err: String(err) });
        llmFailedAnyListing = true;
        break;
      }
      perListingResolved.push(resolvedOne);
    }
    if (llmFailedAnyListing) continue;

    // Flat-merge across listings — addExp sums same-item_id qty automatically.
    // Then mergeDuplicateItems on the resolved_items[] view (keeping max conf).
    const expanded: Array<{
      item_id: string;
      item_name_canonical: string;
      qty: number;
      via_bundle?: string;
    }> = [];
    const addExp = (id: string, name: string, qty: number, via?: string) => {
      const ex = expanded.find((e) => e.item_id === id);
      if (ex) ex.qty += qty;
      else expanded.push({ item_id: id, item_name_canonical: name, qty, via_bundle: via });
    };
    // Build resolved_items[] view by summing qty across listings (per item_id).
    const resolvedSum = new Map<string, {
      item_id: string;
      item_name_canonical: string;
      confidence: number;
      qty: number;
    }>();
    for (const listing of perListingResolved) {
      for (const x of listing) {
        const ex = resolvedSum.get(x.item_id);
        if (ex) {
          ex.qty += x.qty;
          if (x.confidence > ex.confidence) ex.confidence = x.confidence;
        } else {
          resolvedSum.set(x.item_id, { ...x });
        }
        // Bundle expansion happens against EACH listing's resolved entry
        // (one listing's bundle expands once per occurrence).
        const bundleHit = batch.bundles.find((b) => b.bundle_name === x.item_name_canonical);
        if (bundleHit) {
          for (const bi of bundleHit.items) addExp(bi.item_id, bi.item_name_canonical, bi.qty * x.qty, bundleHit.bundle_id);
        } else {
          addExp(x.item_id, x.item_name_canonical, x.qty);
        }
      }
    }
    const resolved = Array.from(resolvedSum.values());

    const llmResult: ResolutionResult = {
      reservation_id: r.id,
      resolved_items: resolved,
      expanded_items: expanded,
      method: "llm",
      input_hash: newHash,
    };
    results.push(llmResult);
    if (listingKey) inBatchByListing.set(listingKey, llmResult);
    inBatchByHash.set(newHash, llmResult);

    // Phase 15.1: write-through to cache (dual-key).
    try {
      await upsertCache({
        title_hash: titleHashOf(r.items),
        account_slug: r.account_slug ?? undefined,
        hygglo_listing_id: r.hygglo_listing_id ?? undefined,
        sample_title: r.items[0]?.item_name?.slice(0, 200) ?? "",
        resolved_items: resolved,
        expanded_items: expanded,
        resolution_method: "llm",
      });
    } catch (err) {
      logger.warn("resolve-items: cache write failed", { reservation_id: r.id, err: String(err) });
    }
  }

  await writeResults(results);
  logger.info("resolve-items: done", {
    runId,
    attempted: batch.unresolved.length,
    written: results.length,
    cacheHits,
    notesOnly,
  });
  return { ok: true, attempted: batch.unresolved.length, written: results.length, cacheHits };
}

// ── Phase 15.1: cache helpers (HTTP into Convex listing_cache) ────────────
function titleHashOf(items: Item[]): string {
  const norm = items
    .map((i) => i.item_name.toLowerCase().replace(/\s+/g, " ").trim())
    .sort()
    .join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0") + "_" + norm.length;
}

async function lookupCache(account_slug: string, hygglo_listing_id: string): Promise<{
  resolved_items: ResolutionResult["resolved_items"];
  expanded_items: ResolutionResult["expanded_items"];
  resolution_method: string;
} | null> {
  try {
    // Modelled as a mutation server-side because it bumps hit_count.
    const res = await fetch(`${CONVEX_URL}/api/mutation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "listing_cache:adminLookupByListing",
        args: { account_slug, hygglo_listing_id },
        format: "json",
      }),
    });
    const data = (await res.json()) as { status: string; value?: unknown };
    if (data.status !== "success" || !data.value) return null;
    return data.value as Awaited<ReturnType<typeof lookupCache>>;
  } catch {
    return null;
  }
}

async function upsertCache(args: {
  title_hash: string;
  account_slug?: string;
  hygglo_listing_id?: string;
  sample_title: string;
  resolved_items: ResolutionResult["resolved_items"];
  expanded_items: ResolutionResult["expanded_items"];
  resolution_method: string;
}): Promise<void> {
  const res = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "listing_cache:adminUpsertResolution",
      args,
      format: "json",
    }),
  });
  const data = (await res.json()) as { status: string; errorMessage?: string };
  if (data.status !== "success") throw new Error(`cache upsert: ${data.errorMessage}`);
}
