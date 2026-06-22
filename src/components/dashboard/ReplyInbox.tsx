"use client";
/**
 * Reply Inbox (2026-06-22) — cross-account "renters waiting for my reply" queue.
 *
 * Each tile = one thread whose last message is from the renter. Header shows the
 * renter profile (★ rating), rental period, requested location + the account in
 * its identity colour. The tile GLOWS with rising intensity the longer the
 * message has gone unanswered. Click to expand the full thread, edit the
 * AI-drafted reply, and send. A sent reply flips the thread owner-last server
 * side, so the tile drops out of this reactive query until the renter writes
 * again. Wherever you type, the message routes to that tile's Hygglo thread.
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

interface ReplyTileData {
  thread_id: string;
  account_slug: string | null;
  renter_name: string;
  renter_rating: number | null;
  renter_review_count: number | null;
  renter_blacklisted: boolean;
  renter_flagged: boolean;
  start_date: string | null;
  end_date: string | null;
  return_date: string | null;
  pickup_method: string | null;
  status: string | null;
  order_step: string | null;
  net_to_owner_gbp: number | null;
  items: string[];
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

/** Urgency model — colour + pulse speed escalate with hours unanswered. */
function urgency(elapsedMs: number) {
  const h = elapsedMs / 3_600_000;
  const intensity = Math.max(0, Math.min(1, h / 24)); // saturates at 24h
  let color = "#22c55e"; // green — fresh
  let label = "fresh";
  if (h >= 24) {
    color = "#ef4444";
    label = "critical";
  } else if (h >= 12) {
    color = "#f97316";
    label = "late";
  } else if (h >= 4) {
    color = "#f59e0b";
    label = "overdue";
  } else if (h >= 1) {
    color = "#eab308";
    label = "waiting";
  }
  return {
    color,
    label,
    intensity,
    durationS: (4 - intensity * 3).toFixed(2), // 4s fresh → 1s critical
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
    <span className="text-[11px] text-[#f5c518] tabular-nums">
      ★ {rating.toFixed(1)}
      {count != null && (
        <span className="text-[#6b7280]"> ({count})</span>
      )}
    </span>
  );
}

// ── tile ──────────────────────────────────────────────────────────

