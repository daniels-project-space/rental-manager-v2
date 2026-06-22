"use client";
/**
 * Reply Inbox (2026-06-22, redesigned) — cross-account "renters waiting on me".
 *
 * Compact, horizontally-stacked card grid. Each card carries the same context
 * Hygglo shows at the top of the chat: item thumbnail(s), what's requested + the
 * rental dates (or "inquiry — not yet requested"), location, price, the renter's
 * ★ rating, and the account in its colour — plus an urgency glow that escalates
 * the longer the message is unanswered. Pending REQUESTs get inline Approve /
 * Decline. Click a card → modal with the full thread, an AI draft grounded in
 * that context, and Send. A sent reply / decision drops the card.
 */
import { useEffect, useState } from "react";
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
interface ReplyTileData {
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
  const m = Math.max(0, Math.floor((now - ts) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function locationLabel(method?: string | null): string {
  if (!method || method === "unknown") return "Location TBC";
  return method.charAt(0).toUpperCase() + method.slice(1);
}
function urgency(elapsedMs: number) {
  const h = elapsedMs / 3_600_000;
  const intensity = Math.max(0, Math.min(1, h / 24));
  let color = "#22c55e";
  let label = "fresh";
  if (h >= 24) (color = "#ef4444"), (label = "critical");
  else if (h >= 12) (color = "#f97316"), (label = "late");
  else if (h >= 4) (color = "#f59e0b"), (label = "overdue");
  else if (h >= 1) (color = "#eab308"), (label = "waiting");
  return {
    color,
    label,
    durationS: (4 - intensity * 3).toFixed(2),
    glowSize: `${Math.round(6 + intensity * 22)}px`,
  };
}

function Stars({
  rating,
  count,
}: {
  rating: number | null;
  count: number | null;
}) {
  if (rating == null)
    return <span className="text-[10px] text-[#6b7280]">no rating</span>;
  return (
    <span className="text-[11px] text-[#f5c518] tabular-nums whitespace-nowrap">
      ★ {rating.toFixed(1)}
      {count != null && <span className="text-[#6b7280]"> ({count})</span>}
    </span>
  );
}

function ItemThumb({
  src,
  accent,
  size = 44,
}: {
  src: string | null;
  accent: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  if (!src || broken)
    return (
      <div
        className="flex items-center justify-center rounded-md text-[10px] flex-shrink-0"
        style={{
          width: size,
          height: size,
          background: `${accent}1a`,
          color: accent,
        }}
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
      className="rounded-md object-cover flex-shrink-0"
      style={{ width: size, height: size }}
    />
  );
}

/** Request-status pill: inquiry vs pending request vs active booking. */
function statusPill(tile: ReplyTileData) {
  if (!tile.has_reservation)
    return { text: "Inquiry · not requested yet", bg: "#3b4252", fg: "#cbd5e1" };
  if (tile.is_request)
    return { text: "REQUEST · awaiting you", bg: "#7c2d12", fg: "#fdba74" };
  const s = tile.status ?? tile.order_step ?? "active";
  return { text: s, bg: "#1e3a2f", fg: "#86efac" };
}

function contextLine(tile: ReplyTileData): string {
  const parts: string[] = [];
  const period = fmtDate(tile.start_date);
  if (period) parts.push(`${period} → ${fmtDate(tile.end_date) ?? "?"}`);
  parts.push(locationLabel(tile.pickup_method));
  const money = fmtMoney(tile.gross_paid_gbp ?? tile.net_to_owner_gbp, tile.currency);
  if (money) parts.push(money);
  return parts.join(" · ");
}

// ── compact card ──────────────────────────────────────────────────

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
  const accent = accountAccent(tile.account_slug);
  const u = urgency(now - tile.last_renter_msg_at);
  const pill = statusPill(tile);
  const approve = useAction(api.replyInbox_actions.approveOrder);
  const decline = useAction(api.replyInbox_actions.declineOrder);
  const [confirming, setConfirming] = useState<"approve" | "decline" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function act(kind: "approve" | "decline") {
    if (!tile.account_slug) {
      setNote("Unknown account");
      return;
    }
    setBusy(true);
    try {
      const fn = kind === "approve" ? approve : decline;
      const r = await fn({ thread_id: tile.thread_id, account_slug: tile.account_slug });
      if (r.status === "sent") onActed(tile.thread_id);
      else if (r.status === "skipped")
        setNote("Order actions disabled (gate off).");
      else setNote(`${kind} failed${r.httpStatus ? ` (${r.httpStatus})` : ""}.`);
    } catch {
      setNote(`${kind} failed.`);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  const itemNames = tile.items.map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name));

  return (
    <div
      onClick={onOpen}
      className="group cursor-pointer rounded-lg border-l-[3px] bg-white/[0.025] hover:bg-white/[0.05] transition-colors p-2.5 flex flex-col gap-2"
      style={{
        borderLeftColor: accent,
        ["--glow" as string]: u.color,
        ["--glow-size" as string]: u.glowSize,
        ["--glow-dur" as string]: `${u.durationS}s`,
        animation: "replyPulse var(--glow-dur) ease-in-out infinite",
      }}
    >
      <div className="flex gap-2.5">
        <ItemThumb src={tile.image_url} accent={accent} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[13px] font-semibold text-[#e4e6eb] truncate">
              {tile.renter_name}
            </span>
            {tile.renter_blacklisted && (
              <span className="text-[8px] px-1 rounded bg-red-500/20 text-red-400">BL</span>
            )}
            {tile.renter_flagged && !tile.renter_blacklisted && (
              <span className="text-[8px] px-1 rounded bg-amber-500/20 text-amber-400">FLAG</span>
            )}
            <span
              className="ml-auto text-[10px] font-semibold tabular-nums flex-shrink-0"
              style={{ color: u.color }}
              title={`${u.label} · unanswered`}
            >
              {waited(tile.last_renter_msg_at, now)}
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <Stars rating={tile.renter_rating} count={tile.renter_review_count} />
            <span
              className="text-[9px] px-1.5 py-0.5 rounded font-medium truncate"
              style={{ background: `${accent}22`, color: accent }}
            >
              {accountLabel(tile.account_slug)}
            </span>
          </div>
        </div>
      </div>

      <span
        className="self-start text-[9px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide"
        style={{ background: pill.bg, color: pill.fg }}
      >
        {pill.text}
      </span>

      {itemNames.length > 0 && (
        <div className="text-[11px] text-[#b8bcc8] truncate">
          {itemNames.join(", ")}
          {tile.item_count > tile.items.length && ` +${tile.item_count - tile.items.length}`}
        </div>
      )}
      {tile.has_reservation && (
        <div className="text-[10px] text-[#8b8fa3] truncate">{contextLine(tile)}</div>
      )}

      <div className="text-[11px] text-[#9aa0ad] line-clamp-2 italic">“{tile.preview}”</div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 mt-auto pt-1" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onOpen}
          className="text-[11px] px-2.5 py-1 rounded bg-white/[0.07] text-[#cbd5e1] hover:bg-white/12"
        >
          💬 Reply{tile.has_draft ? " ✨" : ""}
        </button>
        {tile.can_decide && (
          <div className="ml-auto flex items-center gap-1">
            {confirming ? (
              <>
                <span className="text-[10px] text-[#8b8fa3]">Confirm {confirming}?</span>
                <button
                  disabled={busy}
                  onClick={() => act(confirming)}
                  className="text-[11px] px-2 py-1 rounded bg-white/15 text-white disabled:opacity-50"
                >
                  ✓
                </button>
                <button
                  disabled={busy}
                  onClick={() => setConfirming(null)}
                  className="text-[11px] px-2 py-1 rounded bg-white/5 text-[#8b8fa3]"
                >
                  ✗
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setConfirming("approve")}
                  className="text-[11px] font-medium px-2.5 py-1 rounded bg-emerald-600/90 text-white hover:bg-emerald-600"
                >
                  Approve
                </button>
                <button
                  onClick={() => setConfirming("decline")}
                  className="text-[11px] font-medium px-2.5 py-1 rounded bg-red-600/80 text-white hover:bg-red-600"
                >
                  Decline
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {note && <div className="text-[10px] text-amber-400">{note}</div>}
    </div>
  );
}

// ── expanded modal (thread + draft + send) ────────────────────────

function ReplyModal({
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
      const r = await sendReply({
        thread_id: tile.thread_id,
        account_slug: tile.account_slug,
        text: body,
      });
      if (r.status === "sent") {
        setSent(body);
        setText("");
        setTimeout(onClose, 700);
      } else if (r.status === "skipped")
        setNote("Sending disabled (ALLOW_MANUAL_RENTER_SEND off).");
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
      else setNote(`${kind} failed.`);
    } catch {
      setNote(`${kind} failed.`);
    }
  }

  const pill = statusPill(tile);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[88vh] overflow-hidden flex flex-col rounded-xl border bg-[#13151a]"
        style={{ borderColor: `${accent}55` }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Context header */}
        <div className="p-3 border-b border-white/10 flex gap-3" style={{ background: `${accent}10` }}>
          <ItemThumb src={tile.image_url} accent={accent} size={56} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[#e4e6eb] truncate">{tile.renter_name}</span>
              <Stars rating={tile.renter_rating} count={tile.renter_review_count} />
              <button
                onClick={onClose}
                className="ml-auto text-[#8b8fa3] hover:text-white text-lg leading-none"
              >
                ×
              </button>
            </div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                style={{ background: `${accent}22`, color: accent }}
              >
                {accountLabel(tile.account_slug)}
              </span>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase"
                style={{ background: pill.bg, color: pill.fg }}
              >
                {pill.text}
              </span>
            </div>
            {tile.items.length > 0 && (
              <div className="text-[11px] text-[#b8bcc8] mt-1 truncate">
                {tile.items.map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name)).join(", ")}
              </div>
            )}
            {tile.has_reservation && (
              <div className="text-[10px] text-[#8b8fa3] mt-0.5">{contextLine(tile)}</div>
            )}
          </div>
        </div>

        {/* Thread */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5 bg-black/20">
          {thread === undefined ? (
            <SkeletonBlock className="h-20 w-full" />
          ) : thread.length === 0 ? (
            <div className="text-xs text-[#6b7280]">No messages.</div>
          ) : (
            thread.map((m, i) => (
              <div key={i} className={`flex ${m.role === "owner" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[82%] rounded-lg px-2.5 py-1.5 text-xs ${
                    m.role === "owner"
                      ? "bg-[#2a3a5a] text-[#e4e6eb]"
                      : "bg-white/[0.06] text-[#d1d5db]"
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))
          )}
          {sent && (
            <div className="flex justify-end">
              <div className="max-w-[82%] rounded-lg px-2.5 py-1.5 text-xs bg-[#2a3a5a]/60 text-[#e4e6eb] italic">
                {sent}
                <span className="ml-1 text-[9px] text-[#8b8fa3]">sent ✓</span>
              </div>
            </div>
          )}
        </div>

        {/* Compose + decisions */}
        <div className="p-3 border-t border-white/10 space-y-2">
          {tile.can_decide && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-[#fdba74]">Pending request:</span>
              <button
                onClick={() => onDecide("approve")}
                className="text-[11px] font-medium px-3 py-1 rounded bg-emerald-600/90 text-white hover:bg-emerald-600"
              >
                Approve
              </button>
              <button
                onClick={() => onDecide("decline")}
                className="text-[11px] font-medium px-3 py-1 rounded bg-red-600/80 text-white hover:bg-red-600"
              >
                Decline
              </button>
            </div>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write a reply…"
            rows={3}
            className="w-full resize-y rounded bg-black/30 border border-white/10 px-2.5 py-2 text-xs text-[#e4e6eb] placeholder-[#6b7280] focus:outline-none focus:border-white/25"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={onGenerate}
              disabled={drafting}
              className="text-[11px] px-2.5 py-1.5 rounded bg-white/[0.06] text-[#b8bcc8] hover:bg-white/10 disabled:opacity-50"
            >
              {drafting ? "Drafting…" : tile.has_draft ? "↻ Redraft (AI)" : "✨ Draft (AI)"}
            </button>
            <button
              onClick={onSend}
              disabled={sending || !text.trim()}
              className="ml-auto text-[11px] font-medium px-4 py-1.5 rounded text-white disabled:opacity-50"
              style={{ background: accent }}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
          {note && <div className="text-[10px] text-amber-400">{note}</div>}
        </div>
      </div>
    </div>
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

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const onActed = (id: string) =>
    setActed((prev) => new Set(prev).add(id));

  const visible = (queue ?? []).filter((t) => !acted.has(t.thread_id));
  const requests = visible.filter((t) => t.can_decide).length;
  const open = openId ? visible.find((t) => t.thread_id === openId) ?? null : null;

  return (
    <Card>
      <style>{`
        @keyframes replyPulse {
          0%, 100% { box-shadow: 0 0 4px 0 var(--glow); }
          50% { box-shadow: 0 0 var(--glow-size) 1px var(--glow); }
        }
      `}</style>
      <CardHeader
        title="Reply Inbox"
        badge={
          visible.length > 0 ? (
            <span className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 tabular-nums">
                {visible.length} waiting
              </span>
              {requests > 0 && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-orange-600/30 text-orange-300 tabular-nums">
                  {requests} request{requests > 1 ? "s" : ""}
                </span>
              )}
            </span>
          ) : undefined
        }
      />
      {queue === undefined ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState message="All caught up — no renters waiting on a reply" icon="✅" />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2 max-h-[40rem] overflow-y-auto pr-1">
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
      {open && (
        <ReplyModal tile={open} onClose={() => setOpenId(null)} onActed={onActed} />
      )}
    </Card>
  );
}
