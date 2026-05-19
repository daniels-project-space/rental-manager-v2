/**
 * Wave 4 — Convex action that triggers the Mastra `hygglo_poll` workflow.
 *
 * Mastra workflows run in Node (Vercel server-side / Trigger.dev), NOT in
 * the Convex runtime. So the Convex cron can't invoke the workflow
 * directly — it instead `fetch()`es a Next.js API route that owns the
 * workflow invocation.
 *
 * The API route URL is supplied via `POLL_TRIGGER_URL` (env var, set in
 * Convex dashboard). If unset, this action no-ops with a warning — that
 * keeps the cron registered even when the route hasn't been deployed yet.
 *
 * Cadence: 3 min (see convex/crons.ts). The existing Trigger.dev
 * `poll-hygglo-inbox` task remains the SOURCE-OF-TRUTH scraper at 5 min;
 * this cron only invokes the Mastra workflow on top of what's already
 * been written to Convex (idempotent — workflow detects "nothing new" and
 * exits fast).
 */
import { internalAction } from "./_generated/server";
import { isWithinUkQuietHours } from "./lib/quiet_hours";
import { rateLimiter } from "./rate_limit_config";

export const triggerWorkflow = internalAction({
  args: {},
  handler: async (ctx) => {
    // Rate-limit guard: max 1 trigger per 4 min (prevents cron + manual race).
    // Background crons that are NOT rate-limited: mv_refresh_*, snapshot-*,
    // archive-to-r2-cold, complete stale-confirmed, account profile sync,
    // classify-obsolete-demand-loss — those have fixed cadences with no
    // user amplification and must never be gated here.
    const rl = await rateLimiter.limit(ctx, "hygglo_poll");
    if (!rl.ok) {
      const waitSec = rl.retryAfter !== undefined
        ? Math.ceil(rl.retryAfter / 1000)
        : "unknown";
      console.log(
        `[hygglo_poll_trigger] rate-limited; retry in ${waitSec}s`,
      );
      return { ok: false, reason: "rate_limited", retryAfter: rl.retryAfter };
    }

    if (isWithinUkQuietHours()) {
      console.log("[quiet-hours] skipped", { task: "hygglo_poll_trigger:triggerWorkflow" });
      return { skipped: true, reason: "uk_quiet_hours" };
    }
    const url = process.env.POLL_TRIGGER_URL;
    if (!url) {
      console.warn("[hygglo_poll_trigger] POLL_TRIGGER_URL not set; skipping.");
      return { ok: false, reason: "no_url" };
    }
    const secret = process.env.POLL_TRIGGER_SECRET ?? "";
    // Wave 3b: also send X-Internal-Token so the same cron can drive
    // EITHER the Mastra `/api/workflows/hygglo-poll` route (Bearer auth)
    // OR the redundant L3 backup `/api/poll-hygglo` route (X-Internal-Token).
    // Whichever URL POLL_TRIGGER_URL points to, the matching header is present.
    const internalToken = process.env.INTERNAL_POLL_TOKEN ?? "";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          ...(internalToken ? { "X-Internal-Token": internalToken } : {}),
        },
        body: JSON.stringify({ source: "convex_cron" }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[hygglo_poll_trigger] route returned ${res.status}: ${text.slice(0, 200)}`);
        return { ok: false, status: res.status };
      }
      return { ok: true, status: res.status };
    } catch (err) {
      console.error(`[hygglo_poll_trigger] fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: String(err) };
    }
  },
});
