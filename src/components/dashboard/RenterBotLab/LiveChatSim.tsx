"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";

export interface SessionContext {
  items: string[];
  priceGbp?: number;
  dates?: string;
  startDate?: string;
  endDate?: string;
  location?: string;
}

interface ChatTurn {
  role: "renter" | "bot";
  text: string;
  overallStatus?: string;
  runId?: string;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

function overlapsBooking(
  selStart: string,
  selEnd: string,
  booking: { pickup: string; return: string },
): boolean {
  const bStart = booking.pickup.slice(0, 10);
  const bEnd = booking.return.slice(0, 10);
  return bStart <= selEnd && bEnd >= selStart;
}

// Simulated listing card: real image, real price/specs, and a real editable
// date-range picker checked against the SAME live booking data the bot's own
// check_availability tool reads — not a mock (Daniel, 2026-08-17).
function RentalListingCard({
  itemName,
  initialStartDate,
  initialEndDate,
}: {
  itemName: string;
  initialStartDate?: string;
  initialEndDate?: string;
}) {
  const [startDate, setStartDate] = useState(initialStartDate || todayIso());
  const [endDate, setEndDate] = useState(
    initialEndDate || initialStartDate || todayIso(),
  );

  const itemCtx = useQuery(api.renter_bot_lab_actions.getItemContext, {
    itemName,
  });
  // Wide horizon so upcoming_bookings covers whatever range gets picked.
  const avail = useQuery(api.calendar.getItemAvailabilityForChat, {
    query: itemName,
    horizonDays: 60,
    accountSlug: null,
  });
  const match = avail?.items?.[0];

  const conflicts = (match?.upcoming_bookings ?? []).filter((b) =>
    overlapsBooking(startDate, endDate, b),
  );
  const rangeValid = startDate && endDate && endDate >= startDate;
  const rangeFree = rangeValid && match?.owned && conflicts.length === 0;

  return (
    <div className="border-b border-white/10 bg-black/20">
      <div className="flex gap-4 p-4">
        <div className="h-32 w-32 shrink-0 overflow-hidden rounded-md bg-white/[0.06]">
          {itemCtx?.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={itemCtx.image_url}
              alt={itemCtx.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[11px] text-[#8b8fa3]">
              {itemCtx === undefined ? "…" : "no image"}
            </div>
          )}
        </div>

        <div className="flex-1 space-y-1.5">
          <p className="text-base font-semibold text-[#e4e6eb]">
            {itemCtx?.name ?? itemName}
            {itemCtx && !itemCtx.found && (
              <span className="ml-1.5 text-xs font-normal text-amber-400">
                (not found in real catalog)
              </span>
            )}
          </p>
          <p className="text-xs text-[#8b8fa3]">
            {itemCtx?.kind ? `${itemCtx.kind} · ` : ""}
            {itemCtx?.daily_price_min != null
              ? `£${itemCtx.daily_price_min}${
                  itemCtx.daily_price_max &&
                  itemCtx.daily_price_max !== itemCtx.daily_price_min
                    ? `–£${itemCtx.daily_price_max}`
                    : ""
                }/day`
              : "no real price on file"}
            {" · real pricing_catalog + items rate"}
          </p>

          <div className="flex items-end gap-2 pt-1">
            <label className="text-[11px] text-[#8b8fa3]">
              Pickup
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-0.5 block rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs text-[#e4e6eb]"
              />
            </label>
            <label className="text-[11px] text-[#8b8fa3]">
              Return
              <input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="mt-0.5 block rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs text-[#e4e6eb]"
              />
            </label>
            <span
              className={`mb-0.5 rounded-full px-2 py-1 text-[11px] font-medium ${
                avail === undefined
                  ? "bg-white/10 text-[#8b8fa3]"
                  : rangeFree
                    ? "bg-emerald-500/15 text-emerald-400"
                    : "bg-red-500/15 text-red-400"
              }`}
            >
              {avail === undefined
                ? "checking…"
                : !match
                  ? "no calendar match"
                  : !match.owned
                    ? "marketing-only, no stock"
                    : rangeFree
                      ? "Free for these dates"
                      : "Conflicts with a real booking"}
            </span>
          </div>
        </div>
      </div>

      {conflicts.length > 0 && (
        <div className="border-t border-white/10 px-4 py-2">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[#8b8fa3]">
            Currently rented out (real bookings, this is why it&apos;s not free)
          </p>
          {conflicts.map((b, i) => (
            // Renter name deliberately not shown — this page has no access
            // gate (removed per Daniel, 2026-08-17), and a real customer's
            // name isn't needed to test availability behavior.
            <p key={i} className="text-xs text-[#e4e6eb]">
              Existing booking: {b.pickup} → {b.return}
              {b.account ? ` (${b.account})` : ""}
            </p>
          ))}
        </div>
      )}
      {match?.owned && match.next_free_date && !rangeFree && conflicts.length === 0 && (
        <div className="border-t border-white/10 px-4 py-2 text-xs text-[#8b8fa3]">
          Next confirmed-free date on file: {match.next_free_date}
        </div>
      )}
    </div>
  );
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
    <div>
      {context.items[0] && (
        <RentalListingCard
          itemName={context.items[0]}
          initialStartDate={context.startDate}
          initialEndDate={context.endDate}
        />
      )}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-b border-white/10 bg-black/20 px-4 py-2 sm:grid-cols-4">
        {row(
          "All items",
          context.items.length ? context.items.join(", ") : "not set",
        )}
        {row("Scenario dates", context.dates || "not set")}
        {row("Location", context.location || "not set")}
        {row(
          "Seed price",
          context.priceGbp != null ? `£${context.priceGbp}/day` : "not set",
        )}
      </div>
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
