/**
 * Phase 18.3 — `gatedGenerate*` wrappers (Node-side / Trigger.dev / Mastra).
 *
 * Goal: prevent scheduled LLM calls from firing during UK quiet hours
 * (02:00–08:30 Europe/London) without each call-site having to remember
 * to check `isWithinUkQuietHours()` first.
 *
 * Every scheduled / automation caller (Trigger.dev tasks, Mastra workflows,
 * Convex cron-driven actions) should import `generateObject` /
 * `generateText` from THIS module, NOT directly from `ai`.
 *
 * User-driven paths (chat) can pass `bypass: true`. Scheduled callers MUST
 * NOT pass bypass.
 *
 * The Semgrep rule `.semgrep/no-raw-llm-import.yml` enforces that raw
 * `ai`-package imports do not leak back into scheduled paths.
 *
 * Migration is intentionally a follow-up — this PR ships the wrapper module
 * only. Existing call sites continue to import from `ai` directly until
 * migrated.
 */
import {
  generateObject as rawGenerateObject,
  generateText as rawGenerateText,
} from "ai";
import type { FlexibleSchema } from "ai";
import { isWithinUkQuietHours } from "./quiet-hours";

// Re-export types so callers don't need to dual-import from `ai`.
// `ai`'s `generateObject` constrains SCHEMA to `FlexibleSchema<unknown>`,
// so our wrapper must thread the same bound.
export type GeneratedObjectResult<T extends FlexibleSchema<unknown>> = Awaited<ReturnType<typeof rawGenerateObject<T>>>;
export type GeneratedTextResult = Awaited<ReturnType<typeof rawGenerateText>>;

export type GatedSkip = {
  skipped: true;
  reason: "uk_quiet_hours";
};

export type GatedObjectOk<T extends FlexibleSchema<unknown>> = {
  skipped: false;
  result: GeneratedObjectResult<T>;
};

export type GatedTextOk = {
  skipped: false;
  result: GeneratedTextResult;
};

export type GatedObjectResult<T extends FlexibleSchema<unknown>> = GatedSkip | GatedObjectOk<T>;
export type GatedTextResult = GatedSkip | GatedTextOk;

/** Tags help log-audit which scheduled context invoked the LLM. */
export type GatedContext = {
  /** Trigger.dev task slug, Mastra workflow id, or cron name. */
  source?: string;
  /** Free-form short tag (e.g. "denial-canonicalizer"). */
  tag?: string;
};

export type GatedObjectOpts<T extends FlexibleSchema<unknown>> = Parameters<typeof rawGenerateObject<T>>[0] & {
  /** Pass true ONLY for user-driven paths (chat). */
  bypass?: boolean;
  context?: GatedContext;
};

export type GatedTextOpts = Parameters<typeof rawGenerateText>[0] & {
  bypass?: boolean;
  context?: GatedContext;
};

function approxPromptTokens(input: unknown): number {
  try {
    const s = typeof input === "string" ? input : JSON.stringify(input ?? "");
    return Math.ceil(s.length / 4); // crude ~4 chars/token approximation
  } catch {
    return 0;
  }
}

function logCall(
  kind: "object" | "text",
  opts: { model?: unknown; prompt?: unknown; messages?: unknown; context?: GatedContext },
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const modelId = (opts.model as any)?.modelId ?? (opts.model as any)?.id ?? "unknown";
  const tokens = approxPromptTokens(opts.prompt ?? opts.messages);
  const ctxTag = opts.context?.tag ?? opts.context?.source ?? "untagged";
  // eslint-disable-next-line no-console
  console.log(
    `[gated-generate:${kind}] model=${modelId} ~promptTokens=${tokens} context=${ctxTag}`,
  );
}

/**
 * Quiet-hours-gated `generateObject` wrapper.
 * Returns `{ skipped: true }` during UK quiet hours unless `bypass` is set.
 */
export async function gatedGenerateObject<T extends FlexibleSchema<unknown>>(
  opts: GatedObjectOpts<T>,
): Promise<GatedObjectResult<T>> {
  const { bypass, context, ...generateOpts } = opts;
  if (!bypass && isWithinUkQuietHours()) {
    return { skipped: true, reason: "uk_quiet_hours" };
  }
  logCall("object", { ...generateOpts, context });
  // Cast: spreading the validated Parameters tuple preserves shape.
  const result = await rawGenerateObject(generateOpts as Parameters<typeof rawGenerateObject<T>>[0]);
  return { skipped: false, result: result as GeneratedObjectResult<T> };
}

/**
 * Quiet-hours-gated `generateText` wrapper.
 * Returns `{ skipped: true }` during UK quiet hours unless `bypass` is set.
 */
export async function gatedGenerateText(opts: GatedTextOpts): Promise<GatedTextResult> {
  const { bypass, context, ...generateOpts } = opts;
  if (!bypass && isWithinUkQuietHours()) {
    return { skipped: true, reason: "uk_quiet_hours" };
  }
  logCall("text", { ...generateOpts, context });
  const result = await rawGenerateText(generateOpts as Parameters<typeof rawGenerateText>[0]);
  return { skipped: false, result };
}
