"use client";

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

export default function VacationDrawer({ data }: Props) {
  return (
    <div className="text-sm text-slate-300 space-y-2">
      <div className="text-xs text-slate-400 mb-1">
        {data.active_blocks.length} block{data.active_blocks.length !== 1 ? "s" : ""} active
      </div>
      {data.active_blocks.length === 0 ? (
        <div className="text-xs text-slate-500 italic py-4 text-center">No vacation or maintenance blocks.</div>
      ) : (
        <div className="space-y-1.5">
          {data.active_blocks.map((b, i) => (
            <div key={i} className="py-1.5 border-b border-slate-800">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-200 truncate mr-2">{b.item_name}</span>
                <span className="text-xs text-slate-400 whitespace-nowrap">
                  {fmtDate(b.start)} – {fmtDate(b.end)}
                </span>
              </div>
              {b.reason && (
                <div className="text-[10px] text-slate-500 mt-0.5 truncate">{b.reason}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
