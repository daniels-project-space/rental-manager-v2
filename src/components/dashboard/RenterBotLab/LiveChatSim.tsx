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
              title="Photo attached to this ITEM in inventory (taken from a past rental) — it may show a bundle, and is not what the bot sees."
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
          <p className="text-[10px] text-[#8b8fa3]">
            item photo from a past rental — may show a fuller kit. The bot
            never sees images.
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

      {itemCtx?.found && (
        <details className="border-t border-white/10 px-4 py-2 text-xs">
          <summary className="cursor-pointer text-[#8b8fa3]">
            Full listing info (real catalog data)
          </summary>
          <div className="mt-2 space-y-1.5 text-[#e4e6eb]">
            {itemCtx.notes && <p>{itemCtx.notes}</p>}
            {itemCtx.qty != null && (
              <p className="text-[#8b8fa3]">
                Stock: {itemCtx.qty} {itemCtx.unit_kind ?? "unit"}
                {itemCtx.qty === 1 ? "" : "s"}
              </p>
            )}
            {!!itemCtx.included_with_rental?.length && (
              <p>
                <span className="text-[#8b8fa3]">Included: </span>
                {itemCtx.included_with_rental.join(", ")}
              </p>
            )}
            {!!itemCtx.compatible_lenses?.length && (
              <p>
                <span className="text-[#8b8fa3]">Compatible lenses: </span>
                {itemCtx.compatible_lenses.join(", ")}
              </p>
            )}
            {!!itemCtx.compatible_batteries?.length && (
              <p>
                <span className="text-[#8b8fa3]">Batteries: </span>
                {itemCtx.compatible_batteries.join(", ")}
              </p>
            )}
            {!!itemCtx.compatible_cards?.length && (
              <p>
                <span className="text-[#8b8fa3]">Cards: </span>
                {itemCtx.compatible_cards.join(", ")}
              </p>
            )}
            {!!itemCtx.compatible_accessories?.length && (
              <p>
                <span className="text-[#8b8fa3]">Accessories: </span>
                {itemCtx.compatible_accessories.join(", ")}
              </p>
            )}
            {itemCtx.delivery_notes && (
              <p>
                <span className="text-[#8b8fa3]">Delivery: </span>
                {itemCtx.delivery_notes}
              </p>
            )}
            {itemCtx.cancellation_policy && (
              <p>
                <span className="text-[#8b8fa3]">Pricing / cancellation notes: </span>
                {itemCtx.cancellation_policy}
              </p>
            )}
          </div>
        </details>
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


/**
 * The simulated Hygglo order for this session — what the bot has actually
 * changed, with the arithmetic shown.
 *
 * The point is verification: seeing "1x Blazar Remus 100mm @ £25/day x 2 days
 * = £50" next to the bot's prose is how you catch it adding the wrong item or
 * quoting a total that doesn't follow from the line items.
 */
function OrderPanel({ threadId }: { threadId: string }) {
  const order = useQuery(api.renter_bot_lab_order.get, { thread_id: threadId });
  if (!order) return null;
  const money = (n: number | null | undefined) =>
    typeof n === "number" ? `£${n}` : "—";
  return (
    <div className="border-t border-white/10 bg-black/25 px-4 py-3">
      <div className="mb-1.5 flex items-baseline justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8b8fa3]">
          Simulated booking
        </p>
        <p className="text-[11px] text-[#8b8fa3]">
          {order.start_date ?? "no dates"}
          {order.end_date && order.end_date !== order.start_date
            ? ` → ${order.end_date}`
            : ""}{" "}
          · {order.days} day{order.days === 1 ? "" : "s"}
        </p>
      </div>
      <table className="w-full text-[12px]">
        <tbody>
          {order.lines.length === 0 && (
            <tr>
              <td className="py-0.5 text-[#8b8fa3]">(nothing on the booking)</td>
            </tr>
          )}
          {order.lines.map((l, i) => (
            <tr key={i} className="text-[#e4e6eb]">
              <td className="py-0.5">
                {l.qty}× {l.name}
                {l.origin === "added" && (
                  <span className="ml-1.5 rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-300">
                    added by bot
                  </span>
                )}
              </td>
              <td className="py-0.5 text-right text-[#8b8fa3]">
                {l.effective_rate_gbp != null ? (
                  <>
                    £{Math.round(l.effective_rate_gbp)}/day
                    {l.tiers && (
                      <span className="ml-1 text-[10px] opacity-70">({l.tiers})</span>
                    )}
                  </>
                ) : (
                  "no price on file"
                )}
              </td>
              <td className="w-16 py-0.5 text-right tabular-nums">
                {money(l.line_total_gbp)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-white/10 font-semibold text-[#e4e6eb]">
            <td className="pt-1">Total</td>
            <td />
            <td className="pt-1 text-right tabular-nums">
              {order.total_gbp != null ? money(order.total_gbp) : "not calculable"}
            </td>
          </tr>
        </tfoot>
      </table>
      {order.unpriced.length > 0 && (
        <p className="mt-1 text-[11px] text-amber-400">
          No price on file for {order.unpriced.join(", ")} — the bot is told not
          to quote a total.
        </p>
      )}
      {order.changes.length > 0 && (
        <p className="mt-1.5 text-[11px] text-[#8b8fa3]">
          Changes: {order.changes.map((c) => c.summary).join(" · ")}
        </p>
      )}
    </div>
  );
}

/** Human-readable reason a draft was withheld, from the real guard flags. */
function blockReason(flags: unknown): string {
  const list = (flags as Array<{ type?: string; severity?: string; detail?: string }>) ?? [];
  const critical = list.filter((f) => f.severity === "critical");
  const shown = (critical.length ? critical : list).slice(0, 2);
  if (!shown.length) return "no flags recorded (check the run)";
  return shown.map((f) => `${f.type}: ${f.detail ?? ""}`.trim()).join(" | ");
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
          // An empty draft means the guard WITHHELD the reply. Saying only
          // "(empty draft)" hid the reason and made a real, reproducible
          // failure look like a glitch — the block reason was sitting in the
          // run row the whole time. Show it.
          text:
            result.draft ||
            `⚠ Reply withheld by the production guard — ${blockReason(result.productionGuardFlags)}`,
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
      <OrderPanel threadId={session.threadId} />
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