function ReplyTile({
  tile,
  expanded,
  onToggle,
  now,
}: {
  tile: ReplyTileData;
  expanded: boolean;
  onToggle: () => void;
  now: number;
}) {
  const accent = accountAccent(tile.account_slug);
  const u = urgency(now - tile.last_renter_msg_at);

  const [text, setText] = useState(tile.ai_draft_text ?? "");
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [optimisticSent, setOptimisticSent] = useState<string | null>(null);

  const thread = useQuery(
    api.hygglo.listByThread,
    expanded ? { thread_id: tile.thread_id } : "skip",
  );
  const generateDraft = useAction(api.replyInbox_actions.generateDraft);
  const sendReply = useAction(api.replyInbox_actions.sendRenterReply);

  // Pull a server-cached draft into the box if the user hasn't typed yet.
  useEffect(() => {
    if (!text && tile.ai_draft_text) setText(tile.ai_draft_text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tile.ai_draft_text]);

  const period =
    fmtDate(tile.start_date) &&
    `${fmtDate(tile.start_date)} → ${fmtDate(tile.end_date) ?? "?"}`;

  async function onGenerate() {
    setDrafting(true);
    setNotice(null);
    try {
      const r = await generateDraft({ thread_id: tile.thread_id });
      if (r.status === "ok" && r.draft) setText(r.draft);
      else setNotice("Draft unavailable right now.");
    } catch {
      setNotice("Draft failed.");
    } finally {
      setDrafting(false);
    }
  }

  async function onSend() {
    const body = text.trim();
    if (!body) return;
    if (!tile.account_slug) {
      setNotice("Unknown account — cannot send.");
      return;
    }
    setSending(true);
    setNotice(null);
    try {
      const r = await sendReply({
        thread_id: tile.thread_id,
        account_slug: tile.account_slug,
        text: body,
      });
      if (r.status === "sent") {
        setOptimisticSent(body);
        setText("");
        setNotice("Sent ✓");
      } else if (r.status === "skipped") {
        setNotice("Sending is disabled (ALLOW_MANUAL_RENTER_SEND off).");
      } else {
        setNotice(`Send failed${r.httpStatus ? ` (${r.httpStatus})` : ""}.`);
      }
    } catch {
      setNotice("Send failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="rounded-lg border-l-[3px] bg-white/[0.02] transition-colors"
      style={{
        borderLeftColor: accent,
        // Urgency glow — pulses faster + brighter the longer it waits.
        ["--glow" as string]: u.color,
        ["--glow-size" as string]: u.glowSize,
        ["--glow-dur" as string]: `${u.durationS}s`,
        animation: "replyPulse var(--glow-dur) ease-in-out infinite",
      }}
    >
      {/* Header (always visible, clickable) */}
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-2.5 flex flex-col gap-1.5"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-[#e4e6eb] truncate">
            {tile.renter_name}
          </span>
          <Stars rating={tile.renter_rating} count={tile.renter_review_count} />
          {tile.renter_blacklisted && (
            <span className="text-[9px] px-1 rounded bg-red-500/20 text-red-400">
              BLACKLIST
            </span>
          )}
          {tile.renter_flagged && !tile.renter_blacklisted && (
            <span className="text-[9px] px-1 rounded bg-amber-500/20 text-amber-400">
              FLAG
            </span>
          )}
          <span className="ml-auto flex items-center gap-1 flex-shrink-0">
            <span
              className="text-[10px] font-medium tabular-nums"
              style={{ color: u.color }}
            >
              {waited(tile.last_renter_msg_at, now)}
            </span>
            <span
              className="text-[9px] uppercase tracking-wide"
              style={{ color: u.color }}
            >
              {u.label}
            </span>
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap text-[10px] text-[#8b8fa3]">
          <span
            className="px-1.5 py-0.5 rounded font-medium"
            style={{
              background: `${accent}22`,
              color: accent,
            }}
          >
            {accountLabel(tile.account_slug)}
          </span>
          {period && <span>{period}</span>}
          <span>· {locationLabel(tile.pickup_method)}</span>
          {tile.items.length > 0 && (
            <span className="truncate text-[#6b7280]">
              · {tile.items.join(", ")}
            </span>
          )}
        </div>

        {!expanded && (
          <div className="text-xs text-[#b8bcc8] truncate">{tile.preview}</div>
        )}
      </button>

      {/* Expanded: thread + compose */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          <div className="max-h-56 overflow-y-auto space-y-1.5 rounded bg-black/20 p-2">
            {thread === undefined ? (
              <SkeletonBlock className="h-16 w-full" />
            ) : thread.length === 0 ? (
              <div className="text-xs text-[#6b7280]">No messages.</div>
            ) : (
              thread.map((m, i) => (
                <div
                  key={i}
                  className={`flex ${m.role === "owner" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg px-2.5 py-1.5 text-xs ${
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
            {optimisticSent && (
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-lg px-2.5 py-1.5 text-xs bg-[#2a3a5a]/60 text-[#e4e6eb] italic">
                  {optimisticSent}
                  <span className="ml-1 text-[9px] text-[#8b8fa3]">sending…</span>
                </div>
              </div>
            )}
          </div>

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
              className="ml-auto text-[11px] font-medium px-3.5 py-1.5 rounded text-white disabled:opacity-50"
              style={{ background: accent }}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>

          {notice && (
            <div className="text-[10px] text-[#8b8fa3]">{notice}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── widget ────────────────────────────────────────────────────────

export function ReplyInbox() {
  const { activeAccountSlug } = useAccount();
  const queue = useStableQuery(api.replyInbox.getReplyQueue, {
    accountSlug: activeAccountSlug ?? undefined,
    limit: 50,
  }) as ReplyTileData[] | undefined;

  const [expanded, setExpanded] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Re-tick so relative times + urgency glow advance without a reload.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <Card>
      {/* Urgency-glow keyframes (injected once). */}
      <style>{`
        @keyframes replyPulse {
          0%, 100% { box-shadow: 0 0 4px 0 var(--glow); }
          50% { box-shadow: 0 0 var(--glow-size) 1px var(--glow); }
        }
      `}</style>
      <CardHeader
        title="Reply Inbox"
        badge={
          queue && queue.length > 0 ? (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 tabular-nums">
              {queue.length} waiting
            </span>
          ) : undefined
        }
      />
      {queue === undefined ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : queue.length === 0 ? (
        <EmptyState message="All caught up — no renters waiting on a reply" icon="✅" />
      ) : (
        <div className="space-y-2 max-h-[34rem] overflow-y-auto pr-1">
          {queue.map((tile) => (
            <ReplyTile
              key={tile.thread_id}
              tile={tile}
              expanded={expanded === tile.thread_id}
              onToggle={() =>
                setExpanded((cur) =>
                  cur === tile.thread_id ? null : tile.thread_id,
                )
              }
              now={now}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
