/**
 * canonicalize-denials — Trigger.dev port of the denial canonicaliser.
 *
 * Was a Convex action (`convex/denial_canonicalizer.ts` ::
 * canonicalizeDenialBatch) that held an action open for ~3-8 seconds per
 * Grok call. Convex bills action runtime; lifting the LLM call to
 * Trigger.dev's free-tier compute is materially cheaper.
 *
 * Cadence: daily 04:30 UTC. Picks 20 uncanonicalised denials per run,
 * extracts clean Brand+Model via Grok, writes back via Convex mutation.
 * Naturally idles once the pool is drained (listUnresolvedDenials
 * returns []).
 *
 * Convex still owns:
 *   - the public mutation that persists the result (single small write)
 *   - the read query that returns unresolved rows (paginated)
 *
 * Trigger owns:
 *   - the schedule
 *   - the LLM call (the slow + expensive part)
 *
 * SAFETY: Convex cron for `denial_canonicalizer:canonicalizeDenialBatch`
 * should be removed (or never added) when this task is enabled — otherwise
 * the two will race for the same rows. They are both idempotent so the
 * worst case is double-work, not data corruption.
 */
import { schedules, logger } from "@trigger.dev/sdk/v3";
import { gatedGenerateObject } from "../lib/gated-generate";
import { createXai } from "@ai-sdk/xai";
import { z } from "zod";
import { isWithinUkQuietHours } from "../lib/quiet-hours";
import { GROK_NARROW_MODEL } from "../lib/ai-models";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

// ── Vault + LLM client (lazy) ──────────────────────────────────────────

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
  if (!res.ok) throw new Error(`Vault fetch failed: ${res.status}`);
  const data = (await res.json()) as {
    value?: Array<{ keyName: string; value: string }>;
  };
  for (const s of data.value ?? []) {
    if (s.keyName === keyName) return s.value;
  }
  throw new Error(`${keyName} not found in vault service=${service}`);
}

let _xai: ReturnType<typeof createXai> | null = null;
async function getXai() {
  if (_xai) return _xai;
  const key = process.env.XAI_API_KEY ?? (await getVaultSecret("xai", "XAI_API_KEY"));
  _xai = createXai({ apiKey: key });
  return _xai;
}

// ── LLM schema (must match Convex side, but lives here independently) ──

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
      canonical_product: z.string(),
      brand: z.string(),
      kind: KIND_ENUM,
    }),
  ),
});

const SYSTEM_PROMPT = `You normalise camera-rental listing titles into clean canonical product names.

Rules:
1. canonical_product = "<Brand> <Model>" only. Strip kit contents, accessory lists, SEO keyword soup.
2. Preserve the disambiguating model number/letter exactly: II vs III, Mk2 vs Mk3, 6K vs 6K Pro, A7 III vs A7 IV.
3. For multi-item kits, pick the HEADLINE item (usually the camera body or the most expensive single item).
4. If the title is clearly a bundle/set of identical items ("2x Nanlite Pavotube"), drop the count.
5. Common brands: Sony, Canon, Nikon, Fujifilm, Panasonic, Blackmagic, RED, Atomos, DJI, Hollyland, Aputure, Nanlite, Godox, Rode, Sennheiser, Shure, JBL, SmallRig, Sirui, Tilta, Zhiyun, Pioneer, Astera, GoPro, Insta360, Profoto, Aladdin.
6. Output exactly ONE entry per input index. Use the same index supplied.
7. Output strict JSON matching the schema.`;

// ── Convex HTTP helpers ─────────────────────────────────────────────────

interface UnresolvedDenial {
  id: string;
  item_name: string;
}

async function listUnresolved(limit: number): Promise<UnresolvedDenial[]> {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "denial_canonicalizer_queries:listUnresolvedDenials",
      args: { limit },
      format: "json",
    }),
  });
  const data = (await res.json()) as {
    status: string;
    value?: UnresolvedDenial[];
    errorMessage?: string;
  };
  if (data.status !== "success") {
    throw new Error(`listUnresolvedDenials failed: ${data.errorMessage}`);
  }
  return data.value ?? [];
}

async function setCanonical(args: {
  denial_id: string;
  canonical_product: string;
  canonical_brand: string;
  canonical_kind: string;
}): Promise<void> {
  const res = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "denial_canonicalizer_queries:setDenialCanonical",
      args,
      format: "json",
    }),
  });
  const data = (await res.json()) as { status: string; errorMessage?: string };
  if (data.status !== "success") {
    throw new Error(`setDenialCanonical failed: ${data.errorMessage}`);
  }
}

// ── Scheduled task ──────────────────────────────────────────────────────

export const canonicalizeDenialsTask = schedules.task({
  id: "canonicalize-denials",
  cron: "0 * * * *", // hourly (was: daily 04:30 UTC → widened)
  // One Grok call per run — bounded LLM cost.
  maxDuration: 120,
  run: async (_payload, { ctx }) => {
    if (isWithinUkQuietHours()) {
      logger.info("[quiet-hours] skipped", { task: "canonicalize-denials" });
      return { skipped: true, reason: "uk_quiet_hours" };
    }
    const todo = await listUnresolved(20);
    if (todo.length === 0) {
      // Queue-idle gate: pool drained — skip LLM work, next hourly tick re-checks.
      logger.info("queue idle, skipping run", { task: "canonicalize-denials" });
      return { skipped: true };
    }

    const userMessage =
      "Normalise each listing title to its canonical product:\n\n" +
      todo.map((t, idx) => `[${idx}] ${t.item_name.slice(0, 240)}`).join("\n");

    let result: { object: { results: Array<{ index: number; canonical_product: string; brand: string; kind: string }> } };
    try {
      const gated = await gatedGenerateObject({
        model: (await getXai())(GROK_NARROW_MODEL),
        schema: BATCH_SCHEMA,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        context: { source: "trigger:canonicalize-denials", tag: "canonicalize-denials" },
      });
      if (gated.skipped) {
        logger.info("[quiet-hours] gated skip", { task: "canonicalize-denials" });
        return { skipped: true, reason: "uk_quiet_hours" };
      }
      result = gated.result as typeof result;
    } catch (err) {
      logger.error("canonicalize-denials: LLM call failed", { err: String(err) });
      return { ok: false, error: String(err) };
    }

    let written = 0;
    for (const r of result.object.results) {
      const row = todo[r.index];
      if (!row) continue;
      try {
        await setCanonical({
          denial_id: row.id,
          canonical_product: r.canonical_product.trim(),
          canonical_brand: r.brand.trim(),
          canonical_kind: r.kind,
        });
        written++;
      } catch (err) {
        logger.warn("canonicalize-denials: mutation write failed", {
          denial_id: row.id,
          err: String(err),
        });
      }
    }
    logger.info("canonicalize-denials: done", {
      attempted: todo.length,
      written,
      runId: ctx.run.id,
    });
    return { ok: true, attempted: todo.length, written };
  },
});
