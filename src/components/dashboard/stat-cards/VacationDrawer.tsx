"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

// ── Legacy per-item maintenance display (unchanged behaviour) ───────────────
interface VacationBlock {
  item_name: string;
  start: string;
  end: string;
  reason: string;
}

interface Props {
  data: {
    active_blocks: VacationBlock[];
  };
}

const fmtDate = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric" }).format(new Date(d));

const fmtFullDate = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "short", day: "numeric" }).format(new Date(d));

const fmtGbp = (n: number) => "£" + Math.round(n).toLocaleString("en-GB");

// Colour tokens — matches LifetimeRevenue / StatsGrid aesthetic.
const C = {
  green: "#22c55e",
  amber: "#f59e0b",
  red: "#ef4444",
  muted: "#8b8fa3",
  text: "#e4e6eb",
};

// Today (Europe/London) as YYYY-MM-DD — used to gate past-start validation.
function todayLondon(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

// Parse the structured error message thrown by setVacation when force is false
// and confirmed conflicts exist. The mutation stashes JSON inside Error.message.
function parseConfirmedConflictsError(err: unknown): null | {
  confirmed: ConflictRow[];
  pending: ConflictRow[];
} {
  if (!(err instanceof Error)) return null;
  const msg = err.message;
  // Convex wraps server errors with "Uncaught Error: " prefixes — find the JSON.
  const m = msg.match(/\{.*"code"\s*:\s*"CONFIRMED_CONFLICTS".*\}/s);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    if (parsed && parsed.code === "CONFIRMED_CONFLICTS") {
      return { confirmed: parsed.confirmed ?? [], pending: parsed.pending ?? [] };
    }
  } catch {
    /* fall through */
  }
  return null;
}

type ConflictRow = {
  reservation_id: Id<"reservations">;
  hygglo_id?: string;
  renter_name?: string;
  start_date: string;
  end_date: string;
  status: string;
  total_gbp: number;
};

// ── Sub-components ──────────────────────────────────────────────────────────

