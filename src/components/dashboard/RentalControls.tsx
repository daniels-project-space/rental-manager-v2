"use client";
import type { ReactNode } from "react";
import styles from "./RentalControls.module.css";

export type RentalControlTab = "gear" | "dates" | "pricing";
export type ReplacementCard = { id: string; name: string; image_url: string | null; can_apply: boolean; price_note: string };

/** A review surface only. Writes are delegated to the existing guarded actions. */
export function RentalControls({ name, portrait, identity, progress, gear, tab, onTab, onClose, editor, replacement, actions }: {
  name: string; portrait?: string | null; identity: ReactNode; progress: ReactNode; gear: ReactNode;
  tab: RentalControlTab; onTab: (tab: RentalControlTab) => void; onClose: () => void;
  editor?: ReactNode; actions: ReactNode;
  replacement?: {
    choices: ReplacementCard[]; selected: string | null; text: string; busy: string | null; error: string | null;
    applied: boolean; sending: boolean; onSend: () => void; onChoose: (id: string) => void; onText: (text: string) => void;
    onApply: () => void; onUseReply: () => void; itemPicker?: ReactNode;
  };
}) {
  const selected = replacement?.choices.find(choice => choice.id === replacement.selected);
  return <aside className={styles.panel} aria-label="Rental controls">
    <div className={styles.handle} />
    <header className={styles.header}><h3>Rental controls</h3><button type="button" aria-label="Close rental controls" onClick={onClose}>×</button></header>
    <div className={styles.scroll}>
      <div className={styles.identity}>{portrait ? <img src={portrait} alt={name} /> : <span className={styles.initials}>{name.split(" ").map(part => part[0]).slice(0, 2).join("")}</span>}<div><strong>{name}</strong>{identity}</div></div>
      <div className={styles.progress}>{progress}</div>
      <div className={styles.tabs} role="tablist" aria-label="Rental settings">{([['gear', 'Gear'], ['dates', 'Dates'], ['pricing', 'Pricing']] as const).map(([value, label]) => <button type="button" role="tab" aria-selected={tab === value} key={value} onClick={() => onTab(value)}>{label}</button>)}</div>
      {tab === 'gear' && <><h4>Selected gear</h4><div className={styles.gear}>{gear}</div></>}
      {tab === 'gear' && replacement && <section aria-label="Replacement options" className={styles.replacements}>
        <h4>Find replacement</h4>{replacement.itemPicker}
        {replacement.busy === 'stock' && <p role="status">Checking the full basket and writing a draft…</p>}
        <div className={styles.cards}>{replacement.choices.map(choice => <button type="button" key={choice.id} aria-pressed={choice.id === replacement.selected} className={choice.id === replacement.selected ? styles.selected : ''} disabled={!!replacement.busy || replacement.applied} onClick={() => replacement.onChoose(choice.id)}>
          <span className={styles.check}>{choice.id === replacement.selected ? '✓' : ''}</span>{choice.image_url ? <img src={choice.image_url} alt={choice.name} /> : <span className={styles.noImage}>◇</span>}<span className={styles.cardText}><strong>{choice.name}</strong><small>{choice.price_note}</small></span><span className={styles.available}>Available</span>
        </button>)}</div>
        {selected && <>
          {!selected.can_apply && <p className={styles.hint}>An editable upcoming booking is needed to change gear. You can review and send the offer separately.</p>}
          {replacement.applied && <p className={styles.hint} role="status">Gear updated. Review the reply and press Send message.</p>}
        </>}
        {replacement.error && <p className={styles.error} role="alert">{replacement.error}</p>}
      </section>}
      {editor}
      
    </div>
    <footer className={styles.footer}>
      {tab === "gear" && replacement && selected && <>
<label className={styles.preview}><span>Message preview <small>Editable</small></span><textarea aria-label="AI replacement reply" placeholder="Writing a reply from this conversation…" rows={3} disabled={replacement.busy === "apply"} value={replacement.text} onChange={event => replacement.onText(event.target.value)} /><button type="button" className={styles.editInChat} disabled={!!replacement.busy || replacement.sending || !replacement.text.trim()} onClick={replacement.onUseReply}>Review message in chat</button></label>
          <button type="button" className={styles.approve} disabled={!!replacement.busy || replacement.applied || !selected.can_apply} onClick={replacement.onApply}>{replacement.busy === 'apply' ? 'Applying…' : replacement.applied ? '✓ Replacement approved' : '✓ Approve replacement'}</button>
          <button type="button" className={styles.send} disabled={!!replacement.busy || replacement.sending || !replacement.text.trim()} onClick={replacement.onSend}>{replacement.sending ? "Sending…" : "➤ Send message"}</button>
      </>}
      <div className={styles.actions}><h4>Other actions</h4>{actions}</div>
    </footer>
  </aside>;
}
