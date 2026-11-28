"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { ScenarioPicker } from "./ScenarioPicker";
import { LiveChatSim } from "./LiveChatSim";
import { RunResultsPanel } from "./RunResultsPanel";
import {
  parseRenterBotLabSession,
  RENTER_BOT_LAB_SESSION_STORAGE_KEY,
  serializeRenterBotLabSession,
  type RenterBotLabSession,
} from "../../../lib/renter-bot-lab-session";
import {
  renterBotLabRentalDates,
  renterBotLabScenario,
  type RenterBotLabScenarioId,
} from "../../../../convex/lib/renter_bot_lab_scenarios";

interface LabApiStatus {
  deployment: string;
  live_chat_authorized: boolean;
  openrouter_configured: boolean;
  generation_ready: boolean;
  source_fingerprint: string;
  source_revision: string;
  lab_backend_id: string;
  model_id: string;
  backend_contract_version: string | null;
  expected_backend_contract_version: string;
  backend_contract_matches: boolean;
  backend_source_revision: string | null;
  expected_backend_source_revision: string;
  backend_source_matches: boolean;
  draft_api_contract_version: string | null;
  draft_api_contract_matches: boolean;
  draft_api_source_revision: string | null;
  expected_source_revision: string;
  draft_api_source_matches: boolean;
  catalog_ready: boolean;
  catalog_status: string;
  catalog_fetched_at: number | null;
  catalog_inventory_count: number;
  catalog_listing_count: number;
  catalog_eligible_listing_count: number;
  catalog_blocked_listing_count: number;
}

