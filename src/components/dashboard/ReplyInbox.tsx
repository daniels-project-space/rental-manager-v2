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
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { useAccount } from "@/lib/account-context";
import { accountAccent, accountLabel } from "@/lib/account-theme";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

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
function statusText(t: ReplyTileData): string {
  if (!t.has_reservation) return "Inquiry · not requested yet";
  if (t.order_step && STEP_LABEL[t.order_step]) return STEP_LABEL[t.order_step];
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
}: {
  tile: ReplyTileData;
  now: number;
  onOpen: () => void;
  onActed: (id: string) => void;
}) {
  const u = urgency(now - tile.last_renter_msg_at);
  const approve = useAction(api.replyInbox_actions.approveOrder);
  const decline = useAction(api.replyInbox_actions.declineOrder);
  const [confirming, setConfirming] = useState<"approve" | "decline" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function act(kind: "approve" | "decline") {
    if (!tile.account_slug) return setNote("Unknown account");
    setBusy(true);
    try {
      const fn = kind === "approve" ? approve : decline;
      const r = await fn({ thread_id: tile.thread_id, account_slug: tile.account_slug });
      if (r.status === "sent") onActed(tile.thread_id);
      else if (r.status === "skipped") setNote("Order actions disabled (gate off).");
      else setNote(`${kind} failed${r.httpStatus ? ` (${r.httpStatus})` : ""}.`);
    } catch {
      setNote(`${kind} failed.`);
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
        borderColor: u.glow ? `${u.color}66` : "rgba(255,255,255,0.06)",
        ["--u" as string]: u.color,
        animation: u.glow
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
              <span
                className="text-2xl font-bold tabular-nums"
                style={{ color: u.color, animation: u.blink ? "rgBlink 1s step-end infinite" : undefined }}
              >
                {waited(tile.last_renter_msg_at, now)}
              </span>
              <span className="text-[9px] uppercase tracking-wider text-[#6b7280] mt-0.5">
                {u.caption}
              </span>
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
        {tile.can_decide &&
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
              <button
                onClick={() => setConfirming("approve")}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-600/90 text-white hover:bg-emerald-600"
              >
                Approve
              </button>
              <button
                onClick={() => setConfirming("decline")}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-red-600/80 text-white hover:bg-red-600"
              >
                Decline
              </button>
            </div>
          ))}
      </div>
      {note && <div className="text-[10px] text-amber-400">{note}</div>}
    </div>
  );
}

// ── modal (body portal — escapes widget clipping) ─────────────────
// Exported so the notification deep-link host can open a thread from a tapped
// push without the Reply Inbox widget being mounted/visible.

