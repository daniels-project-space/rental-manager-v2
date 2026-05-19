/**
 * Renter-bot batch scheduler — Phase 1.
 *
 * Cadence (Decision A-15): every 10 minutes, fully dormant during UK
 * quiet hours (02:00–08:30 Europe/London). The cron triggers on every
 * 10-min boundary; if quiet hours are active the task returns immediately.
 *
 * Flow:
 *   1. Quiet-hours guard. If active → return { skipped: "quiet_hours" }.
 *   2. Run the renterBotDraftWorkflow (scan mode, no explicit thread_ids).
 *   3. For each newly-written draft, fetch it from Convex and post a
 *      formatted card to Daniel's Telegram. Persist the Telegram
 *      message_id back to the draft row for the callback handler.
 *
 * READ-ONLY GUARANTEE: this task only writes to:
 *   - `renter_bot_drafts` (via the workflow) — the bot's own table
 *   - Telegram (outbound to Daniel only, NEVER renter)
 * It does NOT call Hygglo write APIs anywhere.
 */
import { schedules, logger } from "@trigger.dev/sdk/v3";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { isWithinUkQuietHours } from "../lib/quiet-hours";
import { runRenterBotDraft } from "../mastra/workflows/renter_bot_draft";
import { sendOperatorMessage, formatDraftCard } from "../lib/telegram";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyApi = api as any;

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

interface DraftRow {
  _id: string;
  thread_id: string;
  account_slug: string;
  draft_text: string;
  draft_intent: string;
  draft_stage?: string;
  draft_red_flags: string[];
  facts_claimed?: Array<{ kind: string; value: string; sourceTool: string }>;
  needs_human: boolean;
  needs_human_reason?: string;
  last_inbound_message_id: string;
  status: string;
  telegram_message_id?: string;
  generated_at: number;
}

export const renterBotBatch = schedules.task({
  id: "renter-bot-batch",
  // Every 10 minutes — Decision A-15.
  cron: "*/10 * * * *",
  maxDuration: 240, // CLAUDE.md hard rule #5: cap Trigger tasks.
  run: async () => {
    if (isWithinUkQuietHours()) {
      logger.log("Quiet hours — skipping renter-bot batch");
      return { skipped: "quiet_hours" };
    }

    const result = await runRenterBotDraft({ limit: 20 });
    if ("ok" in result && result.ok === false) {
      logger.error("renter-bot workflow failed", { error: result.error });
      return { ok: false, error: result.error };
    }

    // Post freshly-written drafts to Telegram. Pull pending drafts whose
    // telegram_message_id is still unset.
    const c = new ConvexHttpClient(CONVEX_URL);
    const pending: DraftRow[] = await c.query(
      anyApi.renter_bot_drafts.listPending,
      { limit: 20 },
    );

    let posted = 0;
    let failed = 0;
    for (const d of pending) {
      if (d.telegram_message_id) continue; // already posted
      // Look up renter name + last inbound body for the card.
      const ctx = await c.query(anyApi.renter_bot_tools.get_renter_context, {
        thread_id: d.thread_id,
      });
      const last = ctx?.last_messages?.find((m: { sender: string }) => m.sender !== "owner");
      const card = formatDraftCard({
        renterName:
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (ctx?.renter as any)?.display_name ?? null,
        accountSlug: d.account_slug,
        inboundBody: last?.body ?? "(no message body)",
        draftText: d.draft_text,
        intent: d.draft_intent,
        stage: d.draft_stage,
        redFlags: d.draft_red_flags,
        needsHuman: d.needs_human,
        needsHumanReason: d.needs_human_reason,
        factsClaimed: d.facts_claimed,
        threadId: d.thread_id,
        draftId: d._id,
      });
      const send = await sendOperatorMessage(card);
      if (send.ok && send.message_id) {
        await c.mutation(anyApi.renter_bot_drafts.recordTelegramPost, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          id: d._id as any,
          telegram_chat_id: send.chat_id ?? "",
          telegram_message_id: send.message_id,
        });
        posted += 1;
      } else {
        failed += 1;
        logger.warn(`Telegram post failed for draft=${d._id}: ${send.error}`);
      }
    }

    return {
      ok: true,
      ...(result as Record<string, unknown>),
      telegramPosted: posted,
      telegramFailed: failed,
    };
  },
});
