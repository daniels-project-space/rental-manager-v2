"use client";

import { useMemo, useState } from "react";
import { useQuery, useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Card } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

// ── Formatters ──────────────────────────────────────────────────────────────

function fmtGbp(n: number, opts?: { signed?: boolean }): string {
  const sign = opts?.signed && n > 0 ? "+" : "";
  return sign + "£" + Math.round(n).toLocaleString("en-GB");
}

function fmtRangeLabel(rangeStart: string, rangeEnd: string): string {
  const a = new Date(rangeStart + "T00:00:00Z");
  const b = new Date(rangeEnd + "T00:00:00Z");
  const fmt = (d: Date) =>
    d.toLocaleString("en", { day: "numeric", month: "short", year: "numeric" });
  return `${fmt(a)} – ${fmt(b)}`;
}

// ── CSV helpers ─────────────────────────────────────────────────────────────

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

type ExportRow = {
  date: string;
  taxYearLabel: string;
  taxMonth: string;
  customer: string;
  description: string;
  days: number;
  grossGbp: number;
  platformFeeGbp: number;
  deliveryFeeGbp: number;
  netGbp: number;
  account: string;
  platform: string;
  reservationId: string;
  hyggloOrderId: string | null;
  pickupDate: string | null;
  returnDate: string | null;
  statusNote: string;
};

const CSV_COLUMNS: Array<{ key: keyof ExportRow; header: string }> = [
  { key: "date", header: "Date" },
  { key: "taxYearLabel", header: "Tax year" },
  { key: "taxMonth", header: "Tax month" },
  { key: "customer", header: "Customer" },
  { key: "description", header: "Description" },
  { key: "days", header: "Days" },
  { key: "grossGbp", header: "Gross (GBP)" },
  { key: "platformFeeGbp", header: "Platform fee (GBP)" },
  { key: "deliveryFeeGbp", header: "Delivery fee (GBP)" },
  { key: "netGbp", header: "Net to owner (GBP)" },
  { key: "account", header: "Account" },
  { key: "platform", header: "Platform" },
  { key: "reservationId", header: "Reservation ID" },
  { key: "hyggloOrderId", header: "Hygglo order ID" },
  { key: "pickupDate", header: "Pickup date" },
  { key: "returnDate", header: "Return date" },
  { key: "statusNote", header: "Status note" },
];

