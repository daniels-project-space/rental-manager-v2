"use client";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { makeFunctionReference } from "convex/server";
import { useRef, useState } from "react";
import type { Id } from "../../../convex/_generated/dataModel";
// Type-only (fully erased at emit) — `listing_price_admin` IS present in the
// committed `_generated/api`, so its functions are reached through `api.` and
// need no makeFunctionReference escape hatch.
import type { ExecuteSummary, PriceDiff } from "../../../convex/listing_price_admin";

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
const accountCommunicationListRef = makeFunctionReference<"query">("settings:listAccountCommunication");
const accountCommunicationSaveRef = makeFunctionReference<"mutation">("settings:setAccountCommunication");
const accountPersonaListRef = makeFunctionReference<"query">("settings:listAccountPersonaSettings");
const accountPersonaSaveRef = makeFunctionReference<"mutation">("settings:setAccountPersonaSettings");
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


type PersonaSettings = {
  account_id: Id<"accounts">;
  slug: string;
  display_name: string;
  persona_prompt: string;
  greeting_template: string;
  signoff_template: string;
};

function PersonaFieldsEditor() {
  const accounts = (useQuery(accountPersonaListRef, {}) ?? []) as PersonaSettings[];
  const save = useMutation(accountPersonaSaveRef);
  const [drafts, setDrafts] = useState<
    Record<string, { persona_prompt: string; greeting_template: string; signoff_template: string }>
  >({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  if (!accounts.length) return null;
  return (
    <div className="py-3">
      <label className="text-sm text-[#e4e6eb] block mb-1">AI persona, greeting &amp; signoff</label>
      <p className="text-xs mb-2" style={{ color: "#8b8fa3" }}>
        Persona prompt shapes the voice used when drafting replies (Reply Inbox drafting).
        Greeting / signoff templates are optional bookend wording. Never shown to renters
        unless the AI actually uses them in a draft.
      </p>
      <div className="space-y-4">
        {accounts.map((a) => {
          const id = String(a.account_id);
          const clean = {
            persona_prompt: a.persona_prompt,
            greeting_template: a.greeting_template,
            signoff_template: a.signoff_template,
          };
          const value = drafts[id] ?? clean;
          const dirty = JSON.stringify(value) !== JSON.stringify(clean);
          return (
            <div key={id} className="rounded-xl border border-white/[0.08] bg-black/15 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-[#cbd5e1]">{a.display_name}</span>
                {dirty ? (
                  <button
                    disabled={savingId === id}
                    onClick={async () => {
                      setSavingId(id);
                      setSavedId(null);
                      try {
                        await save({ account_id: a.account_id, ...value });
                        setDrafts((d) => {
                          const next = { ...d };
                          delete next[id];
                          return next;
                        });
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
              <div className="space-y-2">
                <div>
                  <label htmlFor={`persona-prompt-${id}`} className="text-[11px] text-[#8f96a3] block mb-1">
                    Persona prompt
                  </label>
                  <textarea
                    id={`persona-prompt-${id}`}
                    value={value.persona_prompt}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [id]: { ...value, persona_prompt: e.target.value } }))
                    }
                    rows={3}
                    placeholder="e.g. Friendly, concise, no emoji, always confirm dates before price…"
                    className="w-full resize-y rounded-lg px-2.5 py-2 text-[13px]"
                    style={INPUT_STYLE}
                  />
                </div>
                <div>
                  <label htmlFor={`greeting-template-${id}`} className="text-[11px] text-[#8f96a3] block mb-1">
                    Greeting template
                  </label>
                  <textarea
                    id={`greeting-template-${id}`}
                    value={value.greeting_template}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [id]: { ...value, greeting_template: e.target.value } }))
                    }
                    rows={2}
                    placeholder="Optional opening line template…"
                    className="w-full resize-y rounded-lg px-2.5 py-2 text-[13px]"
                    style={INPUT_STYLE}
                  />
                </div>
                <div>
                  <label htmlFor={`signoff-template-${id}`} className="text-[11px] text-[#8f96a3] block mb-1">
                    Signoff template
                  </label>
                  <textarea
                    id={`signoff-template-${id}`}
                    value={value.signoff_template}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [id]: { ...value, signoff_template: e.target.value } }))
                    }
                    rows={2}
                    placeholder="Optional closing line template…"
                    className="w-full resize-y rounded-lg px-2.5 py-2 text-[13px]"
                    style={INPUT_STYLE}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type DraftTextBlocks = {
  opening: string;
  availability: string;
  location: string;
  pickup_time: string;
  payment: string;
};

type AccountCommunication = {
  account_id: Id<"accounts">;
  slug: string;
  display_name: string;
  pickup_address: string;
  pickup_hours: Array<{ start: string; end: string }>;
  draft_text_blocks: DraftTextBlocks;
};

type CommunicationDraft = Pick<
  AccountCommunication,
  "pickup_address" | "pickup_hours" | "draft_text_blocks"
>;

const DRAFT_TEXT_FIELDS: Array<{
  key: keyof DraftTextBlocks;
  label: string;
  hint: string;
}> = [
  { key: "opening", label: "Opening / greeting", hint: "How a new renter enquiry should begin." },
  { key: "availability", label: "Availability / booking", hint: "How to explain availability and the next booking step." },
  { key: "location", label: "Location", hint: "Collection-location wording. Exact addresses stay hidden until confirmation." },
  { key: "pickup_time", label: "Pickup / return timing", hint: "How to offer the account's collection windows." },
  { key: "payment", label: "Payment", hint: "Payment, deposit or booking-completion wording." },
];

function makeCommunicationDraft(account: AccountCommunication): CommunicationDraft {
  return {
    pickup_address: account.pickup_address,
    pickup_hours: account.pickup_hours.map((window) => ({ ...window })),
    draft_text_blocks: { ...account.draft_text_blocks },
  };
}

/**
 * One clear source of truth for the per-account facts and wording that shape
 * automatic renter drafts. It deliberately keeps each account isolated: no
 * Leo text can spill into Diogo or DB Cinema.
 */
function AccountCommunicationEditor() {
  const accounts = (useQuery(accountCommunicationListRef, {}) ?? []) as AccountCommunication[];
  const save = useMutation(accountCommunicationSaveRef);
  const [activeSlug, setActiveSlug] = useState("leo");
  const [drafts, setDrafts] = useState<Record<string, CommunicationDraft>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const active = accounts.find((account) => account.slug === activeSlug) ?? accounts[0];
  if (!active) return null;
  const draft = drafts[active.slug] ?? makeCommunicationDraft(active);
  const clean = makeCommunicationDraft(active);
  const dirty = JSON.stringify(draft) !== JSON.stringify(clean);

  function update(next: CommunicationDraft) {
    setSaved(null);
    setDrafts((previous) => ({ ...previous, [active.slug]: next }));
  }

  async function saveActive() {
    setSaving(true);
    setSaved(null);
    setError(null);
    try {
      await save({
        account_id: active.account_id,
        pickup_address: draft.pickup_address,
        pickup_hours: draft.pickup_hours,
        draft_text_blocks: draft.draft_text_blocks,
      });
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[active.slug];
        return next;
      });
      setSaved(active.slug);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this account's draft controls.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1 overflow-x-auto rounded-xl bg-black/25 p-1" role="tablist" aria-label="Rental account">
        {accounts.map((account) => {
          const selected = active.slug === account.slug;
          return (
            <button
              key={account.slug}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => { setActiveSlug(account.slug); setError(null); setSaved(null); }}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                selected
                  ? "bg-violet-500/20 text-violet-100 ring-1 ring-violet-400/30"
                  : "text-[#8b8fa3] hover:text-[#d5d8df]"
              }`}
            >
              {account.display_name}
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="rounded-xl border border-white/[0.08] bg-black/15 p-3">
          <label htmlFor={`pickup-address-${active.slug}`} className="block text-xs font-semibold text-[#e8eaf0]">
            Confirmed-booking pickup address
          </label>
          <p className="mt-1 text-[11px] leading-snug text-[#8f96a3]">Never revealed before the booking is confirmed.</p>
          <textarea
            id={`pickup-address-${active.slug}`}
            aria-label={`${active.display_name} confirmed-booking pickup address`}
            value={draft.pickup_address}
            onChange={(event) => update({ ...draft, pickup_address: event.target.value })}
            rows={3}
            placeholder="Full collection address, postcode and arrival note"
            className="mt-2 w-full resize-y rounded-lg px-3 py-2 text-sm"
            style={INPUT_STYLE}
          />
        </div>

        <div className="rounded-xl border border-white/[0.08] bg-black/15 p-3">
          <p className="text-xs font-semibold text-[#e8eaf0]">Pickup / return windows</p>
          <p className="mt-1 text-[11px] leading-snug text-[#8f96a3]">Europe/London. These override the shared fallback for {active.display_name}.</p>
          <div className="mt-2 space-y-2">
            {draft.pickup_hours.length === 0 ? <p className="text-[11px] text-[#8f96a3]">Using the shared fallback windows.</p> : null}
            {draft.pickup_hours.map((window, index) => (
              <div key={`${index}-${window.start}-${window.end}`} className="flex items-center gap-2">
                <input
                  type="time"
                  aria-label={`${active.display_name} pickup window ${index + 1} start`}
                  value={window.start}
                  onChange={(event) => update({
                    ...draft,
                    pickup_hours: draft.pickup_hours.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, start: event.target.value } : item,
                    ),
                  })}
                  className="rounded-lg px-2 py-1.5 text-sm"
                  style={INPUT_STYLE}
                />
                <span className="text-xs text-[#8b8fa3]">to</span>
                <input
                  type="time"
                  aria-label={`${active.display_name} pickup window ${index + 1} end`}
                  value={window.end}
                  onChange={(event) => update({
                    ...draft,
                    pickup_hours: draft.pickup_hours.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, end: event.target.value } : item,
                    ),
                  })}
                  className="rounded-lg px-2 py-1.5 text-sm"
                  style={INPUT_STYLE}
                />
                <button
                  type="button"
                  aria-label={`Remove ${active.display_name} pickup window ${index + 1}`}
                  onClick={() => update({ ...draft, pickup_hours: draft.pickup_hours.filter((_, itemIndex) => itemIndex !== index) })}
                  className="ml-auto rounded-md px-2 py-1 text-sm text-[#8b8fa3] hover:bg-rose-500/10 hover:text-rose-300"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => update({ ...draft, pickup_hours: [...draft.pickup_hours, { start: "10:00", end: "12:00" }] })}
              className="rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-xs text-[#cbd5e1] hover:bg-white/[0.12]"
            >
              + Add window
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {DRAFT_TEXT_FIELDS.map((field) => (
          <div key={field.key} className="rounded-xl border border-white/[0.08] bg-black/15 p-3">
            <label htmlFor={`draft-text-${active.slug}-${field.key}`} className="block text-xs font-semibold text-[#e8eaf0]">
              {field.label}
            </label>
            <p className="mt-1 text-[11px] leading-snug text-[#8f96a3]">{field.hint}</p>
            <textarea
              id={`draft-text-${active.slug}-${field.key}`}
              aria-label={`${active.display_name} ${field.label} automatic draft wording`}
              value={draft.draft_text_blocks[field.key]}
              onChange={(event) => update({
                ...draft,
                draft_text_blocks: { ...draft.draft_text_blocks, [field.key]: event.target.value },
              })}
              rows={4}
              placeholder={`Optional ${field.label.toLowerCase()} wording…`}
              className="mt-2 w-full resize-y rounded-lg px-3 py-2 text-sm"
              style={INPUT_STYLE}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-violet-400/15 bg-violet-500/[0.05] px-3 py-2.5">
        <p className="mr-auto text-[11px] leading-snug text-violet-100/70">Saving refreshes any cached draft before it can be reused.</p>
        {error ? <span className="text-xs text-rose-300" role="alert">{error}</span> : null}
        {saved === active.slug ? <span className="text-xs text-emerald-300" aria-live="polite">Saved</span> : null}
        <button
          type="button"
          disabled={saving || !dirty}
          onClick={() => void saveActive()}
          className="rounded-lg bg-violet-500/20 px-3 py-1.5 text-xs font-semibold text-violet-100 ring-1 ring-violet-400/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save account controls"}
        </button>
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

interface SettingsWorkspaceProps {
  onBack: () => void;
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

// ── Bulk listing-price adjustment ────────────────────────────────────────────

/** £ with pennies only when they carry information. */
function gbp(n: number): string {
  return `£${n.toFixed(2).replace(/\.00$/, "")}`;
}

/** Signed £, for deltas. Uses a real minus sign to match the −10% button. */
function signedGbp(n: number): string {
  return `${n < 0 ? "−" : "+"}${gbp(Math.abs(n))}`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One staged run. Only ever one at a time across every account — a second bulk
 * price rewrite must not be startable while one is mid-flight.
 */
type PriceFlow =
  | { kind: "idle" }
  | { kind: "previewing"; slug: string; percent: number }
  | { kind: "confirm"; slug: string; percent: number; diff: PriceDiff }
  | { kind: "applying"; slug: string; percent: number; diff: PriceDiff }
  | { kind: "done"; slug: string; percent: number; summary: ExecuteSummary }
  | { kind: "failed"; slug: string; percent: number; phase: "preview" | "apply"; message: string };

/**
 * Bulk one-day price adjustment across every listing on a Hygglo account.
 *
 * This is the only control in the dashboard that rewrites LIVE marketplace
 * prices, so it runs as a staged flow in the same shape as ReturnHub's confirm
 * step: a button press only ever fetches numbers, those numbers are shown, and
 * a second explicit click is what commits.
 *
 * The preview deliberately uses `dryRunPriceChange` (a pure query, zero side
 * effects) rather than minting a proposal up front. Two reasons: pressing +10%
 * then changing your mind writes nothing at all, and the proposal's 15-minute
 * token is minted seconds before it is spent rather than while the operator
 * reads the diff — so a slow read can't strand the run on an expired token.
 *
 * Nothing rendered here is trusted by the write path: `executePriceChange`
 * re-derives the diff server-side and drift-checks every listing's live price
 * before touching it. These numbers are for the human, not for the server.
 */
function ListingPriceEditor() {
  const convex = useConvex();
  const createProposal = useMutation(api.listing_price_admin.createPriceChangeProposal);
  const executeChange = useAction(api.listing_price_admin.executePriceChange);
  const [flow, setFlow] = useState<PriceFlow>({ kind: "idle" });
  // Hard single-submit latch. The buttons are disabled too, but a ref closes
  // the window where two clicks land before React has re-rendered.
  const inFlight = useRef(false);

  function labelFor(slug: string): string {
    return LISTING_ACCOUNTS.find((a) => a.slug === slug)?.label ?? slug;
  }

  /** Step 1 — read-only. Safe to run as often as you like. */
  async function preview(slug: string, percent: number) {
    if (inFlight.current) return;
    inFlight.current = true;
    setFlow({ kind: "previewing", slug, percent });
    try {
      const diff = await convex.query(api.listing_price_admin.dryRunPriceChange, {
        account_slug: slug,
        percent_change: percent,
      });
      setFlow({ kind: "confirm", slug, percent, diff });
    } catch (e) {
      setFlow({ kind: "failed", slug, percent, phase: "preview", message: errText(e) });
    } finally {
      inFlight.current = false;
    }
  }

  /** Step 2 — the real write. Only reachable from the confirm view. */
  async function apply() {
    if (flow.kind !== "confirm" || inFlight.current) return;
    const { slug, percent, diff } = flow;
    inFlight.current = true;
    setFlow({ kind: "applying", slug, percent, diff });
    try {
      const proposal = await createProposal({
        account_slug: slug,
        percent_change: percent,
        source: "settings_dashboard",
      });
      const summary = await executeChange({
        account_slug: slug,
        percent_change: percent,
        confirmation_token: proposal.token,
      });
      setFlow({ kind: "done", slug, percent, summary });
    } catch (e) {
      // No auto-retry: re-running blind could double-apply. The failure view
      // routes back to a fresh dry run so the operator re-reads real numbers.
      setFlow({ kind: "failed", slug, percent, phase: "apply", message: errText(e) });
    } finally {
      inFlight.current = false;
    }
  }

  const PCT = [10, -10] as const;

  // ── idle: the account grid ────────────────────────────────────────────────
  if (flow.kind === "idle") {
    return (
      <div className="py-1">
        <p className="text-xs mb-3" style={{ color: "#8b8fa3" }}>
          Shifts the <b>one-day</b> price of every listing on an account, rounded to the
          nearest £0.50 and never below £1. Listings without a single clean one-day tier
          are skipped, never guessed. You always see the numbers before anything is applied.
        </p>
        <div className="space-y-2">
          {LISTING_ACCOUNTS.map((acct) => (
            <div
              key={acct.slug}
              className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-black/15 p-2.5"
            >
              <span className="flex-1 min-w-0 text-sm text-[#e8eaf0]">{acct.label}</span>
              {PCT.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => void preview(acct.slug, p)}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 transition-colors ${
                    p > 0
                      ? "bg-emerald-500/10 text-emerald-300 ring-emerald-400/25 hover:bg-emerald-500/20"
                      : "bg-rose-500/10 text-rose-300 ring-rose-400/25 hover:bg-rose-500/20"
                  }`}
                >
                  {p > 0 ? `+${p}%` : `−${Math.abs(p)}%`}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const pctLabel = flow.percent > 0 ? `+${flow.percent}%` : `−${Math.abs(flow.percent)}%`;
  const acctLabel = labelFor(flow.slug);

  // ── previewing ────────────────────────────────────────────────────────────
  if (flow.kind === "previewing") {
    return (
      <div className="py-4 text-center">
        <p className="text-sm text-[#cbd5e1]">
          Working out what {pctLabel} would do to {acctLabel}&apos;s listings…
        </p>
      </div>
    );
  }

  // ── failed (either phase) ─────────────────────────────────────────────────
  if (flow.kind === "failed") {
    return (
      <div className="py-2">
        <div
          className="rounded-xl px-3 py-2.5 text-xs leading-snug"
          style={{ background: "rgba(239,68,68,0.1)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)" }}
          role="alert"
        >
          <p className="font-semibold">
            {flow.phase === "preview"
              ? `Couldn't price up ${pctLabel} for ${acctLabel}.`
              : `The ${pctLabel} run on ${acctLabel} stopped with an error.`}
          </p>
          <p className="mt-1 opacity-90">{flow.message}</p>
          {flow.phase === "apply" && (
            <p className="mt-1.5 opacity-80">
              Re-run the preview to see the live prices as they stand now before trying again —
              don&apos;t assume the batch did or didn&apos;t land. Every attempt is in the
              <code className="mx-1 rounded bg-black/30 px-1">price_change_audit</code> table.
            </p>
          )}
        </div>
        <div className="mt-2.5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setFlow({ kind: "idle" })}
            className="rounded-lg px-3 py-1.5 text-xs text-[#8b8fa3] transition-colors hover:text-[#e4e6eb]"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void preview(flow.slug, flow.percent)}
            className="rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-[#cbd5e1] hover:bg-white/[0.12]"
          >
            Try again — fresh preview
          </button>
        </div>
      </div>
    );
  }

  // ── done ──────────────────────────────────────────────────────────────────
  if (flow.kind === "done") {
    const { succeeded, failed } = flow.summary;
    // 27 identical "stale listing id" lines help nobody — collapse by message.
    const byError = new Map<string, number[]>();
    for (const f of failed) {
      const ids = byError.get(f.error) ?? [];
      ids.push(f.listing_id);
      byError.set(f.error, ids);
    }
    return (
      <div className="py-2">
        <div
          className="rounded-xl px-3 py-2.5"
          style={
            failed.length === 0
              ? { background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)" }
              : { background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)" }
          }
        >
          <p className="text-sm font-semibold" style={{ color: failed.length === 0 ? "#34d399" : "#fbbf24" }}>
            {failed.length === 0 ? "✓ " : "⚠ "}
            {pctLabel} applied to {succeeded.length} of {succeeded.length + failed.length} {acctLabel} listings
          </p>
          {failed.length > 0 && (
            <div className="mt-2 space-y-1">
              <p className="text-[11px] font-semibold text-[#e8eaf0]">{failed.length} failed:</p>
              {Array.from(byError.entries()).map(([message, ids]) => (
                <p key={message} className="text-[11px] leading-snug text-[#c7ccd6]">
                  <span className="font-semibold">{ids.length}×</span> {message}
                  <span className="text-[#7f8795]">
                    {" "}
                    ({ids.slice(0, 4).join(", ")}
                    {ids.length > 4 ? `, +${ids.length - 4} more` : ""})
                  </span>
                </p>
              ))}
              <p className="text-[11px] leading-snug text-[#8f96a3]">
                Failures are per-listing and isolated — the successful listings above are
                already live. Nothing needs undoing for the ones that failed.
              </p>
            </div>
          )}
          <p className="mt-2 text-[11px] leading-snug text-[#8f96a3]">
            Every attempt, success or failure, is recorded in the
            <code className="mx-1 rounded bg-black/30 px-1">price_change_audit</code> Convex table
            (indexed by account and by time). The cached catalogue still holds the old prices until
            the next catalog sync — run another adjustment only after it has caught up, or the
            live-price drift check will refuse the lot.
          </p>
        </div>
        <div className="mt-2.5 flex justify-end">
          <button
            type="button"
            onClick={() => setFlow({ kind: "idle" })}
            className="rounded-lg bg-violet-500/20 px-3 py-1.5 text-xs font-semibold text-violet-100 ring-1 ring-violet-400/25"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  // ── confirm / applying (share the diff panel) ─────────────────────────────
  const { diff } = flow;
  const applying = flow.kind === "applying";
  const delta = diff.rows.reduce((sum, r) => sum + (r.new_price - r.old_price), 0);
  const examples = diff.rows.slice(0, 5);
  const nothingToDo = diff.count === 0;

  return (
    <div className="py-2">
      <h3 className="text-sm font-semibold text-[#e8eaf0]">
        Apply {pctLabel} to {acctLabel}?
      </h3>

      <div
        className="mt-2 rounded-xl px-3 py-2.5 text-xs leading-snug"
        style={{ background: "rgba(239,68,68,0.1)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)" }}
      >
        This rewrites <b>live prices on Hygglo</b> for real renters. It is not a
        simulation and <b>there is no undo</b> — reversing it means running the
        opposite adjustment, which will not land back on the same numbers because
        of rounding.
      </div>

      {nothingToDo ? (
        <p className="mt-2.5 text-xs text-[#fbbf24]">
          No listing on {acctLabel} has a usable one-day price tier, so there is nothing to change.
        </p>
      ) : (
        <>
          <div className="mt-2.5 grid grid-cols-3 gap-2">
            {[
              ["Listings", String(diff.count)],
              ["Change", pctLabel],
              ["One-day total", signedGbp(delta)],
            ].map(([k, val]) => (
              <div key={k} className="rounded-xl border border-white/[0.08] bg-black/15 px-2.5 py-2">
                <p className="text-[10px] uppercase tracking-[0.12em] text-[#7f8795]">{k}</p>
                <p className="mt-0.5 text-sm font-semibold text-[#f0f2f6]">{val}</p>
              </div>
            ))}
          </div>

          <div className="mt-2.5 rounded-xl border border-white/[0.08] bg-black/15 p-2.5">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#7f8795]">
              Examples
            </p>
            <div className="space-y-1">
              {examples.map((r) => (
                <div key={r.listing_id} className="flex items-baseline gap-2 text-[11px]">
                  <span className="min-w-0 flex-1 truncate text-[#c7ccd6]">
                    {r.name ?? `Listing ${r.listing_id}`}
                  </span>
                  <span className="shrink-0 font-mono text-[#8f96a3]">{gbp(r.old_price)}</span>
                  <span className="shrink-0 text-[#5f6673]">→</span>
                  <span
                    className="shrink-0 font-mono font-semibold"
                    style={{ color: r.new_price >= r.old_price ? "#34d399" : "#fb7185" }}
                  >
                    {gbp(r.new_price)}
                  </span>
                </div>
              ))}
              {diff.count > examples.length && (
                <p className="pt-0.5 text-[11px] text-[#7f8795]">
                  + {diff.count - examples.length} more listing
                  {diff.count - examples.length === 1 ? "" : "s"}
                </p>
              )}
            </div>
          </div>

          {diff.skipped.length > 0 && (
            <p className="mt-2 text-[11px] leading-snug text-[#fbbf24]">
              {diff.skipped.length} listing{diff.skipped.length === 1 ? "" : "s"} will be skipped
              (no single clean one-day price tier) and left exactly as {diff.skipped.length === 1 ? "it is" : "they are"}.
            </p>
          )}
        </>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        {applying && (
          <p className="mr-auto text-[11px] leading-snug text-[#8f96a3]">
            Writing to Hygglo one listing at a time — this can take a few minutes for a
            large catalogue. Leave this open.
          </p>
        )}
        <button
          type="button"
          onClick={() => setFlow({ kind: "idle" })}
          disabled={applying}
          className="rounded-lg px-3 py-1.5 text-xs text-[#8b8fa3] transition-colors hover:text-[#e4e6eb] disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={applying || nothingToDo}
          className="inline-flex items-center gap-2 rounded-lg px-4 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60"
          style={{
            background: "rgba(239,68,68,0.16)",
            color: "#fca5a5",
            border: "1px solid rgba(239,68,68,0.45)",
          }}
        >
          {applying && (
            <span
              className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden
            />
          )}
          {applying
            ? `Applying ${pctLabel} to ${diff.count} listings…`
            : `Apply ${pctLabel} to ${diff.count} listing${diff.count === 1 ? "" : "s"}`}
        </button>
      </div>
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

export function SettingsWorkspace({ onBack }: SettingsWorkspaceProps) {
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
    onBack();
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

  const polling = Math.max(settings?.polling_interval_ms ?? 300000, 120000);
  const displayPolling =
    pollingInput !== "" ? pollingInput : String(Math.max(2, Math.round(polling / 60000)));

  async function handlePollingBlur() {
    const mins = parseInt(pollingInput || String(Math.round(polling / 60000)));
    if (isNaN(mins)) return;
    const ms = Math.max(120000, Math.min(3600000, mins * 60000));
    await applyField({ polling_interval_ms: ms });
    setPollingInput("");
  }

  if (settings == null) {
    return (
      <div className="min-h-[100dvh] bg-[#070910] text-[#e4e6eb]">
        <header className="border-b border-white/[0.08] bg-[#0a0c14]/95 px-4 py-3 backdrop-blur md:px-6">
          <button type="button" onClick={onBack} className="rounded-lg px-2 py-1 text-sm text-[#cbd5e1] hover:bg-white/[0.06]">
            ← Back to dashboard
          </button>
        </header>
        <p className="mx-auto max-w-7xl px-4 py-8 text-sm text-[#8b8fa3] md:px-6">Loading settings…</p>
      </div>
    );
  }

  return (
    <div className="settings-workspace-enter min-h-[100dvh] bg-[#070910] text-[#e4e6eb]">
      <header className="sticky top-0 z-30 border-b border-white/[0.08] bg-[#0a0c14]/95 px-4 py-3 backdrop-blur md:px-6">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium text-[#d9dce4] transition hover:bg-white/[0.06]"
          >
            <span aria-hidden="true">←</span> Back to dashboard
          </button>
          <div className="text-right">
            <p className="text-sm font-semibold text-[#f2f3f6]">Rental operations</p>
            <p className="text-[11px] text-[#858c99]">Settings workspace</p>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-5 px-4 py-5 md:px-6 lg:grid-cols-[210px_minmax(0,1fr)] lg:py-7">
        <aside className="lg:sticky lg:top-20 lg:h-fit">
          <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.025] p-2 lg:flex-col lg:overflow-visible">
            {[
              ["#safety", "Safety"],
              ["#communication", "Account communication"],
              ["#quick-texts", "Quick texts"],
              ["#operations", "Operations"],
              ["#pricing", "Listing prices"],
              ["#intelligence", "AI drafts"],
              ["#returns", "Returns"],
            ].map(([href, label]) => (
              <a key={href} href={href} className="shrink-0 rounded-xl px-3 py-2 text-xs font-medium text-[#9aa0ad] transition hover:bg-violet-500/10 hover:text-violet-100">
                {label}
              </a>
            ))}
          </nav>
          <p className="mt-3 hidden px-2 text-[11px] leading-relaxed text-[#6f7581] lg:block">
            Changes save to the live account configuration. Renter messages remain draft-only.
          </p>
        </aside>

        <main className="min-w-0 space-y-4 pb-10">
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

        <div className="grid gap-4 xl:grid-cols-2">
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

        <div className="xl:col-span-2">
          <SettingsSection id="communication" eyebrow="Per account" title="Automatic-draft communication" description="Control the exact operational wording Wall‑E and Quick Reply drafts use for each account. These blocks are separate from manual shortcuts and never send on their own." tone="violet">
            <AccountCommunicationEditor />
          </SettingsSection>
        </div>

        <SettingsSection id="operations" eyebrow="Live operations" title="Polling, hubs & collection" description="Controls the data refresh cadence and the real-world locations and hours used by availability and drafts.">
        <div className="py-1">
          <label className="text-sm text-[#e4e6eb] block mb-1">Polling interval</label>
          <p className="text-xs mb-2" style={{ color: "#8b8fa3" }}>
            Effective Hygglo polling cadence (minutes, 2-60). Trigger checks every two minutes and skips work until this interval has elapsed.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={2}
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

        <div className="xl:col-span-2">
          <SettingsSection
            id="pricing"
            eyebrow="Real money · live marketplace"
            title="Bulk listing prices"
            description="Move an account's one-day rental price across its whole catalogue. Every press shows you the exact diff first; only a second, explicit confirmation writes to Hygglo. There is no undo."
          >
            <ListingPriceEditor />
          </SettingsSection>
        </div>

        <SettingsSection id="intelligence" eyebrow="Draft intelligence" title="Rental bot knowledge" description="Model routing, learned preferences and account-specific facts shape drafts only. You remain the sender." tone="violet">
        <p className="text-xs text-violet-200/70">Quick Reply drafts are generated only when requested, using the OpenRouter Haiku model.</p>
        <DraftLessonsEditor />

        <HardTruthsEditor />

        <PersonaFieldsEditor />

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
        </main>
      </div>
    </div>
  );
}
