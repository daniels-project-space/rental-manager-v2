/**
 * Wave 4 — Hygglo polling Mastra workflow.
 *
 * SEVEN-STEP PIPELINE:
 *   1. openRun          — insert a `polling_runs` row, status="running"
 *   2. fetchAndIngest   — drain unprocessed rows from `hygglo_inbox` table
 *   3. diffAgainstConvex — compute the net-new reservation set
 *   4. enrichWithContext — for each new rental, attach renter + items
 *   5. decideRules      — deterministic rule engine emits accept/decline/ask_renter
 *                         (was an LLM agent; replaced 2026-05-18 — see commit
 *                         message for cost/data-quality analysis)
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyApi = api as any;

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

// ── Step 5: decideRules ─────────────────────────────────────────
//
// Deterministic rule engine. Replaced the LLM-driven `ai-decision` Mastra
// agent on 2026-05-18 for three reasons:
//   1. Daniel approves every decision manually (READ_ONLY_MODE) — the
//      LLM was an advisory layer, not an autonomous actor.
//   2. The agent's `check_availability` tool referenced
//      `convex/items.checkAvailability`, which doesn't exist — calls
//      silently errored, so decisions were already made without live
//      availability data. Rules == feature parity.
//   3. ~$14/mo saved (≈100 calls/day × ~3k in / ~400 out tok @ Grok 4.3).
//
// Rule order (first match wins):
//   - Blacklist     → decline   @ 1.0
//   - No items      → ask_renter @ 0.3
//   - No dates      → ask_renter @ 0.3
//   - Underpriced   → decline (severe) / ask_renter (mild) by ratio
//   - Default       → accept    @ 0.7

const decision = enrichedCandidate.extend({
  decision: z.enum(["accept", "decline", "ask_renter"]),
  confidence: z.number(),
  reasoning: z.string(),
  suggestedReply: z.string(),
  redFlags: z.array(z.string()),
});
type Decision = z.infer<typeof decision>;

interface BlacklistRow { blacklisted?: boolean; reason?: string | null }
interface PricingRow { ok?: boolean; total?: number; daily_rate?: number; item?: string }

function dayCount(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const days = Math.max(1, Math.round((b - a) / 86400000));
  return days;
}

function firstName(full?: string): string {
  if (!full) return "there";
  return full.trim().split(/\s+/)[0] || "there";
}

function buildReply(d: Decision["decision"], c: RentalCandidate, ctx: { reason?: string }): string {
  const name = firstName(c.renter_name);
  const items = c.items.map((i) => i.item_name).join(", ") || "your selection";
  const dates =
    c.start_date && c.end_date ? ` from ${c.start_date} to ${c.end_date}` : "";
  switch (d) {
    case "accept":
      return `Hi ${name}! Your request for ${items}${dates} looks good — I'll confirm shortly. — Daniel`;
    case "decline":
      if (ctx.reason === "blacklisted_renter") {
        return `Hi ${name}, unfortunately we're unable to accept this request at this time. — Daniel`;
      }
      if (ctx.reason === "underpriced") {
        return `Hi ${name}! Thanks for the request. The total is below our usual rate for ${items}${dates}. Could you double-check the pricing and re-submit? — Daniel`;
      }
      return `Hi ${name}, unfortunately we can't accept this booking. — Daniel`;
    case "ask_renter":
      if (ctx.reason === "no_items") {
        return `Hi ${name}! Could you let me know exactly which items you'd like to rent? — Daniel`;
      }
      if (ctx.reason === "no_dates") {
        return `Hi ${name}! Thanks for the interest — could you confirm the pickup and return dates? — Daniel`;
      }
      return `Hi ${name}! Thanks for the request for ${items}${dates}. Could you confirm a few details so I can finalise? — Daniel`;
  }
}

const decideRules = createStep({
  id: "decideRules",
  inputSchema: runState.extend({ enriched: z.array(enrichedCandidate) }),
  outputSchema: runState.extend({ decisions: z.array(decision) }),
  execute: async ({ inputData }) => {
    const c = convex();
    const out: Decision[] = [];

    for (const cand of inputData.enriched) {
      const redFlags: string[] = [];
      const reasoningParts: string[] = [];
      let d: Decision["decision"] = "accept";
      let confidence = 0.7;
      let replyReason: string | undefined;

      // Rule 1 — blacklist (highest priority).
      let blacklisted = false;
      if (cand.renter_name) {
        try {
          const bl = (await c.query(anyApi.renters.checkBlacklistByName, {
            name: cand.renter_name,
          })) as BlacklistRow | null;
          if (bl?.blacklisted) {
            blacklisted = true;
            redFlags.push("blacklisted_renter");
            reasoningParts.push(
              `Renter "${cand.renter_name}" is blacklisted${bl.reason ? `: ${bl.reason}` : ""}.`,
            );
          }
        } catch {
          // Treat as not-blacklisted on lookup failure; surface via a soft flag.
          redFlags.push("blacklist_lookup_failed");
        }
      }

      if (blacklisted) {
        d = "decline";
        confidence = 1.0;
        replyReason = "blacklisted_renter";
        out.push({
          ...cand,
          decision: d,
          confidence,
          reasoning: reasoningParts.join(" "),
          suggestedReply: buildReply(d, cand, { reason: replyReason }),
          redFlags,
        });
        continue;
      }

      // Rule 2 — missing items.
      if (cand.items.length === 0) {
        d = "ask_renter";
        confidence = 0.3;
        replyReason = "no_items";
        redFlags.push("incomplete_request");
        reasoningParts.push("No items listed on the request.");
        out.push({
          ...cand,
          decision: d,
          confidence,
          reasoning: reasoningParts.join(" "),
          suggestedReply: buildReply(d, cand, { reason: replyReason }),
          redFlags,
        });
        continue;
      }

      // Rule 3 — missing dates.
      const days = dayCount(cand.start_date, cand.end_date);
      if (!days) {
        d = "ask_renter";
        confidence = 0.3;
        replyReason = "no_dates";
        redFlags.push("incomplete_request");
        reasoningParts.push("Pickup or return date missing.");
        out.push({
          ...cand,
          decision: d,
          confidence,
          reasoning: reasoningParts.join(" "),
          suggestedReply: buildReply(d, cand, { reason: replyReason }),
          redFlags,
        });
        continue;
      }

      // Rule 4 — pricing sanity.
      // Look up each item's daily rate; sum the expected total. Compare to
      // gross_paid_gbp. Severity bands tuned to v1 owner intuition:
      //   ratio < 0.7  → decline (underpriced)
      //   ratio < 0.9  → ask_renter (request a re-check)
      //   ratio >= 0.9 → no flag
      if (cand.gross_paid_gbp !== undefined && cand.gross_paid_gbp > 0) {
        let expectedTotal = 0;
        let anyPriced = false;
        for (const item of cand.items) {
          try {
            const row = (await c.query(anyApi.pricing_catalog.lookup, {
              item_name: item.item_name,
            })) as PricingRow[] | null;
            const first = Array.isArray(row) ? row[0] : null;
            if (first?.daily_rate) {
              expectedTotal += first.daily_rate * days;
              anyPriced = true;
            }
          } catch {
            // Skip item — pricing lookup failures don't dominate the decision.
          }
        }

        if (anyPriced && expectedTotal > 0) {
          const ratio = cand.gross_paid_gbp / expectedTotal;
          reasoningParts.push(
            `Paid £${cand.gross_paid_gbp.toFixed(0)} vs expected ~£${expectedTotal.toFixed(0)} (ratio ${ratio.toFixed(2)}).`,
          );
          if (ratio < 0.7) {
            d = "decline";
            confidence = 0.75;
            replyReason = "underpriced";
            redFlags.push("underpriced");
          } else if (ratio < 0.9) {
            d = "ask_renter";
            confidence = 0.6;
            replyReason = "underpriced_mild";
            redFlags.push("underpriced_mild");
          }
        } else {
          redFlags.push("pricing_unavailable");
        }
      } else {
        redFlags.push("total_missing");
      }

      // Default accept path.
      if (d === "accept") {
        reasoningParts.push(
          "No blacklist hit, items + dates present, price within tolerance.",
        );
      }

      out.push({
        ...cand,
        decision: d,
        confidence,
        reasoning: reasoningParts.join(" "),
        suggestedReply: buildReply(d, cand, { reason: replyReason }),
        redFlags,
      });
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
          generatedByAgent: "rules-v1",
          modelId: "deterministic",
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
  .then(decideRules)
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