function rowsToCsv(rows: ExportRow[]): string {
  const head = CSV_COLUMNS.map((c) => csvEscape(c.header)).join(",");
  const body = rows
    .map((r) => CSV_COLUMNS.map((c) => csvEscape(r[c.key])).join(","))
    .join("\n");
  return `${head}\n${body}\n`;
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick before revoking — some Safari builds revoke too eagerly.
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// ── Sub-components ──────────────────────────────────────────────────────────

function MonthlyBars({
  monthly,
}: {
  monthly: Array<{ monthLabel: string; grossGbp: number; netGbp: number; count: number }>;
}) {
  const max = Math.max(1, ...monthly.map((m) => m.grossGbp));
  return (
    <div className="flex items-end gap-1 h-16 mt-2">
      {monthly.map((m) => {
        const h = Math.max(2, Math.round((m.grossGbp / max) * 56));
        const isEmpty = m.count === 0;
        return (
          <div
            key={m.monthLabel}
            className="flex-1 flex flex-col items-center gap-1 group"
            title={`${m.monthLabel}: ${fmtGbp(m.grossGbp)} gross · ${m.count} tx`}
          >
            <div
              className="w-full rounded-t"
              style={{
                height: h,
                background: isEmpty
                  ? "rgba(255,255,255,0.04)"
                  : "linear-gradient(180deg, #22c55e 0%, #16a34a 100%)",
                transition: "filter 120ms",
              }}
            />
            <span className="text-[9px] text-[#8b8fa3] truncate w-full text-center">
              {m.monthLabel.slice(0, 3)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function StatRow({
  label,
  value,
  tone,
  bold,
}: {
  label: string;
  value: string;
  tone?: "muted" | "negative" | "positive" | "default";
  bold?: boolean;
}) {
  const valueColor =
    tone === "negative"
      ? "#f87171"
      : tone === "positive"
        ? "#22c55e"
        : tone === "muted"
          ? "#8b8fa3"
          : "#e4e6eb";
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="text-[#8b8fa3]">{label}</span>
      <span
        className={bold ? "font-bold" : "font-medium"}
        style={{ color: valueColor }}
      >
        {value}
      </span>
    </div>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

export function TaxSummary() {
  const convex = useConvex();
  const availableYears = useQuery(api.tax.listAvailableTaxYears, { count: 4 });
  const [startYear, setStartYear] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Default to the most recent year as soon as the list loads.
  const effectiveStartYear =
    startYear ?? (availableYears?.[0]?.startYear ?? null);

  const data = useQuery(
    api.tax.getTaxYearSummary,
    effectiveStartYear !== null ? { startYear: effectiveStartYear } : "skip",
  );

  const copySummary = async () => {
    if (!data) return;
    const lines = [
      `UK Tax Year ${data.taxYearLabel}  (${data.rangeStart} → ${data.rangeEnd})`,
      `Gross income           ${fmtGbp(data.summary.grossGbp)}`,
      `Platform fees          ${fmtGbp(-data.summary.platformFeeGbp)}`,
      `Delivery fees          ${fmtGbp(data.summary.deliveryFeeGbp)}`,
      `Net to owner           ${fmtGbp(data.summary.netGbp)}`,
      ``,
      `${data.totalTransactions} transactions · ${data.activeMonths} active months`,
      ...data.accounts.map(
        (a) => `  - ${a.account}: ${fmtGbp(a.grossGbp)} gross · ${a.count} tx`,
      ),
    ].join("\n");
    await navigator.clipboard.writeText(lines);
  };

  const downloadExport = async () => {
    if (effectiveStartYear === null) return;
    setDownloading(true);
    try {
      const res = await convex.query(api.tax.getTaxYearExportRows, {
        startYear: effectiveStartYear,
      });
      const csv = rowsToCsv(res.rows as ExportRow[]);
      downloadCsv(
        `tax-${res.taxYearLabel}-rentals-${new Date().toISOString().slice(0, 10)}.csv`,
        csv,
      );
    } finally {
      setDownloading(false);
    }
  };

  const yearOptions = useMemo(() => availableYears ?? [], [availableYears]);

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <div className="text-sm font-semibold text-[#e4e6eb]">Tax Summary</div>
          <div className="text-[11px] text-[#8b8fa3]">
            Accountant-ready · UK tax year · pickup-date basis · consolidated
          </div>
        </div>
        <div className="flex gap-1 flex-wrap">
          {yearOptions.map((y) => {
            const active = (effectiveStartYear ?? -1) === y.startYear;
            return (
              <button
                key={y.startYear}
                onClick={() => setStartYear(y.startYear)}
                className="text-xs px-2.5 py-1 rounded-md transition-colors"
                style={{
                  background: active ? "rgba(34,197,94,0.16)" : "rgba(255,255,255,0.04)",
                  color: active ? "#22c55e" : "#c9cdd5",
                  border: active
                    ? "1px solid rgba(34,197,94,0.4)"
                    : "1px solid rgba(255,255,255,0.06)",
                  fontWeight: active ? 600 : 500,
                }}
              >
                {y.taxYearLabel}
              </button>
            );
          })}
        </div>
      </div>

      {data === undefined ? (
        <SkeletonBlock className="h-44 w-full" />
      ) : (
        <>
          <div className="text-[11px] text-[#8b8fa3] mb-2">
            {fmtRangeLabel(data.rangeStart, data.rangeEnd)}
          </div>

          {/* Summary numbers */}
          <div
            className="space-y-1.5 mb-3 pb-3"
            style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
          >
            <StatRow label="Gross income" value={fmtGbp(data.summary.grossGbp)} />
            <StatRow
              label="Platform fees (Hygglo)"
              value={fmtGbp(-data.summary.platformFeeGbp)}
              tone="negative"
            />
            <StatRow
              label="Delivery fees"
              value={fmtGbp(data.summary.deliveryFeeGbp)}
              tone="muted"
            />
            <StatRow
              label="Net to owner"
              value={fmtGbp(data.summary.netGbp)}
              tone="positive"
              bold
            />
          </div>

          <div className="flex items-center justify-between text-[11px] text-[#8b8fa3] mb-1">
            <span>
              {data.totalTransactions} transactions · {data.activeMonths} active months
            </span>
            {data.reconciliationDriftGbp !== 0 && (
              <span
                className="text-amber-300"
                title="gross - platform fee - net should be ~0; non-zero drift means some rows are missing fee/net fields"
              >
                drift {fmtGbp(data.reconciliationDriftGbp, { signed: true })}
              </span>
            )}
          </div>

          {/* Monthly bars */}
          <MonthlyBars monthly={data.monthly} />

          {/* Per-account split */}
          {data.accounts.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
              {data.accounts.map((a) => (
                <span
                  key={a.account}
                  className="px-2 py-1 rounded"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    color: "#c9cdd5",
                  }}
                >
                  <span className="font-semibold text-[#e4e6eb]">{a.account}</span>{" "}
                  {fmtGbp(a.grossGbp)} gross · {a.count} tx
                </span>
              ))}
            </div>
          )}

          {/* Flags */}
          {(data.flags.refundCandidateCount > 0 ||
            data.flags.missingFeeCount > 0 ||
            data.flags.vatStatus !== "ok") && (
            <div className="mt-3 space-y-1 text-[11px]">
              {data.flags.refundCandidateCount > 0 && (
                <div
                  className="px-2 py-1 rounded"
                  style={{ background: "rgba(245,158,11,0.08)", color: "#fbbf24" }}
                >
                  {data.flags.refundCandidateCount} cancelled/obsolete rental
                  {data.flags.refundCandidateCount === 1 ? "" : "s"} with payments —{" "}
                  {fmtGbp(data.flags.refundCandidateGbp)} in possible refunds to chase
                </div>
              )}
              {data.flags.missingFeeCount > 0 && (
                <div
                  className="px-2 py-1 rounded"
                  style={{ background: "rgba(245,158,11,0.08)", color: "#fbbf24" }}
                >
                  {data.flags.missingFeeCount} transaction
                  {data.flags.missingFeeCount === 1 ? "" : "s"} missing platform_fee —
                  verify before filing
                </div>
              )}
              {data.flags.vatStatus === "approaching" && (
                <div
                  className="px-2 py-1 rounded"
                  style={{ background: "rgba(245,158,11,0.12)", color: "#fbbf24" }}
                >
                  ⚠ Approaching the £{(data.flags.vatThresholdGbp / 1000).toFixed(0)}k
                  VAT threshold — register if you expect to cross it in any 12-month
                  window
                </div>
              )}
              {data.flags.vatStatus === "over" && (
                <div
                  className="px-2 py-1 rounded font-semibold"
                  style={{ background: "rgba(239,68,68,0.16)", color: "#f87171" }}
                >
                  ⚠ Over the £{(data.flags.vatThresholdGbp / 1000).toFixed(0)}k VAT
                  threshold — VAT registration required within 30 days of crossing
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="mt-3 flex gap-2 flex-wrap">
            <button
              onClick={downloadExport}
              disabled={downloading || data.totalTransactions === 0}
              className="text-xs px-3 py-1.5 rounded-lg transition-all disabled:opacity-40"
              style={{
                background: "rgba(34,197,94,0.12)",
                color: "#22c55e",
                border: "1px solid rgba(34,197,94,0.4)",
                fontWeight: 600,
              }}
            >
              {downloading
                ? "Preparing CSV…"
                : `📥 Download CSV (${data.totalTransactions} rows)`}
            </button>
            <button
              onClick={copySummary}
              className="text-xs px-3 py-1.5 rounded-lg transition-colors"
              style={{
                background: "rgba(255,255,255,0.04)",
                color: "#c9cdd5",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              📋 Copy summary
            </button>
          </div>
        </>
      )}
    </Card>
  );
}
