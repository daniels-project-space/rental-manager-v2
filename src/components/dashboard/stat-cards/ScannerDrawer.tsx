"use client";

interface Props {
  data: {
    last_scan_at: number | null;
    last_run_succeeded: boolean | null;
    rows_upserted_last: number;
  };
}

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

  return (
    <div className="text-sm text-slate-300 space-y-3">
      <div className="bg-slate-800/60 rounded p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">Last scan</span>
          <span className="text-xs text-slate-200">{relativeTime(data.last_scan_at)}</span>
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
