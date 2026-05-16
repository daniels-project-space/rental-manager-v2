/**
 * Wave 4 — Hygglo polling Mastra workflow.
 *
 * SEVEN-STEP PIPELINE (per the wave spec):
 *   1. openRun          — insert a `polling_runs` row, status="running"
 *   2. fetchAndIngest   — drain unprocessed rows from `hygglo_inbox` table
 *                         (populated by the Trigger.dev poller or future VPS
 *                         scraper). For Wave 4 the existing Trigger.dev task
 *                         remains the source of truth — this workflow is
 *                         decoupled from raw scraping.
 *   3. diffAgainstConvex — compute the net-new reservation set
 *   4. enrichWithContext — for each new rental, attach renter + items
 *   5. aiDecisionAgent  — run the `ai-decision` Mastra agent per rental
 *   6. writeDecisions   — Convex internal mutation persists `ai_decision` rows
 *   7. refreshMVs       — with per-(mv × account) lock, call `internal.mv.*.refresh`
 *
 * Always ends with `completeRun` (Convex mutation) — whether success or error.
 *
 * IMPORTANT: This file is NEVER imported by the client bundle. It's invoked
 * from server-only contexts: a Next.js API route, the Trigger.dev task, or
 * direct manual invocation in `npx convex run ...` shells.
 *
 * READ_ONLY_MODE: this workflow only WRITES to Convex. It NEVER calls Hygglo.
 * Approvals on Hygglo (sendMessage / acceptOrder) are a future Wave 4.5 task.
 */
import "server-only";

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/../convex/_generated/api";
import type { Id } from "@/../convex/_generated/dataModel";
import { aiDecisionAgent } from "@/mastra/agents/ai-decision";
import { GROK_CHAT_MODEL } from "@/lib/ai-models";

const CONVEX_URL = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "";

const convex = () => new ConvexHttpClient(CONVEX_URL);

// ── Step schemas (shared across steps) ──────────────────────────

const runState = z.object({
  runId: z.string(),
  startedAt: z.number(),
  affectedAccounts: z.array(z.string()),
  newRentalsCount: z.number(),
  decisionsGeneratedCount: z.number(),
  mvRefreshesTriggered: z.array(z.string()),
});
type RunState = z.infer<typeof runState>;

const rentalCandidate = z.object({
  reservation_id: z.string(),       // Convex Id<"reservations">
  hygglo_order_id: z.string().optional(),
  account_slug: z.string(),
  renter_name: z.string().optional(),
  renter_id: z.string().optional(),
  items: z.array(z.object({ item_name: z.string() })),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  gross_paid_gbp: z.number().optional(),
});
type RentalCandidate = z.infer<typeof rentalCandidate>;

// ── Step 1: openRun ─────────────────────────────────────────────

const openRun = createStep({
  id: "openRun",
  inputSchema: z.object({}).passthrough(),
  outputSchema: runState,
  execute: async (): Promise<RunState> => {
    const c = convex();
    const runId = await c.mutation(api.polling_runs.startRun, {});
    return {
      runId: String(runId),
      startedAt: Date.now(),
      affectedAccounts: [],
      newRentalsCount: 0,
      decisionsGeneratedCount: 0,
      mvRefreshesTriggered: [],
    };
  },
});

// ── Step 2: fetchAndIngest ──────────────────────────────────────
// The Trigger.dev poller already writes directly into `reservations`.
// Wave 4's role: read any `hygglo_inbox` rows that are unprocessed and
// mark them processed (forward-compatible with a future VPS-scraper split).

const fetchAndIngest = createStep({
  id: "fetchAndIngest",
  inputSchema: runState,
  outputSchema: runState.extend({ inboxProcessed: z.number() }),
  execute: async ({ inputData }) => {
    const c = convex();
    const result = await c.query(api.hygglo_inbox.listUnprocessed, {
      paginationOpts: { numItems: 100, cursor: null },
    });
    const inbox = result.page;
    if (inbox.length > 0) {
      // Mark processed; no transformation yet (raw payloads only ever
      // arrive via the future VPS-scraper path).
      await c.mutation(api.hygglo_inbox.markProcessed, {
        ids: inbox.map((r: { _id: Id<"hygglo_inbox"> }) => r._id),
      });
    }
    return { ...inputData, inboxProcessed: inbox.length };
  },
});

// ── Step 3: diffAgainstConvex ───────────────────────────────────
// Find net-new pending_review reservations (i.e. orders Hygglo surfaced
// since the previous poll that DO NOT already have an ai_decision).

