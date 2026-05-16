/**
 * vision-resolve — Trigger.dev port of the Convex vision-resolver action.
 *
 * Vision Grok calls hold Convex actions open the longest of any LLM call
 * (~8-15s per call, 5 calls per batch). Lifting to Trigger.dev removes
 * those seconds from Convex's action runtime billing.
 *
 * Cadence: daily 04:45 UTC (Phase 18.1 reduction — vision Grok is the
 * most expensive call in the pipeline; daily sweep is sufficient).
 *
 * SAFETY: When this task is enabled, REMOVE the matching Convex cron
 * (`vision_resolver augment` in convex/crons.ts) to avoid double-LLM.
 * Both write paths use the same merge logic so worst case is wasted
 * vision calls, not corruption.
 */
import { schedules, logger } from "@trigger.dev/sdk/v3";
import { generateObject } from "ai";
import { createXai } from "@ai-sdk/xai";
import { z } from "zod";
import { isWithinUkQuietHours } from "../lib/quiet-hours";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

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

// ── Types matching the Convex bundle response ─────────────────────────

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
interface AlreadyResolved {
  item_id: string;
  item_name_canonical: string;
  confidence: number;
  qty: number;
}
interface Candidate {
  id: string;
  photos_urls: string[];
  title: string;
  already_resolved: AlreadyResolved[];
  resolution_input_hash: string;
}
interface BatchInputs {
  candidates: Candidate[];
  inventory: InventoryItem[];
  bundles: Bundle[];
}

// ── Vision LLM schema + prompt (mirrors Convex vision_resolver.ts) ─────

const VISION_SCHEMA = z.object({
  visible_items: z.array(
    z.object({
      item_id: z.string(),
      item_name_canonical: z.string(),
      qty: z.number().int().min(1).default(1),
      confidence: z.number().min(0).max(1),
      image_index: z.number().int().min(0),
      visual_cue: z.string(),
    }),
  ),
  notes: z.string().optional(),
});

const VISION_PROMPT = `You are auditing equipment-rental listing photos for hidden items.

CONTEXT: A renter booked a kit-style listing on Hygglo (UK photo/film rental
platform). The title only mentions some items. Your job is to look at every
photo and identify every other physical item from OUR inventory that is
clearly visible. Marketing-bundled listings ("Complete Kit", "Full Setup")
routinely hide accessory items in photos — most commonly a kit lens on a
camera body, a tripod under it, batteries, cables, cases.

CRITICAL RULES — the owner has explicitly said "do NOT add wrong items":

1. RESPECT INVENTORY IDS. Only return item_id values that appear in the
   inventory list below.
2. RESPECT MODEL DISAMBIGUATION. Sony FX3 ≠ FX6, A7 II ≠ A7 III.
3. RESPECT THE ALREADY-RESOLVED LIST. Do NOT re-list items already there.
4. CONFIDENCE FLOOR 0.7. Better to miss than to add wrong.
5. NO INFERENCE. If brand isn't visible and inventory has multiple similar
   options, omit.
6. NO ACCESSORIES UNLESS WE OWN THEM.
7. Every visible_item must include a one-line visual_cue.`;

function buildUserText(c: Candidate, inventory: InventoryItem[]): string {
  const resolvedBlock =
    c.already_resolved.length === 0
      ? "  (none — text resolver returned no items)"
      : c.already_resolved
          .map((x) => `  - ${x.item_name_canonical} × ${x.qty}`)
          .join("\n");
  const inv = inventory
    .map((i) => {
      const aliases = (i.aliases?.length ?? 0) > 0 ? ` | aliases: ${i.aliases!.join(", ")}` : "";
      const kind = i.kind ? ` [${i.kind}]` : "";
      return `- item_id: ${i._id} | name: ${i.name_canonical}${kind}${aliases}`;
    })
    .join("\n");
  return `LISTING TITLE:\n"${c.title}"\n\nALREADY-RESOLVED ITEMS (do not re-list these — only add NEW):\n${resolvedBlock}\n\nINVENTORY (the only items we own):\n${inv}`;
}

// ── Convex HTTP plumbing ──────────────────────────────────────────────

async function fetchBatch(limit: number): Promise<BatchInputs> {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "item_resolver_queries:admin_getVisionBatchInputs",
      args: { limit },
      format: "json",
    }),
  });
  const data = (await res.json()) as { status: string; value?: BatchInputs; errorMessage?: string };
  if (data.status !== "success") throw new Error(`vision batch fetch: ${data.errorMessage}`);
  return data.value!;
}

async function writeAugmentation(args: {
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
  input_hash: string;
}): Promise<void> {
  const res = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "item_resolver_queries:admin_writeVisionAugmentation",
      args,
      format: "json",
    }),
  });
  const data = (await res.json()) as { status: string; errorMessage?: string };
  if (data.status !== "success") throw new Error(`vision write: ${data.errorMessage}`);
}

