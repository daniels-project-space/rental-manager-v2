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
          Ready-to-run examples
        </h2>
        <p className="mt-1 text-xs text-[#8b8fa3]">
          Choose a card. Item facts and renter messages are already loaded.
        </p>
      </div>
      {RENTER_BOT_LAB_SCENARIOS.map((scenario) => (
        <article key={scenario.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <p className="text-sm font-semibold text-[#e4e6eb]">{scenario.title}</p>
          <p className="mt-1 text-xs text-[#8b8fa3]">
            {scenario.accountSlug === "dbcinema" ? "DB Cinema" : "Leo"} · {scenario.displayName}
          </p>
          <p className="mt-2 text-xs leading-5 text-[#b6bac7]">{scenario.summary}</p>
          <p className="mt-2 text-[11px] text-[#8b8fa3]">
            {scenario.prompts.length} prepared renter {scenario.prompts.length === 1 ? "message" : "messages"}
          </p>
          <button
            type="button"
            onClick={() => startScenario(scenario.id)}
            disabled={disabled}
            className="mt-3 w-full rounded-md bg-emerald-500/20 px-3 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Load example
          </button>
        </article>
      ))}
    </section>
  );
}