const diffAgainstConvex = createStep({
  id: "diffAgainstConvex",
  inputSchema: runState.extend({ inboxProcessed: z.number() }),
  outputSchema: runState.extend({ candidates: z.array(rentalCandidate) }),
  execute: async ({ inputData }) => {
    const c = convex();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candidates: any[] = await c.query(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (api as any).reservations.listPendingWithoutDecision,
      { limit: 50 },
    ).catch(() => []);

    const mapped: RentalCandidate[] = (candidates ?? []).map((r) => ({
      reservation_id: String(r._id),
      hygglo_order_id: r.hygglo_order_id,
      account_slug: r.account_slug ?? "unknown",
      renter_name: r.renter_name,
      renter_id: r.renter_id ? String(r.renter_id) : undefined,
      items: (r.items ?? []).map((i: { item_name: string }) => ({ item_name: i.item_name })),
      start_date: r.start_date,
      end_date: r.end_date,
      gross_paid_gbp: r.gross_paid_gbp,
    }));

    const affected = Array.from(new Set(mapped.map((m) => m.account_slug))).filter(Boolean);
    return {
      ...inputData,
      candidates: mapped,
      newRentalsCount: mapped.length,
      affectedAccounts: affected,
    };
  },
});

// ── Step 4: enrichWithContext ───────────────────────────────────
// For each candidate, build the prompt-context block.

const enrichedCandidate = rentalCandidate.extend({
  promptBlock: z.string(),
});
type Enriched = z.infer<typeof enrichedCandidate>;

const enrichWithContext = createStep({
  id: "enrichWithContext",
  inputSchema: runState.extend({ candidates: z.array(rentalCandidate) }),
  outputSchema: runState.extend({ enriched: z.array(enrichedCandidate) }),
  execute: async ({ inputData }) => {
    const enriched: Enriched[] = inputData.candidates.map((r) => ({
      ...r,
      promptBlock: [
        `--- NEW RENTAL REQUEST ---`,
        `hygglo_order_id: ${r.hygglo_order_id ?? "?"}`,
        `account: ${r.account_slug}`,
        `renter: ${r.renter_name ?? "Unknown"}`,
        `items: ${r.items.map((i) => i.item_name).join(", ") || "?"}`,
        `dates: ${r.start_date ?? "?"} → ${r.end_date ?? "?"}`,
        `total_gbp: ${r.gross_paid_gbp ?? "?"}`,
        ``,
        `Emit STRICTLY one fenced JSON object per the system prompt.`,
      ].join("\n"),
    }));
    return { ...inputData, enriched };
  },
});

// ── Step 5: aiDecisionAgent ─────────────────────────────────────

const decision = enrichedCandidate.extend({
  decision: z.enum(["accept", "decline", "ask_renter"]),
  confidence: z.number(),
  reasoning: z.string(),
  suggestedReply: z.string(),
  redFlags: z.array(z.string()),
});
type Decision = z.infer<typeof decision>;

function parseDecisionFromText(text: string): Omit<Decision, keyof RentalCandidate | "promptBlock"> | null {
  // Find fenced ```json ... ``` block; fall back to first { ... } object.
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    if (!obj || typeof obj !== "object") return null;
    const d = obj.decision;
    if (d !== "accept" && d !== "decline" && d !== "ask_renter") return null;
    return {
      decision: d,
      confidence: Number(obj.confidence ?? 0.5),
      reasoning: String(obj.reasoning ?? ""),
      suggestedReply: String(obj.suggestedReply ?? ""),
      redFlags: Array.isArray(obj.redFlags) ? obj.redFlags.map(String) : [],
    };
  } catch {
    return null;
  }
}

const runAiDecisionAgent = createStep({
  id: "aiDecisionAgent",
  inputSchema: runState.extend({ enriched: z.array(enrichedCandidate) }),
  outputSchema: runState.extend({ decisions: z.array(decision) }),
  execute: async ({ inputData }) => {
    const out: Decision[] = [];
    for (const c of inputData.enriched) {
      try {
        const res = await aiDecisionAgent.generate(c.promptBlock);
        const parsed = parseDecisionFromText(res.text ?? "");
        if (!parsed) {
          // Fallback: ask_renter so Daniel gets visibility on the broken case.
          out.push({
            ...c,
            decision: "ask_renter",
            confidence: 0,
            reasoning: "Agent output could not be parsed as JSON.",
            suggestedReply: "Hi! We received your request and will reply shortly with details.",
            redFlags: ["agent_output_unparseable"],
          });
        } else {
          out.push({ ...c, ...parsed });
        }
      } catch (err) {
        out.push({
          ...c,
          decision: "ask_renter",
          confidence: 0,
          reasoning: `Agent invocation failed: ${err instanceof Error ? err.message : String(err)}`,
          suggestedReply: "Hi! We received your request and will reply shortly with details.",
          redFlags: ["agent_invocation_error"],
        });
      }
    }
    return { ...inputData, decisions: out };
  },
});

// ── Step 6: writeDecisions ──────────────────────────────────────

