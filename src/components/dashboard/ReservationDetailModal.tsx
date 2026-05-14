"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

function fmtTime(t: string | null | undefined): string {
  if (!t) return "—";
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${min}${ampm}`;
}

function fmtRange(start: string, end: string): string {
  const a = new Date(start);
  const b = new Date(end);
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  const aStr = a.toLocaleString("en", { month: "short", day: "numeric" });
  const bStr = sameMonth
    ? b.getDate().toString()
    : b.toLocaleString("en", { month: "short", day: "numeric" });
  const days = Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000) + 1);
  return `${aStr} → ${bStr} (${days}d)`;
}

function fmtGbp(n: number | null | undefined): string {
  if (n == null) return "—";
  return "£" + Math.round(n).toLocaleString("en-GB");
}

const ACCOUNT_COLORS: Record<string, string> = {
  dbcinema: "#6ea8fe",
  leo: "#a855f7",
};
function accountColor(slug: string | null | undefined) {
  return slug ? ACCOUNT_COLORS[slug] ?? "#22c55e" : "#22c55e";
}

export function ReservationDetailModal({
  reservationId,
  onClose,
}: {
  reservationId: Id<"reservations">;
  onClose: () => void;
}) {
  const r = useQuery(api.calendar.getReservationDetail, { reservationId });
  const color = accountColor(r?.accountSlug);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
      role="dialog"
      aria-modal
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl border bg-[#0b0e18] shadow-2xl overflow-hidden"
        style={{ borderColor: "rgba(255,255,255,0.1)", maxHeight: "85dvh" }}
      >
        {r === undefined ? (
          <div className="p-6">
            <SkeletonBlock className="h-32 w-full" />
          </div>
        ) : r === null ? (
          <div className="p-6 text-sm text-slate-400">Reservation not found.</div>
        ) : (
          <>
            <div
              className="flex items-start justify-between px-4 py-3 border-b"
              style={{ borderColor: "rgba(255,255,255,0.08)" }}
            >
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded"
                    style={{ background: `${color}22`, color }}
                  >
                    {r.accountSlug ?? "all"}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400">
                    {r.status.replace("_", " ")}
                  </span>
                </div>
                <h3 className="text-base font-semibold text-slate-100">{r.renterName}</h3>
                <p className="text-xs text-slate-400">
                  {fmtRange(r.startDate ?? "", r.endDate ?? "")}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="text-slate-400 hover:text-white text-xl leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div
              className="overflow-y-auto p-4 space-y-4"
              style={{ maxHeight: "calc(85dvh - 65px)" }}
            >
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div
                  className="rounded-lg p-2.5"
                  style={{
                    background: "rgba(34,197,94,0.06)",
                    border: "1px solid rgba(34,197,94,0.2)",
                  }}
                >
                  <div className="text-[10px] uppercase tracking-wider text-emerald-300 mb-1">
                    Pickup
                  </div>
                  <div className="text-slate-200 font-medium">{fmtTime(r.pickupTime)}</div>
                  {r.pickupMethod && (
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {r.pickupMethod === "delivery" ? "🚚 Delivery" : "Self pickup"}
                    </div>
                  )}
                </div>
                <div
                  className="rounded-lg p-2.5"
                  style={{
                    background: "rgba(168,85,247,0.06)",
                    border: "1px solid rgba(168,85,247,0.2)",
                  }}
                >
                  <div className="text-[10px] uppercase tracking-wider text-violet-300 mb-1">
                    Return
                  </div>
                  <div className="text-slate-200 font-medium">{fmtTime(r.returnTime)}</div>
                  {r.returnMethod && (
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {r.returnMethod === "delivery" ? "🚚 Delivery" : "Self return"}
                    </div>
                  )}
                </div>
              </div>

              {(r.grossPaidGbp ?? r.netToOwnerGbp) != null && (
                <div className="flex items-center justify-between text-xs px-2.5 py-2 rounded-lg border border-white/5">
                  <span className="text-slate-400">Earnings</span>
                  <span className="text-slate-200 font-medium">
                    <span className="text-emerald-300">{fmtGbp(r.netToOwnerGbp)}</span>
                    {r.grossPaidGbp != null && (
                      <span className="text-slate-500 ml-2">
                        net · {fmtGbp(r.grossPaidGbp)} gross
                      </span>
                    )}
                  </span>
                </div>
              )}

              <section>
                <h4 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
                  Items ({r.items.length})
                </h4>
                <ul className="space-y-1.5">
                  {r.items.map((it, idx) => (
                    <li
                      key={idx}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-white/5 hover:bg-white/[0.03]"
                    >
                      {it.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={it.imageUrl}
                          alt=""
                          className="w-10 h-10 rounded object-cover flex-shrink-0"
                          loading="lazy"
                        />
                      ) : (
                        <div
                          className="w-10 h-10 rounded flex-shrink-0 flex items-center justify-center text-[10px] text-slate-500"
                          style={{ background: "rgba(255,255,255,0.04)" }}
                        >
                          no img
                        </div>
                      )}
                      <span className="text-sm text-slate-200 flex-1 truncate">
                        {it.name ?? "unknown item"}
                      </span>
                      {it.qty != null && it.qty > 1 && (
                        <span className="text-[11px] text-slate-400">×{it.qty}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>

              {r.notes && r.notes.trim().length > 0 && (
                <section>
                  <h4 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
                    Notes
                  </h4>
                  <p
                    className="text-xs text-slate-300 whitespace-pre-wrap px-2.5 py-2 rounded-lg"
                    style={{ background: "rgba(255,255,255,0.03)" }}
                  >
                    {r.notes}
                  </p>
                </section>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
