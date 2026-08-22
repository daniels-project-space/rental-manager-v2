"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { ScenarioPicker, type CustomScenarioInput } from "./ScenarioPicker";
import { LiveChatSim, type SessionContext } from "./LiveChatSim";
import { RunResultsPanel } from "./RunResultsPanel";

interface Session {
  threadId: string;
  accountSlug: string;
  context: SessionContext;
}

export function RenterBotLabWorkspace() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [ending, setEnding] = useState(false);

  const fixtures = useQuery(api.renter_bot_lab_actions.listFixtures);
  const startLiveSession = useAction(api.renter_bot_lab_actions.startLiveSession);
  const endLiveSession = useAction(api.renter_bot_lab_actions.endLiveSession);

  async function handleStart(
    accountSlug: string,
    fixtureId?: string,
    custom?: CustomScenarioInput,
  ) {
    const result = await startLiveSession({
      accountSlug,
      fixtureId: fixtureId as never, // Convex Id<> branding; picker only ever passes a real fixture _id
      items: custom?.items,
      priceGbp: custom?.priceGbp,
      startDate: custom?.startDate,
      endDate: custom?.endDate,
      location: custom?.location,
      productId: custom?.productId,
    });
    setSession({
      threadId: result.threadId,
      accountSlug,
      context: result.context,
    });
  }

  async function handleEnd() {
    setEnding(true);
    try {
      await endLiveSession({});
    } finally {
      setSession(null);
      setEnding(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0b0c10] text-[#e4e6eb]">
      <div className="sticky top-0 z-10 border-b border-white/10 bg-[#0b0c10]/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push("/")}
              className="rounded-md px-1.5 py-1 text-sm text-[#8b8fa3] transition-colors hover:bg-white/[0.06] hover:text-[#e4e6eb]"
            >
              ← Dashboard
            </button>
            <h1 className="text-sm font-semibold">Renter Bot Lab</h1>
          </div>
          <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-400">
            TEST MODE — real draft pipeline, never sends to a real renter
          </span>
        </div>
      </div>

      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 p-6 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <ScenarioPicker
            fixtures={fixtures}
            disabled={!!session}
            startSession={handleStart}
          />
          {session && (
            <button
              onClick={handleEnd}
              disabled={ending}
              className="w-full rounded-md bg-white/10 px-3 py-2 text-sm text-[#e4e6eb] hover:bg-white/20 disabled:opacity-50"
            >
              {ending ? "Ending…" : "End session"}
            </button>
          )}
        </div>

        <div className="space-y-6">
          {session ? (
            <LiveChatSim session={session} />
          ) : (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-sm text-[#8b8fa3]">
              Pick an account and a scenario (or a custom one), then start a
              test conversation.
            </div>
          )}
          <RunResultsPanel />
        </div>
      </div>
    </div>
  );
}
