/**
 * Wave 4.6 — Hygglo UI action Trigger task.
 *
 * Single entry point for every browser-driven Hygglo mutation. It is
 * dispatched by `src/mastra/data/ui_actions.ts` (via the chat tools)
 * and reuses cookies captured by `scripts/bootstrap-hygglo-session.mjs`.
 *
 * Lifecycle per run:
 *   1. Idempotency check (correlationId → existing row?)
 *   2. Load storage_state cookies for the account from Convex
 *   3. Write storage_state to a temp file
 *   4. Spawn the Python runner via @trigger.dev/python `python.runScript`
 *   5. Parse the `RESULT::{json}` line from stdout
 *   6. Upload screenshot to R2 (best-effort)
 *   7. Write the completion row + add cost to ledger
 *   8. Refresh affected MVs
 *
 * Concurrency: keyed queue ensures only one browser-use run per account
 * at a time so cookies stay valid and we don't trip Hygglo rate limits.
 */
import { logger, task, queue } from "@trigger.dev/sdk/v3";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// Wrapper around spawning the Python runner. Installs requirements lazily
// the first time the worker boots (no-op on warm starts).
let pythonReady: Promise<void> | null = null;
function ensurePythonDeps(): Promise<void> {
  if (pythonReady) return pythonReady;
  pythonReady = new Promise<void>((resolve, reject) => {
    const proc = spawn("python3", ["-m", "pip", "install", "--quiet", "-r", "requirements.txt"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    proc.on("error", reject);
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`pip install exit ${code}`))));
  });
  return pythonReady;
}

interface PyRun {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runPython(args: string[], env: Record<string, string>): Promise<PyRun> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["./python/browser_use_action.py", ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => resolve({ stdout, stderr, code }));
  });
}

// Output result the Trigger task returns to the dispatcher.
export interface HyggloUiActionResult {
  ok: boolean;
  correlationId: string;
  status: "shadow_complete" | "live_complete" | "failed" | "duplicate";
  strategyUsed?: "recipe" | "ai_fallback" | "ai_first";
  llmCallCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  estCostUsd?: number;
  screenshotUrl?: string;
  hyggloConfirmationText?: string | null;
  errorMessage?: string;
}

export interface HyggloUiActionPayload {
  accountSlug: "dbcinema" | "leo";
  action: string;
  orderId?: string;
  args?: Record<string, unknown>;
  correlationId: string;
}

// Per-action strategy decision: recipe-first for stable text buttons,
// AI-first for dynamic form interactions (per Daniel's Wave 4.6 spec).
const STRATEGY_MAP: Record<string, "recipe" | "ai_first"> = {
  accept: "recipe",
  decline: "recipe",
  send_message: "recipe",
  mark_picked_up: "recipe",
  mark_returned: "recipe",
  leave_review: "recipe",
  remove_item: "recipe",
  add_item: "ai_first",
  apply_discount: "ai_first",
  change_owner_earnings: "ai_first",
};

// Grok 4.3 pricing (May 2026): $1.25/$2.50 per 1M tokens.
const GROK_INPUT_USD_PER_TOK = 1.25 / 1_000_000;
const GROK_OUTPUT_USD_PER_TOK = 2.5 / 1_000_000;

// Per-account concurrency 1. Trigger v4 keyed queue, applied via `queue` opt.
const accountQueue = queue({
  name: "hygglo-ui-action-account",
  concurrencyLimit: 1,
});

