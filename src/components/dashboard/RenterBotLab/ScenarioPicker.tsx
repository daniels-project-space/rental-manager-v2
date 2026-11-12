"use client";

import {
  RENTER_BOT_LAB_SCENARIOS,
  type RenterBotLabScenarioId,
} from "../../../../convex/lib/renter_bot_lab_scenarios";

export function ScenarioPicker({
  disabled,
  startScenario,
}: {
  disabled: boolean;
  startScenario: (scenarioId: RenterBotLabScenarioId) => void;
}) {
  return (
    <section aria-labelledby="prepared-scenarios" className="space-y-3">
      <div>
        <h2 id="prepared-scenarios" className="text-base font-semibold text-[#e4e6eb]">
          Load a rental
        </h2>
        <p className="mt-1 text-xs text-[#8b8fa3]">
          Each card loads a rental example with its item and dates. You write the renter’s messages.
        </p>
      </div>
      {RENTER_BOT_LAB_SCENARIOS.map((scenario) => (
        <article key={scenario.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <p className="text-sm font-semibold text-[#e4e6eb]">{scenario.title}</p>
          <p className="mt-1 text-xs text-[#8b8fa3]">
            {scenario.accountSlug === "dbcinema" ? "DB Cinema" : "Leo"} · {scenario.displayName}
          </p>
          {scenario.startStage === "verification_failed" && (
            <p className="mt-1 text-xs text-[#8b8fa3]">A failed verification cancels the test booking and shows the automatic reply.</p>
          )}
          <button
            type="button"
            onClick={() => startScenario(scenario.id)}
            disabled={disabled}
            className="mt-3 w-full rounded-md bg-emerald-500/20 px-3 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Load rental
          </button>
        </article>
      ))}
    </section>
  );
}
