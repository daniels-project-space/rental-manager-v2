"use client";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { makeFunctionReference } from "convex/server";
import { useState } from "react";
import { Drawer } from "@/components/ui/Drawer";
import type { Id } from "../../../convex/_generated/dataModel";

// New convex modules — referenced by name so `next build` typechecks against the
// committed (lagging) _generated api (same pattern as ReplyInbox's new modules).
const listingsSyncRef = makeFunctionReference<"query">("online_listings:syncMeta");
const rescanListingsRef = makeFunctionReference<"action">("online_listings_actions:rescan");
const lessonsListRef = makeFunctionReference<"query">("draft_learning:list");
const lessonRemoveRef = makeFunctionReference<"mutation">("draft_learning:remove");
const cannedListRef = makeFunctionReference<"query">("canned_responses:list");
const cannedCreateRef = makeFunctionReference<"mutation">("canned_responses:create");
const cannedUpdateRef = makeFunctionReference<"mutation">("canned_responses:update");
const cannedRemoveRef = makeFunctionReference<"mutation">("canned_responses:remove");
const LISTING_ACCOUNTS = [
  { slug: "leo", label: "Leo" },
  { slug: "dbcinema", label: "DB Cinema" },
  { slug: "diogo", label: "Diogo" },
] as const;
import { useEditMode } from "@/lib/dashboard/edit-mode-context";
import {
  PANEL_WIDGETS,
  STAT_WIDGETS,
} from "@/lib/dashboard/widget-registry";

const INPUT_STYLE = {
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "#e4e6eb",
} as const;

interface LockedToggleProps {
  label: string;
  value: boolean;
  dangerOn?: boolean;
  dangerOff?: boolean;
  warning: string;
  tooltip: string;
  onConfirmedChange: (next: boolean) => void;
}

function LockedToggle({
  label,
  value,
  dangerOff,
  dangerOn,
  warning,
  tooltip,
  onConfirmedChange,
}: LockedToggleProps) {
  function handleClick() {
    const next = !value;
    const isDangerous = (next === false && dangerOff) || (next === true && dangerOn);
    if (isDangerous) {
      const ok = window.confirm(warning);
      if (!ok) return;
    }
    onConfirmedChange(next);
  }

  const isActive = value;
  const color = isActive ? "#22c55e" : "#8b8fa3";

  return (
    <div
      className="flex items-center justify-between py-3"
      style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
    >
      <div className="min-w-0 mr-3">
        <p className="text-sm text-[#e4e6eb]">{label}</p>
        <p className="text-xs mt-0.5" style={{ color: "#8b8fa3" }} title={tooltip}>
          {tooltip}
        </p>
      </div>
      <button
        onClick={handleClick}
        className="flex-shrink-0 relative inline-flex items-center rounded-full transition-colors"
        style={{
          width: 40,
          height: 22,
          background: isActive ? "rgba(34,197,94,0.3)" : "rgba(255,255,255,0.08)",
          border: "1px solid " + color,
        }}
        aria-pressed={isActive}
      >
        <span
          className="absolute rounded-full transition-transform"
          style={{
            width: 16,
            height: 16,
            background: color,
            left: 2,
            transform: isActive ? "translateX(18px)" : "translateX(0)",
          }}
        />
      </button>
    </div>
  );
}

/**
 * Per-account "hard truths" editor — the ground-truth block injected verbatim at
 * the end of every AI draft for that account. Each account gets its own textarea
 * with a Save button that appears only when there are unsaved edits.
 */
