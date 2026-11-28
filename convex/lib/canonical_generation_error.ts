import {v} from "convex/values";
import {modelOutputDiagnosticsValidator,safeModelFailureMetadata,type LabGenerationTrace,type ModelOutputDiagnostics} from "./model_output_failure";
const codes = ["upstream_timeout", "upstream_throttled", "upstream_unavailable", "upstream_authorization", "cancelled", "generation_failed", "http_failure", "invalid_model_output"] as const;
type FailureCode = typeof codes[number];
const diagnosticStages = ["endpoint_configuration", "endpoint_request", "response_body", "response_json", "response_processing", "context_revalidation", "delivery_verification", "generation_telemetry"] as const;
export type GenerationDiagnosticStage = typeof diagnosticStages[number];
export type CanonicalGenerationError = { http_status: number; error_code: FailureCode; upstream_status?: number; transient: boolean; request_id?: string; error_class?: string; cause_class?: string; failure_hint?: string; error_frames?: string[]; diagnostic_stage?: GenerationDiagnosticStage; model_id?:string;cost_usd?:number;output_diagnostics?:ModelOutputDiagnostics;lab_trace?:LabGenerationTrace };

export const canonicalGenerationErrorValidator=v.object({http_status:v.number(),error_code:v.union(...codes.map(c=>v.literal(c))),upstream_status:v.optional(v.number()),transient:v.boolean(),request_id:v.optional(v.string()),error_class:v.optional(v.string()),cause_class:v.optional(v.string()),failure_hint:v.optional(v.string()),error_frames:v.optional(v.array(v.string())),diagnostic_stage:v.optional(v.union(...diagnosticStages.map(stage=>v.literal(stage)))),model_id:v.optional(v.string()),cost_usd:v.optional(v.number()),output_diagnostics:v.optional(modelOutputDiagnosticsValidator),lab_trace:v.optional(v.object({token_usage:v.optional(v.object({prompt:v.union(v.number(),v.null()),completion:v.union(v.number(),v.null()),cached:v.union(v.number(),v.null()),cost:v.union(v.number(),v.null())})),tool_stats:v.optional(v.any())}))});

function safeErrorClass(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : undefined;
}

function safeFailureHint(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = (value as { message?: unknown }).message;
  if (typeof message !== "string") return undefined;
  if (message === "VAULT_ACCESS_TOKEN is not configured") return "vault_token_missing";
  const vaultStatus = message.match(/^Vault fetch failed: (\d{3})$/);
  if (vaultStatus) return `vault_http_${vaultStatus[1]}`;
  if (/^OPENROUTER_API_KEY not found in vault service=openrouter$/.test(message)) return "vault_model_key_missing";
  if (/no endpoints|model not found|no such model/i.test(message)) return "model_unavailable";
  if (/unauthorized|invalid api key|authentication failed/i.test(message)) return "provider_authorization_failed";
  if (/rate limit|too many requests/i.test(message)) return "provider_rate_limited";
  if (/failed to insert or update a document in table\b[\s\S]{0,240}does not match the schema/i.test(message)) return "database_schema_validation";
  if (/fetch failed|network error|socket hang up/i.test(message)) return "network_request_failed";
  return undefined;
}

function safeErrorFrames(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stack = (value as { stack?: unknown }).stack;
  if (typeof stack !== "string") return undefined;
  const frames = stack.split("\n").slice(1, 5).flatMap((line) => {
    const match = line.trim().match(/^at (?:async )?([A-Za-z0-9_.$<>]+)/);
    return match ? [match[1].slice(0, 96)] : [];
  });
  return frames.length ? frames : undefined;
}

/** Never serialize upstream error objects: they may contain prompts, request
 * headers or credentials. Preserve only bounded diagnostic fields. */
export function generationFailure(error: unknown, phase: "context" | "agent") {
  let node: unknown = error;
  let upstream: number | undefined;
  let error_class: string | undefined;
  let cause_class: string | undefined;
  let failure_hint: string | undefined;
  let error_frames: string[] | undefined;
  let transient = false;
  const visited = new Set<unknown>();
  for (let depth = 0; node && typeof node === "object" && depth < 5 && !visited.has(node); depth++) {
    visited.add(node);
    const value = node as Record<string, unknown>;
    if (depth === 0) {
      error_class = safeErrorClass(value);
      failure_hint = safeFailureHint(value);
      error_frames = safeErrorFrames(value);
    } else if (!cause_class) cause_class = safeErrorClass(value);
    if (typeof value.statusCode === "number" && Number.isInteger(value.statusCode) && value.statusCode >= 400 && value.statusCode <= 599) {
      upstream = value.statusCode;
      transient = value.isRetryable === false ? false : [408, 429].includes(upstream) || upstream >= 500;
      break;
    }
    node = value.cause;
  }
  const code: FailureCode = upstream === 408 || upstream === 504 ? "upstream_timeout"
    : upstream === 429 ? "upstream_throttled" : upstream === 401 || upstream === 403 ? "upstream_authorization"
    : upstream && upstream >= 500 ? "upstream_unavailable"
    : error instanceof Error && error.name === "AbortError" ? "cancelled" : "generation_failed";
  return { error: phase === "context" ? "context_failed" : "agent_failed", error_code: code, upstream_status: upstream, transient, error_class, cause_class, failure_hint, error_frames };
}

