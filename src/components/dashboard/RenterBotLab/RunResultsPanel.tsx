"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";

const statusColor = (s: string) =>
  s === "pass"
    ? "text-emerald-400"
    : s === "fail"
      ? "text-red-400"
      : s === "flag"
        ? "text-amber-400"
        : "text-[#8b8fa3]";

export function RunResultsPanel() {
  const runs = useQuery(api.renter_bot_lab_actions.recentRuns, { limit: 20 });

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <h2 className="mb-3 text-sm font-semibold text-[#e4e6eb]">
        Recent harness / Lab runs
      </h2>
      {!runs && <p className="text-sm text-[#8b8fa3]">Loading…</p>}
      {runs && runs.length === 0 && (
        <p className="text-sm text-[#8b8fa3]">
          No runs yet — start a test conversation above, or run a batch via
          the Convex dashboard/CLI (renter_bot_harness.runBatch).
        </p>
      )}
      <div className="space-y-2">
        {(runs ?? []).map((r) => (
          <details key={r._id} className="rounded-md border border-white/10 p-2">
            <summary className="cursor-pointer text-xs">
              <span className={`font-medium ${statusColor(r.overall_status)}`}>
                {r.overall_status.toUpperCase()}
              </span>{" "}
              <span className="text-[#8b8fa3]">
                {r.account_slug} · {r.triggered_by} ·{" "}
                {new Date(r.run_at).toLocaleString()}
              </span>
            </summary>
            <div className="mt-2 space-y-1 text-xs">
              <p className="text-[#8b8fa3]">Draft:</p>
              <p className="whitespace-pre-wrap rounded bg-black/30 p-2">
                {r.draft_text || "(empty)"}
              </p>
              {r.rubric_results.map((res, i: number) => (
                <p key={i} className={statusColor(res.status)}>
                  {res.category}: {res.status} — {res.detail}
                </p>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
