"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { isCanonicalGenerationFailure } from "../../../../convex/lib/canonical_generation_error";
import { renterBotLabAccountName } from "../../../../convex/lib/renter_bot_lab_scenarios";
import { renterBotNeedsHumanReview } from "../../../../convex/lib/renter_bot_review_state";
import type { RenterBotLabSessionContext } from "../../../lib/renter-bot-lab-session";
import { resumableLabTurn } from "../../../lib/renter-bot-lab-resumable-turn";

interface ChatTurn {
  role: "renter" | "bot";
  text: string;
  status?: "pass" | "fail" | "flag" | "incomplete";
  needsReview?: boolean;
  contextAdded?: boolean;
  automatic?: boolean;
  run?: {
    model_id: string;
    overall_status: string;
    generation_status?: string;
    cost_usd?: number | null;
    candidate_text?: string;
    draft_text?: string;
    draftIncluded: boolean;
    rubric_results: unknown;
    token_usage?: unknown;
    tool_stats?: unknown;
    source_receipts?: unknown;
    draft_evidence?: unknown;
    pending_owner_checks?: unknown;
    production_guard_flags?: unknown;
    failure?: unknown;
  };
}

function rentalDateLabel(value: string) {
  const date = new Date(value + "T12:00:00Z");
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(date);
}

function rentalPeriodLabel(startDate: string, endDate: string) {
  if (startDate === endDate) return rentalDateLabel(startDate) + " · 1 day";
  return rentalDateLabel(startDate) + " – " + rentalDateLabel(endDate);
}

function poundAmount(value: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(value);
}

