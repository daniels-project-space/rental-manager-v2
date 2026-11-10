"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { ScenarioPicker } from "./ScenarioPicker";
import { LiveChatSim, type SessionContext } from "./LiveChatSim";
import {
  renterBotLabRentalDates,
  renterBotLabScenario,
  type RenterBotLabScenarioId,
} from "../../../../convex/lib/renter_bot_lab_scenarios";

interface Session {
  threadId: string;
  accountSlug: string;
  context: SessionContext;
}

interface LabApiStatus {
  deployment: string;
  live_chat_authorized: boolean;
  openrouter_configured: boolean;
  generation_ready: boolean;
  source_fingerprint: string;
}

export function RenterBotLabWorkspace() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [ending, setEnding] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [labApiStatus, setLabApiStatus] = useState<LabApiStatus | null>(null);
  const [labApiChecked, setLabApiChecked] = useState(false);

  const startLiveSession = useAction(api.renter_bot_lab_actions.startLiveSession);
  const endLiveSession = useAction(api.renter_bot_lab_actions.endLiveSession);

  useEffect(() => {
    let mounted = true;
    async function checkLabApi() {
      try {
        const response = await fetch("/api/renter-bot-draft/lab-status", { cache: "no-store" });
        if (!response.ok) throw new Error("Renter Bot Lab API is unavailable");
        const status = await response.json() as LabApiStatus;
        if (mounted) setLabApiStatus(status);
      } catch {
        if (mounted) setLabApiStatus(null);
      } finally {
        if (mounted) setLabApiChecked(true);
      }
    }
    void checkLabApi();
    const timer = window.setInterval(() => void checkLabApi(), 30_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  const labApiReady = (labApiStatus?.deployment === "local" || labApiStatus?.deployment === "hosted") &&
    labApiStatus.live_chat_authorized === false && labApiStatus.openrouter_configured === true &&
    labApiStatus.generation_ready === true;
  const labReady = labApiReady;
  const sourceVersion = labApiStatus?.source_fingerprint.slice(0, 12);

  async function handleStart(scenarioId: RenterBotLabScenarioId) {
    setStartError(null);
    try {
      const scenario = renterBotLabScenario(scenarioId);
      if (!scenario) throw new Error("That Lab scenario is no longer available");
      const { startDate, endDate } = renterBotLabRentalDates(scenario);
      const result = await startLiveSession({
        accountSlug: scenario.accountSlug,
        items: [scenario.item.name_canonical],
        lifecycle: "awaiting_owner_approval",
        startDate,
        endDate,
        dates: startDate + " to " + endDate,
      });
      setSession({
        threadId: result.threadId,
        accountSlug: scenario.accountSlug,
        context: {
          scenarioTitle: scenario.title,
          itemName: scenario.item.name_canonical,
          displayName: scenario.displayName,
          items: result.context.items,
          startDate,
          endDate,
        },
      });
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Could not start the Lab conversation");
    }
  }

  async function handleEnd() {
    setEnding(true);
    try {
      if (session) await endLiveSession({ threadId: session.threadId });
    } finally {
      setSession(null);
      setEnding(false);
      setStartError(null);
    }
  }

  return (
    <div className="min-h-screen bg-[#0b0c10] text-[#e4e6eb]">
      <div className="sticky top-0 z-10 border-b border-white/10 bg-[#0b0c10]/95 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push("/")}
              className="rounded-md px-1.5 py-1 text-sm text-[#8b8fa3] transition-colors hover:bg-white/[0.06] hover:text-[#e4e6eb]"
            >
              ← Dashboard
            </button>
            <h1 className="text-sm font-semibold">Renter Bot Lab</h1>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-400">
              TEST MODE — never sends to a real renter
            </span>
            <span
              role="status"
              aria-live="polite"
              className={`rounded-full px-3 py-1 text-xs font-medium ${labReady ? "bg-emerald-500/15 text-emerald-300" : "bg-white/10 text-[#b6bac7]"}`}
            >
              {labReady
                ? `Lab bot connected · ${sourceVersion} · Model ready · sends off`
                : !labApiChecked
                  ? "Checking Lab connection…"
                  : !labApiReady
                    ? "Lab API unavailable — isolated backend not ready"
                    : "Connecting to isolated Lab data…"}
            </span>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        {!session && (
          <ScenarioPicker
            disabled={!labReady}
            startScenario={handleStart}
          />
        )}

        {startError && <p className="rounded-md border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200" role="alert">{startError}</p>}

        {session && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-[#8b8fa3]">Rental loaded. Type any first message and continue the chat naturally.</p>
              <button
                onClick={handleEnd}
                disabled={ending}
                className="rounded-md bg-white/10 px-3 py-2 text-sm text-[#e4e6eb] hover:bg-white/20 disabled:opacity-50"
              >
                {ending ? "Closing…" : "Choose another example"}
              </button>
            </div>
            <LiveChatSim session={session} />
          </section>
        )}
      </main>
    </div>
  );
}
