const codes = ["upstream_timeout", "upstream_throttled", "upstream_unavailable", "upstream_authorization", "cancelled", "generation_failed", "http_failure"] as const;
type FailureCode = typeof codes[number];
export type CanonicalGenerationError = { http_status: number; error_code: FailureCode; upstream_status?: number; transient: boolean; request_id?: string };

/** Never serialize upstream error objects: they may contain prompts, request
 * headers or credentials. Preserve only bounded diagnostic fields. */
export function generationFailure(error: unknown, phase: "context" | "agent") {
  let node: unknown = error;
  let upstream: number | undefined;
  let transient = false;
  const visited = new Set<unknown>();
  for (let depth = 0; node && typeof node === "object" && depth < 5 && !visited.has(node); depth++) {
    visited.add(node);
    const value = node as Record<string, unknown>;
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
  return { error: phase === "context" ? "context_failed" : "agent_failed", error_code: code, upstream_status: upstream, transient };
}

export async function canonicalGenerationError(response: Response): Promise<CanonicalGenerationError> {
  let body: Record<string, unknown> = {};
  try { const value: unknown = await response.json(); if (value && typeof value === "object") body = value as Record<string, unknown>; } catch { /* HTML/proxy failures have no trusted body. */ }
  const error_code = codes.includes(body.error_code as FailureCode) ? body.error_code as FailureCode : "http_failure";
  const upstream_status = typeof body.upstream_status === "number" && Number.isInteger(body.upstream_status) && body.upstream_status >= 400 && body.upstream_status <= 599 ? body.upstream_status : undefined;
  const rawId = response.headers.get("x-vercel-id");
  const request_id = rawId && /^[a-zA-Z0-9_:.~-]{1,180}$/.test(rawId) ? rawId : undefined;
  return { http_status: response.status, error_code, upstream_status, transient: body.transient === true, request_id };
}