function HardTruthsEditor() {
  const accounts = useQuery(api.settings.listAccountHardTruths);
  const save = useMutation(api.settings.setAccountHardTruths);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  if (!accounts) return null;
  return (
    <div className="py-3">
      <label className="text-sm text-[#e4e6eb] block mb-1">AI ground truth (hard truths)</label>
      <p className="text-xs mb-2" style={{ color: "#8b8fa3" }}>
        Account-specific facts the AI must always respect — injected at the end of
        every draft (e.g. included-free accessories, battery families, gear you do
        / don&apos;t own). Never shown to renters.
      </p>
      <div className="space-y-3">
        {accounts.map((a) => {
          const id = String(a.account_id);
          const value = drafts[id] ?? a.hard_truths;
          const dirty = value !== a.hard_truths;
          return (
            <div key={id}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-[#cbd5e1]">
                  {a.display_name}
                </span>
                {dirty ? (
                  <button
                    disabled={savingId === id}
                    onClick={async () => {
                      setSavingId(id);
                      setSavedId(null);
                      try {
                        await save({ account_id: a.account_id, hard_truths: value });
                        setSavedId(id);
                      } finally {
                        setSavingId(null);
                      }
                    }}
                    className="text-[11px] px-2 py-0.5 rounded-md bg-violet-500/20 text-violet-200 hover:bg-violet-500/30 disabled:opacity-50"
                  >
                    {savingId === id ? "Saving…" : "Save"}
                  </button>
                ) : savedId === id ? (
                  <span className="text-[11px] text-green-400">Saved</span>
                ) : null}
              </div>
              <textarea
                value={value}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [id]: e.target.value }))
                }
                rows={4}
                placeholder="e.g. SD cards & batteries are included free; only suggest gear I actually own…"
                className="w-full resize-y rounded-lg px-2.5 py-2 text-[13px]"
                style={INPUT_STYLE}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Small labelled read-only preview of one outbound text. */
function TextPreview({ label, text }: { label: string; text: string | null }) {
  if (!text) return null;
  return (
    <div>
      <p className="text-[10px] font-semibold mb-0.5" style={{ color: "#8b8fa3" }}>{label}</p>
      <p
        className="text-[11px] leading-snug rounded-md px-2 py-1.5 whitespace-pre-wrap"
        style={{ background: "rgba(255,255,255,0.04)", color: "#cbd5e1", border: "1px solid rgba(255,255,255,0.07)" }}
      >
        {text}
      </p>
    </div>
  );
}

/**
 * Per-account post-return discount code + percent editor, with the exact texts
 * a good renter gets (discount message, review-only ask, 5★ review comment).
 * Code/percent save to account_profiles and are rendered into the outbound
 * chat text at return time — so an edit here changes every future automatic
 * text for that account. Wordings themselves are fixed per-account brand copy
 * (convex/lib/return_messages.ts).
 */
function ReturnTextsEditor() {
  const rows = useQuery(api.settings.listReturnDiscounts);
  const save = useMutation(api.settings.setReturnDiscount);
  const [drafts, setDrafts] = useState<Record<string, { code: string; percent: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  if (!rows) return null;
  return (
    <div className="py-3">
      <label className="text-sm text-[#e4e6eb] block mb-1">Return texts &amp; discount codes</label>
      <p className="text-xs mb-2" style={{ color: "#8b8fa3" }}>
        What a good renter gets when you close a return: a 5★ review + one chat
        text. Change the code / % here and every future automatic text for that
        account uses the new value.
      </p>
      {error && <p className="text-xs mb-2" style={{ color: "#ef4444" }}>{error}</p>}
      <div className="space-y-3">
        {rows.map((r) => {
          const id = String(r.account_id);
          const d = drafts[id] ?? { code: r.code, percent: String(r.percent) };
          const dirty = d.code !== r.code || d.percent !== String(r.percent);
          const open = openId === id;
          return (
            <div
              key={id}
              className="rounded-lg px-2.5 py-2"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-[#cbd5e1]">{r.display_name}</span>
                {dirty ? (
                  <button
                    disabled={savingId === id}
                    onClick={async () => {
                      setSavingId(id);
                      setSavedId(null);
                      setError(null);
                      try {
                        await save({
                          account_id: r.account_id,
                          code: d.code,
                          percent: Number(d.percent),
                        });
                        setDrafts((prev) => {
                          const next = { ...prev };
                          delete next[id];
                          return next;
                        });
                        setSavedId(id);
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      } finally {
                        setSavingId(null);
                      }
                    }}
                    className="text-[11px] px-2 py-0.5 rounded-md bg-violet-500/20 text-violet-200 hover:bg-violet-500/30 disabled:opacity-50"
                  >
                    {savingId === id ? "Saving…" : "Save"}
                  </button>
                ) : savedId === id ? (
                  <span className="text-[11px] text-green-400">Saved</span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={d.code}
                  onChange={(e) => setDrafts((p) => ({ ...p, [id]: { ...d, code: e.target.value.toUpperCase() } }))}
                  placeholder="DISCOUNT CODE"
                  className="flex-1 min-w-0 rounded-lg px-2.5 py-1.5 text-[13px] font-mono tracking-wide"
                  style={INPUT_STYLE}
                />
                <input
                  value={d.percent}
                  onChange={(e) => setDrafts((p) => ({ ...p, [id]: { ...d, percent: e.target.value } }))}
                  type="number"
                  min={1}
                  max={90}
                  className="w-16 rounded-lg px-2 py-1.5 text-[13px] text-right"
                  style={INPUT_STYLE}
                />
                <span className="text-xs text-[#8b8fa3] shrink-0">% off</span>
              </div>
              <button
                onClick={() => setOpenId(open ? null : id)}
                className="text-[11px] mt-1.5 text-[#8b8fa3] hover:text-[#cbd5e1] transition-colors"
              >
                {open ? "▾ Hide the texts" : "▸ Show the texts that get sent"}
              </button>
              {open && (
                <div className="space-y-1.5 mt-1.5">
                  <TextPreview label="Chat text — discount + review ask" text={r.preview_discount} />
                  <TextPreview label="Chat text — review ask only (code toggle off)" text={r.preview_review_only} />
                  <TextPreview label="5★ review left on the renter" text={r.preview_review_comment} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One account's hub row: confirmed chip + postcode input + Confirm. */
function HubRow({
  account_id,
  display_name,
  hub_postcode,
  hub_label,
}: {
  account_id: string;
  display_name: string;
  hub_postcode: string | null;
  hub_label: string | null;
}) {
  const setHub = useAction(api.settings.setHub);
  const [pc, setPc] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-[#cbd5e1]">{display_name}</span>
        {hub_label && (
          <span className="text-[11px] text-emerald-300">
            📍 {hub_label} · {hub_postcode}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          value={pc}
          onChange={(e) => setPc(e.target.value)}
          placeholder={hub_postcode ?? "e.g. WC2H 7ER"}
          className="text-sm rounded-lg px-2.5 py-1.5 flex-1 min-w-0"
          style={INPUT_STYLE}
        />
        <button
          disabled={busy || pc.trim().length < 5}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              const r = await setHub({
                account_id: account_id as Parameters<typeof setHub>[0]["account_id"],
                postcode: pc,
              });
              if (r.ok) {
                setMsg({ ok: true, text: `Confirmed: ${r.label}` });
                setPc("");
              } else {
                setMsg({ ok: false, text: r.reason ?? "Couldn't confirm" });
              }
            } finally {
              setBusy(false);
            }
          }}
          className="text-xs px-3 py-1.5 rounded-lg bg-violet-500/20 text-violet-200 hover:bg-violet-500/30 disabled:opacity-50 shrink-0"
        >
          {busy ? "Checking…" : "Confirm"}
        </button>
      </div>
      {msg && (
        <p className="mt-1 text-xs" style={{ color: msg.ok ? "#22c55e" : "#ef4444" }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

/**
 * Per-account rental hubs — each account's gear lives somewhere different. Type
 * a UK postcode per account, confirmed against postcodes.io (the register). Tile
 * distance + the too-heavy tag are measured from that account's hub. The
 * heavy/max travel ranges below are shared across accounts.
 */
function HubEditor() {
  const hubs = useQuery(api.settings.listAccountHubs);
  const settings = useQuery(api.settings.get);
  const update = useMutation(api.settings.update);
  if (!hubs || !settings) return null;
  return (
    <div className="py-3">
      <label className="text-sm text-[#e4e6eb] block mb-1">Rental hubs (per account)</label>
      <p className="text-xs mb-2" style={{ color: "#8b8fa3" }}>
        Where each account&apos;s gear lives. Distance to a chat&apos;s pickup
        location and the &ldquo;too heavy&rdquo; tag are measured from that
        account&apos;s hub. Enter a UK postcode — confirmed against the register.
      </p>
      <div className="space-y-3">
        {hubs.map((h) => (
          <HubRow
            key={String(h.account_id)}
            account_id={String(h.account_id)}
            display_name={h.display_name}
            hub_postcode={h.hub_postcode}
            hub_label={h.hub_label}
          />
        ))}
      </div>
      <div className="flex items-center gap-4 mt-3 flex-wrap">
        <label className="text-xs text-[#cbd5e1] flex items-center gap-1.5">
          Heavy items reach
          <input
            type="number"
            min={1}
            defaultValue={settings.hub_heavy_max_km ?? 5}
            onBlur={(e) =>
              void update({ hub_heavy_max_km: Number(e.target.value) || 5 })
            }
            className="w-14 text-sm rounded-lg px-2 py-1"
            style={INPUT_STYLE}
          />
          km
        </label>
        <label className="text-xs text-[#cbd5e1] flex items-center gap-1.5">
          Max range
          <input
            type="number"
            min={1}
            defaultValue={settings.hub_max_km ?? 30}
            onBlur={(e) =>
              void update({ hub_max_km: Number(e.target.value) || 30 })
            }
            className="w-14 text-sm rounded-lg px-2 py-1"
            style={INPUT_STYLE}
          />
          km
        </label>
      </div>
    </div>
  );
}

interface Props {
  onClose: () => void;
}

type QuickText = {
  _id: Id<"canned_responses">;
  label: string;
  symbol: string;
  text: string;
};

/** Central editor for the three Hygglo account shortcut sets. */
function QuickTextsEditor() {
  const [account, setAccount] = useState<(typeof LISTING_ACCOUNTS)[number]["slug"]>("leo");
  const rows = (useQuery(cannedListRef, { account_slug: account }) ?? []) as QuickText[];
  const create = useMutation(cannedCreateRef);
  const update = useMutation(cannedUpdateRef);
  const remove = useMutation(cannedRemoveRef);
  const [editing, setEditing] = useState<Id<"canned_responses"> | null>(null);
  const [symbol, setSymbol] = useState("💬");
  const [label, setLabel] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  function reset() {
    setEditing(null);
    setSymbol("💬");
    setLabel("");
    setBody("");
  }

  async function save() {
    if (!label.trim() || !body.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        await update({ id: editing, symbol, label, text: body });
      } else {
        await create({ account_slug: account, symbol, label, text: body });
      }
      reset();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="py-1">
      <div className="flex gap-1 rounded-xl bg-black/25 p-1 mb-3">
        {LISTING_ACCOUNTS.map((a) => (
          <button
            key={a.slug}
            type="button"
            onClick={() => { setAccount(a.slug); reset(); }}
            className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
              account === a.slug
                ? "bg-violet-500/20 text-violet-100 ring-1 ring-violet-400/30"
                : "text-[#8b8fa3] hover:text-[#d5d8df]"
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-xs text-[#6b7280] py-1">No shortcuts for this account yet.</p>
        ) : rows.map((row) => (
          <div key={row._id} className="flex items-start gap-2 rounded-xl border border-white/[0.08] bg-black/15 p-2.5">
            <span className="text-lg leading-none pt-0.5">{row.symbol}</span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-[#e8eaf0]">{row.label}</p>
              <p className="text-[11px] leading-snug text-[#8f96a3] line-clamp-2">{row.text}</p>
            </div>
            <button
              type="button"
              onClick={() => { setEditing(row._id); setSymbol(row.symbol); setLabel(row.label); setBody(row.text); }}
              className="text-[11px] rounded-md bg-white/[0.06] px-2 py-1 text-[#cbd5e1] hover:bg-white/[0.11]"
            >
              Edit
            </button>
            <button
              type="button"
              aria-label={`Delete ${row.label}`}
              onClick={() => { if (confirm(`Delete “${row.label}” for this account?`)) void remove({ id: row._id }); }}
              className="text-sm leading-none px-1 py-1 text-[#6f7581] hover:text-rose-300"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 rounded-xl border border-violet-400/15 bg-violet-500/[0.04] p-3 space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-violet-200/75">
          {editing ? "Edit shortcut" : "New shortcut"}
        </p>
        <div className="flex gap-2">
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} className="w-14 rounded-lg px-2 py-2 text-center" style={INPUT_STYLE} aria-label="Shortcut icon" />
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Bank details" className="min-w-0 flex-1 rounded-lg px-3 py-2 text-sm" style={INPUT_STYLE} />
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Text pasted into Quick Reply…" className="w-full resize-y rounded-lg px-3 py-2 text-sm" style={INPUT_STYLE} />
        <div className="flex items-center gap-2">
          <p className="text-[10px] leading-snug text-[#737987]">Pastes into the composer. It never sends automatically.</p>
          {editing && <button type="button" onClick={reset} className="ml-auto text-xs text-[#8b8fa3]">Cancel</button>}
          <button type="button" disabled={saving || !label.trim() || !body.trim()} onClick={save} className={`${editing ? "" : "ml-auto "}rounded-lg bg-violet-500/20 px-3 py-1.5 text-xs font-semibold text-violet-100 ring-1 ring-violet-400/25 disabled:opacity-40`}>
            {saving ? "Saving…" : editing ? "Save" : "Add shortcut"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Online-listings rescan — refresh the cached listing set the Reply-Inbox
 * "Add items" picker searches. Run it after adding new listings on Hygglo.
 */
function OnlineListingsEditor() {
  const meta = (useQuery(listingsSyncRef, {}) ?? []) as Array<{
    account_slug: string;
    last_rescan_at: number;
    count: number;
  }>;
  const rescan = useAction(rescanListingsRef);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});

  function ago(ts?: number): string {
    if (!ts) return "never scanned";
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const h = Math.round(mins / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }

  async function onRescan(slug: string) {
    setBusy(slug);
    setNote((n) => ({ ...n, [slug]: "" }));
    try {
      const r = (await rescan({ account_slug: slug })) as { ok: boolean; stored?: number; error?: string };
      setNote((n) => ({ ...n, [slug]: r.ok ? `✓ ${r.stored} listings` : `✗ ${r.error ?? "failed"}` }));
    } catch (e) {
      setNote((n) => ({ ...n, [slug]: `✗ ${e instanceof Error ? e.message : "failed"}` }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="py-3">
      <label className="text-sm text-[#e4e6eb] block mb-1">Online listings</label>
      <p className="text-xs mb-2" style={{ color: "#8b8fa3" }}>
        The searchable inventory behind the chat’s “Add item” button. Rescan an
        account after you add new listings on Hygglo so they show up.
      </p>
      <div className="space-y-2">
        {LISTING_ACCOUNTS.map((acct) => {
          const m = meta.find((x) => x.account_slug === acct.slug);
          return (
            <div key={acct.slug} className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <span className="text-sm text-[#e4e6eb]">{acct.label}</span>
                <span className="text-xs ml-2" style={{ color: "#8b8fa3" }}>
                  {note[acct.slug] || `${m?.count ?? 0} listings · ${ago(m?.last_rescan_at)}`}
                </span>
              </div>
              <button
                disabled={busy === acct.slug}
                onClick={() => onRescan(acct.slug)}
                className="text-xs px-3 py-1.5 rounded-lg bg-white/[0.06] text-[#cbd5e1] hover:bg-white/[0.12] disabled:opacity-50"
              >
                {busy === acct.slug ? "Scanning…" : "↻ Rescan"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type Lesson = {
  _id: string;
  account_slug: string | null;
  applies_when: string;
  lesson: string;
  draft_mistake: string | null;
  weight: number;
};

/**
 * Learned drafting lessons — what the AI has picked up from the replies you send
 * instead of its drafts. Consolidated + capped (it refines/merges rather than
 * piling up). Delete any that aren't right.
 */
function DraftLessonsEditor() {
  const lessons = (useQuery(lessonsListRef, {}) ?? []) as Lesson[];
  const remove = useMutation(lessonRemoveRef);
  return (
    <div className="py-3">
      <label className="text-sm text-[#e4e6eb] block mb-1">
        What the AI has learned from your replies
      </label>
      <p className="text-xs mb-2" style={{ color: "#8b8fa3" }}>
        When you send something other than the AI draft, it works out why and distils a general
        rule so future drafts write more like you. It refines existing rules instead of piling up.
        Remove any that are wrong.
      </p>
      {lessons.length === 0 ? (
        <p className="text-xs" style={{ color: "#6b7280" }}>
          Nothing learned yet — it starts adapting once you send replies that differ from the drafts.
        </p>
      ) : (
        <div className="space-y-2">
          {lessons.map((l) => (
            <div key={l._id} className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-[#cbd5e1]">{l.applies_when}</span>
                  {l.account_slug && (
                    <span className="text-[9px] px-1 rounded bg-white/[0.06] text-[#8b8fa3]">{l.account_slug}</span>
                  )}
                  {l.weight > 1 && (
                    <span className="text-[9px] px-1 rounded bg-emerald-500/15 text-emerald-300" title="Reinforced this many times">
                      ×{l.weight}
                    </span>
                  )}
                </div>
                <div className="text-xs text-[#9aa0ad] mt-0.5">{l.lesson}</div>
              </div>
              <button
                onClick={() => { if (confirm("Delete this learned rule?")) void remove({ id: l._id }); }}
                className="shrink-0 text-[11px] px-2 py-1 rounded-lg bg-red-500/15 text-red-300 hover:bg-red-500/25"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AppleCalendarSection() {
  const status = useQuery(api.calendar_apple_db.getStatus);
  const connectFromVault = useAction(api.calendar_apple.connectFromVault);
  const syncAll = useAction(api.calendar_apple.syncAllConfirmed);
  const disconnectCal = useAction(api.calendar_apple.disconnect);
  const updateCal = useMutation(api.calendar_apple_db.updateCalendarSettings);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!status) return null;
  const BTN = "text-xs font-medium px-3 py-1.5 rounded-lg transition-colors";
  return (
    <div className="py-3 border-t border-white/[0.06]">
      <label className="text-sm text-[#e4e6eb] block mb-1">📅 Apple Calendar</label>
      <p className="text-xs mb-2" style={{ color: "#8b8fa3" }}>
        Push confirmed booking pickup &amp; return times into your Apple Calendar with reminders — kept in sync when a booking changes.
      </p>
      {status.connected ? (
        <div className="space-y-2">
          <div className="text-xs text-emerald-300">
            ✓ Connected — {status.apple_id} · calendar &ldquo;{status.calendar_name}&rdquo; · {status.events} event{status.events === 1 ? "" : "s"}
          </div>
          {status.last_error ? <div className="text-xs text-red-300">Last error: {status.last_error}</div> : null}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              disabled={busy}
              onClick={async () => { setBusy(true); setMsg(null); const r = await syncAll({}); setBusy(false); setMsg(`Synced ${r.synced}, removed ${r.removed} across ${r.threads} bookings.`); }}
              className={`${BTN} bg-sky-500/15 text-sky-300 ring-1 ring-sky-400/25 disabled:opacity-50`}
            >{busy ? "Syncing…" : "Sync all confirmed"}</button>
            <button
              onClick={async () => { if (confirm("Disconnect Apple Calendar? Existing events stay in your calendar.")) { await disconnectCal({}); } }}
              className={`${BTN} bg-white/[0.06] text-[#9ca3af] hover:bg-white/[0.1]`}
            >Disconnect</button>
          </div>
          <div className="flex items-center gap-2 text-xs text-[#cbd5e1] flex-wrap">
            Remind
            <input type="number" min={0} defaultValue={status.reminder_lead_min}
              onBlur={(e) => void updateCal({ reminder_lead_min: Number(e.target.value) })}
              className="w-16 rounded-lg px-2 py-1" style={INPUT_STYLE} />
            min before pickup ·
            <input type="number" min={0} defaultValue={status.return_reminder_lead_min}
              onBlur={(e) => void updateCal({ return_reminder_lead_min: Number(e.target.value) })}
              className="w-16 rounded-lg px-2 py-1" style={INPUT_STYLE} />
            min before return
          </div>
          {msg ? <div className="text-xs text-[#8b8fa3]">{msg}</div> : null}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] text-[#8b8fa3]">Apple credentials are held in the server vault and never entered into this dashboard.</p>
          <button
            disabled={busy}
            onClick={async () => { setBusy(true); setMsg(null); const r = await connectFromVault({}); setBusy(false); setMsg(r.ok ? `Connected to "${r.chosen}".` : (r.error ?? "Connection failed")); }}
            className={`${BTN} bg-sky-500/15 text-sky-300 ring-1 ring-sky-400/25 disabled:opacity-50`}
          >{busy ? "Connecting…" : "Connect Apple Calendar"}</button>
          {msg ? <div className={`text-xs ${msg.startsWith("Connected") ? "text-emerald-300" : "text-red-300"}`}>{msg}</div> : null}
        </div>
      )}
    </div>
  );
}

function SettingsSection({
  id,
  eyebrow,
  title,
  description,
  children,
  tone = "neutral",
}: {
  id: string;
  eyebrow: string;
  title: string;
  description?: string;
  children: React.ReactNode;
  tone?: "neutral" | "safe" | "violet";
}) {
  const accent = tone === "safe" ? "#34d399" : tone === "violet" ? "#a78bfa" : "#7f8795";
  return (
    <section
      id={id}
      className="scroll-mt-20 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 shadow-[0_16px_45px_-35px_rgba(0,0,0,0.9)]"
    >
      <p className="text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: accent }}>{eyebrow}</p>
      <h2 className="mt-1 text-[15px] font-semibold text-[#f0f2f6]">{title}</h2>
      {description && <p className="mt-1 text-xs leading-relaxed text-[#858c99]">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function SettingsDrawer({ onClose }: Props) {
  const settings = useQuery(api.settings.get);
  const updateSettings = useMutation(api.settings.update);
  const [pollingInput, setPollingInput] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saveOk, setSaveOk] = useState(false);
  const { editMode, toggleEditMode, layout } = useEditMode();

  const hiddenPanelCount = PANEL_WIDGETS.filter((w) =>
    layout.hiddenPanels.includes(w.id),
  ).length;
  const hiddenStatCount = STAT_WIDGETS.filter((w) =>
    layout.hiddenStats.includes(w.id),
  ).length;
  const totalHidden = hiddenPanelCount + hiddenStatCount;

  function handleEditDashboard() {
    if (!editMode) toggleEditMode();
    onClose();
  }

  async function applyField(fields: Parameters<typeof updateSettings>[0]) {
    setSaveError("");
    setSaveOk(false);
    try {
      await updateSettings(fields);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  }

  const polling = settings?.polling_interval_ms ?? 300000;
  const displayPolling =
    pollingInput !== "" ? pollingInput : String(Math.round(polling / 60000));

  async function handlePollingBlur() {
    const mins = parseInt(pollingInput || String(Math.round(polling / 60000)));
    if (isNaN(mins)) return;
    const ms = Math.max(60000, Math.min(3600000, mins * 60000));
    await applyField({ polling_interval_ms: ms });
    setPollingInput("");
  }

  if (settings == null) {
    return (
      <Drawer onClose={onClose} title="Master settings" width="min(480px, 100vw)">
        <p className="text-sm text-[#8b8fa3]">Loading...</p>
      </Drawer>
    );
  }

  return (
    <Drawer onClose={onClose} title="Master settings" width="min(480px, 100vw)">
      <div className="space-y-3 pb-8">
        <div className="rounded-2xl border border-violet-400/15 bg-gradient-to-br from-violet-500/[0.12] via-slate-500/[0.04] to-transparent p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 text-lg ring-1 ring-violet-400/20">⌘</div>
            <div>
              <p className="text-sm font-semibold text-[#f2f3f6]">Rental operations control</p>
              <p className="mt-0.5 text-xs leading-relaxed text-[#9299a6]">Accounts stay separate. Shared rules and safety rails live here.</p>
            </div>
          </div>
          <div className="mt-3 flex gap-1.5 overflow-x-auto pb-0.5 text-[10px] font-medium">
            {[["#safety","Safety"],["#quick-texts","Quick texts"],["#operations","Operations"],["#intelligence","AI drafts"]].map(([href,label]) => (
              <a key={href} href={href} className="whitespace-nowrap rounded-full border border-white/[0.08] bg-black/15 px-2.5 py-1 text-[#aeb4bf] hover:border-violet-400/30 hover:text-white">{label}</a>
            ))}
          </div>
        </div>

        {/* Dashboard customization — entry point for widget add/remove/reorder. */}
        <div
          className="mb-4 p-3 rounded-lg"
          style={{
            background: "rgba(59,130,246,0.08)",
            border: "1px solid rgba(59,130,246,0.25)",
          }}
        >
          <div className="flex items-center justify-between gap-3 mb-1">
            <p className="text-sm font-medium text-[#e4e6eb]">Dashboard layout</p>
            <button
              type="button"
              onClick={handleEditDashboard}
              className="px-3 py-1.5 rounded-md text-xs font-medium"
              style={{
                background: "rgba(59,130,246,0.85)",
                color: "#fff",
              }}
            >
              ✎ Edit dashboard
            </button>
          </div>
          <p className="text-xs" style={{ color: "#8b8fa3" }}>
            Drag to reorder, × to hide, + to add. {totalHidden > 0 ? `${totalHidden} hidden.` : "All visible."}
          </p>
        </div>

        <SettingsSection id="safety" eyebrow="Protected" title="Reply safety" description="AI can prepare drafts, but cannot dispatch them. A renter message only leaves after you press Send in Quick Reply." tone="safe">
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-emerald-400/15 bg-emerald-500/[0.06] px-3 py-2.5">
            <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.7)]" />
            <div><p className="text-xs font-semibold text-emerald-200">Draft-only bot enforced in code</p><p className="text-[10px] text-emerald-200/60">There is no automatic-send switch.</p></div>
          </div>
          <LockedToggle label="Read-only mode" value={settings.read_only_mode} dangerOff warning="WARNING: Disabling read-only mode permits non-message Hygglo operations that have their own gates. AI renter replies remain permanently draft-only. Continue?" tooltip="Umbrella rail for automated Hygglo operations; manual Quick Reply uses its own deliberate-click gate" onConfirmedChange={(next) => applyField({ read_only_mode: next })} />
        </SettingsSection>

        <SettingsSection id="quick-texts" eyebrow="Per account" title="Quick Reply shortcuts" description="Add delivery, pickup, bank-detail or any other reusable text. Each of the three accounts keeps its own wording." tone="violet">
          <QuickTextsEditor />
        </SettingsSection>

        <SettingsSection id="operations" eyebrow="Live operations" title="Polling, hubs & collection" description="Controls the data refresh cadence and the real-world locations and hours used by availability and drafts.">
        <div className="py-1">
          <label className="text-sm text-[#e4e6eb] block mb-1">Polling interval</label>
          <p className="text-xs mb-2" style={{ color: "#8b8fa3" }}>
            How often to poll Hygglo (minutes, 1-60)
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={60}
              step={1}
              value={displayPolling}
              onChange={(e) => setPollingInput(e.target.value)}
              onBlur={handlePollingBlur}
              className="w-24 text-sm rounded-lg px-3 py-2"
              style={INPUT_STYLE}
            />
            <span className="text-xs text-[#8b8fa3]">min</span>
          </div>
        </div>

        <HubEditor />

        <AppleCalendarSection />

        <div className="py-3">
          <label className="text-sm text-[#e4e6eb] block mb-1">Pickup / collection hours</label>
          <p className="text-xs mb-2" style={{ color: "#8b8fa3" }}>
            Windows you accept pickups &amp; returns (London time). The AI only confirms times inside these.
          </p>
          <div className="space-y-2">
            {(settings.pickup_hours ?? []).map((w, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="time"
                  value={w.start}
                  onChange={(e) =>
                    applyField({
                      pickup_hours: (settings.pickup_hours ?? []).map((x, idx) =>
                        idx === i ? { ...x, start: e.target.value } : x,
                      ),
                    })
                  }
                  className="text-sm rounded-lg px-2 py-1.5"
                  style={INPUT_STYLE}
                />
                <span className="text-xs text-[#8b8fa3]">to</span>
                <input
                  type="time"
                  value={w.end}
                  onChange={(e) =>
                    applyField({
                      pickup_hours: (settings.pickup_hours ?? []).map((x, idx) =>
                        idx === i ? { ...x, end: e.target.value } : x,
                      ),
                    })
                  }
                  className="text-sm rounded-lg px-2 py-1.5"
                  style={INPUT_STYLE}
                />
                <button
                  onClick={() =>
                    applyField({
                      pickup_hours: (settings.pickup_hours ?? []).filter((_, idx) => idx !== i),
                    })
                  }
                  className="text-[#8b8fa3] hover:text-red-400 px-1.5 text-lg leading-none"
                  aria-label="Remove window"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                applyField({
                  pickup_hours: [...(settings.pickup_hours ?? []), { start: "10:00", end: "12:00" }],
                })
              }
              className="text-xs px-2.5 py-1.5 rounded-lg bg-white/[0.06] text-[#cbd5e1] hover:bg-white/[0.12]"
            >
              + Add window
            </button>
          </div>
        </div>

        <OnlineListingsEditor />
        </SettingsSection>

        <SettingsSection id="intelligence" eyebrow="Draft intelligence" title="Rental bot knowledge" description="Model routing, learned preferences and account-specific facts shape drafts only. You remain the sender." tone="violet">
        <p className="text-xs text-violet-200/70">Quick Reply drafts are generated only when requested, using the OpenRouter Haiku model.</p>
        <DraftLessonsEditor />

        <HardTruthsEditor />

        </SettingsSection>

        <SettingsSection id="returns" eyebrow="After return" title="Review & discount texts" description="Per-account wording used when you deliberately finalise a return.">
        <ReturnTextsEditor />
        </SettingsSection>
      </div>

      {saveError && (
        <p className="mt-3 text-xs" style={{ color: "#ef4444" }}>{saveError}</p>
      )}
      {saveOk && (
        <p className="mt-3 text-xs" style={{ color: "#22c55e" }}>Saved.</p>
      )}
    </Drawer>
  );
}
