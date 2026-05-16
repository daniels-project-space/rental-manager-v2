/**
 * Wave 4.6 / Phase 3c — Hygglo UI action Trigger task.
 *
 * Single entry point for every browser-driven Hygglo mutation. It is
 * dispatched by `src/mastra/data/ui_actions.ts` (via the chat tools)
 * and reuses cookies captured by `scripts/bootstrap-hygglo-session.mjs`.
 *
 * Lifecycle per run:
 *   1. Idempotency check (correlationId → existing row?)
 *   2. READ_ONLY_MODE gate (refuses without queuing)
 *   3. Load storage_state cookies for the account from Convex
 *   4. Branch by `USE_STAGEHAND` env flag:
 *        - ON  → Stagehand (Browserbase cloud session, natural-language
 *                act() + structured extract({zodSchema}))
 *        - OFF → legacy Python + Playwright + browser-use runner (FALLBACK)
 *   5. Upload screenshot to R2 (best-effort)
 *   6. Write the completion row + add cost to ledger
 *
 * Concurrency: keyed queue ensures only one browser-use run per account
 * at a time so cookies stay valid and we don't trip Hygglo rate limits.
 */
import { logger, task, queue } from "@trigger.dev/sdk/v3";
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { api } from "../../convex/_generated/api";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  getStagehand,
  releaseStagehand,
  isStagehandEnabled,
} from "../lib/browserbase";

// ── Legacy Playwright/Python runner (FALLBACK) ──────────────────────────────

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

// ── Public types (DO NOT change shape — external callers depend on it) ─────

