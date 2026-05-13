/**
 * Wave 4.6 — Hygglo UI surface (browser-use over Trigger).
 *
 * Mirror of `src/lib/hygglo-write.ts` but for browser-driven actions
 * that have NO Hygglo REST equivalent (discount, set-earnings,
 * mark-returned, leave-review, add/remove item).
 *
 * Sole entry point is `dispatchUiAction`. All callers route through
 * `src/mastra/data/ui_actions.ts` so the chat agent + future schedules
 * share the same code path.
 *
 * Safety stack (in order, all server-side):
 *   1. READ_ONLY_MODE — refuses without queuing. Same trip-wire as REST.
 *   2. UI cost guard  — per-account per-day $5 ceiling.
 *   3. Shadow mode    — Python runner stops before final submit unless
 *                       HYGGLO_UI_LIVE_<ACTION>=true.
 *   4. Idempotency    — Convex correlationId index in hygglo_ui_actions.
 *   5. Concurrency    — Trigger queue {concurrencyLimit:1} per account.
 */
import { tasks, runs } from "@trigger.dev/sdk/v3";
import type { HyggloUiActionPayload, HyggloUiActionResult } from "@/trigger/hygglo-ui-action";

export interface DispatchUiInput {
  accountSlug: "dbcinema" | "leo";
  action: string;
  orderId?: string;
  args?: Record<string, unknown>;
  /** Caller-provided idempotency key. Auto-derived when omitted. */
  correlationId?: string;
  /** Max ms to wait for the Trigger run; defaults to 150_000. */
  pollTimeoutMs?: number;
}

export type DispatchEnvelope =
  | { status: "skipped"; reason: string }
  | { status: "queued"; runId: string }
  | { status: "completed"; result: HyggloUiActionResult }
  | { status: "failed"; error: string };

function isReadOnly(): boolean {
  return (process.env.READ_ONLY_MODE ?? "").toLowerCase() === "true";
}

function deriveCorrelationId(input: DispatchUiInput): string {
  if (input.correlationId) return input.correlationId;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `ui-${input.action}-${input.accountSlug}-${input.orderId ?? "x"}-${ts}-${rand}`;
}

export async function dispatchUiAction(input: DispatchUiInput): Promise<DispatchEnvelope> {
  if (isReadOnly()) {
    return { status: "skipped", reason: "READ_ONLY_MODE active — UI action not dispatched" };
  }

  const correlationId = deriveCorrelationId(input);
  const payload: HyggloUiActionPayload = {
    accountSlug: input.accountSlug,
    action: input.action,
    orderId: input.orderId,
    args: input.args,
    correlationId,
  };

  try {
    const handle = await tasks.trigger<typeof import("@/trigger/hygglo-ui-action").hyggloUiAction>(
      "hygglo-ui-action",
      payload,
    );
    // Poll for completion (best-effort; caller may also re-poll via correlationId).
    const timeoutMs = input.pollTimeoutMs ?? 150_000;
    const deadline = Date.now() + timeoutMs;
    let lastStatus = "QUEUED";
    while (Date.now() < deadline) {
      const run = await runs.retrieve(handle.id);
      lastStatus = run.status;
      if (run.status === "COMPLETED") {
        return { status: "completed", result: run.output as HyggloUiActionResult };
      }
      if (run.status === "FAILED" || run.status === "CANCELED" || run.status === "TIMED_OUT" || run.status === "SYSTEM_FAILURE" || run.status === "CRASHED" || run.status === "EXPIRED") {
        const errMsg = (run as { error?: { message?: string } }).error?.message ?? run.status;
        return { status: "failed", error: `run ${run.status}: ${errMsg}` };
      }
      await new Promise((r) => setTimeout(r, 2_500));
    }
    void lastStatus;
    return { status: "queued", runId: handle.id };
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}
