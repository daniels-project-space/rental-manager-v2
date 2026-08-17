"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";

export interface SessionContext {
  items: string[];
  priceGbp?: number;
  dates?: string;
  location?: string;
}

interface ChatTurn {
  role: "renter" | "bot";
  text: string;
  overallStatus?: string;
  runId?: string;
}

function ContextBanner({ context }: { context: SessionContext }) {
  const row = (label: string, value: string) => (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-[#8b8fa3]">
        {label}
      </span>
      <span className="text-sm text-[#e4e6eb]">{value}</span>
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-b border-white/10 bg-black/20 px-4 py-3 sm:grid-cols-4">
      {row(
        "Items",
        context.items.length ? context.items.join(", ") : "not set",
      )}
      {row(
        "Price",
        context.priceGbp != null ? `£${context.priceGbp}/day` : "not set",
      )}
      {row("Dates", context.dates || "not set")}
      {row("Location", context.location || "not set")}
    </div>
  );
}

export function LiveChatSim({
  session,
}: {
  session: { threadId: string; accountSlug: string; context: SessionContext };
}) {
  const sendTestMessage = useAction(api.renter_bot_lab_actions.sendTestMessage);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setTurns((t) => [...t, { role: "renter", text }]);
    setSending(true);
    try {
      const result = await sendTestMessage({
        threadId: session.threadId,
        accountSlug: session.accountSlug,
        text,
      });
      setTurns((t) => [
        ...t,
        {
          role: "bot",
          text: result.draft || "(empty draft — see run for details)",
          overallStatus: result.overall_status,
          runId: result.runId,
        },
      ]);
    } catch (e) {
      setTurns((t) => [
        ...t,
        {
          role: "bot",
          text: `ERROR: ${e instanceof Error ? e.message : String(e)}`,
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  const statusColor = (s?: string) =>
    s === "pass"
      ? "text-emerald-400"
      : s === "fail"
        ? "text-red-400"
        : s === "flag"
          ? "text-amber-400"
          : "text-[#8b8fa3]";

  return (
    <div className="flex h-[560px] flex-col rounded-lg border border-white/10 bg-white/[0.03]">
      <ContextBanner context={session.context} />
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {turns.length === 0 && (
          <p className="text-sm text-[#8b8fa3]">
            Type as a renter below. Every reply is the real production draft
            pipeline — nothing here is sent anywhere. The bar above shows
            exactly what context the AI actually has for this conversation.
          </p>
        )}
        {turns.map((t, i) => (
          <div
            key={i}
            className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
              t.role === "renter"
                ? "ml-auto bg-blue-500/20 text-blue-100"
                : "bg-white/[0.06] text-[#e4e6eb]"
            }`}
          >
            <p className="whitespace-pre-wrap">{t.text}</p>
            {t.overallStatus && (
              <p className={`mt-1 text-[11px] font-medium ${statusColor(t.overallStatus)}`}>
                rubric: {t.overallStatus}
              </p>
            )}
          </div>
        ))}
        {sending && (
          <p className="text-xs text-[#8b8fa3]">Generating real draft…</p>
        )}
      </div>
      <div className="flex gap-2 border-t border-white/10 p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Type as the renter…"
          disabled={sending}
          className="flex-1 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-[#e4e6eb] outline-none focus:border-white/30 disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={sending || !input.trim()}
          className="rounded-md bg-white/10 px-4 py-2 text-sm font-medium text-[#e4e6eb] hover:bg-white/20 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
