"use client";
/**
 * Reply Inbox (2026-06-22 v3) — cross-account "renters waiting on me".
 *
 * Minimal card grid: each card = item thumbnail + renter ★ + account + booking/
 * request context, with a large "unanswered for" timer. Urgency: calm < 20h →
 * amber ≥ 20h → red ≥ 30h → blinking red ≥ 48h. Pending rental REQUESTs always
 * surface with Approve / Decline (live, verified `accept`/`deny` verbs, gated by
 * ALLOW_MANUAL_ORDER_ACTIONS). Click a card → a body-portaled modal (escapes the
 * widget's clipping) with the full thread + AI draft + Send.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../../../convex/_generated/dataModel";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { useAccount } from "@/lib/account-context";
import { accountAccent, accountLabel } from "@/lib/account-theme";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

// canned_responses is a NEW convex module not yet in the committed _generated/api
// type map (only existing modules are picked up via `typeof import`), so the
// typed `api.canned_responses.*` breaks `next build`. Reference by name — same
// pattern the dashboard chat tools + the dbcinema_web sync use.
const cannedListRef = makeFunctionReference<"query">("canned_responses:list");
const cannedCreateRef = makeFunctionReference<"mutation">("canned_responses:create");
const cannedUpdateRef = makeFunctionReference<"mutation">("canned_responses:update");
const cannedRemoveRef = makeFunctionReference<"mutation">("canned_responses:remove");

interface RichItem {
  name: string;
  qty: number;
  image_url: string | null;
}
export interface ReplyTileData {
  thread_id: string;
  account_slug: string | null;
  renter_name: string;
  renter_rating: number | null;
  renter_review_count: number | null;
  renter_blacklisted: boolean;
  renter_flagged: boolean;
  has_reservation: boolean;
  start_date: string | null;
  end_date: string | null;
  return_date: string | null;
  pickup_method: string | null;
  status: string | null;
  booking_status: string | null;
  order_step: string | null;
  is_request: boolean;
  can_decide: boolean;
  kind: "request" | "message";
  last_sender: "owner" | "renter" | null;
  can_accept: boolean | null;
  can_deny: boolean | null;
  gross_paid_gbp: number | null;
  net_to_owner_gbp: number | null;
  delivery_fee_gbp: number | null;
  currency: string;
  items: RichItem[];
  item_count: number;
  image_url: string | null;
  last_renter_msg_at: number;
  last_msg_at: number;
  preview: string;
  has_draft: boolean;
  ai_draft_text: string | null;
}

// ── helpers ───────────────────────────────────────────────────────

const STEP_LABEL: Record<string, string> = {
  REQUEST: "Request · awaiting you",
  APPROVED: "Awaiting payment",
  FUNDS_RESERVED: "Awaiting payment",
  VERIFIED: "Verifying renter",
  BOOKED_AFTER_VERIFIED: "Confirmed",
  DELIVERED: "Out with renter",
  RETURNED: "Awaiting return",
  REVIEWED: "Complete",
  CANCELED: "Cancelled",
  VERIFICATION_FAILED: "Verification failed",
};
/**
 * Decision state from the granular owner-action flags (falling back to the
 * is_request boolean for rows not yet stamped). approved = I've accepted but can
 * still decline until the renter pays.
 */
