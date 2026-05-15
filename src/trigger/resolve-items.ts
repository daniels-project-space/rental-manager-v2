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
import { generateObject } from "ai";
import { createXai } from "@ai-sdk/xai";
import { z } from "zod";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

// ── Vault + LLM client ─────────────────────────────────────────────────

async function getVaultSecret(service: string, keyName: string): Promise<string> {
  const res = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service },
      format: "json",
    }),
  });
  if (!res.ok) throw new Error(`vault: ${res.status}`);
  const data = (await res.json()) as {
    value?: Array<{ keyName: string; value: string }>;
  };
  for (const s of data.value ?? []) if (s.keyName === keyName) return s.value;
  throw new Error(`${keyName} missing in vault service=${service}`);
}

let _xai: ReturnType<typeof createXai> | null = null;
async function getXai() {
  if (_xai) return _xai;
  const key = process.env.XAI_API_KEY ?? (await getVaultSecret("xai", "XAI_API_KEY"));
  _xai = createXai({ apiKey: key });
  return _xai;
}

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

async function fetchBatch(limit: number, notesOnly: boolean): Promise<BatchInputs> {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "item_resolver_queries:admin_getResolverBatchInputs",
      args: { limit, include_notes_only: notesOnly },
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

You receive a Hygglo listing title (which often bundles multiple physical items)
and a list of every item we actually own (master inventory). Identify which
inventory items the listing represents.

CRITICAL RULES:
1. RESPECT MODEL DISAMBIGUATORS. "Sony A7 II" ≠ "Sony A7 III". A listing for
   "A7 III" does NOT match an inventory entry for "A7 II".
2. NO SUBSTRING SHORTCUTS. "Sony FX3" appearing in the title does not match
   inventory entry "Sony FX6".
3. Only return items physically in the title's bundle.
4. If an item in the title is NOT in inventory, add to unresolved_phrases.
5. QUANTITY: extract integer qty. "2x" / "(2x)" / "2×" → qty:2.
6. Confidence: 1.0 only when the disambiguator is unambiguous. 0.6-0.9 partial.
   < 0.5 = guess; skip it.
7. Use the exact item_id value supplied (Convex Id, must round-trip verbatim).`;
}

function buildUserMessage(title: string, inv: InventoryItem[]): string {
  const lines = inv.map((i) => {
    const aliases = (i.aliases?.length ?? 0) > 0 ? ` | aliases: ${i.aliases!.join(", ")}` : "";
    const kind = i.kind ? ` [${i.kind}]` : "";
    const notes = i.notes ? ` — ${i.notes.slice(0, 80)}` : "";
    return `- item_id: ${i._id} | name: ${i.name_canonical}${kind}${aliases}${notes}`;
  });
  return `LISTING TITLE:\n"${title}"\n\nINVENTORY (the only items we own):\n${lines.join("\n")}`;
}

// ── Scheduled task ─────────────────────────────────────────────────────

export const resolveItemsTask = schedules.task({
  id: "resolve-items",
  cron: "*/15 * * * *",
  maxDuration: 180,
  run: async (_payload, { ctx }) => {
    return await runBatch(ctx.run.id, false);
  },
});

// Separate task for the slower notes-only backfill cohort. Cron hourly.
export const resolveItemsNotesBackfillTask = schedules.task({
  id: "resolve-items-notes-backfill",
  cron: "0 * * * *",
  maxDuration: 180,
  run: async (_payload, { ctx }) => {
    return await runBatch(ctx.run.id, true);
  },
});

async function runBatch(runId: string, notesOnly: boolean) {
  const batch = await fetchBatch(notesOnly ? 10 : 15, notesOnly);
  if (batch.unresolved.length === 0) {
    logger.info("resolve-items: pool empty", { runId, notesOnly });
    return { ok: true, processed: 0, idle: true };
  }

  const results: ResolutionResult[] = [];
  for (const r of batch.unresolved) {
    const combinedTitle = r.items
      .map((i) => (i.qty && i.qty > 1 ? `${i.qty}× ${i.item_name}` : i.item_name))
      .join("\n");
    const newHash = inputHash(r.items);

    let resolved: Array<{
      item_id: string;
      item_name_canonical: string;
      confidence: number;
      qty: number;
    }> = [];

    try {
      const result = await generateObject({
        model: (await getXai())("grok-4.3"),
        schema: RESOLUTION_SCHEMA,
        messages: [
          { role: "system", content: modelPrompt() },
          {
            role: "user",
            content: buildUserMessage(
              combinedTitle,
              filterInventoryByCategory(batch.inventory, combinedTitle),
            ),
          },
        ],
      });
      const validIds = new Set(batch.inventory.map((i) => i._id));
      resolved = result.object.resolved_items
        .filter((x) => validIds.has(x.item_id) && x.confidence >= 0.5)
        .map((x) => {
          let qty = Math.max(1, Math.floor(x.qty ?? 1));
          if (qty === 1 && x.matched_phrase) {
            const phrase = x.matched_phrase.toLowerCase();
            const idx = combinedTitle.toLowerCase().indexOf(phrase);
            if (idx > 0) {
              const before = combinedTitle.slice(Math.max(0, idx - 8), idx);
              const m = /(\d+)\s*[x×]/i.exec(before);
              if (m) qty = Math.max(qty, parseInt(m[1], 10));
            }
          }
          return {
            item_id: x.item_id,
            item_name_canonical: x.item_name_canonical,
            confidence: x.confidence,
            qty,
          };
        });
      // Brand integrity gate
      const primary = primaryBrand(combinedTitle);
      if (primary) {
        const before = resolved.length;
        resolved = resolved.filter((x) => !brandMismatch(primary, x.item_name_canonical));
        if (resolved.length !== before) {
          logger.info("resolve-items: brand gate dropped", {
            dropped: before - resolved.length,
            primary,
            reservation_id: r.id,
          });
        }
      }
    } catch (err) {
      logger.error("resolve-items: LLM failed", { reservation_id: r.id, err: String(err) });
      continue;
    }

    // Bundle expansion
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
    for (const x of resolved) {
      const bundleHit = batch.bundles.find((b) => b.bundle_name === x.item_name_canonical);
      if (bundleHit) {
        for (const bi of bundleHit.items) addExp(bi.item_id, bi.item_name_canonical, bi.qty * x.qty, bundleHit.bundle_id);
      } else {
        addExp(x.item_id, x.item_name_canonical, x.qty);
      }
    }

    results.push({
      reservation_id: r.id,
      resolved_items: resolved,
      expanded_items: expanded,
      method: "llm",
      input_hash: newHash,
    });
  }

  await writeResults(results);
  logger.info("resolve-items: done", {
    runId,
    attempted: batch.unresolved.length,
    written: results.length,
    notesOnly,
  });
  return { ok: true, attempted: batch.unresolved.length, written: results.length };
}
