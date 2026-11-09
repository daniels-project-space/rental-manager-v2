"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";

export interface SessionContext {
  scenarioTitle: string;
  displayName: string;
  items: string[];
  examplePrompts: string[];
}

interface ChatTurn {
  role: "renter" | "bot";
  text: string;
}

export function LiveChatSim({
  session,
}: {
  session: { threadId: string; accountSlug: string; context: SessionContext };
}) {
  const sendTestMessage = useAction(api.renter_bot_lab_actions.sendTestMessage);
  const item = useQuery(api.renter_bot_lab_actions.getItemContext, {
    itemName: session.context.items[0],
    accountSlug: session.accountSlug,
  });
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [promptIndex, setPromptIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextPrompt = session.context.examplePrompts[promptIndex];
  const canSend = Boolean(nextPrompt) && item?.found === true && !sending;

  async function sendNextPrompt() {
    if (!nextPrompt || !canSend) return;
    const text = nextPrompt;
    setError(null);
    setTurns((current) => [...current, { role: "renter", text }]);
    setSending(true);
    try {
      const result = await sendTestMessage({
        threadId: session.threadId,
        accountSlug: session.accountSlug,
        text,
      });
      setTurns((current) => [
        ...current,
        {
          role: "bot",
          text: result.draft || (result.status === "ok"
            ? `Reply withheld by a safety check${result.reason ? `: ${result.reason}` : "."}`
            : `Reply generation failed${result.reason ? `: ${result.reason}` : "."}`),
        },
      ]);
      setPromptIndex((current) => current + 1);
    } catch (cause) {
      setTurns((current) => current.at(-1)?.role === "renter" ? current.slice(0, -1) : current);
      setError(cause instanceof Error ? cause.message : "The test reply could not be generated.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]" aria-label="Prepared conversation">
      <div className="border-b border-white/10 p-4">
        <p className="text-base font-semibold text-[#e4e6eb]">{session.context.scenarioTitle}</p>
        <p className="mt-1 text-xs text-[#8b8fa3]">
          {session.accountSlug === "dbcinema" ? "DB Cinema" : "Leo"} · isolated test conversation
        </p>
        <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-3" aria-live="polite">
          <p className="text-sm font-medium text-[#e4e6eb]">
            {item?.display_name ?? session.context.displayName}
          </p>
          {item === undefined ? (
            <p className="mt-1 text-xs text-[#8b8fa3]">Loading the item facts…</p>
          ) : !item.found ? (
            <p className="mt-1 text-xs text-red-300">This item is missing from the isolated Lab catalogue, so the conversation is paused.</p>
          ) : (
            <>
              <p className="mt-1 text-xs text-[#8b8fa3]">{item.kind}{item.sub_kind ? ` · ${item.sub_kind.replace(/_/g, " ")}` : ""}</p>
              {item.notes && <p className="mt-2 text-xs leading-5 text-[#b6bac7]">{item.notes}</p>}
              {item.included_with_rental?.length ? (
                <p className="mt-2 text-xs leading-5 text-[#b6bac7]">
                  Included: {item.included_with_rental.join(" · ")}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="min-h-40 space-y-3 p-4" aria-live="polite">
        {turns.length === 0 && item?.found && (
          <p className="text-sm text-[#8b8fa3]">The selected item and its confirmed facts are loaded. Run the prepared renter message below.</p>
        )}
        {turns.map((turn, index) => (
          <div
            key={`${index}-${turn.role}`}
            className={`max-w-[88%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${turn.role === "renter" ? "ml-auto bg-blue-500/20 text-blue-100" : "bg-white/[0.06] text-[#e4e6eb]"}`}
          >
            {turn.text}
          </div>
        ))}
        {sending && <p className="text-xs text-[#8b8fa3]">Generating the isolated test reply…</p>}
        {error && <p className="rounded-md bg-red-400/10 p-2 text-xs text-red-200" role="alert">{error}</p>}
      </div>

      <div className="border-t border-white/10 bg-black/10 p-4">
        {nextPrompt ? (
          <>
            <p className="text-[11px] text-[#8b8fa3]">Prepared message {promptIndex + 1} of {session.context.examplePrompts.length}</p>
            <p className="mt-1 text-sm text-[#e4e6eb]">{nextPrompt}</p>
            <button
              type="button"
              onClick={() => void sendNextPrompt()}
              disabled={!canSend}
              className="mt-3 rounded-md bg-blue-500/20 px-4 py-2 text-sm font-medium text-blue-100 hover:bg-blue-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {sending ? "Waiting for reply…" : "Run next message"}
            </button>
          </>
        ) : (
          <p className="text-sm text-emerald-300">Example complete. Choose another card to run a different conversation.</p>
        )}
        <p className="mt-3 text-[11px] text-[#8b8fa3]">Messages stay in the isolated test backend. Real renter messaging is disabled.</p>
      </div>
    </section>
  );
}
