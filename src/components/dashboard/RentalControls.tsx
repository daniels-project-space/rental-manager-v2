"use client";
import type { ReactNode } from "react";
import styles from "./RentalControls.module.css";
import { ProfilePortrait } from "./ProfilePortrait";
export type RentalControlTab = "gear" | "dates" | "pricing";
export type ReplacementCard = {
  id: string;
  name: string;
  image_url: string | null;
  can_apply: boolean;
  price_note: string;
};
/** The replacement picker is a separate, simple review flow. Source writes
 * remain delegated to the same guarded actions; sending is always explicit. */
export function RentalControls({
  name,
  portrait,
  identity,
  progress,
  gear,
  tab,
  onTab,
  onClose,
  editor,
  replacement,
  actions,
}: {
  name: string;
  portrait?: string | null;
  identity: ReactNode;
  progress: ReactNode;
  gear: ReactNode;
  tab: RentalControlTab;
  onTab: (tab: RentalControlTab) => void;
  onClose: () => void;
  editor?: ReactNode;
  actions: ReactNode;
  replacement?: {
    original: { name: string; image_url: string | null; qty: number };
    choices: ReplacementCard[];
    selected: string | null;
    text: string;
    busy: string | null;
    error: string | null;
    applied: boolean;
    sending: boolean;
    onSend: () => void;
    onChoose: (id: string) => void;
    onText: (text: string) => void;
    onApply: () => void;
    onUseReply: () => void;
    itemPicker?: ReactNode;
  };
}) {
  const selected = replacement?.choices.find(
    (choice) => choice.id === replacement.selected,
  );
  return (
    <aside
      className={`${styles.panel} ${replacement ? styles.replacementPanel : ""}`}
      aria-label="Rental controls"
    >
      <header className={styles.header}>
        <div>
          <small>
            {replacement ? "Keep the rental moving" : "Booking workspace"}
          </small>
          <h3>{replacement ? "Find a replacement" : "Rental controls"}</h3>
        </div>
        <button
          type="button"
          aria-label="Close rental controls"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className={styles.scroll}>
        {replacement ? (
          <section
            aria-label="Replacement options"
            className={styles.replacements}
          >
            <div className={styles.original}>
              {replacement.original.image_url ? (
                <img
                  data-no-zoom
                  src={replacement.original.image_url}
                  alt={replacement.original.name}
                />
              ) : (
                <span className={styles.noImage}>◇</span>
              )}
              <div>
                <span className={styles.unavailable}>Unavailable</span>
                <strong>{replacement.original.name}</strong>
                <small>{replacement.original.qty}× requested</small>
              </div>
            </div>
            {replacement.itemPicker && (
              <div className={styles.itemPicker}>{replacement.itemPicker}</div>
            )}
            <h4>
              <span>1</span> Choose an available alternative
            </h4>
            {replacement.busy === "stock" && (
              <div className={styles.loading} role="status">
                Checking alternatives for these rental dates…
              </div>
            )}
            <div className={styles.cards}>
              {replacement.choices.map((choice) => (
                <button
                  type="button"
                  key={choice.id}
                  aria-pressed={choice.id === replacement.selected}
                  className={
                    choice.id === replacement.selected ? styles.selected : ""
                  }
                  disabled={!!replacement.busy || replacement.applied}
                  onClick={() => replacement.onChoose(choice.id)}
                >
                  <span className={styles.check}>
                    {choice.id === replacement.selected ? "✓" : ""}
                  </span>
                  {choice.image_url ? (
                    <img
                      data-no-zoom
                      src={choice.image_url}
                      alt={choice.name}
                    />
                  ) : (
                    <span className={styles.noImage}>◇</span>
                  )}
                  <strong>{choice.name}</strong>
                  <span className={styles.available}>● Available</span>
                  <small>
                    {choice.id === replacement.selected
                      ? "Selected"
                      : "Choose this"}
                  </small>
                </button>
              ))}
            </div>
            {replacement.error && (
              <p className={styles.error} role="alert">
                {replacement.error}
              </p>
            )}
            {selected && (
              <>
                <h4>
                  <span>2</span> Review your reply
                </h4>
                <label className={styles.preview}>
                  <span>
                    Prepared from this conversation <small>Editable</small>
                  </span>
                  <textarea
                    aria-label="AI replacement reply"
                    placeholder="Writing a reply from this conversation…"
                    rows={4}
                    disabled={
                      replacement.busy === "apply" ||
                      replacement.busy === "draft" ||
                      replacement.sending
                    }
                    value={replacement.text}
                    onChange={(event) => replacement.onText(event.target.value)}
                  />
                </label>
                {replacement.busy === "draft" && (
                  <p role="status" className={styles.hint}>
                    Preparing your reply…
                  </p>
                )}
                <p className={styles.hint}>{selected.price_note}</p>
                {!selected.can_apply && (
                  <p className={styles.hint}>
                    This request cannot be edited yet. Send the offer so the
                    renter can choose.
                  </p>
                )}
                {replacement.applied && (
                  <p className={styles.success} role="status">
                    ✓ Booking updated. Your reply is ready to send.
                  </p>
                )}
                <button
                  type="button"
                  className={styles.editInChat}
                  disabled={
                    !!replacement.busy ||
                    replacement.sending ||
                    !replacement.text.trim()
                  }
                  onClick={replacement.onUseReply}
                >
                  Edit in chat ↗
                </button>
              </>
            )}
          </section>
        ) : (
          <>
            <div className={styles.identity}>
              <ProfilePortrait
                src={portrait}
                name={name}
                className={styles.initials}
              />
              <div>
                <strong>{name}</strong>
                {identity}
              </div>
            </div>
            <div className={styles.progress}>{progress}</div>
            <div
              className={styles.tabs}
              role="tablist"
              aria-label="Rental settings"
            >
              {(
                [
                  ["gear", "Gear"],
                  ["dates", "Dates"],
                  ["pricing", "Pricing"],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  key={value}
                  onClick={() => onTab(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === "gear" && (
              <>
                <h4>Requested equipment</h4>
                <div className={styles.gear}>{gear}</div>
              </>
            )}
            {editor}
          </>
        )}
      </div>
      {replacement ? (
        <footer className={styles.footer}>
          {selected && (
            <>
              {selected.can_apply && (
                <button
                  type="button"
                  className={styles.approve}
                  disabled={
                    !!replacement.busy ||
                    replacement.sending ||
                    replacement.applied
                  }
                  onClick={replacement.onApply}
                >
                  {replacement.busy === "apply"
                    ? "Updating booking…"
                    : replacement.applied
                      ? "✓ Booking updated"
                      : "Use replacement in booking"}
                </button>
              )}
              <button
                type="button"
                className={styles.send}
                disabled={
                  !!replacement.busy ||
                  replacement.sending ||
                  !replacement.text.trim()
                }
                onClick={replacement.onSend}
              >
                {replacement.sending ? "Sending…" : "Send replacement offer"}
              </button>
              <small>Only Send delivers this reply to the renter.</small>
            </>
          )}
        </footer>
      ) : (
        <footer className={styles.footer}>
          <div className={styles.actions}>
            <h4>Booking actions</h4>
            {actions}
          </div>
        </footer>
      )}
    </aside>
  );
}