function decideState(t: ReplyTileData): {
  canApprove: boolean;
  canDecline: boolean;
  approved: boolean;
} {
  const canApprove = t.can_accept ?? t.is_request;
  const canDecline = t.can_deny ?? t.is_request;
  return { canApprove, canDecline, approved: !canApprove && canDecline };
}
/** True when the ball is in MY court (renter spoke last, or a pending request). */
function awaitingMe(t: ReplyTileData): boolean {
  return t.last_sender === "renter" || t.is_request;
}
function statusText(t: ReplyTileData): string {
  if (!t.has_reservation) {
    return t.last_sender === "owner" ? "Inquiry · you replied" : "Inquiry · not requested yet";
  }
  const { canApprove, canDecline, approved } = decideState(t);
  // Decision-state labels take priority — never say "awaiting payment" for a
  // request that hasn't been approved/declined yet.
  if (canApprove && canDecline) return "New request · approve or decline";
  if (approved) return "Approved · awaiting payment";
  if (t.order_step && STEP_LABEL[t.order_step]) return STEP_LABEL[t.order_step];
  if (t.last_sender === "owner") return "You replied · awaiting renter";
  return t.status ?? "Active";
}
function fmtDate(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function fmtMoney(n?: number | null, ccy = "GBP"): string | null {
  if (n == null) return null;
  const sym = ccy === "GBP" ? "£" : `${ccy} `;
  return `${sym}${Math.round(n)}`;
}
function waited(ts: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - ts) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}
function urgency(elapsedMs: number) {
  const h = elapsedMs / 3_600_000;
  if (h >= 48)
    return { color: "#ef4444", caption: "2d+ overdue", glow: true, blink: true };
  if (h >= 30)
    return { color: "#ef4444", caption: "overdue", glow: true, blink: false };
  if (h >= 20)
    return { color: "#eab308", caption: "waiting", glow: true, blink: false };
  return { color: "#94a3b8", caption: "unanswered", glow: false, blink: false };
}
function contextLine(t: ReplyTileData): string {
  const parts: string[] = [];
  const p = fmtDate(t.start_date);
  if (p) parts.push(`${p} → ${fmtDate(t.end_date) ?? "?"}`);
  if (t.pickup_method && t.pickup_method !== "unknown")
    parts.push(t.pickup_method[0].toUpperCase() + t.pickup_method.slice(1));
  const m = fmtMoney(t.gross_paid_gbp ?? t.net_to_owner_gbp, t.currency);
  if (m) parts.push(m);
  return parts.join("  ·  ");
}
function itemLine(t: ReplyTileData): string {
  const names = t.items.map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name));
  const extra = t.item_count > t.items.length ? ` +${t.item_count - t.items.length}` : "";
  return names.join(", ") + extra;
}

function Stars({ rating, count }: { rating: number | null; count: number | null }) {
  if (rating == null) return <span className="text-[11px] text-[#64748b]">no rating</span>;
  return (
    <span className="text-xs text-[#f5c518] tabular-nums whitespace-nowrap">
      ★ {rating.toFixed(1)}
      {count != null && <span className="text-[#64748b]"> ({count})</span>}
    </span>
  );
}
function Thumb({ src, accent, size = 56 }: { src: string | null; accent: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken)
    return (
      <div
        className="flex items-center justify-center rounded-xl flex-shrink-0 text-base"
        style={{ width: size, height: size, background: `${accent}14`, color: accent }}
      >
        📷
      </div>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      onError={() => setBroken(true)}
      className="rounded-xl object-cover flex-shrink-0"
      style={{ width: size, height: size }}
    />
  );
}

function AccountTag({ slug }: { slug: string | null }) {
  const accent = accountAccent(slug);
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-[#9aa0ad]">
      <span className="inline-block w-2 h-2 rounded-full" style={{ background: accent }} />
      {accountLabel(slug)}
    </span>
  );
}

// ── card ──────────────────────────────────────────────────────────

