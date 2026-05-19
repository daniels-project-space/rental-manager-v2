/**
 * Phase 2 debug: fetch a single Hygglo order detail and log the steps array
 * shape so we can verify what `order_step` extraction is receiving.
 *
 * Run: npx convex run --prod admin_debug_steps:probe '{"account_slug":"leo","hygglo_order_id":"<id>"}'
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "../src/lib/hygglo-auth";

export const probe = internalAction({
  args: {
    account_slug: v.string(),
    hygglo_order_id: v.string(),
  },
  handler: async (_ctx, { account_slug, hygglo_order_id }) => {
    const creds = await getAccountCredentials(account_slug);
    const token = await getHyggloAccessToken({
      email: creds.email,
      password: creds.password,
      clientSecret: creds.clientSecret,
      accountSlug: account_slug,
    });
    const res = await fetch(
      `${HYGGLO_API_BASE}/v4/my/orders/${hygglo_order_id}?timezone=Europe/London`,
      { headers: hyggloAuthHeaders(token) },
    );
    if (!res.ok) {
      return { ok: false, status: res.status, error: await res.text() };
    }
    const detail = (await res.json()) as any;
    const topKeys = Object.keys(detail ?? {});
    const stepCandidates = {
      steps: detail?.steps,
      "detail.steps": detail?.detail?.steps,
      progress: detail?.progress,
      funnel: detail?.funnel,
      state: detail?.state,
      status: detail?.status,
    };
    return {
      ok: true,
      topKeys,
      stepsType: Array.isArray(detail?.steps) ? "array" : typeof detail?.steps,
      stepsLength: Array.isArray(detail?.steps) ? detail.steps.length : null,
      stepsRaw: detail?.steps,
      stepCandidates,
    };
  },
});
