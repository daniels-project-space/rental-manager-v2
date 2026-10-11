"use client";
import styles from "./RentalControls.module.css";
/** Changes are reviewed locally; only the explicit confirmation invokes a write. */
export function ChangeReview({
  title,
  before,
  after,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  before: string;
  after: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section
      className={styles.changeReview}
      role="region"
      aria-label={`Review ${title.toLowerCase()}`}
    >
      <h4>{title}</h4>
      <div className={styles.changeAmounts}>
        <div>
          <small>Current</small>
          <strong>{before}</strong>
        </div>
        <span aria-hidden="true">→</span>
        <div>
          <small>After confirmation</small>
          <strong>{after}</strong>
        </div>
      </div>
      <div className={styles.confirmActions}>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel change
        </button>
        <button type="button" disabled={busy} onClick={onConfirm}>
          {busy ? "Saving…" : "Confirm change"}
        </button>
      </div>
    </section>
  );
}
