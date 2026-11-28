import { describe, expect, it } from "vitest";
import { canonicalGenerationError, canonicalGenerationException, isCanonicalGenerationFailure, isFailedLabReply } from "./canonical_generation_error";

describe("canonical generation exception diagnostics", () => {
  it("keeps useful bounded error metadata without serializing the raw exception message", () => {
    const error = new Error("fetch failed");
    error.cause = new TypeError("socket details must not escape");
    const failure = canonicalGenerationException(error, "agent", 500, "endpoint_request");
    expect(failure).toMatchObject({
      http_status: 500,
      error_code: "generation_failed",
      transient: false,
      error_class: "Error",
      cause_class: "TypeError",
      failure_hint: "network_request_failed",
      diagnostic_stage: "endpoint_request",
    });
    expect(JSON.stringify(failure)).not.toContain("fetch failed");
    expect(JSON.stringify(failure)).not.toContain("socket details");
  });

  it("identifies a local persistence-schema failure without exposing document contents", () => {
    const error = new Error('Failed to insert or update a document in table "hygglo_messages" because it does not match the schema: Object contains extra field aliases');
    const failure = canonicalGenerationException(error, "context", 500, "response_processing");
    expect(failure).toMatchObject({
      error_code: "generation_failed",
      failure_hint: "database_schema_validation",
      diagnostic_stage: "response_processing",
    });
    expect(JSON.stringify(failure)).not.toContain("hygglo_messages");
    expect(JSON.stringify(failure)).not.toContain("aliases");
  });

  it("treats a canonical skipped generation as failed even if older code omitted the object", () => {
    expect(isCanonicalGenerationFailure({ status: "skipped", reason: "canonical_generation_error_error" })).toBe(true);
    expect(isCanonicalGenerationFailure({ status: "skipped", reason: "needs_human:invalid_model_output" })).toBe(true);
    expect(isCanonicalGenerationFailure({ status: "ok", reason: "canonical_generation_empty_reply" })).toBe(false);
    expect(isCanonicalGenerationFailure({ status: "skipped", reason: "needs_human:unverified" })).toBe(false);
    expect(isCanonicalGenerationFailure({ generation_error: { error_code: "generation_failed" } })).toBe(true);
  });

  it("distinguishes a saved failed no-reply run from a legitimate handoff", () => {
    expect(isFailedLabReply({generation_status:"complete",overall_status:"fail",draft_text:"",rubric_results:[{category:"generation_outcome",status:"fail"}]})).toBe(true);
    expect(isFailedLabReply({generation_status:"failed",draft_text:""})).toBe(true);
    expect(isFailedLabReply({generation_status:"complete",overall_status:"flag",draft_text:"",rubric_results:[]})).toBe(false);
    expect(isFailedLabReply({generation_status:"failed",overall_status:"fail",draft_text:"A visible handoff reply"})).toBe(false);
  });

  it("retains only bounded model and tool telemetry for an isolated Lab output failure", async () => {
    const failure = await canonicalGenerationError(new Response(JSON.stringify({
      error_code: "invalid_model_output",
      model_id: "google/gemini-3.7-flash",
      lab_trace: {
        token_usage: { prompt: 170802, completion: 3128, cached: 122202, cost: 0.0091 },
        tool_stats: {
          steps: 2, total: 1, byName: { lookup_pricing: 1 }, duplicates: 0, errors: 0,
          calls: [{ call_id: "call-1", name: "lookup_pricing", args: { thread_id: "__probe__safe", api_key: "hidden" },
            result: { quote: 50, authorization: "Bearer hidden" }, error: false }],
        },
      },
    }), { status: 502 }));

    expect(failure).toMatchObject({
      error_code: "invalid_model_output",
      model_id: "google/gemini-3.7-flash",
      lab_trace: {
        token_usage: { prompt: 170802, completion: 3128, cached: 122202, cost: 0.0091 },
        tool_stats: { steps: 2, total: 1, byName: { lookup_pricing: 1 }, calls: [{ name: "lookup_pricing", error: false }] },
      },
    });
    expect(JSON.stringify(failure)).not.toContain("hidden");
  });
});
