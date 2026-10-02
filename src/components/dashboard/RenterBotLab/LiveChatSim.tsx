"use client";

import { useEffect, useRef, useState } from "react";
import { formatGbp } from "../../../../convex/lib/hygglo_pricing";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";

export interface SessionContext {
  items: string[];
  lifecycle?: string;
  productId?: number;
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
  productId,
  threadId,
  accountSlug,
  initialStartDate,
  initialEndDate,
}: {
  itemName: string;
  productId?: number;
  threadId: string;
  accountSlug: string;
  initialStartDate?: string;
  initialEndDate?: string;
}) {
  const [startDate, setStartDate] = useState(initialStartDate || todayIso());
  const [endDate, setEndDate] = useState(
    initialEndDate || initialStartDate || todayIso(),
  );
  const applyChange = useMutation(api.renter_bot_lab_order.applyChange);
  const [savingDates, setSavingDates] = useState(false);
  const [dateFeedback, setDateFeedback] = useState("");
  async function applyDates() {
    setSavingDates(true);
    try {
      const result = await applyChange({ thread_id: threadId, action: "set_dates", start_date: startDate, end_date: endDate });
      setDateFeedback(result.ok ? "Simulation dates updated" : result.error ?? "Dates could not be updated");
    } catch {
      setDateFeedback("Dates could not be updated");
    } finally {
      setSavingDates(false);
    }
  }

  const itemCtx = useQuery(api.renter_bot_lab_actions.getItemContext, {
    itemName, productId, accountSlug,
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
  const stock = useQuery(api.renter_bot_tools.check_availability, rangeValid ? { item_name: itemName, product_id: productId, account_slug: accountSlug, thread_id: threadId, quantity: 1, start_date: startDate, end_date: endDate } : "skip");
  const rangeFree = rangeValid && stock?.available === true;
  const days = rangeValid ? Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1 : 0;
  const quote = useQuery(api.renter_bot_tools.lookup_pricing, days > 0 && days <= 366 ? { item_name: itemName, account_slug: accountSlug, days } : "skip");

  return (
    <div className="border-b border-white/10 bg-black/20">
      <div className="flex gap-3 p-4">
        <div className="h-20 w-20 shrink-0 overflow-hidden rounded-md bg-white/[0.06] sm:h-32 sm:w-32">
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

        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-base font-semibold text-[#e4e6eb]">
            {itemCtx?.display_name ?? itemCtx?.name ?? itemName}
            {productId == null && itemCtx && !itemCtx.found && (
              <span className="ml-1.5 text-xs font-normal text-amber-400">
                (not found in real catalog)
              </span>
            )}
          </p>
          <p className="text-[10px] text-[#8b8fa3]">
            Listing photo; confirmed kit contents are shown below.
          </p>
          <p className="text-xs text-[#8b8fa3]">
            {itemCtx?.kind ? `${itemCtx.kind} · ` : ""}
            {quote === undefined ? "Checking price…" : quote?.found && "daily_rate_gbp" in quote
              ? `£${quote.daily_rate_gbp}/day${quote.listed_total_gbp != null ? ` · £${quote.listed_total_gbp} for ${days} days` : " · total needs confirmation"}`
              : "Price needs confirmation"}
          </p>

          <div className="flex flex-wrap items-end gap-2 pt-1">
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
            <button type="button" disabled={!rangeValid || savingDates} onClick={applyDates} className="mb-0.5 rounded-md bg-white/10 px-2 py-1 text-[11px] disabled:opacity-40">
              {savingDates ? "Saving…" : "Apply dates"}
            </button>
            <span
              className={`mb-0.5 rounded-full px-2 py-1 text-[11px] font-medium ${
                stock === undefined
                  ? "bg-white/10 text-[#8b8fa3]"
                  : rangeFree
                    ? "bg-emerald-500/15 text-emerald-400"
                    : "bg-red-500/15 text-red-400"
              }`}
            >
              {stock === undefined
                ? "checking…"
                : stock.available === null
                  ? "Availability needs clarification"
                  : stock.owned === false
                    ? "Not rentable from owned inventory"
                    : rangeFree
                      ? `Free for these dates (${stock.free_units} ${productId != null ? "kits" : "units"})`
                      : "Unavailable for these dates"}
            </span>
          </div>
          {dateFeedback && <p role="status" className="pt-1 text-[11px] text-[#8b8fa3]">{dateFeedback}</p>}
        </div>
      </div>

      {stock && "components" in stock && (
        <div className="border-t border-white/10 px-4 py-2">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[#8b8fa3]">Kit stock for selected dates</p>
          {stock.components.map((component, index) => (
            <p key={index} className="text-xs text-[#e4e6eb]">
              {component.item_name}: {component.requested_units} required · {component.free_units ?? "unknown"} free
            </p>
          ))}
        </div>
      )}
      {productId == null && conflicts.length > 0 && (
        <div className="border-t border-white/10 px-4 py-2">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[#8b8fa3]">
            Existing commitments (included in the stock check)
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
      {productId == null && match?.owned && match.next_free_date && !rangeFree && conflicts.length === 0 && (
        <div className="border-t border-white/10 px-4 py-2 text-xs text-[#8b8fa3]">
          Next confirmed-free date on file: {match.next_free_date}
        </div>
      )}

      {itemCtx?.found && (
        <details className="border-t border-white/10 px-4 py-2 text-xs">
          <summary className="cursor-pointer text-[#8b8fa3]">
            Item details
          </summary>
          <div className="mt-2 space-y-1.5 text-[#e4e6eb]">
            {itemCtx.raw_title && <p><span className="text-[#8b8fa3]">Original listing: </span>{itemCtx.raw_title}</p>}
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

function ContextBanner({ context, threadId, accountSlug }: { context: SessionContext; threadId: string; accountSlug: string }) {
  const order = useQuery(api.renter_bot_lab_order.get, { thread_id: threadId });
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
          productId={context.productId}
          threadId={threadId}
          accountSlug={accountSlug}
          initialStartDate={context.startDate}
          initialEndDate={context.endDate}
        />
      )}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-b border-white/10 bg-black/20 px-4 py-2 sm:grid-cols-4">
        {row(
          "All items",
          order?.lines.length ? order.lines.map((l) => `${l.qty}× ${l.display_name ?? l.name}`).join(", ") : context.items.length ? context.items.join(", ") : "not set",
        )}
        {row("Simulation dates", order?.start_date ? `${order.start_date} → ${order.end_date}` : context.dates || (context.startDate ? `${context.startDate} → ${context.endDate}` : "not set"))}
        {row("Stage", context.lifecycle?.replace(/_/g, " ") || "inquiry")}
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
                {l.qty}× {l.display_name ?? l.name}
                {l.origin === "added" && (
                  <span className="ml-1.5 rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-300">
                    added by bot
                  </span>
                )}
              </td>
              <td className="py-0.5 text-right text-[#8b8fa3]">
                {l.effective_rate_gbp != null ? (
                  <>
                    ~£{formatGbp(l.effective_rate_gbp)}/day
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
  session: initialSession,
}: {
  session: { threadId: string; accountSlug: string; context: SessionContext };
}) {
  const [session, setSession] = useState(initialSession);
  const createdFriendThreads = useRef<string[]>([]);
  const endLiveSession = useAction(api.renter_bot_lab_actions.endLiveSession);
  useEffect(() => () => { for (const threadId of createdFriendThreads.current) void endLiveSession({ threadId }); }, [endLiveSession]);
  const startLiveSession = useAction(api.renter_bot_lab_actions.startLiveSession);
  const simulateFailure = useMutation(api.renter_bot_lab_order.simulateVerificationFailure);
  const redeemReferral = useMutation(api.renter_bot_lab_order.redeemReferral);
  const currentOrder = useQuery(api.renter_bot_lab_order.get, { thread_id: session.threadId });
  const [failureFeedback, setFailureFeedback] = useState("");
  const [referralInput, setReferralInput] = useState("");
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
            `⚠ Reply withheld — ${result.reason ?? blockReason(result.productionGuardFlags)}`,
          overallStatus: result.status.startsWith("referral_") ? undefined : result.overall_status,
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

  async function failVerification() {
    setSending(true);
    try {
      const result = await simulateFailure({ thread_id: session.threadId, referral_code: crypto.randomUUID() });
      setTurns(t => [...t, { role: "bot", text: result.message }]);
      setFailureFeedback("Final failed check: simulated booking cancelled. Basket preserved for referral.");
    } catch (e) { setFailureFeedback(e instanceof Error ? e.message : String(e)); }
    finally { setSending(false); }
  }
  async function startFriend() {
    if (!referralInput.trim() || sending) return;
    setSending(true);
    let threadId: string | undefined;
    try {
      const friend = await startLiveSession({ accountSlug: session.accountSlug, items: [], lifecycle: "inquiry" });
      threadId = friend.threadId;
      const restored = await redeemReferral({ thread_id: threadId, code: referralInput.trim() });
      if (!restored.ok) throw new Error(restored.error ?? "Could not restore the basket");
      createdFriendThreads.current.push(threadId);
      setSession({ threadId, accountSlug: session.accountSlug, context: { ...friend.context, items: restored.order?.lines.map(l => l.name) ?? [], startDate: restored.order?.start_date ?? undefined, endDate: restored.order?.end_date ?? undefined } });
      setTurns([{ role: "bot", text: "Friend referral recognised. Your basket has been restored with current stock and prices. This is a new request from your own account and still needs the platform's checks." }]);
      setFailureFeedback("Separate friend inquiry — no verification, payment or approval transferred.");
      setReferralInput("");
    } catch (e) {
      if (threadId) await endLiveSession({ threadId });
      setFailureFeedback(e instanceof Error ? e.message : String(e));
    } finally { setSending(false); }
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
    <div className="flex min-h-[560px] flex-col rounded-lg border border-white/10 bg-white/[0.03]">
      <ContextBanner context={session.context} threadId={session.threadId} accountSlug={session.accountSlug} />
      <div className="max-h-[420px] min-h-[120px] flex-1 space-y-3 overflow-y-auto p-4">
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
      <div className="border-t border-white/10 p-3 text-xs text-[#8b8fa3]">
        <p>Current platform stage: {currentOrder?.stage?.replace(/_/g, " ") ?? "loading"}</p>
        <button disabled={sending || currentOrder?.stage !== "AWAITING_VERIFICATION"} onClick={failVerification} className="my-2 rounded bg-red-500/20 px-3 py-2 text-red-200 disabled:opacity-40">Simulate final failed verification</button>
        {currentOrder?.referral_code && <p className="break-all">Basket referral: {currentOrder.referral_code}</p>}
        <div className="mt-2 flex gap-2">
          <input aria-label="Friend basket referral" value={referralInput} onChange={e => setReferralInput(e.target.value)} placeholder="Friend's basket referral code" className="min-w-0 flex-1 rounded bg-black/30 p-2" />
          <button disabled={sending || !referralInput.trim()} onClick={startFriend} className="rounded bg-white/10 p-2 disabled:opacity-40">Start friend's own request</button>
        </div>
        {failureFeedback && <p className="mt-2">{failureFeedback}</p>}
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