export function ReplyModal({
  tile,
  onClose,
  onActed,
}: {
  tile: ReplyTileData;
  onClose: () => void;
  onActed: (id: string) => void;
}) {
  const accent = accountAccent(tile.account_slug);
  const thread = useQuery(api.hygglo.listByThread, { thread_id: tile.thread_id });
  const generateDraft = useAction(api.replyInbox_actions.generateDraft);
  const sendReply = useAction(api.replyInbox_actions.sendRenterReply);
  const approve = useAction(api.replyInbox_actions.approveOrder);
  const decline = useAction(api.replyInbox_actions.declineOrder);

  const [text, setText] = useState(tile.ai_draft_text ?? "");
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"approve" | "decline" | null>(null);

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
  async function onSend() {
    const body = text.trim();
    if (!body || !tile.account_slug) return;
    setSending(true);
    setNote(null);
    try {
      const r = await sendReply({ thread_id: tile.thread_id, account_slug: tile.account_slug, text: body });
      if (r.status === "sent") {
        setSent(body);
        setText("");
        setTimeout(onClose, 650);
      } else if (r.status === "skipped") setNote("Sending disabled (ALLOW_MANUAL_RENTER_SEND off).");
      else setNote(`Send failed${r.httpStatus ? ` (${r.httpStatus})` : ""}.`);
    } catch {
      setNote("Send failed.");
    } finally {
      setSending(false);
    }
  }
  async function onDecide(kind: "approve" | "decline") {
    if (!tile.account_slug) return;
    try {
      const fn = kind === "approve" ? approve : decline;
      const r = await fn({ thread_id: tile.thread_id, account_slug: tile.account_slug });
      if (r.status === "sent") {
        onActed(tile.thread_id);
        onClose();
      } else if (r.status === "skipped") setNote("Order actions disabled (gate off).");
      else setNote(`${kind} failed${r.httpStatus ? ` (${r.httpStatus})` : ""}.`);
    } catch {
      setNote(`${kind} failed.`);
    } finally {
      setConfirming(null);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl border bg-[#101216] shadow-2xl overflow-hidden"
        style={{ borderColor: `${accent}44` }}
        onClick={(e) => e.stopPropagation()}
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
          {sent && (
            <div className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl px-3.5 py-2 text-sm bg-[#2a3a5a]/60 text-[#eef1f5] italic">
                {sent} <span className="text-[10px] text-[#8b8fa3]">sent ✓</span>
              </div>
            </div>
          )}
        </div>

        {/* Compose + decisions */}
        <div className="p-4 border-t border-white/10 space-y-2.5">
          {tile.can_decide && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#fdba74] font-medium">Pending request —</span>
              {confirming ? (
                <>
                  <span className="text-xs text-[#9aa0ad] capitalize">{confirming}?</span>
                  <button onClick={() => onDecide(confirming)} className="text-xs px-3 py-1.5 rounded-lg bg-white/20 text-white">
                    Confirm
                  </button>
                  <button onClick={() => setConfirming(null)} className="text-xs px-2.5 py-1.5 rounded-lg bg-white/5 text-[#8b8fa3]">
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => setConfirming("approve")} className="text-xs font-medium px-3.5 py-1.5 rounded-lg bg-emerald-600/90 text-white hover:bg-emerald-600">
                    Approve
                  </button>
                  <button onClick={() => setConfirming("decline")} className="text-xs font-medium px-3.5 py-1.5 rounded-lg bg-red-600/80 text-white hover:bg-red-600">
                    Decline
                  </button>
                </>
              )}
            </div>
          )}
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
          {note && <div className="text-xs text-amber-400">{note}</div>}
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

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const onActed = (id: string) => setActed((p) => new Set(p).add(id));
  const visible = (queue ?? []).filter((t) => !acted.has(t.thread_id));
  const requests = visible.filter((t) => t.can_decide).length;
  const open = openId ? visible.find((t) => t.thread_id === openId) ?? null : null;

  return (
    <Card>
      <style>{`
        @keyframes rgGlow { 0%,100% { box-shadow: 0 0 0 0 transparent; } 50% { box-shadow: 0 0 18px -4px var(--u); } }
        @keyframes rgBlink { 0%,49% { opacity: 1; } 50%,100% { opacity: 0.3; } }
      `}</style>
      <CardHeader
        title="Reply Inbox"
        badge={
          visible.length > 0 ? (
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 tabular-nums">
                {visible.length} waiting
              </span>
              {requests > 0 && (
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-orange-600/25 text-orange-300 tabular-nums">
                  {requests} request{requests > 1 ? "s" : ""}
                </span>
              )}
            </span>
          ) : undefined
        }
      />
      {queue === undefined ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-32 w-full rounded-2xl" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState message="All caught up — no renters waiting on a reply" icon="✅" />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-3 max-h-[42rem] overflow-y-auto p-0.5">
          {visible.map((tile) => (
            <ReplyCard
              key={tile.thread_id}
              tile={tile}
              now={now}
              onOpen={() => setOpenId(tile.thread_id)}
              onActed={onActed}
            />
          ))}
        </div>
      )}
      {mounted && open && (
        <ReplyModal tile={open} onClose={() => setOpenId(null)} onActed={onActed} />
      )}
    </Card>
  );
}
