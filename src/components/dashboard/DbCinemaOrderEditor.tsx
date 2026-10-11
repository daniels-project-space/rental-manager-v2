"use client";
import {
  rentalCalendarParts,
  rentalCalendarTimestamp,
} from "@/lib/rental-calendar-time";
import { useAction } from "convex/react";
import { makeFunctionReference } from "convex/server";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DbCinemaEquipmentEditor,
  type EquipmentLine,
} from "./DbCinemaEquipmentEditor";
import styles from "./ReplyInbox.module.css";
const detailsRef = makeFunctionReference<"action">(
  "dbcinema_chat:rentalControls",
);
const previewRef = makeFunctionReference<"action">(
  "dbcinema_chat:previewRentalDates",
);
const datesRef = makeFunctionReference<"action">(
  "dbcinema_chat:applyRentalDates",
);
const refundRef = makeFunctionReference<"action">("dbcinema_chat:refundRental");
type Details = {
  status: string;
  total: number;
  depositHoldAmount: number;
  snapshot: string;
  canChangeDates: boolean;
  canAddEquipment: boolean;
  canRemoveEquipment: boolean;
  lines: EquipmentLine[];
  refunds: Array<{ status: string; amountPence: number }>;
};
type Proposal = {
  start: number;
  end: number;
  reason: string;
  keep_agreed_price: boolean;
  controlsSnapshot: string;
};
const money = (amount: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(
    amount,
  );
export function DbCinemaOrderEditor({
  bookingId,
  calendar,
  initialAction,
  actionRevision,
}: {
  bookingId: string;
  initialAction?: "change" | "dates" | "discount" | "refund";
  actionRevision: number;
  calendar: (p: {
    start: string;
    end: string;
    busy: boolean;
    startTime: string;
    endTime: string;
    onReview: (
      start: string,
      end: string,
      startTime?: string,
      endTime?: string,
    ) => void;
    onCancel: () => void;
    revision: number;
    canReview: boolean;
  }) => ReactNode;
}) {
  const get = useAction(detailsRef),
    preview = useAction(previewRef),
    apply = useAction(datesRef),
    refund = useAction(refundRef);
  const [details, setDetails] = useState<Details | null>(null),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState("");
  const [reason, setReason] = useState(""),
    [keep, setKeep] = useState(false),
    [proposal, setProposal] = useState<Proposal | null>(null);
  const [amount, setAmount] = useState(""),
    [refundReason, setRefundReason] = useState(""),
    [refundReview, setRefundReview] = useState(false);
  const [calendarRevision, setCalendarRevision] = useState(0);
  const equipmentSection = useRef<HTMLElement | null>(null),
    datesSection = useRef<HTMLElement | null>(null),
    pricingSection = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!details || !initialAction) return;
    const target =
      initialAction === "change"
        ? equipmentSection
        : initialAction === "dates"
          ? datesSection
          : pricingSection;
    target.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [actionRevision, initialAction, !!details]);
  const requestId = useRef<string | null>(null),
    pendingRefund = useRef(false);
  const refresh = useCallback(
    async () => setDetails((await get({ booking_id: bookingId })) as Details),
    [get, bookingId],
  );
  useEffect(() => {
    let active = true;
    get({ booking_id: bookingId })
      .then((d) => {
        if (active) setDetails(d as Details);
      })
      .catch((e) => {
        if (active) setNote(e.message);
      });
    return () => {
      active = false;
    };
  }, [get, bookingId]);
  if (!details)
    return <p role="status">{note || "Loading rental controls…"}</p>;
  const locked = details.refunds.some((r) =>
    ["prepared", "pending"].includes(r.status),
  );
  async function review(
    start: string,
    end: string,
    startTime?: string,
    endTime?: string,
  ) {
    setBusy(true);
    setNote("");
    setProposal(null);
    try {
      const args = {
        start: startTime
          ? rentalCalendarTimestamp(start, startTime)
          : Date.parse(start + "T00:00:00Z"),
        end: endTime
          ? rentalCalendarTimestamp(end, endTime)
          : Date.parse(end + "T00:00:00Z"),
        reason,
        keep_agreed_price: keep,
      };
      const result = await preview({ booking_id: bookingId, ...args });
      if (!result.ok || !result.controlsSnapshot)
        throw Error(result.reason || "These dates could not be verified.");
      setProposal({ ...args, controlsSnapshot: result.controlsSnapshot });
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Date review failed.");
    } finally {
      setBusy(false);
    }
  }
  async function saveDates() {
    if (!proposal) return;
    setBusy(true);
    try {
      await apply({
        booking_id: bookingId,
        start: proposal.start,
        end: proposal.end,
        reason: proposal.reason,
        keep_agreed_price: proposal.keep_agreed_price,
        expected_snapshot: proposal.controlsSnapshot,
        operator_confirmed: true,
      });
      setProposal(null);
      setNote("Dates updated. Agreed charges and security are unchanged.");
      await refresh();
    } catch (e) {
      setProposal(null);
      setNote(
        e instanceof Error
          ? e.message
          : "Check the current rental before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function saveRefund() {
    setBusy(true);
    requestId.current ??= crypto.randomUUID();
    pendingRefund.current = true;
    try {
      const result = await refund({
        booking_id: bookingId,
        request_id: requestId.current,
        amount_pence: Math.round(Number(amount) * 100),
        reason: refundReason,
        operator_confirmed: true,
      });
      setNote(`${money(result.amount)} rental refund: ${result.status}.`);
      if (result.status !== "pending") {
        requestId.current = null;
        pendingRefund.current = false;
        setRefundReview(false);
      }
      await refresh();
    } catch (e) {
      setNote(
        e instanceof Error
          ? e.message
          : "Check the refund before retrying. The same request is retained.",
      );
    } finally {
      setBusy(false);
    }
  }
  const first = details.lines.length
    ? Math.min(...details.lines.map((l) => l.start))
    : Date.now();
  const last = details.lines.length
    ? Math.max(...details.lines.map((l) => l.end))
    : first;
  const pickup = rentalCalendarParts(first),
    returned = rentalCalendarParts(last);
  const start = pickup.date,
    end = returned.date;
  return (
    <div className={styles.sourceActions}>
      <section ref={equipmentSection}>
        <h4>1. Equipment</h4>
        <DbCinemaEquipmentEditor
          bookingId={bookingId}
          details={details}
          busy={busy}
          setBusy={setBusy}
          onNote={setNote}
          onRefresh={refresh}
        />
      </section>
      <section ref={datesSection}>
        <h4>2. Rental dates</h4>
        <p>Select dates and handover times.</p>
        <label>
          Reason
          <input
            aria-label="Date change reason"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setProposal(null);
            }}
            disabled={busy}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={keep}
            onChange={(e) => {
              setKeep(e.target.checked);
              setProposal(null);
            }}
            disabled={busy}
          />
          Keep the agreed charge; any extra days are complimentary.
        </label>
        {!details.canChangeDates || locked ? (
          <p>Finish any open rental operation before changing dates.</p>
        ) : (
          calendar({
            start,
            end,
            startTime: pickup.time,
            endTime: returned.time,
            busy,
            canReview: reason.trim().length >= 5,
            onReview: review,
            onCancel: () => {
              setProposal(null);
              setCalendarRevision((v) => v + 1);
            },
            revision: calendarRevision,
          })
        )}
        {proposal && (
          <div role="region" aria-label="Review date change">
            <p>
              {new Date(proposal.start).toLocaleString("en-GB", {
                timeZone: "Europe/London",
              })}{" "}
              –{" "}
              {new Date(proposal.end).toLocaleString("en-GB", {
                timeZone: "Europe/London",
              })}
              <br />
              Agreed rental charge {money(details.total)}. Security unchanged.
            </p>
            <button disabled={busy} onClick={saveDates}>
              Confirm date change
            </button>
            <button disabled={busy} onClick={() => setProposal(null)}>
              Cancel date change
            </button>
          </div>
        )}
      </section>
      <section ref={pricingSection}>
        <h4>3. Pricing</h4>
        <div className={styles.moneyOverview}>
          <div>
            <small>Rental payment</small>
            <strong>{money(details.total)}</strong>
          </div>
          <div>
            <small>Refund</small>
            <strong>{money(Number(amount) || 0)}</strong>
          </div>
          <div>
            <small>Payment change</small>
            <strong>{money(-(Number(amount) || 0))}</strong>
          </div>
        </div>
        <label>
          Rental refund (£)
          <input
            aria-label="Rental refund amount"
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            disabled={busy || pendingRefund.current}
            onChange={(e) => {
              setAmount(e.target.value);
              setRefundReview(false);
            }}
          />
        </label>
        <label>
          Reason
          <input
            aria-label="Rental refund reason"
            value={refundReason}
            disabled={busy || pendingRefund.current}
            onChange={(e) => {
              setRefundReason(e.target.value);
              setRefundReview(false);
            }}
          />
        </label>
        {!refundReview ? (
          <button
            disabled={
              busy ||
              locked ||
              !Number.isFinite(Number(amount)) ||
              Number(amount) <= 0 ||
              refundReason.trim().length < 5
            }
            onClick={() => setRefundReview(true)}
          >
            Review rental refund
          </button>
        ) : (
          <div role="region" aria-label="Review rental refund">
            <p>
              Refund {money(Number(amount))} from the rental payment.{" "}
              {refundReason}
            </p>
            <button disabled={busy} onClick={saveRefund}>
              {pendingRefund.current
                ? "Check existing refund"
                : "Confirm rental refund"}
            </button>
            {!pendingRefund.current && (
              <button disabled={busy} onClick={() => setRefundReview(false)}>
                Cancel refund
              </button>
            )}
          </div>
        )}
      </section>
      {note && <p role="status">{note}</p>}
    </div>
  );
}