export function RenterBotLabWorkspace() {
  const router = useRouter();
  const [session, setSession] = useState<RenterBotLabSession | null>(null);
  const [sessionRestored, setSessionRestored] = useState(false);
  const [ending, setEnding] = useState(false);
  const [startingFriend, setStartingFriend] = useState(false);
  const [savedThreadId, setSavedThreadId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [labApiStatus, setLabApiStatus] = useState<LabApiStatus | null>(null);
  const [labApiChecked, setLabApiChecked] = useState(false);

  const startLiveSession = useAction(api.renter_bot_lab_actions.startLiveSession);
  const endLiveSession = useAction(api.renter_bot_lab_actions.endLiveSession);
  const savedTranscript = useQuery(
    api.renter_bot_lab_actions.getLabTranscript,
    savedThreadId ? { thread_id: savedThreadId } : "skip",
  );

  useEffect(() => {
    const raw = window.sessionStorage.getItem(RENTER_BOT_LAB_SESSION_STORAGE_KEY);
    const restored = parseRenterBotLabSession(raw);
    if (restored) setSession(restored);
    else if (raw) window.sessionStorage.removeItem(RENTER_BOT_LAB_SESSION_STORAGE_KEY);
    setSessionRestored(true);
  }, []);

  useEffect(() => {
    if (!sessionRestored) return;
    if (session) {
      window.sessionStorage.setItem(
        RENTER_BOT_LAB_SESSION_STORAGE_KEY,
        serializeRenterBotLabSession(session),
      );
    } else {
      window.sessionStorage.removeItem(RENTER_BOT_LAB_SESSION_STORAGE_KEY);
    }
  }, [session, sessionRestored]);

  useEffect(() => {
    if (!savedThreadId || !savedTranscript) return;
    if (!savedTranscript.session) {
      setStartError("That saved Lab conversation is no longer available.");
      setSavedThreadId(null);
      return;
    }
    setStartError(null);
    setSession({
      threadId: savedThreadId,
      accountSlug: savedTranscript.session.account_slug,
      context: {
        scenarioTitle: "Saved Lab conversation",
        itemName: savedTranscript.session.item_name,
        displayName: savedTranscript.session.display_name,
        items: savedTranscript.session.items,
        startDate: savedTranscript.session.start_date,
        endDate: savedTranscript.session.end_date,
      },
    });
    setSavedThreadId(null);
  }, [savedThreadId, savedTranscript]);

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
    labApiStatus.generation_ready === true && labApiStatus.catalog_ready === true;
  const labReady = labApiReady;
  const sourceVersion = labApiStatus?.source_revision.match(/^[a-f0-9]{7,40}$/i)
    ? labApiStatus.source_revision.slice(0, 12)
    : labApiStatus?.source_revision;
  const draftApiSourceVersion = labApiStatus?.draft_api_source_revision?.match(/^[a-f0-9]{7,40}$/i)
    ? labApiStatus.draft_api_source_revision.slice(0, 12)
    : labApiStatus?.draft_api_source_revision;
  const backendSourceVersion = labApiStatus?.backend_source_revision?.slice(0, 12);
  const catalogUpdatedAt = labApiStatus?.catalog_fetched_at
    ? new Date(labApiStatus.catalog_fetched_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" })
    : null;

  async function handleStart(scenarioId: RenterBotLabScenarioId) {
    setStartError(null);
    try {
      const scenario = renterBotLabScenario(scenarioId);
      if (!scenario) throw new Error("That Lab scenario is no longer available");
      const { startDate, endDate } = renterBotLabRentalDates(scenario);
      const result = await startLiveSession({
        accountSlug: scenario.accountSlug,
        scenarioId,
        items: [scenario.item.name_canonical],
        lifecycle: scenario.startStage === "confirmed" ? "confirmed" : "awaiting_owner_approval",
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
          initialBotMessage: result.context.initialBotMessage,
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
      if (session?.sourceThreadId) await endLiveSession({ threadId: session.sourceThreadId });
    } finally {
      setSession(null);
      setEnding(false);
      setStartError(null);
    }
  }

  function handleOpenSavedConversation(threadId: string) {
    setStartError(null);
    setSavedThreadId(threadId);
  }

  async function handleStartFriend(reference: string) {
    if (!labReady || !session) return;
    setStartingFriend(true);
    setStartError(null);
    try {
      const result = await startLiveSession({accountSlug:session.accountSlug,items:[],lifecycle:"inquiry",
        startDate:session.context.startDate,endDate:session.context.endDate});
      setSession({threadId:result.threadId,accountSlug:session.accountSlug,sourceThreadId:session.threadId,
        context:{...session.context,scenarioTitle:"Friend's new inquiry",items:[],initialBotMessage:undefined,friendReference:reference}});
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Could not start the friend's test conversation");
    } finally { setStartingFriend(false); }
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
              title={labApiStatus ? `Page source ${labApiStatus.source_revision} · generator source ${labApiStatus.draft_api_source_revision ?? "unknown"} · Lab backend ${labApiStatus.lab_backend_id} · backend source ${labApiStatus.backend_source_revision ?? "unknown"} (expected ${labApiStatus.expected_backend_source_revision}) · backend contract ${labApiStatus.backend_contract_version ?? "unknown"} · generator contract ${labApiStatus.draft_api_contract_version ?? "unknown"} · fingerprint ${labApiStatus.source_fingerprint}` : undefined}
              className={`rounded-full px-3 py-1 text-xs font-medium ${labReady ? "bg-emerald-500/15 text-emerald-300" : "bg-white/10 text-[#b6bac7]"}`}
            >
              {labReady
                ? `Lab connected · ${labApiStatus.lab_backend_id} · source ${sourceVersion} · generator ${draftApiSourceVersion} · backend ${backendSourceVersion} · ${labApiStatus.model_id} · sends off`
                : !labApiChecked
                  ? "Checking Lab connection…"
                  : !labApiReady
                    ? labApiStatus?.deployment === "local" && !labApiStatus.catalog_ready
                      ? labApiStatus.catalog_status === "ready"
                        ? "Rental catalogue is stale — refresh the local source data"
                        : `Rental catalogue ${labApiStatus.catalog_status} — chat is disabled`
                      : labApiStatus?.backend_contract_matches === false
                      ? `Lab backend outdated — expected ${labApiStatus.expected_backend_contract_version}`
                      : labApiStatus?.backend_source_matches === false
                        ? `Lab backend loading old code — running ${labApiStatus.backend_source_revision?.slice(0, 12) ?? "unknown"}, expected ${labApiStatus.expected_backend_source_revision.slice(0, 12)}`
                        : labApiStatus?.draft_api_contract_matches === false
                        ? `Draft API outdated — expected ${labApiStatus.expected_backend_contract_version}`
                        : labApiStatus?.draft_api_source_matches === false
                          ? `Lab source mismatch — page ${sourceVersion ?? "unknown"}, generator ${draftApiSourceVersion ?? "unknown"}`
                      : "Lab API unavailable — isolated backend not ready"
                    : "Connecting to isolated Lab data…"}
            </span>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        {labApiStatus?.deployment === "local" && (
          <p className={`rounded-md border px-3 py-2 text-xs ${labApiStatus.catalog_ready
            ? "border-emerald-400/20 bg-emerald-400/5 text-emerald-200"
            : "border-amber-400/20 bg-amber-400/5 text-amber-200"}`}>
            {labApiStatus.catalog_ready
              ? `Local rental data · ${labApiStatus.catalog_inventory_count.toLocaleString()} physical items · ${labApiStatus.catalog_listing_count.toLocaleString()} listings · ${labApiStatus.catalog_eligible_listing_count.toLocaleString()} offerable · refreshed ${catalogUpdatedAt ?? "time unavailable"} (London)`
              : `Local rental data is ${labApiStatus.catalog_status}${catalogUpdatedAt ? ` · last refreshed ${catalogUpdatedAt} (London)` : ""}. Start a chat after the catalogue is refreshed.`}
          </p>
        )}
        {!sessionRestored && <p className="text-sm text-[#8b8fa3]" role="status">Restoring the isolated test chat…</p>}

        {sessionRestored && !session && (
          <ScenarioPicker
            disabled={!labReady}
            startScenario={handleStart}
          />
        )}

        {startError && <p className="rounded-md border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200" role="alert">{startError}</p>}

        {sessionRestored && session && (
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
            <LiveChatSim key={session.threadId} session={session} labReady={labReady} onStartFriend={handleStartFriend} startingFriend={startingFriend} />
          </section>
        )}
        <RunResultsPanel
          onOpenConversation={handleOpenSavedConversation}
          openingThreadId={savedThreadId}
        />
      </main>
    </div>
  );
}
