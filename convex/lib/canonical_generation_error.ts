import {v} from "convex/values";
import {modelOutputDiagnosticsValidator,safeModelFailureMetadata,type ModelOutputDiagnostics} from "./model_output_failure";
const codes = ["upstream_timeout", "upstream_throttled", "upstream_unavailable", "upstream_authorization", "cancelled", "generation_failed", "http_failure", "invalid_model_output"] as const;
type FailureCode = typeof codes[number];
export type CanonicalGenerationError = { http_status: number; error_code: FailureCode; upstream_status?: number; transient: boolean; request_id?: string; error_class?: string; cause_class?: string; model_id?:string;cost_usd?:number;output_diagnostics?:ModelOutputDiagnostics };

export const canonicalGenerationErrorValidator=v.object({http_status:v.number(),error_code:v.union(...codes.map(c=>v.literal(c))),upstream_status:v.optional(v.number()),transient:v.boolean(),request_id:v.optional(v.string()),error_class:v.optional(v.string()),cause_class:v.optional(v.string()),model_id:v.optional(v.string()),cost_usd:v.optional(v.number()),output_diagnostics:v.optional(modelOutputDiagnosticsValidator)});

function safeErrorClass(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : undefined;
}

/** Never serialize upstream error objects: they may contain prompts, request
 * headers or credentials. Preserve only bounded diagnostic fields. */
export function generationFailure(error: unknown, phase: "context" | "agent") {
  let node: unknown = error;
  let upstream: number | undefined;
  let error_class: string | undefined;
  let cause_class: string | undefined;
  let transient = false;
  const visited = new Set<unknown>();
  for (let depth = 0; node && typeof node === "object" && depth < 5 && !visited.has(node); depth++) {
    visited.add(node);
    const value = node as Record<string, unknown>;
    if (depth === 0) error_class = safeErrorClass(value);
    else if (!cause_class) cause_class = safeErrorClass(value);
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
  return { error: phase === "context" ? "context_failed" : "agent_failed", error_code: code, upstream_status: upstream, transient, error_class, cause_class };
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
  return { http_status: response.status, error_code, upstream_status, transient: body.transient === true, request_id, error_class: errorClass, cause_class: causeClass, ...(error_code==="invalid_model_output"?safeModelFailureMetadata(body):{}) };
}
