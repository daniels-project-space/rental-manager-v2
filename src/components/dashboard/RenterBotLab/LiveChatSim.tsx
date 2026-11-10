"use client";

import { useState, type FormEvent } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";

export interface SessionContext {
  scenarioTitle: string;
  itemName: string;
  displayName: string;
  items: string[];
  startDate: string;
  endDate: string;
}

interface ChatTurn {
  role: "renter" | "bot";
  text: string;
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
  session,
}: {
  session: { threadId: string; accountSlug: string; context: SessionContext };
}) {
  const sendTestMessage = useAction(api.renter_bot_lab_actions.sendTestMessage);
  const item = useQuery(api.renter_bot_lab_actions.getItemContext, {
    itemName: session.context.itemName,
    accountSlug: session.accountSlug,
  });
  const order = useQuery(api.renter_bot_lab_order.get, { thread_id: session.threadId });
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSend = Boolean(message.trim()) && item?.found === true && order != null && !sending;

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = message.trim();
    if (!text || !canSend) return;

    setMessage("");
    setError(null);
    setTurns((current) => [...current, { role: "renter", text }]);
    setSending(true);
    try {
      const result = await sendTestMessage({
        threadId: session.threadId,
        accountSlug: session.accountSlug,
        text,
      });
      if (result.draft) {
        setTurns((current) => [...current, { role: "bot", text: result.draft }]);
      } else if (result.generation_error || result.reason?.startsWith("canonical_generation_")) {
        setError("The isolated reply connection failed. Refresh the Lab and try again.");
      } else if (result.status === "skipped") {
        setError("The bot held this reply for review" + (result.reason ? ": " + result.reason : "."));
      } else {
        setError("The bot did not return a reply. You can continue the test or try again.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The test reply could not be generated.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]" aria-label="Rental test chat">
      <div className="border-b border-white/10 p-4">
        <p className="text-base font-semibold text-[#e4e6eb]">{session.context.scenarioTitle}</p>
        <p className="mt-1 text-xs text-[#8b8fa3]">
          {session.accountSlug === "dbcinema" ? "DB Cinema" : "Leo"} · isolated test conversation
        </p>

        <div className="mt-3 grid gap-2 rounded-md border border-white/10 bg-black/20 p-3 text-xs sm:grid-cols-2">
          <div>
            <p className="text-[#8b8fa3]">Rental item</p>
            <p className="mt-1 font-medium text-[#e4e6eb]">
              {item?.found ? item.display_name : session.context.displayName}
            </p>
          </div>
          <div>
            <p className="text-[#8b8fa3]">Rental request</p>
            <p className="mt-1 font-medium text-[#e4e6eb]">
              {rentalPeriodLabel(session.context.startDate, session.context.endDate)}
            </p>
          </div>
          <div>
            <p className="text-[#8b8fa3]">Request total</p>
            <p className="mt-1 font-medium text-[#e4e6eb]">
              {order === undefined ? "Loading price…" : order?.total_gbp == null ? "Price not available" : poundAmount(order.total_gbp)}
            </p>
          </div>
          <div>
            <p className="text-[#8b8fa3]">Pickup and return times</p>
            <p className="mt-1 font-medium text-[#e4e6eb]">To confirm in the chat</p>
          </div>
        </div>
        {item?.found === false && (
          <p className="mt-2 text-xs text-red-300">This item is missing from the isolated Lab catalogue, so the chat is paused.</p>
        )}
      </div>

      <div className="min-h-48 space-y-3 p-4" aria-live="polite">
        {turns.length === 0 && item?.found && order && (
          <p className="text-sm text-[#8b8fa3]">
            Rental details are loaded. Start with any message; the bot can look up the item and request details as the conversation needs them.
          </p>
        )}
        {turns.map((turn, index) => (
          <div
            key={index + "-" + turn.role}
            className={"max-w-[88%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm " +
              (turn.role === "renter" ? "ml-auto bg-blue-500/20 text-blue-100" : "bg-white/[0.06] text-[#e4e6eb]")}
          >
            {turn.text}
          </div>
        ))}
        {sending && <p className="text-xs text-[#8b8fa3]">Generating the isolated test reply…</p>}
        {error && <p className="rounded-md bg-red-400/10 p-2 text-xs text-red-200" role="alert">{error}</p>}
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
            disabled={!item?.found || order == null || sending}
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