function ReplyCard({
  tile,
  now,
  onOpen,
  onActed,
  dryRun,
}: {
  tile: ReplyTileData;
  now: number;
  onOpen: () => void;
  onActed: (id: string) => void;
  dryRun: boolean;
}) {
  const aw = awaitingMe(tile);
  const ds = decideState(tile);
  // Urgency timer only when the ball is in MY court; a thread I replied to last
  // is calm (no glow / no "unanswered for" clock).
  const u = aw ? urgency(now - tile.last_renter_msg_at) : null;
  const approve = useAction(api.replyInbox_actions.approveOrder);
  const decline = useAction(api.replyInbox_actions.declineOrder);
  const [confirming, setConfirming] = useState<"approve" | "decline" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function act(kind: "approve" | "decline") {
    if (!tile.account_slug) return setNote("No account for this thread — can't " + kind + ".");
    setBusy(true);
    setNote(null);
    try {
      const fn = kind === "approve" ? approve : decline;
      const r = await fn({ thread_id: tile.thread_id, account_slug: tile.account_slug, dryRun });
      if (r.status === "sent") {
        if (r.reason === "DRY_RUN") setNote(`✓ ${kind} OK (test — nothing sent)`);
        else onActed(tile.thread_id);
      } else if (r.status === "skipped") {
        setNote("Order actions disabled (ALLOW_MANUAL_ORDER_ACTIONS off).");
      } else {
        setNote(`${kind} failed${r.httpStatus ? ` (${r.httpStatus})` : ""}: ${r.error ?? r.reason ?? "unknown"}`);
      }
    } catch (e) {
      setNote(`${kind} failed: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  return (
    <div
      onClick={onOpen}
      className="group relative cursor-pointer rounded-2xl border bg-[#16181d] hover:bg-[#191c22] transition-colors p-3.5 flex flex-col gap-2.5"
      style={{
        borderColor: u?.glow ? `${u.color}66` : "rgba(255,255,255,0.06)",
        ["--u" as string]: u?.color ?? "transparent",
        animation: u?.glow
          ? `rgGlow ${u.blink ? "1.2s" : "2.8s"} ease-in-out infinite`
          : undefined,
      }}
    >
      <div className="flex gap-3">
        <Thumb src={tile.image_url} accent={accountAccent(tile.account_slug)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2">
            <span className="text-[15px] font-semibold text-[#f1f3f5] truncate leading-tight">
              {tile.renter_name}
            </span>
            {tile.renter_blacklisted && (
              <span className="text-[9px] px-1 rounded bg-red-500/20 text-red-400 mt-0.5">BL</span>
            )}
            <span className="ml-auto flex flex-col items-end leading-none flex-shrink-0">
              {u ? (
                <>
                  <span
                    className="text-2xl font-bold tabular-nums"
                    style={{ color: u.color, animation: u.blink ? "rgBlink 1s step-end infinite" : undefined }}
                  >
                    {waited(tile.last_renter_msg_at, now)}
                  </span>
                  <span className="text-[9px] uppercase tracking-wider text-[#6b7280] mt-0.5">
                    {u.caption}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-sm font-semibold text-emerald-400/80">✓ replied</span>
                  <span className="text-[9px] uppercase tracking-wider text-[#6b7280] mt-0.5">
                    awaiting renter
                  </span>
                </>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <Stars rating={tile.renter_rating} count={tile.renter_review_count} />
            <AccountTag slug={tile.account_slug} />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 text-[11px]">
        <span
          className="uppercase tracking-wide font-medium"
          style={{ color: tile.is_request ? "#fdba74" : "#7a8190" }}
        >
          {statusText(tile)}
        </span>
      </div>

      {itemLine(tile) && (
        <div className="text-[13px] text-[#c5cad3] truncate">{itemLine(tile)}</div>
      )}
      {tile.has_reservation && contextLine(tile) && (
        <div className="text-[11px] text-[#7a8190]">{contextLine(tile)}</div>
      )}
      {tile.preview && (
        <div className="text-[12px] text-[#8b92a0] line-clamp-2">“{tile.preview}”</div>
      )}

      <div className="flex items-center gap-2 mt-auto pt-1" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onOpen}
          className="text-xs px-3 py-1.5 rounded-lg bg-white/[0.06] text-[#cbd5e1] hover:bg-white/[0.12] transition-colors"
        >
          💬 Reply{tile.has_draft ? " ✨" : ""}
        </button>
        {(ds.canApprove || ds.canDecline) &&
          (confirming ? (
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-[11px] text-[#9aa0ad] capitalize">{confirming}?</span>
              <button
                disabled={busy}
                onClick={() => act(confirming)}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-white/20 text-white disabled:opacity-50"
              >
                Confirm
              </button>
              <button
                disabled={busy}
                onClick={() => setConfirming(null)}
                className="text-xs px-2 py-1.5 rounded-lg bg-white/5 text-[#8b8fa3]"
              >
                ✗
              </button>
            </div>
          ) : (
            <div className="ml-auto flex items-center gap-1.5">
              {ds.approved && (
                <span className="text-[11px] font-medium text-emerald-400">✓ Approved</span>
              )}
              {ds.canApprove && (
                <button
                  onClick={() => setConfirming("approve")}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-600/90 text-white hover:bg-emerald-600"
                >
                  Approve
                </button>
              )}
              {ds.canDecline && (
                <button
                  onClick={() => setConfirming("decline")}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg bg-red-600/80 text-white hover:bg-red-600"
                >
                  Decline
                </button>
              )}
            </div>
          ))}
      </div>
      {note && (
        <div className={`text-[10px] ${note.startsWith("✓") ? "text-emerald-400" : "text-amber-400"}`}>{note}</div>
      )}
    </div>
  );
}

// ── Canned responses (per-account quick texts) ────────────────────

type Canned = {
  _id: Id<"canned_responses">;
  account_slug: string;
  label: string;
  symbol: string;
  text: string;
  sort: number;
};

const CANNED_ACCOUNTS = ["dbcinema", "leo", "diogo", "dbcinema_web"];

/** Manage overlay — see/add/edit/delete each account's saved auto-replies. */
function CannedManager({ accountSlug, onClose }: { accountSlug: string | null; onClose: () => void }) {
  const [acct, setAcct] = useState<string>(accountSlug ?? CANNED_ACCOUNTS[0]);
  const list = (useQuery(cannedListRef, { account_slug: acct }) ?? []) as Canned[];
  const create = useMutation(cannedCreateRef);
  const update = useMutation(cannedUpdateRef);
  const remove = useMutation(cannedRemoveRef);

  const [symbol, setSymbol] = useState("💬");
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<Id<"canned_responses"> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function resetForm() {
    setEditing(null);
    setSymbol("💬");
    setLabel("");
    setText("");
  }
  async function save() {
    if (!text.trim() || !label.trim()) return;
    if (editing) await update({ id: editing, symbol, label, text });
    else await create({ account_slug: acct, symbol, label, text });
    resetForm();
  }

  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg max-h-[88vh] flex flex-col rounded-2xl border border-white/10 bg-[#101216] shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-white/10 flex items-center gap-3">
          <span className="text-base font-semibold text-[#f1f3f5]">Quick texts</span>
          <select
            value={acct}
            onChange={(e) => { setAcct(e.target.value); resetForm(); }}
            className="text-xs rounded-lg bg-black/40 border border-white/10 px-2 py-1 text-[#cbd5e1]"
          >
            {CANNED_ACCOUNTS.map((a) => (
              <option key={a} value={a}>{accountLabel(a)}</option>
            ))}
          </select>
          <button onClick={onClose} className="ml-auto text-[#8b8fa3] hover:text-white text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {list.length === 0 ? (
            <div className="text-sm text-[#6b7280]">No quick texts for {accountLabel(acct)} yet.</div>
          ) : (
            list.map((c) => (
              <div key={c._id} className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
                <span className="text-xl leading-none">{c.symbol}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[#eef1f5]">{c.label}</div>
                  <div className="text-xs text-[#9aa0ad] line-clamp-2">{c.text}</div>
                </div>
                <button
                  onClick={() => { setEditing(c._id); setSymbol(c.symbol); setLabel(c.label); setText(c.text); }}
                  className="text-[11px] px-2 py-1 rounded-lg bg-white/[0.06] text-[#cbd5e1] hover:bg-white/[0.12]"
                >
                  Edit
                </button>
                <button
                  onClick={() => { if (confirm(`Delete "${c.label}"?`)) void remove({ id: c._id }); }}
                  className="text-[11px] px-2 py-1 rounded-lg bg-red-500/15 text-red-300 hover:bg-red-500/25"
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>

        <div className="p-4 border-t border-white/10 space-y-2">
          <div className="text-xs text-[#8b8fa3]">{editing ? "Edit quick text" : "New quick text"} for {accountLabel(acct)}</div>
          <div className="flex gap-2">
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="🏦"
              className="w-14 text-center rounded-lg bg-black/30 border border-white/10 px-2 py-2 text-lg"
            />
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (e.g. Bank details)"
              className="flex-1 rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-[#eef1f5] placeholder-[#6b7280]"
            />
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="The message to paste + send (e.g. delivery details, location, bank info)…"
            rows={3}
            className="w-full resize-y rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-[#eef1f5] placeholder-[#6b7280]"
          />
          <div className="flex items-center gap-2">
            {editing && (
              <button onClick={resetForm} className="text-xs px-3 py-2 rounded-lg bg-white/[0.06] text-[#8b8fa3]">Cancel</button>
            )}
            <button
              onClick={save}
              disabled={!text.trim() || !label.trim()}
              className="ml-auto text-sm font-medium px-5 py-2 rounded-lg bg-emerald-600/90 text-white hover:bg-emerald-600 disabled:opacity-40"
            >
              {editing ? "Save" : "Add"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── modal (body portal — escapes widget clipping) ─────────────────
// Exported so the notification deep-link host can open a thread from a tapped
// push without the Reply Inbox widget being mounted/visible.

export function ReplyModal({
  tile,
  onClose,
  onActed,
  dryRun,
}: {
  tile: ReplyTileData;
  onClose: () => void;
  onActed: (id: string) => void;
  dryRun: boolean;
}) {
  const accent = accountAccent(tile.account_slug);
  const ds = decideState(tile);
  const thread = useQuery(api.hygglo.listByThread, { thread_id: tile.thread_id });
  const generateDraft = useAction(api.replyInbox_actions.generateDraft);
  const sendReply = useAction(api.replyInbox_actions.sendRenterReply);
  const approve = useAction(api.replyInbox_actions.approveOrder);
  const decline = useAction(api.replyInbox_actions.declineOrder);

  const [text, setText] = useState(tile.ai_draft_text ?? "");
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [sentMsgs, setSentMsgs] = useState<string[]>([]);
  const [decided, setDecided] = useState<"approve" | "decline" | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [confirming, setConfirming] = useState<"approve" | "decline" | null>(null);
  // Per-account canned "quick texts" + the one pending a send-confirm.
  const canned = (useQuery(cannedListRef, {
    account_slug: tile.account_slug ?? undefined,
  }) ?? []) as Canned[];
  const [pendingCanned, setPendingCanned] = useState<Canned | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function onGenerate() {
    setDrafting(true);
    setNote(null);
    try {
      const r = await generateDraft({ thread_id: tile.thread_id });
      if (r.status === "ok" && r.draft) setText(r.draft);
      else setNote("Draft unavailable.");
    } catch {
      setNote("Draft failed.");
    } finally {
      setDrafting(false);
    }
  }
  // Shared send used by the compose box AND the canned quick-text buttons.
  // Returns true on success. clearBox=true also empties the textarea.
  async function sendBody(body: string, clearBox: boolean): Promise<boolean> {
    if (!body.trim()) {
      setNote("Type a message first.");
      return false;
    }
    if (!tile.account_slug) {
      setNote("No account for this thread — can't send.");
      return false;
    }
    setSending(true);
    setNote(null);
    try {
      const r = await sendReply({ thread_id: tile.thread_id, account_slug: tile.account_slug, text: body.trim(), dryRun });
      if (r.status === "sent") {
        // Keep the chat OPEN so you can also approve/decline or keep texting.
        setSentMsgs((p) => [...p, body.trim()]);
        if (clearBox) setText("");
        setNote(r.reason === "DRY_RUN" ? "✓ Reply OK (test — nothing sent)" : null);
        return true;
      }
      if (r.status === "skipped") setNote("Sending disabled (ALLOW_MANUAL_RENTER_SEND off).");
      else setNote(`Send failed${r.httpStatus ? ` (${r.httpStatus})` : ""}: ${r.error ?? r.reason ?? "unknown"}`);
      return false;
    } catch (e) {
      setNote(`Send failed: ${e instanceof Error ? e.message : "error"}`);
      return false;
    } finally {
      setSending(false);
    }
  }
  function onSend() {
    return sendBody(text, true);
  }
  async function onDecide(kind: "approve" | "decline") {
    if (!tile.account_slug) {
      setConfirming(null);
      return setNote("No account for this thread — can't " + kind + ".");
    }
    setDeciding(true);
    setNote(null);
    try {
      const fn = kind === "approve" ? approve : decline;
      const r = await fn({ thread_id: tile.thread_id, account_slug: tile.account_slug, dryRun });
      if (r.status === "sent") {
        // Mark decided IN PLACE — do NOT close, so you can also message.
        setDecided(kind);
        if (r.reason === "DRY_RUN") setNote(`✓ ${kind === "approve" ? "Approved" : "Declined"} (test — nothing sent)`);
        else onActed(tile.thread_id);
      } else if (r.status === "skipped") {
        setNote("Order actions disabled (ALLOW_MANUAL_ORDER_ACTIONS off).");
      } else {
        setNote(`${kind} failed${r.httpStatus ? ` (${r.httpStatus})` : ""}: ${r.error ?? r.reason ?? "unknown"}`);
      }
    } catch (e) {
      setNote(`${kind} failed: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setDeciding(false);
      setConfirming(null);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
    >
      {/* Backdrop click does NOT close — only the × button (or Esc) closes, so
          you can text AND approve/decline in one session without losing it. */}
      <div
        className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl border bg-[#101216] shadow-2xl overflow-hidden"
        style={{ borderColor: `${accent}44` }}
      >
        {/* Context header */}
        <div className="p-4 border-b border-white/10 flex gap-4" style={{ background: `${accent}0d` }}>
          <Thumb src={tile.image_url} accent={accent} size={64} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
              <span className="text-lg font-semibold text-[#f1f3f5] truncate">{tile.renter_name}</span>
              <Stars rating={tile.renter_rating} count={tile.renter_review_count} />
              <button onClick={onClose} className="ml-auto text-[#8b8fa3] hover:text-white text-2xl leading-none">
                ×
              </button>
            </div>
            <div className="flex items-center gap-3 mt-1.5">
              <AccountTag slug={tile.account_slug} />
              <span
                className="text-[11px] uppercase tracking-wide font-medium"
                style={{ color: tile.is_request ? "#fdba74" : "#7a8190" }}
              >
                {statusText(tile)}
              </span>
            </div>
            {itemLine(tile) && (
              <div className="text-[13px] text-[#c5cad3] mt-1.5">{itemLine(tile)}</div>
            )}
            {tile.has_reservation && contextLine(tile) && (
              <div className="text-[12px] text-[#7a8190] mt-0.5">{contextLine(tile)}</div>
            )}
          </div>
        </div>

        {/* Thread */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-black/20 min-h-[10rem]">
          {thread === undefined ? (
            <SkeletonBlock className="h-24 w-full" />
          ) : thread.length === 0 ? (
            <div className="text-sm text-[#6b7280]">No messages yet.</div>
          ) : (
            thread.map((m, i) => (
              <div key={i} className={`flex ${m.role === "owner" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm ${
                    m.role === "owner" ? "bg-[#2a3a5a] text-[#eef1f5]" : "bg-white/[0.07] text-[#d8dce3]"
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))
          )}
          {sentMsgs.map((s, i) => (
            <div key={`sent-${i}`} className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl px-3.5 py-2 text-sm bg-[#2a3a5a]/60 text-[#eef1f5] italic">
                {s} <span className="text-[10px] text-[#8b8fa3]">{dryRun ? "test ✓" : "sent ✓"}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Compose + decisions */}
        <div className="p-4 border-t border-white/10 space-y-2.5">
          {(ds.canApprove || ds.canDecline || decided) && (
            <div className="flex items-center gap-2 flex-wrap">
              {decided ? (
                <span className="text-xs font-medium" style={{ color: decided === "approve" ? "#34d399" : "#f87171" }}>
                  {decided === "approve" ? "✓ Approved" : "✓ Declined"}{dryRun ? " (test)" : ""} — you can still message below.
                </span>
              ) : (
                <>
                  <span className="text-xs font-medium" style={{ color: ds.approved ? "#34d399" : "#fdba74" }}>
                    {ds.approved ? "✓ Approved earlier · awaiting payment —" : "New request —"}
                  </span>
                  {confirming ? (
                    <>
                      <span className="text-xs text-[#9aa0ad] capitalize">{confirming}?</span>
                      <button disabled={deciding} onClick={() => onDecide(confirming)} className="text-xs px-3 py-1.5 rounded-lg bg-white/20 text-white disabled:opacity-50">
                        {deciding ? "…" : "Confirm"}
                      </button>
                      <button disabled={deciding} onClick={() => setConfirming(null)} className="text-xs px-2.5 py-1.5 rounded-lg bg-white/5 text-[#8b8fa3]">
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      {ds.canApprove && (
                        <button onClick={() => setConfirming("approve")} className="text-xs font-medium px-3.5 py-1.5 rounded-lg bg-emerald-600/90 text-white hover:bg-emerald-600">
                          Approve
                        </button>
                      )}
                      {ds.canDecline && (
                        <button onClick={() => setConfirming("decline")} className="text-xs font-medium px-3.5 py-1.5 rounded-lg bg-red-600/80 text-white hover:bg-red-600">
                          Decline
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* Quick texts — tap a symbol to paste + send a saved reply (after a
              confirm). Per-account; manage them via the widget's "Quick texts". */}
          {pendingCanned ? (
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] p-2.5">
              <span className="text-lg leading-none">{pendingCanned.symbol}</span>
              <span className="text-xs text-[#c5cad3] flex-1 min-w-0 line-clamp-2">
                Send <span className="font-medium text-[#eef1f5]">{pendingCanned.label}</span>: “{pendingCanned.text}”
              </span>
              <button
                disabled={sending}
                onClick={async () => {
                  const c = pendingCanned;
                  const ok = await sendBody(c.text, false);
                  if (ok) setPendingCanned(null);
                }}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-600/90 text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                {sending ? "Sending…" : dryRun ? "Send (test)" : "Send"}
              </button>
              <button onClick={() => setPendingCanned(null)} className="text-xs px-2.5 py-1.5 rounded-lg bg-white/5 text-[#8b8fa3]">
                Cancel
              </button>
            </div>
          ) : canned.length > 0 ? (
            <div className="flex items-center gap-1.5 flex-wrap">
              {canned.map((c) => (
                <button
                  key={c._id}
                  onClick={() => setPendingCanned(c)}
                  title={c.text}
                  className="flex flex-col items-center justify-center gap-0.5 px-2.5 py-1.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] transition-colors min-w-[3.5rem]"
                >
                  <span className="text-base leading-none">{c.symbol}</span>
                  <span className="text-[9px] text-[#9aa0ad] leading-none max-w-[4.5rem] truncate">{c.label}</span>
                </button>
              ))}
            </div>
          ) : null}

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write a reply…"
            rows={3}
            className="w-full resize-y rounded-xl bg-black/30 border border-white/10 px-3 py-2.5 text-sm text-[#eef1f5] placeholder-[#6b7280] focus:outline-none focus:border-white/25"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={onGenerate}
              disabled={drafting}
              className="text-xs px-3 py-2 rounded-lg bg-white/[0.06] text-[#c5cad3] hover:bg-white/[0.12] disabled:opacity-50"
            >
              {drafting ? "Drafting…" : tile.has_draft ? "↻ Redraft (AI)" : "✨ Draft (AI)"}
            </button>
            <button
              onClick={onSend}
              disabled={sending || !text.trim()}
              className="ml-auto text-sm font-medium px-5 py-2 rounded-lg text-white disabled:opacity-40"
              style={{ background: accent }}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
          {note && (
            <div className={`text-xs ${note.startsWith("✓") ? "text-emerald-400" : "text-amber-400"}`}>{note}</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── widget ────────────────────────────────────────────────────────

export function ReplyInbox() {
  const { activeAccountSlug } = useAccount();
  const queue = useStableQuery(api.replyInbox.getReplyQueue, {
    accountSlug: activeAccountSlug ?? undefined,
    limit: 60,
  }) as ReplyTileData[] | undefined;

  const [openId, setOpenId] = useState<string | null>(null);
  const [acted, setActed] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [mounted, setMounted] = useState(false);
  const [filter, setFilter] = useState<"all" | "requests" | "messages">("all");
  const [testMode, setTestMode] = useState(false);
  const [showManager, setShowManager] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const onActed = (id: string) => setActed((p) => new Set(p).add(id));
  const all = (queue ?? []).filter((t) => !acted.has(t.thread_id));
  const requests = all.filter((t) => t.kind === "request").length;
  const messages = all.filter((t) => t.kind === "message").length;
  const visible = all.filter((t) =>
    filter === "all" ? true : filter === "requests" ? t.kind === "request" : t.kind === "message",
  );
  // `open` resolves against ALL tiles (not the filtered view) so an open chat
  // doesn't vanish when you switch the filter.
  const open = openId ? all.find((t) => t.thread_id === openId) ?? null : null;

  return (
    <Card>
      <style>{`
        @keyframes rgGlow { 0%,100% { box-shadow: 0 0 0 0 transparent; } 50% { box-shadow: 0 0 18px -4px var(--u); } }
        @keyframes rgBlink { 0%,49% { opacity: 1; } 50%,100% { opacity: 0.3; } }
      `}</style>
      <CardHeader
        title="Quick Reply"
        badge={
          requests > 0 ? (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-orange-600/25 text-orange-300 tabular-nums">
              {requests} request{requests > 1 ? "s" : ""}
            </span>
          ) : undefined
        }
      />
      {/* Filter (requests vs normal messages) + a TEST MODE toggle that makes
          approve/decline/send simulate only — nothing reaches Hygglo. */}
      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        {([
          { k: "all", label: `All${all.length ? ` (${all.length})` : ""}` },
          { k: "requests", label: `Requests${requests ? ` (${requests})` : ""}` },
          { k: "messages", label: `Messages${messages ? ` (${messages})` : ""}` },
        ] as const).map((f) => (
          <button
            key={f.k}
            onClick={() => setFilter(f.k)}
            className={`text-xs font-medium px-2.5 py-1 rounded-full transition-colors ${
              filter === f.k
                ? "bg-white/15 text-white"
                : "bg-white/[0.04] text-[#8b8fa3] hover:bg-white/[0.08]"
            }`}
          >
            {f.label}
          </button>
        ))}
        <button
          onClick={() => setShowManager(true)}
          title="See + edit each account's saved quick texts (delivery, location, bank details…)."
          className="ml-auto text-xs font-medium px-2.5 py-1 rounded-full bg-white/[0.04] text-[#8b8fa3] hover:bg-white/[0.08] transition-colors"
        >
          ✏️ Quick texts
        </button>
        <button
          onClick={() => setTestMode((x) => !x)}
          title="When on, Approve/Decline/Send only simulate — nothing is sent to renters."
          className={`text-xs font-medium px-2.5 py-1 rounded-full transition-colors ${
            testMode
              ? "bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40"
              : "bg-white/[0.04] text-[#8b8fa3] hover:bg-white/[0.08]"
          }`}
        >
          {testMode ? "🧪 Test mode ON" : "Test mode off"}
        </button>
      </div>
      {queue === undefined ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-32 w-full rounded-2xl" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          message={
            filter === "requests"
              ? "No pending requests"
              : filter === "messages"
                ? "No messages"
                : "All caught up — nothing here"
          }
          icon="✅"
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-3 max-h-[42rem] overflow-y-auto p-0.5">
          {visible.map((tile) => (
            <ReplyCard
              key={tile.thread_id}
              tile={tile}
              now={now}
              onOpen={() => setOpenId(tile.thread_id)}
              onActed={onActed}
              dryRun={testMode}
            />
          ))}
        </div>
      )}
      {mounted && open && (
        <ReplyModal tile={open} onClose={() => setOpenId(null)} onActed={onActed} dryRun={testMode} />
      )}
      {mounted && showManager && (
        <CannedManager accountSlug={activeAccountSlug} onClose={() => setShowManager(false)} />
      )}
    </Card>
  );
}