// Output result the Trigger task returns to the dispatcher.
export interface HyggloUiActionResult {
  ok: boolean;
  correlationId: string;
  status: "shadow_complete" | "live_complete" | "failed" | "duplicate";
  strategyUsed?: "recipe" | "ai_fallback" | "ai_first" | "stagehand";
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

// READ_ONLY_MODE master safety rail (same trip-wire as src/lib/hygglo-write.ts).
function isReadOnly(): boolean {
  return (process.env.READ_ONLY_MODE ?? "").toLowerCase() === "true";
}

// ── Stagehand action mapping (Phase 3c, USE_STAGEHAND=1) ────────────────────

/**
 * Structured-extract schema for any Hygglo order page after a UI mutation.
 * Used by Stagehand's `extract({ schema })` to return typed data instead of
 * scraping with brittle CSS selectors.
 */
const HyggloOrderExtract = z.object({
  orderId: z.string().optional(),
  renterName: z.string().optional(),
  confirmationText: z.string().optional(),
  visibleStatus: z.string().optional(),
});
export type HyggloOrderExtract = z.infer<typeof HyggloOrderExtract>;

/**
 * Natural-language instruction map for each Hygglo UI action. Stagehand's
 * `act()` resolves these to selectors at runtime via its LLM — so we don't
 * carry brittle CSS in our codebase. Order id is included in the URL we
 * navigate to before calling `act()`.
 */
const STAGEHAND_INSTRUCTIONS: Record<string, string> = {
  accept: "click the Accept Order button and confirm if a dialog appears",
  decline: "click the Decline Order button and confirm if a dialog appears",
  send_message: "open the chat box, type the message from args.text, then submit",
  mark_picked_up: "click the 'Mark as Picked Up' button and confirm",
  mark_returned: "click the 'Mark as Returned' button and confirm",
  leave_review: "open the review form, set the star rating from args.rating, paste args.text into the comment field, then submit",
  remove_item: "in the order's item list, find the row matching args.itemName and click its remove or trash icon, then confirm",
  add_item: "open the add-item menu, search for args.itemName, select the matching result, set quantity to args.quantity, then confirm",
  apply_discount: "open the discount form, enter args.amount as the discount in SEK, then apply",
  change_owner_earnings: "open the owner-earnings editor, replace the value with args.amount, then save",
};

const HYGGLO_ORDER_URL_BASE = "https://hygglo.se/my/orders";

async function runStagehand(args: {
  payload: HyggloUiActionPayload;
  storageStateJson: string;
}): Promise<{
  ok: boolean;
  mode: "shadow" | "live";
  extracted?: HyggloOrderExtract;
  screenshotB64?: string;
  error?: string;
}> {
  const { payload } = args;
  const { accountSlug, action, orderId } = payload;
  const sh = await getStagehand(accountSlug);

  // 1) Inject cookies from the saved storage_state so we're logged in.
  try {
    const parsed = JSON.parse(args.storageStateJson) as { cookies?: unknown[] };
    const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
    if (cookies.length) {
      const ctx = (sh as unknown as { context?: { addCookies?: (c: unknown[]) => Promise<void> } }).context;
      if (ctx?.addCookies) {
        await ctx.addCookies(cookies);
      }
    }
  } catch (err) {
    logger.warn("stagehand cookie inject failed", { err: (err as Error).message });
  }

  const page = (sh as unknown as { page: {
    goto: (u: string) => Promise<unknown>;
    act: (i: string) => Promise<unknown>;
    extract: (o: { instruction: string; schema: z.ZodTypeAny }) => Promise<unknown>;
    screenshot: (o?: { fullPage?: boolean }) => Promise<Buffer>;
  } }).page;

  const targetUrl = orderId
    ? `${HYGGLO_ORDER_URL_BASE}/${encodeURIComponent(orderId)}`
    : `${HYGGLO_ORDER_URL_BASE}`;
  await page.goto(targetUrl);

  // 2) Live-mode gate. Shadow mode = navigate + extract only, no click.
  const liveFlag = process.env[`HYGGLO_UI_LIVE_${action.toUpperCase()}`]?.toLowerCase() === "true";
  const shadowMode = (process.env.HYGGLO_UI_SHADOW_MODE ?? "true").toLowerCase() !== "false";
  const mode: "shadow" | "live" = (!shadowMode && liveFlag) ? "live" : "shadow";

  let extracted: HyggloOrderExtract | undefined;
  let screenshotB64: string | undefined;
  let runErr: string | undefined;

  try {
    if (mode === "live") {
      const instruction = STAGEHAND_INSTRUCTIONS[action];
      if (!instruction) {
        runErr = `no stagehand instruction mapped for action="${action}"`;
      } else {
        // Pass args as JSON into the instruction so Stagehand's LLM can resolve
        // values like args.text / args.amount / args.rating without us
        // hard-coding selectors.
        const argsJson = JSON.stringify(payload.args ?? {});
        await page.act(`${instruction}. args=${argsJson}`);
      }
    }

    // Always extract post-state — gives us the confirmation text for the
    // completeAction row, regardless of shadow vs. live.
    const ex = await page.extract({
      instruction: "extract the visible order id, renter name, any confirmation message, and visible order status",
      schema: HyggloOrderExtract,
    });
    extracted = HyggloOrderExtract.parse(ex);

    // Screenshot for the audit trail.
    const buf = await page.screenshot({ fullPage: false });
    screenshotB64 = Buffer.from(buf).toString("base64");
  } catch (err) {
    runErr = `stagehand ${mode} failure: ${(err as Error).message}`;
  }

  return {
    ok: !runErr,
    mode,
    extracted,
    screenshotB64,
    error: runErr,
  };
}

// ── Trigger queue + task ────────────────────────────────────────────────────

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
    const convexUrl = process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";
    const convex = new ConvexHttpClient(convexUrl);
    const { correlationId, accountSlug, action } = payload;

    logger.log("dispatch", {
      correlationId,
      accountSlug,
      action,
      stagehand: isStagehandEnabled(),
      readOnly: isReadOnly(),
    });

    // 1) READ_ONLY_MODE gate — same master safety rail as hygglo-write.ts.
    //    Refuse without queuing; caller records the intent upstream.
    if (isReadOnly()) {
      const err = "READ_ONLY_MODE active — hyggloUiAction refused (master safety rail)";
      logger.warn(err, { correlationId });
      return {
        ok: false,
        correlationId,
        status: "failed",
        errorMessage: err,
      };
    }

    // 2) Idempotency.
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
    const useStagehand = isStagehandEnabled();
    const recordedStrategy: "recipe" | "ai_first" | "stagehand" = useStagehand
      ? "stagehand"
      : (strategy === "ai_first" ? "ai_first" : "recipe");

    await convex.mutation(api.hygglo_ui.insertActionAttempt, {
      correlationId,
      accountSlug,
      orderId: payload.orderId,
      action,
      args: payload.args ?? {},
      strategyUsed: recordedStrategy === "stagehand" ? "ai_first" : recordedStrategy,
    });

    // 3) Load cookies.
    const sess = await convex.query(api.hygglo_ui.getSession, { accountSlug });
    if (!sess) {
      const err = `no hygglo session for ${accountSlug} — run scripts/bootstrap-hygglo-session.mjs first`;
      await convex.mutation(api.hygglo_ui.completeAction, {
        correlationId, status: "failed", errorMessage: err,
      });
      return { ok: false, correlationId, status: "failed", errorMessage: err };
    }

