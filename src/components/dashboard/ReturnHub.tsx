"use client";
import { useMutation, useQuery } from "convex/react";
import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

type RenterTrust = {
  blacklisted: boolean;
  whitelisted: boolean;
  blacklist_reason: string | null;
  total_rentals: number | null;
  rating: number | null;
  note_count: number;
  notes: string | null;
};

type DueReturn = {
  reservationId: Id<"reservations">;
  renterName: string;
  itemNames: string[];
  endDate?: string;
  isOverdue: boolean;
  accountSlug?: string;
  orderStep?: string | null;
  imageUrl?: string | null;
  renter?: RenterTrust;
  returnTime?: string | null;
  memberIds?: Id<"reservations">[];
  memberCount?: number;
  items?: { item_id: string; name: string; qty?: number }[];
};

function Thumb({ url, name, size = 36 }: { url?: string | null; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={url}
        alt=""
        onError={() => setBroken(true)}
        className="flex-shrink-0 rounded-lg object-cover"
        style={{ width: size, height: size, background: "rgba(255,255,255,0.05)" }}
        loading="lazy"
      />
    );
  }
  return (
    <div
      className="flex-shrink-0 flex items-center justify-center rounded-lg text-xs font-bold"
      style={{ width: size, height: size, background: "rgba(255,255,255,0.06)", color: "#8b8fa3" }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function TrustBadge({ t }: { t?: RenterTrust }) {
  if (!t) return null;
  if (t.blacklisted)
    return (
      <span
        className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0"
        style={{ background: "rgba(239,68,68,0.18)", color: "#f87171", border: "1px solid rgba(239,68,68,0.4)" }}
        title={t.blacklist_reason ?? "blacklisted"}
      >
        ⛔ blacklisted
      </span>
    );
  if (t.whitelisted)
    return (
      <span
        className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0"
        style={{ background: "rgba(34,197,94,0.16)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.35)" }}
        title={t.notes ?? "trusted"}
      >
        ✓ trusted
      </span>
    );
  return null;
}

type ReturnPayload = {
  outcome: "smooth" | "issues" | "fantastic";
  condition: string;
  notes?: string;
  issueDetails?: string;
  flagOnRequest?: boolean;
  blacklist?: boolean;
  blacklistReason?: string;
  whitelist?: boolean;
  whitelistReason?: string;
  sendReview?: boolean;
};

/** Preset issue tags shown as one-tap chips in the "what went wrong" view. */
const ISSUE_PRESETS = [
  "Damage to gear",
  "Rude behavior",
  "Late timings",
  "Late return",
  "Bad communication",
] as const;

function ReturnModal({
  item,
  onClose,
  onConfirm,
}: {
  item: DueReturn;
  onClose: () => void;
  onConfirm: (p: ReturnPayload) => Promise<void>;
}) {
  const [view, setView] = useState<"choose" | "issues" | "fantastic" | "done">("choose");
  const [condition, setCondition] = useState<"minor" | "major">("minor");
  const [issueDetails, setIssueDetails] = useState("");
  const [issueAction, setIssueAction] = useState<"none" | "flag" | "blacklist">("none");
  const [reason, setReason] = useState("");
  const [wlReason, setWlReason] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [issueTags, setIssueTags] = useState<Set<string>>(() => new Set());
  const discountCode = item.accountSlug === "dbcinema" ? "DB15OFF" : "LEO10OFF";
  const toggleTag = (t: string) =>
    setIssueTags((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  // Selected chips + free text, combined into one renter-history string.
  const composedIssues = [Array.from(issueTags).join(", "), issueDetails.trim()].filter(Boolean).join(" — ");

  async function finish(p: ReturnPayload, msg: string) {
    if (submitting) return;
    setError(null);
    setSummary(msg);
    setSubmitting(true);
    try {
      await onConfirm(p);
      setView("done");
      setTimeout(onClose, 2200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const errorBanner = error ? (
    <div className="text-xs mb-3 px-2 py-1.5 rounded" style={{ background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)" }}>
      ⚠ {error}
    </div>
  ) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="glass-card p-6 w-full max-w-sm">
        <div className="flex items-center gap-3 mb-4">
          <Thumb url={item.imageUrl} name={item.renterName} size={44} />
          <div className="min-w-0">
            <div className="text-sm text-[#e4e6eb] flex items-center gap-2">
              <span className="truncate font-medium">{item.renterName}</span>
              <TrustBadge t={item.renter} />
            </div>
            <div className="text-xs text-[#8b8fa3] truncate">{item.itemNames.join(", ")}</div>
          </div>
        </div>
        {item.renter?.blacklisted && view !== "done" && (
          <div className="text-xs mb-3 px-2 py-1.5 rounded" style={{ background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)" }}>
            ⛔ Already blacklisted{item.renter.blacklist_reason ? `: ${item.renter.blacklist_reason}` : ""}.
          </div>
        )}

        {view === "choose" && (
          <>
            <h3 className="text-base font-semibold text-[#e4e6eb] mb-3">How was this rental?</h3>
            {errorBanner}
            <div className="space-y-2">
              <button
                disabled={submitting}
                onClick={() => finish({ outcome: "smooth", condition: "good", sendReview: true }, `✓ Returned — pending platform close · ${discountCode} + ⭐ review ask prepared`)}
                className="w-full text-left px-3 py-2.5 rounded-xl transition-colors hover:brightness-125 disabled:opacity-40"
                style={{ border: "1px solid rgba(34,197,94,0.45)", background: "rgba(34,197,94,0.08)" }}
              >
                <div className="text-sm font-semibold" style={{ color: "#34d399" }}>🟢 Smooth — all good</div>
                <div className="text-[11px] text-[#8b8fa3]">Mark returned · prepare the discount code + review ask</div>
              </button>
              <button
                disabled={submitting}
                onClick={() => setView("fantastic")}
                className="w-full text-left px-3 py-2.5 rounded-xl transition-colors hover:brightness-125 disabled:opacity-40"
                style={{ border: "1px solid rgba(251,191,36,0.5)", background: "rgba(251,191,36,0.08)" }}
              >
                <div className="text-sm font-semibold" style={{ color: "#fbbf24" }}>🏆 Fantastic renter</div>
                <div className="text-[11px] text-[#8b8fa3]">Whitelist them (trusted) · discount code + review ask</div>
              </button>
              <button
                disabled={submitting}
                onClick={() => setView("issues")}
                className="w-full text-left px-3 py-2.5 rounded-xl transition-colors hover:brightness-125 disabled:opacity-40"
                style={{ border: "1px solid rgba(239,68,68,0.5)", background: "rgba(239,68,68,0.08)" }}
              >
                <div className="text-sm font-semibold" style={{ color: "#f87171" }}>🔴 There were issues</div>
                <div className="text-[11px] text-[#8b8fa3]">Log damage/problems · flag or blacklist</div>
              </button>
            </div>
            <div className="flex justify-end mt-3">
              <button onClick={onClose} disabled={submitting} className="text-sm px-3 py-1.5 rounded text-[#8b8fa3] hover:text-[#e4e6eb] transition-colors disabled:opacity-40">Cancel</button>
            </div>
          </>
        )}

        {view === "issues" && (
          <>
            <h3 className="text-base font-semibold mb-3" style={{ color: "#f87171" }}>🔴 What went wrong?</h3>
            {errorBanner}
            <div className="flex flex-wrap gap-1.5 mb-3">
              {ISSUE_PRESETS.map((t) => {
                const on = issueTags.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleTag(t)}
                    className="text-[11px] font-medium px-2 py-1 rounded-full transition-colors"
                    style={{
                      background: on ? "rgba(239,68,68,0.18)" : "rgba(255,255,255,0.05)",
                      color: on ? "#f87171" : "#9296a6",
                      border: `1px solid ${on ? "rgba(239,68,68,0.5)" : "rgba(255,255,255,0.1)"}`,
                    }}
                  >
                    {on ? "✓ " : ""}{t}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-4 mb-3">
              {(["minor", "major"] as const).map((c) => (
                <label key={c} className="flex items-center gap-1.5 cursor-pointer text-sm text-[#e4e6eb]">
                  <input type="radio" name="cond" checked={condition === c} onChange={() => setCondition(c)} className="accent-[#f87171]" />
                  {c === "minor" ? "Minor damage" : "Major damage"}
                </label>
              ))}
            </div>
            <textarea
              placeholder="More detail? (optional — added to the renter's history)"
              value={issueDetails}
              onChange={(e) => setIssueDetails(e.target.value)}
              className="w-full text-sm rounded-lg p-2 mb-3 resize-none h-16"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e6eb" }}
            />
            <div className="space-y-1.5 mb-3">
              {([["none", "Just log it"], ["flag", "⚑ Flag — alert me if they request again"], ["blacklist", "⛔ Blacklist — block future bookings"]] as const).map(([v, l]) => (
                <label key={v} className="flex items-center gap-2 cursor-pointer text-xs text-[#e4e6eb]">
                  <input type="radio" name="ia" checked={issueAction === v} onChange={() => setIssueAction(v)} className="accent-[#f87171]" />
                  {l}
                </label>
              ))}
              {issueAction === "blacklist" && (
                <input
                  type="text"
                  placeholder="blacklist reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full text-xs rounded p-1.5 mt-1"
                  style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(239,68,68,0.3)", color: "#e4e6eb" }}
                />
              )}
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setView("choose")} disabled={submitting} className="text-sm px-3 py-1.5 rounded text-[#8b8fa3] hover:text-[#e4e6eb] transition-colors disabled:opacity-40">Back</button>
              <button
                disabled={submitting}
                onClick={() => finish(
                  { outcome: "issues", condition, notes: composedIssues || undefined, issueDetails: composedIssues || undefined, flagOnRequest: issueAction === "flag", blacklist: issueAction === "blacklist", blacklistReason: issueAction === "blacklist" ? (reason || composedIssues || undefined) : undefined, sendReview: false },
                  issueAction === "blacklist" ? "⛔ Logged · renter blacklisted · pending platform close" : issueAction === "flag" ? "⚑ Logged · flagged on next request · pending platform close" : "Issue logged to renter history · pending platform close",
                )}
                className="text-sm px-4 py-1.5 rounded transition-colors disabled:opacity-40"
                style={{ background: "rgba(239,68,68,0.15)", color: "#f87171", border: "1px solid rgba(239,68,68,0.4)" }}
              >
                {submitting ? "Saving…" : "Save & close"}
              </button>
            </div>
          </>
        )}

        {view === "fantastic" && (
          <>
            <h3 className="text-base font-semibold mb-3" style={{ color: "#fbbf24" }}>🏆 Fantastic renter</h3>
            {errorBanner}
            <p className="text-xs text-[#8b8fa3] mb-3">
              Whitelists {item.renterName} (trusted badge) and queues a thank-you + ⭐ review request.
            </p>
            <input
              type="text"
              placeholder="Why? (optional — spotless return, great comms…)"
              value={wlReason}
              onChange={(e) => setWlReason(e.target.value)}
              className="w-full text-sm rounded-lg p-2 mb-3"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(251,191,36,0.3)", color: "#e4e6eb" }}
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setView("choose")} disabled={submitting} className="text-sm px-3 py-1.5 rounded text-[#8b8fa3] hover:text-[#e4e6eb] transition-colors disabled:opacity-40">Back</button>
              <button
                disabled={submitting}
                onClick={() => finish({ outcome: "fantastic", condition: "good", whitelist: true, whitelistReason: wlReason || undefined, sendReview: true }, `🏆 Whitelisted — pending platform close · ${discountCode} + ⭐ review ask prepared`)}
                className="text-sm px-4 py-1.5 rounded font-semibold transition-colors disabled:opacity-40"
                style={{ background: "rgba(251,191,36,0.18)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.5)" }}
              >
                {submitting ? "Saving…" : "Whitelist & close"}
              </button>
            </div>
          </>
        )}

        {view === "done" && (
          <div className="flex flex-col items-center py-3 gap-2 text-center">
            <div className="text-4xl">✓</div>
            <p className="text-sm font-semibold text-[#e4e6eb]">{summary}</p>
            <p className="text-[10px] text-[#8b8fa3] mt-1 px-2 leading-snug">
              Platform close &amp; the renter message are <b>preview-only (read-only)</b> for now — prepared, not sent. Good renters get the discount code; flagged / blacklisted renters are only marked returned. Flag / whitelist / blacklist are saved now.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function OpenCaseModal({
  item,
  onClose,
  onConfirm,
}: {
  item: DueReturn;
  onClose: () => void;
  onConfirm: (projected: number, description: string, repairItemIds: string[]) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [desc, setDesc] = useState("");
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allItems = item.items ?? [];
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allItems.map((i) => i.item_id)));
  const [holdQty, setHoldQty] = useState<Map<string, number>>(() => new Map(allItems.map((i) => [i.item_id, Math.max(1, i.qty ?? 1)])));
  const qtyMaxById = new Map(allItems.map((i) => [i.item_id, Math.max(1, i.qty ?? 1)]));
  const [manual, setManual] = useState<{ item_id: string; name: string }[]>([]);
  const inventory = (useQuery(api.items.listActive) ?? []) as { id: string; name: string }[];
  const shownItems = (() => {
    const seen = new Set<string>();
    const out: { item_id: string; name: string }[] = [];
    for (const it of [...allItems, ...manual]) {
      if (seen.has(it.item_id)) continue;
      seen.add(it.item_id);
      out.push(it);
    }
    return out;
  })();
  const addable = inventory.filter((i) => !shownItems.some((s) => s.item_id === i.id));
  const projected = Math.max(0, Math.round(Number(value) || 0));
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function submit() {
    if (projected <= 0 || done || submitting) return;
    const ids: string[] = [];
    for (const id of selected) { const q = holdQty.get(id) ?? 1; for (let k = 0; k < q; k++) ids.push(id); }
    setError(null);
    setSubmitting(true);
    try {
      await onConfirm(projected, desc, ids);
      setDone(true);
      setTimeout(onClose, 1400);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg || "Failed to open case — please try again.");
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="glass-card p-6 w-full max-w-sm">
        {done ? (
          <div className="flex flex-col items-center py-4 gap-2">
            <div className="text-5xl" style={{ color: "#f59e0b" }}>📂</div>
            <p className="text-base font-semibold" style={{ color: "#f59e0b" }}>Case opened</p>
            <p className="text-xs" style={{ color: "#f87171" }}>{item.renterName} flagged · moved to Cases</p>
          </div>
        ) : (
          <>
            <h3 className="text-base font-semibold text-[#e4e6eb] mb-3">Open case</h3>
            <div className="flex items-center gap-2 mb-3">
              <Thumb url={item.imageUrl} name={item.renterName} size={44} />
              <div className="min-w-0">
                <div className="text-sm text-[#e4e6eb] truncate">{item.renterName}</div>
                <div className="text-xs text-[#8b8fa3] truncate">{item.itemNames.join(", ")}</div>
              </div>
            </div>
            <div className="text-xs mb-3 px-2 py-1.5 rounded" style={{ background: "rgba(245,158,11,0.1)", color: "#fbbf24", border: "1px solid rgba(245,158,11,0.3)" }}>
              Flags (blacklists) {item.renterName} and moves this rental to the Cases pipeline at stage 1. It leaves the Return Hub.
            </div>
            <div className="mb-3">
              <label className="block text-xs text-[#8b8fa3] mb-1">Items out on repair (drop stock until closed)</label>
              <div className="space-y-1 max-h-28 overflow-y-auto rounded-lg p-1.5" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
                {shownItems.length === 0 && (
                  <p className="text-[11px] text-[#8b8fa3] px-1 py-0.5">No items auto-detected — add from inventory below.</p>
                )}
                {shownItems.map((it) => {
                  const maxq = Math.max(1, qtyMaxById.get(it.item_id) ?? 1);
                  const isSel = selected.has(it.item_id);
                  return (
                    <div key={it.item_id} className="flex items-center gap-2 text-xs text-[#e4e6eb]">
                      <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                        <input type="checkbox" checked={isSel} onChange={() => toggle(it.item_id)} className="accent-[#f59e0b]" />
                        <span className="truncate">{it.name}</span>
                      </label>
                      {isSel && maxq > 1 && (
                        <>
                          <input type="number" min={1} max={maxq} value={holdQty.get(it.item_id) ?? maxq}
                            onChange={(e) => { const v = Math.min(maxq, Math.max(1, Number(e.target.value) || 1)); setHoldQty((prev) => new Map(prev).set(it.item_id, v)); }}
                            className="w-11 text-xs rounded p-1 text-center" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "#e4e6eb" }} title="Units to mark out on repair" />
                          <span className="text-[10px] text-[#8b8fa3]">/ {maxq}</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              <select
                value=""
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) return;
                  const inv = inventory.find((i) => i.id === id);
                  if (!inv) return;
                  setManual((prev) => (prev.some((p) => p.item_id === id) ? prev : [...prev, { item_id: id, name: inv.name }]));
                  setSelected((prev) => new Set(prev).add(id));
                }}
                className="w-full text-xs rounded-lg p-1.5 mt-1.5 cursor-pointer"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e6eb" }}
              >
                <option value="">+ Add an item from inventory…</option>
                {addable.map((i) => (
                  <option key={i.id} value={i.id} style={{ background: "#0e111c" }}>{i.name}</option>
                ))}
              </select>
            </div>
            <label className="block text-xs text-[#8b8fa3] mb-1">Projected case value (£)</label>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              className="w-full text-sm rounded-lg p-2 mb-3"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "#e4e6eb" }}
              placeholder="e.g. 450"
            />
            <textarea
              placeholder="What happened? (damage / loss details)"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              className="w-full text-sm rounded-lg p-2 mb-4 resize-none h-16"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e6eb" }}
            />
            {error && (
              <div className="text-xs mb-3 px-2 py-1.5 rounded" style={{ background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)" }}>
                ⚠ {error}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button onClick={onClose} disabled={submitting} className="text-sm px-3 py-1.5 rounded text-[#8b8fa3] hover:text-[#e4e6eb] transition-colors disabled:opacity-40">Cancel</button>
              <button
                onClick={submit}
                disabled={projected <= 0 || submitting}
                className="text-sm px-4 py-1.5 rounded transition-colors disabled:opacity-40"
                style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.4)" }}
              >
                {submitting ? "Opening…" : "Open case"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ReturnHub() {
  const { activeAccountSlug } = useAccount();
  const rows = useQuery(api.reservations.getDueReturns, { accountSlug: activeAccountSlug }) as DueReturn[] | undefined;
  const [active, setActive] = useState<DueReturn | null>(null);
  const [caseFor, setCaseFor] = useState<DueReturn | null>(null);
  const markReturned = useMutation(api.reservations.markReturned);
  const openCase = useMutation(api.insurance_claims.openCaseFromReservation);

  async function handleReturn(p: ReturnPayload) {
    if (!active) return;
    await markReturned({
      reservationId: active.reservationId,
      condition: p.condition,
      notes: p.notes,
      issueDetails: p.issueDetails,
      blacklistRenter: p.blacklist || undefined,
      blacklistReason: p.blacklistReason,
      flagOnRequest: p.flagOnRequest || undefined,
      whitelist: p.whitelist || undefined,
      whitelistReason: p.whitelistReason,
      outcome: p.outcome,
      sendReview: p.sendReview || undefined,
      memberIds: active.memberIds && active.memberIds.length > 1 ? active.memberIds : undefined,
    });
  }

  async function handleOpenCase(projected: number, description: string, repairItemIds: string[]) {
    if (!caseFor) return;
    await openCase({
      reservationId: caseFor.reservationId,
      memberIds: caseFor.memberIds && caseFor.memberIds.length > 1 ? caseFor.memberIds : undefined,
      projected_value_gbp: projected,
      description: description || undefined,
      // Server resolves/skips non-inventory ids (auto-detected return-hub item
      // ids don't always exist in the items table), so send raw strings.
      repair_item_ids: repairItemIds.length ? repairItemIds : undefined,
    });
  }

  const overdueCount = rows?.filter((r) => r.isOverdue).length ?? 0;
  const todayCount = rows?.filter((r) => !r.isOverdue).length ?? 0;

  return (
    <>
      <Card>
        <CardHeader
          title="Return Hub"
          badge={
            rows !== undefined && rows.length > 0 ? (
              <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444" }}>{rows.length}</span>
            ) : undefined
          }
        />
        {rows === undefined ? (
          <div className="space-y-2">{[1, 2, 3].map((i) => <SkeletonBlock key={i} className="h-14 w-full" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState message="No returns due — all gear is back" icon="checkmark" />
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3 mb-3">
              {rows.map((r) => {
                const accColor = r.accountSlug === "dbcinema" ? "#6ea8fe" : "#22c55e";
                const accent = r.renter?.blacklisted ? "#ef4444" : r.isOverdue ? "#f59e0b" : accColor;
                return (
                  <div
                    key={String(r.reservationId)}
                    className="group flex flex-col rounded-2xl transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/30"
                    style={{
                      border: `1px solid ${r.renter?.blacklisted ? "rgba(239,68,68,0.28)" : "rgba(255,255,255,0.08)"}`,
                      background: "rgba(255,255,255,0.018)",
                    }}
                  >
                    <div className="flex gap-3 p-3">
                      <div className="relative flex-shrink-0">
                        <Thumb url={r.imageUrl} name={r.renterName} size={56} />
                        <span
                          className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full"
                          style={{ background: accent, border: "2px solid #0e111c" }}
                          title={r.renter?.blacklisted ? "blacklisted" : r.isOverdue ? "overdue" : "due"}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[13px] font-semibold text-[#f0f1f5] truncate leading-tight">{r.renterName}</span>
                          <span
                            className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded-md whitespace-nowrap flex-shrink-0 tabular-nums"
                            style={{
                              background: r.isOverdue ? "rgba(245,158,11,0.14)" : "rgba(255,255,255,0.05)",
                              color: r.isOverdue ? "#fbbf24" : "#9296a6",
                            }}
                          >
                            {r.isOverdue ? "⚠ " : ""}{r.endDate}{r.returnTime ? ` · ${r.returnTime}` : ""}
                          </span>
                        </div>
                        <div className="text-[11px] text-[#9296a6] line-clamp-2 leading-snug mt-1">{r.itemNames.join(", ")}</div>
                        <div className="flex items-center gap-1.5 flex-wrap mt-2">
                          <TrustBadge t={r.renter} />
                          {(r.memberCount ?? 1) > 1 && (
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md" style={{ background: "rgba(110,168,254,0.14)", color: "#6ea8fe" }} title={`${r.memberCount} back-to-back bookings merged (extended)`}>⛓ ×{r.memberCount}</span>
                          )}
                          {!!r.renter?.note_count && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-md" style={{ background: "rgba(255,255,255,0.05)", color: "#9296a6" }} title={r.renter?.notes ?? ""}>📝 {r.renter.note_count}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 mt-auto rounded-b-2xl overflow-hidden" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                      <button
                        onClick={() => setActive(r)}
                        className="text-[11px] font-semibold py-2.5 transition-colors text-[#34d399] hover:bg-[rgba(34,197,94,0.1)]"
                      >
                        ✓ Return
                      </button>
                      <button
                        onClick={() => setCaseFor(r)}
                        className="text-[11px] font-medium py-2.5 transition-colors text-[#8b8fa3] hover:bg-[rgba(245,158,11,0.1)] hover:text-[#fbbf24]"
                        style={{ borderLeft: "1px solid rgba(255,255,255,0.06)" }}
                        title="Open a damage/loss case — flags the renter and moves this to the Cases pipeline (stage 1)"
                      >
                        Open case
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-[#8b8fa3]">{todayCount} due · {overdueCount} overdue · shows only after return time · auto-closes when Hygglo confirms</p>
          </>
        )}
      </Card>
      {active && <ReturnModal item={active} onClose={() => setActive(null)} onConfirm={handleReturn} />}
      {caseFor && <OpenCaseModal item={caseFor} onClose={() => setCaseFor(null)} onConfirm={handleOpenCase} />}
    </>
  );
}
