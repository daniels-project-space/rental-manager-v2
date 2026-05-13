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

export const triggerWorkflow = internalAction({
  args: {},
  handler: async () => {
    const url = process.env.POLL_TRIGGER_URL;
    if (!url) {
      console.warn("[hygglo_poll_trigger] POLL_TRIGGER_URL not set; skipping.");
      return { ok: false, reason: "no_url" };
    }
    const secret = process.env.POLL_TRIGGER_SECRET ?? "";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
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
