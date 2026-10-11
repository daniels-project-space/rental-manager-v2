"use client";
import { useAction } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useEffect, useRef, useState } from "react";
import { ItemImage } from "./RequestedItemStack";
import styles from "./DbCinemaEquipmentEditor.module.css";
const catalogRef = makeFunctionReference<"action">(
  "dbcinema_chat:equipmentCatalog",
);
const previewRef = makeFunctionReference<"action">(
  "dbcinema_chat:previewEquipmentAddition",
);
const addRef = makeFunctionReference<"action">("dbcinema_chat:addEquipment");
const removeRef = makeFunctionReference<"action">(
  "dbcinema_chat:removeEquipment",
);
export type EquipmentLine = {
  listing_id: string;
  line_index: number;
  name: string;
  qty: number;
  start: number;
  end: number;
  image_url: string | null;
  image_urls?: string[];
};
type Choice = {
  listingId: string;
  title: string;
  imageSources: string[];
  daily: number;
};
type Quote = {
  ok: boolean;
  reason?: string;
  snapshot: string;
  quoteSnapshot: string;
  title: string;
  qty: number;
  start: number;
  end: number;
  lineTotal: number;
  securityCharge: number;
  holdTotal: number;
  imageSources: string[];
};
const money = (v: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(
    v,
  );
const date = (v: number) =>
  new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
export function DbCinemaEquipmentEditor({
  bookingId,
  details,
  busy,
  setBusy,
  onNote,
  onRefresh,
}: {
  bookingId: string;
  details: {
    snapshot: string;
    canAddEquipment: boolean;
    canRemoveEquipment: boolean;
    lines: EquipmentLine[];
  };
  busy: boolean;
  setBusy: (v: boolean) => void;
  onNote: (v: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const catalog = useAction(catalogRef),
    preview = useAction(previewRef),
    add = useAction(addRef),
    remove = useAction(removeRef);
  const [mode, setMode] = useState<"add" | "remove" | null>(null),
    [choices, setChoices] = useState<Choice[]>([]),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState<Choice | null>(null),
    [line, setLine] = useState<EquipmentLine | null>(null),
    [qty, setQty] = useState(1),
    [reason, setReason] = useState(""),
    [complimentary, setComplimentary] = useState(false),
    [quote, setQuote] = useState<Quote | null>(null),
    [removalSnapshot, setRemovalSnapshot] = useState<string | null>(null),
    [localNote, setLocalNote] = useState(""),
    [retry, setRetry] = useState(false);
  const requestId = useRef<string | null>(null);
  const reviewSection = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (quote || removalSnapshot)
      reviewSection.current?.scrollIntoView({
        block: "start",
        behavior: "instant",
      });
  }, [quote, removalSnapshot]);
  const image = (c: Choice) => ({
    name: c.title,
    qty: 1,
    image_url: c.imageSources[0] ?? null,
    image_urls: c.imageSources,
  });
  function reset() {
    setMode(null);
    setSelected(null);
    setLine(null);
    setQuote(null);
    setRemovalSnapshot(null);
    setReason("");
    setQty(1);
    setComplimentary(false);
    setLocalNote("");
    setRetry(false);
    requestId.current = null;
  }
  async function browse(term = search) {
    setBusy(true);
    setLocalNote("");
    try {
      setChoices((await catalog({ search: term })) as Choice[]);
    } catch (e) {
      setLocalNote(e instanceof Error ? e.message : "Equipment search failed.");
    } finally {
      setBusy(false);
    }
  }
  async function review() {
    if (!selected) return;
    setBusy(true);
    setLocalNote("");
    try {
      const r = (await preview({
        booking_id: bookingId,
        listing_id: selected.listingId,
        qty,
        reason,
        complimentary,
      })) as Quote;
      if (!r.ok || !r.snapshot || !r.quoteSnapshot)
        throw Error(r.reason || "The complete rental could not be verified.");
      setQuote(r);
    } catch (e) {
      setLocalNote(e instanceof Error ? e.message : "Equipment review failed.");
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!quote && !removalSnapshot) return;
    setBusy(true);
    setLocalNote("");
    requestId.current ??= crypto.randomUUID();
    setRetry(true);
    try {
      if (mode === "add" && selected && quote) {
        const r = (await add({
          booking_id: bookingId,
          listing_id: selected.listingId,
          request_id: requestId.current,
          qty,
          reason,
          complimentary,
          expected_snapshot: quote.snapshot,
          expected_quote: quote.quoteSnapshot,
          operator_confirmed: true,
        })) as { applied: boolean; review_required?: boolean };
        if (r.review_required) {
          reset();
          onNote(
            "The rental or equipment quote changed. Review the current kit again.",
          );
          await onRefresh();
          return;
        }
        onNote(
          r.applied
            ? "Equipment added. Agreed rental charges are unchanged."
            : "Addition prepared. The renter's payment link is in their DB Cinema conversation; the kit updates after payment and any security approval.",
        );
      } else if (mode === "remove" && line && removalSnapshot) {
        const r = (await remove({
          booking_id: bookingId,
          listing_id: line.listing_id,
          request_id: requestId.current,
          line_index: line.line_index,
          qty: line.qty,
          start: line.start,
          end: line.end,
          reason,
          expected_snapshot: removalSnapshot,
          operator_confirmed: true,
        })) as { review_required?: boolean };
        if (r.review_required) {
          reset();
          onNote("The rental changed. Review the current kit again.");
          await onRefresh();
          return;
        }
        onNote(
          "Equipment removed and stock released. Agreed charges and security are unchanged. The renter has been notified.",
        );
      } else throw Error("Review the equipment change first.");
      reset();
      await onRefresh();
    } catch (e) {
      setLocalNote(
        (e instanceof Error ? e.message : "The result could not be verified.") +
          " Check this saved request before starting another change.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={styles.editor}
      data-equipment-editing={mode ? "true" : "false"}
    >
      <div className={styles.lines}>
        {details.lines.map((l) => (
          <div className={styles.line} key={`${l.line_index}-${l.listing_id}`}>
            <div className={styles.photo}>
              <ItemImage item={l} />
            </div>
            <div className={styles.lineText}>
              <strong>{l.name}</strong>
              <small>
                {l.qty}× · {date(l.start)} – {date(l.end)}
              </small>
            </div>
            <button
              type="button"
              disabled={busy || !!mode || !details.canRemoveEquipment}
              aria-label={`Remove ${l.name}`}
              onClick={() => {
                reset();
                setMode("remove");
                setLine(l);
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      {!mode && (
        <button
          type="button"
          className={styles.addButton}
          disabled={busy || !details.canAddEquipment}
          onClick={() => {
            reset();
            setMode("add");
            void browse("");
          }}
        >
          ＋ Add equipment
        </button>
      )}
      {!mode && !details.canAddEquipment && (
        <p className={styles.note}>
          Finish the current rental operation before changing equipment.
        </p>
      )}
      {mode && (
        <section
          ref={reviewSection}
          className={styles.selection}
          aria-label={
            mode === "add"
              ? "Add DB Cinema equipment"
              : "Remove DB Cinema equipment"
          }
        >
          <header>
            <h5>{mode === "add" ? "Add equipment" : "Remove equipment"}</h5>
            {!retry && (
              <button type="button" disabled={busy} onClick={reset}>
                Cancel
              </button>
            )}
          </header>
          {mode === "add" && !selected && (
            <>
              <form
                className={styles.search}
                onSubmit={(e) => {
                  e.preventDefault();
                  void browse();
                }}
              >
                <input
                  aria-label="Search DB Cinema equipment"
                  value={search}
                  maxLength={120}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search equipment…"
                  disabled={busy}
                />
                <button disabled={busy}>Search</button>
              </form>
              <div className={styles.choices}>
                {choices.map((c) => (
                  <button
                    type="button"
                    key={c.listingId}
                    disabled={busy}
                    onClick={() => setSelected(c)}
                    aria-label={`Choose ${c.title}`}
                  >
                    <div className={styles.photo}>
                      <ItemImage item={image(c)} />
                    </div>
                    <strong>{c.title}</strong>
                    <small>From {money(c.daily)} / day</small>
                  </button>
                ))}
              </div>
              {!busy && !choices.length && (
                <p className={styles.note}>
                  No bookable equipment matches. Try another search.
                </p>
              )}
              <p className={styles.note}>
                Stock and the complete price are checked before you confirm.
              </p>
            </>
          )}
          {(selected || line) && (
            <>
              <div className={styles.selected}>
                <div className={styles.photo}>
                  <ItemImage item={selected ? image(selected) : line!} />
                </div>
                <strong>{selected?.title ?? line?.name}</strong>
                {selected && !quote && !retry && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setSelected(null)}
                  >
                    Change
                  </button>
                )}
              </div>
              {!quote && !removalSnapshot && (
                <>
                  {mode === "add" && (
                    <div className={styles.quantity}>
                      <label>
                        Quantity
                        <input
                          aria-label="Equipment quantity"
                          type="number"
                          min={1}
                          max={20}
                          value={qty}
                          disabled={busy}
                          onChange={(e) => setQty(Number(e.target.value))}
                        />
                      </label>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={complimentary}
                          disabled={busy}
                          onChange={(e) => setComplimentary(e.target.checked)}
                        />
                        Complimentary rental charge
                      </label>
                      <small>
                        Any required refundable security still applies.
                      </small>
                    </div>
                  )}
                  <label className={styles.reason}>
                    Reason
                    <input
                      aria-label="Equipment change reason"
                      maxLength={400}
                      value={reason}
                      disabled={busy}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Why is the kit changing?"
                    />
                  </label>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={
                      busy ||
                      reason.trim().length < 5 ||
                      (mode === "add" &&
                        (!Number.isInteger(qty) || qty < 1 || qty > 20))
                    }
                    onClick={() =>
                      mode === "add"
                        ? void review()
                        : setRemovalSnapshot(details.snapshot)
                    }
                  >
                    Review {mode === "add" ? "addition" : "removal"}
                  </button>
                </>
              )}
              {(quote || removalSnapshot) && (
                <div
                  className={styles.review}
                  role="region"
                  aria-label="Review equipment change"
                >
                  {quote ? (
                    <>
                      <span className={styles.verified}>
                        ✓ Complete kit stock verified
                      </span>
                      <p>
                        {quote.qty}× · {date(quote.start)} – {date(quote.end)}
                      </p>
                      <dl>
                        <div>
                          <dt>Added rental charge</dt>
                          <dd>{money(quote.lineTotal)}</dd>
                        </div>
                        <div>
                          <dt>Extra refundable payment</dt>
                          <dd>{money(quote.securityCharge)}</dd>
                        </div>
                        <div>
                          <dt>Resulting security hold</dt>
                          <dd>{money(quote.holdTotal)}</dd>
                        </div>
                      </dl>
                      <p>
                        The renter receives a payment link if payment or
                        security approval is needed. The kit updates after
                        approval.
                      </p>
                    </>
                  ) : (
                    <p>
                      Remove {line?.qty}× {line?.name}. The renter will be
                      notified. Agreed charges and security stay unchanged; any
                      refund is handled separately.
                    </p>
                  )}
                  <p className={styles.note}>{reason}</p>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={busy}
                    onClick={() => void confirm()}
                  >
                    {retry
                      ? "Check saved equipment change"
                      : mode === "add"
                        ? "Confirm equipment addition"
                        : "Confirm equipment removal"}
                  </button>
                  {!retry && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setQuote(null);
                        setRemovalSnapshot(null);
                      }}
                    >
                      Edit change
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          {localNote && (
            <p className={styles.error} role="status">
              {localNote}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
