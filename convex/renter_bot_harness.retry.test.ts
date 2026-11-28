import { describe, expect, it } from "vitest";
import { insertRun } from "./renter_bot_harness";
import { draftEvidenceValidator } from "./lib/renter_draft_evidence";

describe("Lab harness run retries", () => {
  it("stores the travel adjustment receipt emitted by the accepted Lab offer", () => {
    const price = (draftEvidenceValidator as any).json.value.prices.fieldType.value.value;
    expect(price.travel_adjustment).toMatchObject({
      optional: true,
      fieldType: {
        type: "object",
        value: {
          base_total_gbp: { fieldType: { type: "number" }, optional: false },
          amount_gbp: { fieldType: { type: "number" }, optional: false },
          total_gbp: { fieldType: { type: "number" }, optional: false },
        },
      },
    });
  });

  it("replaces a prior failed attempt instead of retaining stale failure diagnostics", async () => {
    const existing = {
      _id: "run:1",
      _creationTime: 1,
      lab_turn_id: "turn-retry-1",
      session_thread_id: "__probe__session",
      account_slug: "dbcinema",
      generation_status: "failed",
      failure_reason: "canonical_generation_http_500",
      generation_error: { error_code: "upstream_unavailable", http_status: 503, transient: true },
      candidate_text: "old failed candidate",
      draft_text: "",
    };
    const messageId = "message-retry-123";
    const leaseToken = "lease-retry-123";
    const activeTurn = {
      turn_id: "turn-retry-1", thread_id: "__probe__session", account_slug: "dbcinema",
      renter_message_id: messageId, lease_token: leaseToken, status: "running",
    };
    const latestMessage = {
      message_id: messageId, account_slug: "dbcinema", thread_id: "__probe__session",
      sender: "renter", body_text: "Verified answer please",
    };
    let stored: Record<string, unknown> = existing;
    const ctx = {
      db: {
        query: (table: string) => ({
          withIndex: (_index: string, select: (q: { eq: (field: string, value: string) => unknown }) => void) => {
            const filters: Record<string, string> = {};
            const q = { eq: (field: string, value: string) => { filters[field] = value; return q; } };
            select(q);
            const first = async () => {
              if (table === "renter_bot_harness_runs" && stored.lab_turn_id === filters.lab_turn_id) return stored;
              if (table === "renter_bot_lab_turns" && activeTurn.turn_id === filters.turn_id) return activeTurn;
              if (table === "hygglo_messages" && latestMessage.thread_id === filters.thread_id) return latestMessage;
              return null;
            };
            return { first, order: () => ({ first }) };
          },
        }),
        replace: async (id: string, value: Record<string, unknown>) => {
          stored = { ...value, _id: id, _creationTime: 1 };
        },
      },
    };

    const result = await (insertRun as unknown as { _handler(ctx: unknown, args: unknown): Promise<string> })._handler(ctx, {
      expected_message_id: messageId,
      lab_lease_token: leaseToken,
      lab_turn_id: "turn-retry-1",
      session_thread_id: "__probe__session",
      account_slug: "dbcinema",
      generation_status: "complete",
      draft_text: "Verified answer",
      model_id: "google/gemini-3.7-flash",
      filter_violations: [],
      rubric_results: [],
      overall_status: "pass",
      triggered_by: "lab_ui_manual",
      run_at: 2,
    });

    expect(result).toBe("run:1");
    expect(stored).toMatchObject({ generation_status: "complete", draft_text: "Verified answer" });
    expect(stored).not.toHaveProperty("failure_reason");
    expect(stored).not.toHaveProperty("generation_error");
    expect(stored).not.toHaveProperty("candidate_text");
  });
});
