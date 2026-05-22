"use client";

interface Props {
  data: {
    last_scan_at: number | null;
    last_run_succeeded: boolean | null;
    rows_upserted_last: number;
    last_scan_source?: string | null;
  };
}

const STALE_THRESHOLD_MS = 60 * 60 * 1000;

function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ScannerDrawer({ data }: Props) {
  if (data.last_scan_at === null) {
    return (
      <div className="text-sm text-slate-300">
        <div className="text-xs text-slate-500 italic py-4 text-center">Scanner has not run yet.</div>
      </div>
    );
  }

  const succeeded = data.last_run_succeeded;
  const lastScanAt: number | null = data.last_scan_at ?? null;
  const isStale = lastScanAt !== null && (Date.now() - lastScanAt) > STALE_THRESHOLD_MS;
  const lastScanSource = data.last_scan_source ?? null;

  return (
    <div className="text-sm text-slate-300 space-y-3">
      {isStale && (
        <div className="flex items-center gap-2 text-xs text-red-400/80">
          <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span>Scanner inactive</span>
        </div>
      )}
      <div className="bg-slate-800/60 rounded p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">Last scan</span>
          <span className="flex items-center">
            <span className={isStale ? "text-xs text-red-400/80" : "text-xs text-slate-200"}>
              {relativeTime(data.last_scan_at)}{isStale ? " · inactive" : ""}
            </span>
            {lastScanSource && (
              <span className="text-[10px] text-zinc-500 ml-2">Source: {lastScanSource}</span>
            )}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">Status</span>
          {succeeded === null ? (
            <span className="text-xs text-slate-400">Unknown</span>
          ) : succeeded ? (
            <span className="text-xs font-medium text-emerald-400">✓ Success</span>
          ) : (
            <span className="text-xs font-medium text-red-400">✗ Failed</span>
          )}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">Rows upserted</span>
          <span className="text-xs text-slate-200">{data.rows_upserted_last.toLocaleString("en-GB")}</span>
        </div>
      </div>
    </div>
  );
}