export const hyggloUiAction = task({
  id: "hygglo-ui-action",
  maxDuration: 180,
  machine: { preset: "medium-1x" },
  queue: accountQueue,
  run: async (payload: HyggloUiActionPayload, { ctx }): Promise<HyggloUiActionResult> => {
    const convexUrl = process.env.CONVEX_URL ?? "https://exciting-lion-29.convex.cloud";
    const convex = new ConvexHttpClient(convexUrl);
    const { correlationId, accountSlug, action } = payload;

    logger.log("dispatch", { correlationId, accountSlug, action });

    // 1) Idempotency.
    const existing = await convex.query(api.hygglo_ui.findByCorrelation, { correlationId });
    if (existing && (existing.status === "shadow_complete" || existing.status === "live_complete")) {
      logger.log("idempotency hit", { status: existing.status });
      return {
        ok: true,
        correlationId,
        status: "duplicate",
        strategyUsed: existing.strategyUsed,
        screenshotUrl: existing.screenshotUrl ?? undefined,
        hyggloConfirmationText: existing.hyggloConfirmationText,
      };
    }

    const strategy = STRATEGY_MAP[action] ?? "ai_first";

    await convex.mutation(api.hygglo_ui.insertActionAttempt, {
      correlationId,
      accountSlug,
      orderId: payload.orderId,
      action,
      args: payload.args ?? {},
      strategyUsed: strategy === "ai_first" ? "ai_first" : "recipe",
    });

    // 2) Load cookies.
    const sess = await convex.query(api.hygglo_ui.getSession, { accountSlug });
    if (!sess) {
      const err = `no hygglo session for ${accountSlug} — run scripts/bootstrap-hygglo-session.mjs first`;
      await convex.mutation(api.hygglo_ui.completeAction, {
        correlationId, status: "failed", errorMessage: err,
      });
      return { ok: false, correlationId, status: "failed", errorMessage: err };
    }

    // 3) Stage storage_state + screenshot dir.
    const workdir = await mkdtemp(join(tmpdir(), "hygglo-ui-"));
    const ssPath = join(workdir, "storage_state.json");
    const shotDir = join(workdir, "shots");
    await writeFile(ssPath, sess.storageStateJson, "utf8");

    // 4) Spawn Python runner.
    let pythonOut = "";
    try {
      await ensurePythonDeps();
      const result = await runPython(
        [JSON.stringify(payload), strategy, ssPath, shotDir],
        {
          HYGGLO_UI_SHADOW_MODE: process.env.HYGGLO_UI_SHADOW_MODE ?? "true",
          [`HYGGLO_UI_LIVE_${action.toUpperCase()}`]:
            process.env[`HYGGLO_UI_LIVE_${action.toUpperCase()}`] ?? "false",
          XAI_API_KEY: process.env.XAI_API_KEY ?? "",
          XAI_VISION_MODEL: process.env.XAI_VISION_MODEL ?? "grok-4.3",
          XAI_USE_VISION: process.env.XAI_USE_VISION ?? "true",
        },
      );
      if (result.code !== 0) {
        logger.warn("python non-zero exit", { code: result.code, stderr: result.stderr.slice(-2_000) });
      }
      pythonOut = result.stdout ?? "";
    } catch (err) {
      const msg = (err as Error).message;
      await convex.mutation(api.hygglo_ui.completeAction, {
        correlationId, status: "failed", errorMessage: `python.runScript: ${msg}`,
      });
      return { ok: false, correlationId, status: "failed", errorMessage: msg };
    }

    // 5) Parse RESULT:: line.
    const resultLine = pythonOut.split("\n").reverse().find((l) => l.startsWith("RESULT::"));
    if (!resultLine) {
      const err = "no RESULT line from python script";
      await convex.mutation(api.hygglo_ui.completeAction, {
        correlationId, status: "failed", errorMessage: err,
      });
      return { ok: false, correlationId, status: "failed", errorMessage: err };
    }
    const pyResult = JSON.parse(resultLine.slice("RESULT::".length));

    // 6) Upload screenshot to R2 (best-effort — log on fail, don't error).
    let screenshotUrl: string | undefined;
    let screenshotR2Key: string | undefined;
    if (pyResult.screenshotB64) {
      try {
        const { uploadShadowScreenshot } = await import("../lib/hygglo-ui-r2");
        const buf = Buffer.from(pyResult.screenshotB64, "base64");
        screenshotR2Key = `hygglo-shadow/${correlationId}.png`;
        screenshotUrl = await uploadShadowScreenshot(screenshotR2Key, buf);
      } catch (rerr) {
        logger.warn("r2 upload failed", { err: (rerr as Error).message });
      }
    }

    // 7) Cost accounting.
    const inTok = pyResult.input_tokens ?? 0;
    const outTok = pyResult.output_tokens ?? 0;
    const cost = inTok * GROK_INPUT_USD_PER_TOK + outTok * GROK_OUTPUT_USD_PER_TOK;

    const final: HyggloUiActionResult["status"] = pyResult.ok
      ? (pyResult.mode === "live" ? "live_complete" : "shadow_complete")
      : "failed";

    await convex.mutation(api.hygglo_ui.completeAction, {
      correlationId,
      status: final,
      strategyUsed: pyResult.strategyUsed ?? (strategy === "ai_first" ? "ai_first" : "recipe"),
      llmCallCount: pyResult.llm_call_count ?? 0,
      inputTokens: inTok,
      outputTokens: outTok,
      estCostUsd: cost,
      screenshotR2Key,
      screenshotUrl,
      errorMessage: pyResult.error,
      hyggloConfirmationText: pyResult.confirmationText ?? null,
    });

    if (cost > 0) {
      const isoDate = new Date().toISOString().slice(0, 10);
      await convex.mutation(api.hygglo_ui.addSpend, {
        accountSlug, isoDate, deltaUsd: cost,
      });
    }

    try {
      await convex.mutation(api.hygglo_ui.markSessionUsed, {
        accountSlug, runId: ctx.run.id,
      });
    } catch (sessErr) {
      logger.warn("markSessionUsed failed", { err: (sessErr as Error).message });
    }

    return {
      ok: pyResult.ok,
      correlationId,
      status: final,
      strategyUsed: pyResult.strategyUsed,
      llmCallCount: pyResult.llm_call_count,
      inputTokens: inTok,
      outputTokens: outTok,
      estCostUsd: cost,
      screenshotUrl,
      hyggloConfirmationText: pyResult.confirmationText,
      errorMessage: pyResult.error,
    };
  },
});
