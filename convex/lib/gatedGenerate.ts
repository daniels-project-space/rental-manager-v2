/**
 * Phase 18.3 — `gatedGenerate*` wrappers (Convex runtime mirror).
 *
 * Mirror of `src/lib/gated-generate.ts` for Convex actions. Convex's runtime
 * is isolated from `src/` so we duplicate the wrapper. Same contract:
 *   • `isWithinUkQuietHours()` → return `{ skipped: true, reason: 'uk_quiet_hours' }`.
 *   • Otherwise call through to `generateObject` / `generateText` from `ai`.
 *   • `bypass: true` skips the gate (user-driven chat paths only).
 *   • Log model + ~prompt-tokens for later audit.
 *
 * Migration is a follow-up; raw `ai`-package call sites continue to work
 * until migrated. The Semgrep rule (`.semgrep/no-raw-llm-import.yml`)
 * warns on raw imports under scheduled paths.
 */
import {
  generateObject as rawGenerateObject,
  generateText as rawGenerateText,
} from "ai";
import type { FlexibleSchema } from "ai";
import { isWithinUkQuietHours } from "./quiet_hours";

// Match `ai`'s SCHEMA constraint exactly.
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

export type GatedContext = {
  /** Convex action name, cron job id, or workflow id. */
  source?: string;
  tag?: string;
};

export type GatedObjectOpts<T extends FlexibleSchema<unknown>> = Parameters<typeof rawGenerateObject<T>>[0] & {
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
    return Math.ceil(s.length / 4);
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

export async function gatedGenerateObject<T extends FlexibleSchema<unknown>>(
  opts: GatedObjectOpts<T>,
): Promise<GatedObjectResult<T>> {
  const { bypass, context, ...generateOpts } = opts;
  if (!bypass && isWithinUkQuietHours()) {
    return { skipped: true, reason: "uk_quiet_hours" };
  }
  logCall("object", { ...generateOpts, context });
  const result = await rawGenerateObject(generateOpts as Parameters<typeof rawGenerateObject<T>>[0]);
  return { skipped: false, result: result as GeneratedObjectResult<T> };
}

export async function gatedGenerateText(opts: GatedTextOpts): Promise<GatedTextResult> {
  const { bypass, context, ...generateOpts } = opts;
  if (!bypass && isWithinUkQuietHours()) {
    return { skipped: true, reason: "uk_quiet_hours" };
  }
  logCall("text", { ...generateOpts, context });
  const result = await rawGenerateText(generateOpts as Parameters<typeof rawGenerateText>[0]);
  return { skipped: false, result };
}