/** Preserve bounded diagnostics when a generation throws outside an HTTP response. */
export function canonicalGenerationException(error: unknown, phase: "context" | "agent", httpStatus = 500, diagnosticStage?: GenerationDiagnosticStage): CanonicalGenerationError {
  const failure = generationFailure(error, phase);
  return {
    http_status: httpStatus,
    error_code: failure.error_code,
    upstream_status: failure.upstream_status,
    transient: failure.transient,
    error_class: failure.error_class,
    cause_class: failure.cause_class,
    failure_hint: failure.failure_hint,
    error_frames: failure.error_frames,
    diagnostic_stage: diagnosticStage,
  };
}

/** Canonical generation exceptions remain failures even when no reply object was returned. */
export function isCanonicalGenerationFailure(result: {
  status?: unknown;
  reason?: unknown;
  generation_error?: unknown;
}): boolean {
  return result.generation_error != null ||
    (result.status === "skipped" && typeof result.reason === "string" &&
      (result.reason.startsWith("canonical_generation_") || result.reason === "needs_human:invalid_model_output"));
}

/** A failed turn may have no canonical error object, but must never become a
 * completed conversation when its saved run has no reply and failed the
 * generation-outcome check. */
export function isFailedLabReply(run: {
  generation_status?: unknown;
  overall_status?: unknown;
  draft_text?: unknown;
  rubric_results?: unknown;
} | null | undefined): boolean {
  if (!run || (typeof run.draft_text === "string" && run.draft_text.trim())) return false;
  if (run.generation_status === "failed") return true;
  return run.overall_status === "fail" && Array.isArray(run.rubric_results) && run.rubric_results.some((result) =>
    result && typeof result === "object" &&
    (result as Record<string, unknown>).category === "generation_outcome" &&
    (result as Record<string, unknown>).status === "fail",
  );
}

export async function canonicalGenerationError(response: Response): Promise<CanonicalGenerationError> {
  let body: Record<string, unknown> = {};
  try { const value: unknown = await response.json(); if (value && typeof value === "object") body = value as Record<string, unknown>; } catch { /* HTML/proxy failures have no trusted body. */ }
  const error_code = codes.includes(body.error_code as FailureCode) ? body.error_code as FailureCode : "http_failure";
  const upstream_status = typeof body.upstream_status === "number" && Number.isInteger(body.upstream_status) && body.upstream_status >= 400 && body.upstream_status <= 599 ? body.upstream_status : undefined;
  const rawId = response.headers.get("x-vercel-id");
  const request_id = rawId && /^[a-zA-Z0-9_:.~-]{1,180}$/.test(rawId) ? rawId : undefined;
  const errorClass = typeof body.error_class === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(body.error_class) ? body.error_class : undefined;
  const causeClass = typeof body.cause_class === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(body.cause_class) ? body.cause_class : undefined;
  const failureHint = typeof body.failure_hint === "string" && /^[a-z0-9_]{1,64}$/.test(body.failure_hint) ? body.failure_hint : undefined;
  const errorFrames = Array.isArray(body.error_frames) ? body.error_frames.filter((frame): frame is string => typeof frame === "string" && /^[A-Za-z0-9_.$<>]{1,96}$/.test(frame)).slice(0, 4) : undefined;
  const diagnostic_stage = diagnosticStages.includes(body.diagnostic_stage as GenerationDiagnosticStage) ? body.diagnostic_stage as GenerationDiagnosticStage : undefined;
  return { http_status: response.status, error_code, upstream_status, transient: body.transient === true, request_id, error_class: errorClass, cause_class: causeClass, failure_hint: failureHint, error_frames: errorFrames, diagnostic_stage, ...(error_code==="invalid_model_output"?safeModelFailureMetadata(body):{}) };
}