    // 4) Branch: Stagehand vs. legacy Playwright/Python.
    let resultOk = false;
    let resultMode: "shadow" | "live" = "shadow";
    let screenshotB64: string | undefined;
    let confirmationText: string | null = null;
    let llmCallCount = 0;
    let inTok = 0;
    let outTok = 0;
    let runErrMsg: string | undefined;

    if (useStagehand) {
      // ── Stagehand path (Phase 3c) ─────────────────────────────────────
      try {
        const sh = await runStagehand({ payload, storageStateJson: sess.storageStateJson });
        resultOk = sh.ok;
        resultMode = sh.mode;
        screenshotB64 = sh.screenshotB64;
        confirmationText = sh.extracted?.confirmationText ?? null;
        runErrMsg = sh.error;
        // Stagehand's own LLM accounting (gpt-4o family) isn't routed through
        // our Grok ledger — leave tokens at 0 and rely on Browserbase
        // dashboard for session cost. We'll wire a usage hook in a follow-up.
      } catch (err) {
        runErrMsg = `stagehand: ${(err as Error).message}`;
      } finally {
        await releaseStagehand(accountSlug);
      }
    } else {
      // ── Legacy Playwright/Python path (FALLBACK) ──────────────────────
      const workdir = await mkdtemp(join(tmpdir(), "hygglo-ui-"));
      const ssPath = join(workdir, "storage_state.json");
      const shotDir = join(workdir, "shots");
      await writeFile(ssPath, sess.storageStateJson, "utf8");
      void shotDir;

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

      const resultLine = pythonOut.split("\n").reverse().find((l) => l.startsWith("RESULT::"));
      if (!resultLine) {
        const err = "no RESULT line from python script";
        await convex.mutation(api.hygglo_ui.completeAction, {
          correlationId, status: "failed", errorMessage: err,
        });
        return { ok: false, correlationId, status: "failed", errorMessage: err };
      }
      const pyResult = JSON.parse(resultLine.slice("RESULT::".length));
      resultOk = !!pyResult.ok;
      resultMode = pyResult.mode === "live" ? "live" : "shadow";
      screenshotB64 = pyResult.screenshotB64;
      confirmationText = pyResult.confirmationText ?? null;
      llmCallCount = pyResult.llm_call_count ?? 0;
      inTok = pyResult.input_tokens ?? 0;
      outTok = pyResult.output_tokens ?? 0;
      runErrMsg = pyResult.error;
    }

    // 5) Upload screenshot to R2 (best-effort).
    let screenshotUrl: string | undefined;
    let screenshotR2Key: string | undefined;
    if (screenshotB64) {
      try {
        const { uploadShadowScreenshot } = await import("../lib/hygglo-ui-r2");
        const buf = Buffer.from(screenshotB64, "base64");
        screenshotR2Key = `hygglo-shadow/${correlationId}.png`;
        screenshotUrl = await uploadShadowScreenshot(screenshotR2Key, buf);
      } catch (rerr) {
        logger.warn("r2 upload failed", { err: (rerr as Error).message });
      }
    }

    // 6) Cost accounting (legacy path only; Stagehand cost is billed by
    //    Browserbase per-session, see lib/browserbase.ts header).
    const cost = inTok * GROK_INPUT_USD_PER_TOK + outTok * GROK_OUTPUT_USD_PER_TOK;

    const final: HyggloUiActionResult["status"] = resultOk
      ? (resultMode === "live" ? "live_complete" : "shadow_complete")
      : "failed";

    await convex.mutation(api.hygglo_ui.completeAction, {
      correlationId,
      status: final,
      strategyUsed: recordedStrategy === "stagehand" ? "ai_first" : recordedStrategy,
      llmCallCount,
      inputTokens: inTok,
      outputTokens: outTok,
      estCostUsd: cost,
      screenshotR2Key,
      screenshotUrl,
      errorMessage: runErrMsg,
      hyggloConfirmationText: confirmationText ?? undefined,
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
      ok: resultOk,
      correlationId,
      status: final,
      strategyUsed: recordedStrategy,
      llmCallCount,
      inputTokens: inTok,
      outputTokens: outTok,
      estCostUsd: cost,
      screenshotUrl,
      hyggloConfirmationText: confirmationText,
      errorMessage: runErrMsg,
    };
  },
});