export function LiveChatSim({
  session, labReady, onStartFriend, startingFriend,
}: {
  session: { threadId: string; accountSlug: string; context: RenterBotLabSessionContext };
  labReady: boolean;
  onStartFriend: (reference: string) => void;
  startingFriend: boolean;
}) {
  const order = useQuery(api.renter_bot_lab_order.get, { thread_id: session.threadId });
  const itemName = session.context.itemName || order?.lines[0]?.name || "";
  const item = useQuery(
    api.renter_bot_lab_actions.getItemContext,
    itemName ? { itemName, accountSlug: session.accountSlug } : "skip",
  );
  const orderChanges = order?.changes ?? [];
  const followups = useQuery(api.renter_bot_lab_followups.list, { thread_id: session.threadId });
  const transcript = useQuery(api.renter_bot_lab_actions.getLabTranscript, { thread_id: session.threadId });
  const turns: ChatTurn[] = transcript?.messages.map((entry) => {
    const relatedTurn = entry.sender === "renter"
      ? transcript.turns.find((candidate) => candidate.renter_message_id === entry.message_id)
      : undefined;
    const runId = entry.run_id ?? relatedTurn?.run_id;
    const run = runId ? transcript.runs.find((candidate) => candidate._id === runId) : undefined;
    const draftIncluded = Boolean(run?.draft_text && transcript.messages.some((candidate) =>
      candidate.sender === "owner" && candidate.run_id === run._id && candidate.text === run.draft_text));
    const ownerReplyExists = Boolean(run && transcript.messages.some((candidate) =>
      candidate.sender === "owner" && candidate.run_id === run._id));
    const evidence = run && (entry.sender !== "renter" || !ownerReplyExists) ? {
      model_id: run.model_id,
      overall_status: run.overall_status,
      generation_status: run.generation_status,
      cost_usd: run.cost_usd,
      candidate_text: run.candidate_text,
      draft_text: run.draft_text,
      draftIncluded,
      rubric_results: run.rubric_results,
      token_usage: run.token_usage,
      tool_stats: run.tool_stats,
      source_receipts: run.source_receipts,
      draft_evidence: run.draft_evidence,
      pending_owner_checks: run.pending_owner_checks,
      production_guard_flags: run.production_guard_flags,
      failure: { reason: run.failure_reason, generation_error: run.generation_error },
    } : undefined;
    return { role: entry.sender === "renter" ? "renter" : "bot", text: entry.text,
      status: run?.overall_status,
      needsReview: run ? renterBotNeedsHumanReview(run.rubric_results, run.production_guard_flags) : false,
      contextAdded: entry.sender !== "renter", run: evidence };
  }) ?? (session.context.initialBotMessage ? [{ role: "bot", text: session.context.initialBotMessage, automatic: true }] : []);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const [error, setError] = useState<string | null>(null);
  const [pendingTurn, setPendingTurn] = useState<{ turnId: string; text: string } | null>(null);
  const recoveredTurn = resumableLabTurn(transcript);
  const visiblePendingTurn = pendingTurn ?? (recoveredTurn ? { turnId: recoveredTurn.turnId, text: recoveredTurn.text } : null);

  useEffect(() => {
    setPendingTurn(null);
    setError(null);
  }, [session.threadId]);

  useEffect(() => {
    if (pendingTurn && transcript?.turns.some((turn) => turn.turn_id === pendingTurn.turnId && turn.status === "complete")) {
      setPendingTurn(null);
      setError(null);
    }
  }, [pendingTurn, transcript?.turns]);

  const canSend = labReady && Boolean(message.trim()) && order != null && !sending && !visiblePendingTurn;

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = message.trim();
    if (!text || !canSend || sendingRef.current) return;
    const turn = { turnId: crypto.randomUUID(), text };
    setMessage("");
    setError(null);
    setPendingTurn(turn);
    await submitTurn(turn);
  }

  async function submitTurn(turn: { turnId: string; text: string }) {
    if (!labReady || sendingRef.current) return;
    sendingRef.current = true;
    setError(null);
    setSending(true);
    try {
      const response = await fetch("/api/renter-bot-lab/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: session.threadId,
          accountSlug: session.accountSlug,
          text: turn.text,
          turnId: turn.turnId,
        }),
      });
      const result = await response.json().catch(() => ({})) as {
        ok?: boolean;
        pending?: boolean;
        draft?: string;
        overall_status?: "pass" | "fail" | "flag" | "incomplete";
        assistantContextAdded?: boolean;
        needs_review?: boolean;
        generation_error?: unknown;
        reason?: string;
        status?: string;
      };
      if (response.status === 202 && result.pending) {
        setError("This saved turn is still generating. Retry the same turn after that request finishes.");
        return;
      }
      if (!response.ok || result.ok !== true) {
        const alreadyComplete = transcriptRef.current?.turns.some((saved) =>
          saved.turn_id === turn.turnId && saved.status === "complete");
        if (!alreadyComplete) setError("The turn could not be completed. It remains tied to this message; retry it or inspect the saved transcript.");
        return;
      }
      setError(null);
      const failedGeneration = isCanonicalGenerationFailure(result);
      if (!failedGeneration) setPendingTurn(null);
      const draft = result.draft;
      if (draft) {
        if (result.overall_status === "fail") setError("The candidate failed the Lab checks and was not added to the persisted chat. Review the run details below.");
      } else if (failedGeneration) {
        setError("Generation failed. The message and failure details are saved; retrying will reuse this same turn.");
      } else if (result.status === "skipped") {
        setError("The reply needs review. The candidate and guard results are saved below.");
      } else {
        setError("The bot did not return a reply. You can continue the test or try again.");
      }
    } catch {
      setError("The test reply could not be generated. Check the current request above before continuing; a change may already have been saved.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]" aria-label="Rental test chat">
      <div className="border-b border-white/10 p-4">
        <p className="text-base font-semibold text-[#e4e6eb]">Example: {session.context.scenarioTitle}</p>
        <p className="mt-1 text-xs text-[#8b8fa3]">
          {renterBotLabAccountName(session.accountSlug)} · isolated test conversation
        </p>

        <div className="mt-3 grid gap-2 rounded-md border border-white/10 bg-black/20 p-3 text-xs sm:grid-cols-2">
          <div>
            <p className="text-[#8b8fa3]">Rental item</p>
            <p className="mt-1 font-medium text-[#e4e6eb]">
              {order === undefined ? "Loading items…" : order?.lines.length ? order.lines.map(line => `${line.qty} × ${line.display_name || line.name}`).join(", ") : "No items yet"}
            </p>
          </div>
          <div>
            <p className="text-[#8b8fa3]">Rental request</p>
            <p className="mt-1 font-medium text-[#e4e6eb]">
              {rentalPeriodLabel(order?.start_date ?? session.context.startDate, order?.end_date ?? session.context.endDate)}
            </p>
          </div>
          <div>
            <p className="text-[#8b8fa3]">Rental price</p>
            <p className="mt-1 font-medium text-[#e4e6eb]">
              {order === undefined ? "Loading price…" : !order?.lines.length ? "No items yet" : order.total_gbp == null ? "Price not available" : poundAmount(order.total_gbp)}
            </p>
            {order?.travel_compensation_gbp ? (
              <p className="mt-1 text-[#a8d5b1]">Subtotal {order.subtotal_gbp == null ? "not available" : poundAmount(order.subtotal_gbp)} · travel compensation −{poundAmount(order.travel_compensation_gbp)}</p>
            ) : null}
          </div>
          <div>
            <p className="text-[#8b8fa3]">Pickup and return times</p>
            <p className="mt-1 font-medium text-[#e4e6eb]">Pickup: {order?.pickup_time ? `${order.pickup_time}${order.pickup_date && order.pickup_date !== order.start_date ? ` on ${rentalDateLabel(order.pickup_date)}` : ""}` : "Not confirmed"} · Return: {order?.return_time ? `${order.return_time}${order.return_date && order.return_date !== order.end_date ? ` on ${rentalDateLabel(order.return_date)}` : ""}` : "Not confirmed"}</p>
          </div>
          <div>
            <p className="text-[#8b8fa3]">Request status</p>
            <p className="mt-1 font-medium text-[#e4e6eb]">{order?.stage ? order.stage.replaceAll("_", " ").toLowerCase() : "Loading…"}</p>
          </div>
        </div>
        {orderChanges.length > 0 && (
          <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-3 text-xs">
            <p className="font-semibold text-[#b6bac7]">Recent booking changes</p>
            <ul className="mt-1 space-y-1 text-[#e4e6eb]">
              {orderChanges.slice(-4).reverse().map((change, index) => (
                <li key={`${change.at}-${index}`}>{change.summary}</li>
              ))}
            </ul>
          </div>
        )}
        {item?.found === false && (
          <p className="mt-2 text-xs text-amber-200">This item has no direct Lab catalogue match. The conversation is still open; the bot must resolve it before offering or changing it.</p>
        )}
        {session.context.friendReference && !order?.lines.length && (
          <p className="mt-3 text-xs text-[#b6bac7]">The friend starts a separate inquiry. Include this reference in your message: <span className="select-all font-mono">{session.context.friendReference}</span></p>
        )}
        {followups && followups.length > 0 && (
          <div className="mt-3 rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-100">
            <p className="font-semibold">Unsent follow-up drafts</p>
            {followups.map(draft=><p key={draft.kind} className="mt-2">{draft.text}</p>)}
          </div>
        )}
        {order?.stage === "VERIFICATION_FAILED" && order.referral_code && (
          <button type="button" onClick={() => onStartFriend(order.referral_code!)} disabled={!labReady || sending || startingFriend}
            className="mt-3 rounded-md bg-white/10 px-3 py-2 text-xs text-[#e4e6eb] hover:bg-white/20 disabled:opacity-50">
            {startingFriend ? "Starting…" : "Try as the friend"}
          </button>
        )}
      </div>

      <div className="min-h-48 space-y-3 p-4" aria-live="polite">
        {turns.length === 0 && order && (
          <p className="text-sm text-[#8b8fa3]">
            {session.context.friendReference ? "Start the friend's separate inquiry with any message." : "Rental details are loaded. Start with any message; the bot can look up the item and request details as the conversation needs them."}
          </p>
        )}
        {turns.map((turn, index) => (
          <div
            key={index + "-" + turn.role}
            className="space-y-2"
          >
          <div
            className={"max-w-[88%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm " +
              (turn.role === "renter" ? "ml-auto bg-blue-500/20 text-blue-100" :
                turn.status === "fail" ? "border border-red-400/40 bg-red-400/10 text-red-100" :
                turn.status === "flag" ? "border border-amber-400/40 bg-amber-400/10 text-amber-100" :
                  turn.status === "incomplete" ? "border border-sky-300/30 bg-sky-300/5 text-sky-100" :
                    "bg-white/[0.06] text-[#e4e6eb]")}
          >
            {turn.role === "bot" && turn.status === "fail" && (
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide">
                Failed checks · candidate only, not added to chat history
              </span>
            )}
            {turn.role === "bot" && turn.automatic && (
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide">Automatic test reply</span>
            )}
            {turn.role === "bot" && turn.status === "flag" && (
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide">
                {turn.needsReview
                  ? turn.contextAdded ? "Review required · included in this test chat" : "Review required · not added to this test chat"
                  : turn.contextAdded ? "Guard corrected the candidate · included in this test chat" : "Guard corrected the candidate · not added to this test chat"}
              </span>
            )}
            {turn.role === "bot" && turn.status === "incomplete" && (
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide">
                Scoring incomplete · see run evidence for unassessed checks
              </span>
            )}
            {turn.text}
          </div>
          {turn.run && (
            <details className="ml-auto max-w-[88%] rounded-md border border-white/10 bg-black/20 p-3 text-xs text-[#b6bac7]">
              <summary className="cursor-pointer font-medium">
                Run evidence · {turn.run.overall_status} · {turn.run.model_id} · {turn.run.cost_usd == null ? "cost not reported" : `$${turn.run.cost_usd.toFixed(4)}`}
              </summary>
              <p className="mt-2">Generation: {turn.run.generation_status ?? "legacy run"}</p>
              {turn.run.candidate_text && (
                <div className="mt-2">
                  <p className="font-semibold">{turn.run.candidate_text === turn.run.draft_text
                    ? "Model candidate · same as the reply shown in the chat"
                    : turn.run.draftIncluded
                      ? "Original model candidate · corrected reply shown in the chat"
                      : turn.run.draft_text
                        ? "Model candidate · reply not included in the test chat"
                        : "Rejected model candidate · not sent in the test chat"}</p>
                  <pre className="mt-1 whitespace-pre-wrap font-sans">{turn.run.candidate_text}</pre>
                </div>
              )}
              {turn.role === "renter" && turn.run.draft_text && !turn.run.draftIncluded && (
                <div className="mt-2">
                  <p className="font-semibold">Generated reply · not included in the test chat</p>
                  <pre className="mt-1 whitespace-pre-wrap font-sans">{turn.run.draft_text}</pre>
                </div>
              )}
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify({
                rubric_results: turn.run.rubric_results,
                token_usage: turn.run.token_usage,
                tool_stats: turn.run.tool_stats,
                source_receipts: turn.run.source_receipts,
                facts: turn.run.draft_evidence,
                pending_owner_checks: turn.run.pending_owner_checks,
                guard_flags: turn.run.production_guard_flags,
                failure: turn.run.failure,
              }, null, 2)}</pre>
            </details>
          )}
          </div>
        ))}
        {visiblePendingTurn && !transcript?.messages.some((entry) => entry.message_id === `${session.threadId}-turn-${visiblePendingTurn.turnId}`) && (
          <div className="ml-auto max-w-[88%] whitespace-pre-wrap rounded-lg bg-blue-500/20 px-3 py-2 text-sm text-blue-100">{visiblePendingTurn.text}</div>
        )}
        {sending && <p className="text-xs text-[#8b8fa3]">Generating the isolated test reply…</p>}
        {error && <p className="rounded-md bg-red-400/10 p-2 text-xs text-red-200" role="alert">{error}</p>}
        {visiblePendingTurn && !sending && (
          <>
            {!error && <p className="text-xs text-amber-100" role="status">A saved test turn needs a retry. The same renter message and turn ID will be reused.</p>}
          <button type="button" onClick={() => void submitTurn(visiblePendingTurn)} disabled={!labReady || sending} className="rounded-md bg-amber-400/15 px-3 py-2 text-xs font-medium text-amber-100 hover:bg-amber-400/25 disabled:cursor-not-allowed disabled:opacity-50">
            {recoveredTurn?.status === "running" ? "Check or resume the same test turn" : "Retry the same test turn"}
          </button>
          </>
        )}
      </div>

      <form onSubmit={(event) => void sendMessage(event)} className="border-t border-white/10 bg-black/10 p-4">
        <label htmlFor="renter-lab-message" className="mb-2 block text-xs font-medium text-[#b6bac7]">
          Your renter message
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <textarea
            id="renter-lab-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            disabled={order == null || sending || Boolean(visiblePendingTurn)}
            maxLength={4000}
            rows={2}
            placeholder="Type anything to start the conversation…"
            className="min-h-12 flex-1 resize-y rounded-md border border-white/10 bg-[#0b0c10] px-3 py-2 text-sm text-[#e4e6eb] placeholder:text-[#6e7282] focus:border-blue-400/50 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!canSend}
            className="rounded-md bg-blue-500/20 px-5 py-2 text-sm font-medium text-blue-100 hover:bg-blue-500/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? "Waiting…" : "Send"}
          </button>
        </div>
        <p className="mt-3 text-[11px] text-[#8b8fa3]">
          Test messages stay in the isolated Lab. No renter messages are sent.
        </p>
      </form>
    </section>
  );
}