const writeDecisions = createStep({
  id: "writeDecisions",
  inputSchema: runState.extend({ decisions: z.array(decision) }),
  outputSchema: runState,
  execute: async ({ inputData }) => {
    const c = convex();
    let written = 0;
    for (const d of inputData.decisions) {
      try {
        await c.mutation(api.ai_decisions.writeDecision, {
          reservation_id: d.reservation_id as unknown as Id<"reservations">,
          hygglo_order_id: d.hygglo_order_id,
          account_slug: d.account_slug,
          decision: d.decision,
          confidence: d.confidence,
          reasoning: d.reasoning,
          suggestedReply: d.suggestedReply,
          redFlags: d.redFlags,
          generatedByAgent: "ai-decision",
          modelId: GROK_CHAT_MODEL,
          pollingRunId: inputData.runId as unknown as Id<"polling_runs">,
        });
        written += 1;
      } catch (err) {
        console.error(`[hygglo_poll] writeDecision failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ...inputData, decisionsGeneratedCount: written };
  },
});

// ── Step 7: refreshMVs ──────────────────────────────────────────

// Wave 4 cycle scope: only the two poll-sensitive MVs and purchase-signals
// (which depends on new denial_records). The other 3 (top_earners, churn_risk,
// utilization) keep their cron cadence — touching them per-poll adds load
// with no freshness benefit.
const MV_NAMES_TO_REFRESH = [
  "daily_briefing",
  "upcoming_returns",
  "purchase_signals",
] as const;

const refreshMVs = createStep({
  id: "refreshMVs",
  inputSchema: runState,
  outputSchema: runState,
  execute: async ({ inputData }) => {
    const c = convex();
    const refreshed: string[] = [];
    const accountsToRefresh = inputData.affectedAccounts.length > 0
      ? inputData.affectedAccounts
      : [];  // No new rentals → skip MV refresh; crons handle the baseline.

    for (const account of accountsToRefresh) {
      for (const mvName of MV_NAMES_TO_REFRESH) {
        const lock = await c.mutation(api.mv_refresh_locks.tryAcquire, {
          mvName,
          account,
          lockedBy: inputData.runId,
        });
        if (!lock.acquired) {
          console.warn(`[hygglo_poll] lock-busy mv=${mvName} acct=${account} held_by=${lock.heldBy ?? "?"}`);
          continue;
        }
        try {
          await c.action(api.mv.refresh_dispatch.refreshOne, { mvName, account });
          refreshed.push(`${mvName}:${account}`);
        } catch (err) {
          console.error(`[hygglo_poll] refresh ${mvName}:${account} failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          await c.mutation(api.mv_refresh_locks.release, {
            mvName,
            account,
            lockedBy: inputData.runId,
          });
        }
      }
    }
    return { ...inputData, mvRefreshesTriggered: refreshed };
  },
});

// ── Workflow assembly ───────────────────────────────────────────

export const hyggloPollWorkflow = createWorkflow({
  id: "hygglo_poll",
  inputSchema: z.object({}),
  outputSchema: runState,
})
  .then(openRun)
  .then(fetchAndIngest)
  .then(diffAgainstConvex)
  .then(enrichWithContext)
  .then(runAiDecisionAgent)
  .then(writeDecisions)
  .then(refreshMVs)
  .commit();

/**
 * Top-level run() helper — used by:
 *   - The Next.js API route `app/api/workflows/hygglo-poll/route.ts` (Wave 4.5)
 *   - Manual `npx tsx src/mastra/workflows/hygglo_poll.ts` runs
 *   - The existing `poll-hygglo-inbox` Trigger.dev task (optional integration)
 *
 * Always closes the `polling_runs` row in a `finally` block so the audit row
 * never gets stuck in `running` state.
 */
export async function runHyggloPoll(): Promise<RunState | { ok: false; error: string }> {
  const c = convex();
  let state: RunState | null = null;
  try {
    const run = hyggloPollWorkflow.createRun();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (run as any).start({ inputData: {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state = ((result as any)?.result ?? (result as any)?.output ?? null) as RunState | null;
    if (state) {
      await c.mutation(api.polling_runs.completeRun, {
        runId: state.runId as unknown as Id<"polling_runs">,
        status: "ok",
        newRentalsCount: state.newRentalsCount,
        decisionsGeneratedCount: state.decisionsGeneratedCount,
        mvRefreshesTriggered: state.mvRefreshesTriggered,
        affectedAccounts: state.affectedAccounts,
      });
    }
    return state ?? { ok: false, error: "workflow_no_output" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (state?.runId) {
      await c.mutation(api.polling_runs.completeRun, {
        runId: state.runId as unknown as Id<"polling_runs">,
        status: "error",
        newRentalsCount: state.newRentalsCount,
        decisionsGeneratedCount: state.decisionsGeneratedCount,
        mvRefreshesTriggered: state.mvRefreshesTriggered,
        affectedAccounts: state.affectedAccounts,
        errorMessage: msg,
      });
    }
    return { ok: false, error: msg };
  }
}
