import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * The most recent Lab runs, including the ones that produced an EMPTY draft.
 *
 * The Lab chat bubble shows "(empty draft — see run for details)" but never
 * surfaces WHY, so a failure there is invisible from the UI. The run row has
 * the production guard flags that caused it — read those rather than guessing
 * from a re-run, which will not reproduce a non-deterministic block.
 */
export const recent = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query("renter_bot_harness_runs").order("desc").take(limit ?? 12);
    return rows.map((r) => ({
      at: new Date(r._creationTime).toISOString().slice(11, 19),
      thread: r.session_thread_id ?? "(fixture)",
      account: r.account_slug,
      empty: !r.draft_text,
      draft: (r.draft_text ?? "").slice(0, 110),
      model: r.model_id,
      filters: r.filter_violations,
      rubric: (r.rubric_results ?? [])
        .filter((x) => x.status === "fail")
        .map((x) => `${x.category}: ${x.detail}`),
      overall: r.overall_status,
    }));
  },
});

export default internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, a): Promise<unknown> =>
    ctx.runQuery(internal.diag_lab_runs.recent, a),
});