// ── Scheduled task ────────────────────────────────────────────────────

// Phase 15.1: conditional vision pass. Skip when the text resolver already
// returned confident matches and the title shows no kit/bundle signals.
const KIT_RE =
  /[+&]|\b(kit|bundle|combo|set)\b|×\s*\d|\b\d+x\b/i;

export const visionResolveTask = schedules.task({
  id: "vision-resolve",
  cron: "45 4 * * *", // daily 04:45 UTC
  maxDuration: 300,
  run: async (_payload, { ctx }) => {
    if (isWithinUkQuietHours()) {
      logger.info("[quiet-hours] skipped", { task: "vision-resolve" });
      return { skipped: true, reason: "uk_quiet_hours" };
    }
    const batch = await fetchBatch(5);
    if (batch.candidates.length === 0) {
      logger.info("vision-resolve: pool empty", { runId: ctx.run.id });
      return { ok: true, processed: 0, idle: true };
    }
    const validIds = new Set(batch.inventory.map((i) => i._id));

    let totalAdded = 0;
    let processed = 0;
    let skippedGate = 0;
    for (const c of batch.candidates) {
      // Phase 15.1: gate. If every existing resolution has confidence>=0.7
      // AND the title is not kit-shaped, skip the vision LLM call entirely.
      const hasLowConfidence = c.already_resolved.some(
        (x) => (x.confidence ?? 0) < 0.7,
      );
      const isKit = KIT_RE.test(c.title);
      if (!hasLowConfidence && !isKit && c.already_resolved.length > 0) {
        logger.info("vision-resolve: skipped (confident + no kit signals)", {
          reservation_id: c.id,
        });
        skippedGate++;
        processed++;
        continue;
      }
      const alreadyIds = new Set(c.already_resolved.map((x) => x.item_id));

      type VisionImage = { type: "image"; image: string | URL };
      type VisionText = { type: "text"; text: string };
      const userContent: Array<VisionText | VisionImage> = [
        { type: "text", text: buildUserText(c, batch.inventory) },
        ...c.photos_urls.map((u) => ({ type: "image" as const, image: u })),
      ];

      let added: Array<{
        item_id: string;
        item_name_canonical: string;
        qty: number;
        confidence: number;
      }> = [];
      try {
        const result = await generateObject({
          model: (await getXai())("grok-4.3"),
          schema: VISION_SCHEMA,
          messages: [
            { role: "system", content: VISION_PROMPT },
            { role: "user", content: userContent },
          ],
        });
        added = (result.object.visible_items ?? [])
          .filter((vi) => validIds.has(vi.item_id))
          .filter((vi) => vi.confidence >= 0.7)
          .filter((vi) => !alreadyIds.has(vi.item_id))
          .map((vi) => ({
            item_id: vi.item_id,
            item_name_canonical: vi.item_name_canonical,
            qty: Math.max(1, Math.floor(vi.qty ?? 1)),
            confidence: vi.confidence,
          }));
      } catch (err) {
        logger.error("vision-resolve: LLM failed", { reservation_id: c.id, err: String(err) });
        processed++;
        continue;
      }

      if (added.length === 0) {
        processed++;
        continue;
      }

      const merged = [
        ...c.already_resolved.map((x) => ({
          item_id: x.item_id,
          item_name_canonical: x.item_name_canonical,
          confidence: x.confidence,
          qty: x.qty,
        })),
        ...added,
      ];

      // Bundle expansion
      const expanded: Array<{ item_id: string; item_name_canonical: string; qty: number; via_bundle?: string }> = [];
      const addExp = (id: string, name: string, qty: number, via?: string) => {
        const ex = expanded.find((e) => e.item_id === id);
        if (ex) ex.qty += qty;
        else expanded.push({ item_id: id, item_name_canonical: name, qty, via_bundle: via });
      };
      for (const r of merged) {
        const bundleHit = batch.bundles.find((b) => b.bundle_name === r.item_name_canonical);
        if (bundleHit) {
          for (const bi of bundleHit.items) addExp(bi.item_id, bi.item_name_canonical, bi.qty * (r.qty ?? 1), bundleHit.bundle_id);
        } else {
          addExp(r.item_id, r.item_name_canonical, r.qty ?? 1);
        }
      }

      try {
        await writeAugmentation({
          reservation_id: c.id,
          resolved_items: merged,
          expanded_items: expanded,
          input_hash: c.resolution_input_hash,
        });
        totalAdded += added.length;
      } catch (err) {
        logger.warn("vision-resolve: mutation write failed", {
          reservation_id: c.id,
          err: String(err),
        });
      }
      processed++;
    }

    logger.info("vision-resolve: done", {
      runId: ctx.run.id,
      processed,
      totalAdded,
      skippedGate,
      candidates: batch.candidates.length,
    });
    return { ok: true, processed, totalAdded, skippedGate };
  },
});