function ConflictPanel({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: ConflictRow[];
  tone: "red" | "amber";
}) {
  const color = tone === "red" ? C.red : C.amber;
  if (rows.length === 0) return null;
  return (
    <div
      className="rounded-md p-3 mt-2 text-xs"
      style={{
        background: `rgba(${tone === "red" ? "239,68,68" : "245,158,11"},0.08)`,
        border: `1px solid ${color}40`,
      }}
    >
      <div className="font-semibold mb-1.5" style={{ color }}>
        {title}
      </div>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li
            key={r.reservation_id}
            className="flex items-center justify-between gap-2"
            style={{ color: C.text }}
          >
            <span className="truncate flex-1">
              <span className="opacity-80">{r.renter_name ?? r.hygglo_id ?? r.reservation_id}</span>{" "}
              <span className="opacity-60">
                · {fmtDate(r.start_date)}–{fmtDate(r.end_date)}
              </span>
            </span>
            <span className="tabular-nums opacity-80 whitespace-nowrap">
              {fmtGbp(r.total_gbp)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Main drawer ─────────────────────────────────────────────────────────────

export default function VacationDrawer({ data }: Props) {
  // Live queries / mutations
  const activeVacations = useQuery(api.vacation.getActiveVacations);
  const setVacation = useMutation(api.vacation.setVacation);
  const cancelVacation = useMutation(api.vacation.cancelVacation);

  // Form state
  const [formOpen, setFormOpen] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Conflict-check state
  const [checking, setChecking] = useState(false);
  const [conflicts, setConflicts] = useState<{
    confirmed: ConflictRow[];
    pending: ConflictRow[];
  } | null>(null);

  // UX state
  const [formError, setFormError] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  // Programmatic call to checkVacationConflicts via the HTTP client — avoids
  // a network roundtrip on every keystroke that a reactive useQuery would cause.
  const runConflictCheck = async () => {
    setFormError(null);
    if (!start || !end) return;
    if (start > end) {
      setFormError("End date must be on or after start date");
      return;
    }
    if (start < todayLondon()) {
      setFormError("Cannot set vacation in the past");
      return;
    }
    setChecking(true);
    try {
      const { ConvexHttpClient } = await import("convex/browser");
      // Hardcode the canonical deployment (CLAUDE.md hard rule #3): Vercel pins
      // NEXT_PUBLIC_CONVEX_URL to the orphan exciting-lion-29, which has a stale,
      // incomplete dataset (missing 1481 v1 imports) and would silently give
      // wrong vacation-conflict results.
      const client = new ConvexHttpClient("https://hearty-oyster-600.convex.cloud");
      const result = await client.query(api.vacation.checkVacationConflicts, {
        start_date: start,
        end_date: end,
      });
      setConflicts(result);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to check conflicts",
      );
    } finally {
      setChecking(false);
    }
  };

  const submit = async (force: boolean) => {
    setFormError(null);
    if (!start || !end) {
      setFormError("Pick both dates first");
      return;
    }
    if (start > end) {
      setFormError("End date must be on or after start date");
      return;
    }
    if (start < todayLondon()) {
      setFormError("Cannot set vacation in the past");
      return;
    }
    setSubmitting(true);
    try {
      const res = await setVacation({
        start_date: start,
        end_date: end,
        reason: reason || undefined,
        force: force || undefined,
        created_by: "dashboard",
      });
      const pendingN = res.pending_conflicts?.length ?? 0;
      setSuccessBanner(
        pendingN > 0
          ? `Vacation set. ${pendingN} pending request(s) overlap — handle them in the renter bot drafts.`
          : "Vacation set.",
      );
      setStart("");
      setEnd("");
      setReason("");
      setConflicts(null);
      setFormOpen(false);
      window.setTimeout(() => setSuccessBanner(null), 6000);
    } catch (err) {
      const parsed = parseConfirmedConflictsError(err);
      if (parsed) {
        setConflicts(parsed);
        setFormError(
          `BLOCKED — ${parsed.confirmed.length} confirmed booking(s) overlap. Use Force-set to keep them.`,
        );
      } else {
        setFormError(
          err instanceof Error ? err.message : "Failed to set vacation",
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onCancelVacation = async (id: Id<"vacation_periods">) => {
    try {
      await cancelVacation({ vacation_id: id });
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to cancel vacation",
      );
    }
  };

  const hasConfirmedConflicts = useMemo(
    () => (conflicts?.confirmed?.length ?? 0) > 0,
    [conflicts],
  );

  const canCheck = Boolean(start && end);

  return (
    <div className="text-sm space-y-3" style={{ color: C.text }}>
      {/* ───────── Owner Vacation (global) ───────── */}
      <section
        className="rounded-md p-3"
        style={{
          background: "rgba(34,197,94,0.04)",
          border: `1px solid ${C.green}22`,
        }}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold" style={{ color: C.green }}>
            Owner Vacation (global)
          </div>
          {!formOpen && (
            <button
              type="button"
              onClick={() => {
                setFormOpen(true);
                setFormError(null);
                setSuccessBanner(null);
              }}
              className="text-[11px] px-2 py-0.5 rounded-md transition-all hover:opacity-90"
              style={{
                border: `1px solid ${C.green}80`,
                color: C.green,
                background: "rgba(34,197,94,0.08)",
              }}
            >
              + Set Vacation
            </button>
          )}
        </div>

        {successBanner && (
          <div
            className="rounded-md p-2 mb-2 text-xs"
            style={{
              background: "rgba(34,197,94,0.08)",
              border: `1px solid ${C.green}40`,
              color: C.green,
            }}
          >
            {successBanner}
          </div>
        )}

        {/* Active vacation list */}
        {activeVacations === undefined ? (
          <div className="text-xs italic py-2" style={{ color: C.muted }}>
            Loading vacations…
          </div>
        ) : activeVacations.length === 0 ? (
          <div className="text-xs italic py-2" style={{ color: C.muted }}>
            No active vacation periods.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {activeVacations.map((v) => (
              <li
                key={v._id}
                className="flex items-center justify-between gap-2 py-1.5 border-b last:border-b-0"
                style={{ borderColor: "#3a3f4b" }}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium" style={{ color: C.text }}>
                    {fmtFullDate(v.start_date)} – {fmtFullDate(v.end_date)}
                  </div>
                  {(v.reason || v.created_by) && (
                    <div className="text-[10px] mt-0.5 truncate" style={{ color: C.muted }}>
                      {v.reason ? v.reason : ""}
                      {v.reason && v.created_by ? " · " : ""}
                      {v.created_by ? `by ${v.created_by}` : ""}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onCancelVacation(v._id)}
                  className="text-[11px] px-2 py-0.5 rounded-md transition-all hover:opacity-90"
                  style={{
                    border: `1px solid ${C.red}80`,
                    color: C.red,
                    background: "rgba(239,68,68,0.06)",
                  }}
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Inline form */}
        {formOpen && (
          <div
            className="mt-3 rounded-md p-3"
            style={{
              background: "rgba(255,255,255,0.02)",
              border: `1px solid #3a3f4b`,
            }}
          >
            <div className="grid grid-cols-2 gap-2 mb-2">
              <label className="flex flex-col text-[11px]" style={{ color: C.muted }}>
                Start
                <input
                  type="date"
                  value={start}
                  onChange={(e) => {
                    setStart(e.target.value);
                    setConflicts(null);
                    setFormError(null);
                  }}
                  min={todayLondon()}
                  className="mt-1 bg-transparent rounded px-2 py-1 text-xs"
                  style={{ border: "1px solid #3a3f4b", color: C.text }}
                />
              </label>
              <label className="flex flex-col text-[11px]" style={{ color: C.muted }}>
                End
                <input
                  type="date"
                  value={end}
                  onChange={(e) => {
                    setEnd(e.target.value);
                    setConflicts(null);
                    setFormError(null);
                  }}
                  min={start || todayLondon()}
                  className="mt-1 bg-transparent rounded px-2 py-1 text-xs"
                  style={{ border: "1px solid #3a3f4b", color: C.text }}
                />
              </label>
            </div>
            <label className="flex flex-col text-[11px]" style={{ color: C.muted }}>
              Reason (optional)
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. away in Italy"
                className="mt-1 bg-transparent rounded px-2 py-1 text-xs"
                style={{ border: "1px solid #3a3f4b", color: C.text }}
              />
            </label>

            {formError && (
              <div
                className="rounded-md p-2 mt-2 text-xs"
                style={{
                  background: "rgba(239,68,68,0.08)",
                  border: `1px solid ${C.red}40`,
                  color: C.red,
                }}
              >
                {formError}
              </div>
            )}

            {/* Conflict panels */}
            {conflicts && (
              <>
                <ConflictPanel
                  title={`BLOCKED — ${conflicts.confirmed.length} confirmed booking(s) overlapping`}
                  rows={conflicts.confirmed}
                  tone="red"
                />
                <ConflictPanel
                  title={`FYI: ${conflicts.pending.length} pending request(s) in this window — they'll be flagged but not auto-declined`}
                  rows={conflicts.pending}
                  tone="amber"
                />
                {conflicts.confirmed.length === 0 &&
                  conflicts.pending.length === 0 && (
                    <div
                      className="rounded-md p-2 mt-2 text-xs"
                      style={{
                        background: "rgba(34,197,94,0.08)",
                        border: `1px solid ${C.green}40`,
                        color: C.green,
                      }}
                    >
                      No conflicts — safe to set.
                    </div>
                  )}
              </>
            )}

            <div className="flex flex-wrap gap-2 mt-3">
              <button
                type="button"
                disabled={!canCheck || checking}
                onClick={runConflictCheck}
                className="text-[11px] px-3 py-1 rounded-md transition-all hover:opacity-90 disabled:opacity-40"
                style={{
                  border: `1px solid ${C.muted}80`,
                  color: C.text,
                  background: "rgba(255,255,255,0.04)",
                }}
              >
                {checking ? "Checking…" : "Check Conflicts"}
              </button>
              {!hasConfirmedConflicts && (
                <button
                  type="button"
                  disabled={!canCheck || submitting}
                  onClick={() => submit(false)}
                  className="text-[11px] px-3 py-1 rounded-md transition-all hover:opacity-90 disabled:opacity-40"
                  style={{
                    border: `1px solid ${C.green}80`,
                    color: C.green,
                    background: "rgba(34,197,94,0.08)",
                  }}
                >
                  {submitting ? "Setting…" : "Set Vacation"}
                </button>
              )}
              {hasConfirmedConflicts && (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    // Inline confirm via window.confirm — keeps the drawer simple
                    // and avoids pulling in a modal lib for one prompt.
                    const ok = window.confirm(
                      `Force-set vacation despite ${conflicts?.confirmed.length ?? 0} confirmed booking(s)?\n\nYou will still honor those bookings — the vacation row will be saved alongside them.`,
                    );
                    if (ok) submit(true);
                  }}
                  className="text-[11px] px-3 py-1 rounded-md transition-all hover:opacity-90 disabled:opacity-40"
                  style={{
                    border: `1px solid ${C.amber}80`,
                    color: C.amber,
                    background: "rgba(245,158,11,0.08)",
                  }}
                >
                  {submitting
                    ? "Setting…"
                    : "Force-set (keep confirmed bookings, you'll honor them)"}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setFormOpen(false);
                  setFormError(null);
                  setConflicts(null);
                }}
                className="text-[11px] px-3 py-1 rounded-md transition-all hover:opacity-90"
                style={{
                  border: `1px solid #3a3f4b`,
                  color: C.muted,
                  background: "transparent",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ───────── Per-item maintenance (legacy display, unchanged) ───────── */}
      <section>
        <div className="text-xs mb-1" style={{ color: C.muted }}>
          Per-item maintenance ·{" "}
          {data.active_blocks.length} block{data.active_blocks.length !== 1 ? "s" : ""} active
        </div>
        {data.active_blocks.length === 0 ? (
          <div
            className="text-xs italic py-4 text-center"
            style={{ color: C.muted }}
          >
            No vacation or maintenance blocks.
          </div>
        ) : (
          <div className="space-y-1.5">
            {data.active_blocks.map((b, i) => (
              <div
                key={i}
                className="py-1.5 border-b"
                style={{ borderColor: "#3a3f4b" }}
              >
                <div className="flex items-center justify-between">
                  <span
                    className="text-xs font-medium truncate mr-2"
                    style={{ color: C.text }}
                  >
                    {b.item_name}
                  </span>
                  <span
                    className="text-xs whitespace-nowrap"
                    style={{ color: C.muted }}
                  >
                    {fmtDate(b.start)} – {fmtDate(b.end)}
                  </span>
                </div>
                {b.reason && (
                  <div
                    className="text-[10px] mt-0.5 truncate"
                    style={{ color: C.muted }}
                  >
                    {b.reason}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
