"use client";

interface AccountEarning {
  account_slug: string;
  today: number;
  week: number;
}

interface Props {
  data: {
    today: number;
    week: number;
    by_account: AccountEarning[];
  };
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;

const accountColor: Record<string, string> = {
  dbcinema: "bg-blue-900/60 text-blue-300",
  leo: "bg-purple-900/60 text-purple-300",
  diogo: "bg-orange-900/60 text-orange-300",
};

export default function EarningsDrawer({ data }: Props) {
  return (
    <div className="text-sm text-slate-300 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-slate-800/60 rounded p-3">
          <div className="text-xs text-slate-500 mb-1">Today</div>
          <div className="text-lg font-semibold text-emerald-400">{gbp(data.today)}</div>
        </div>
        <div className="bg-slate-800/60 rounded p-3">
          <div className="text-xs text-slate-500 mb-1">This week</div>
          <div className="text-lg font-semibold text-emerald-400">{gbp(data.week)}</div>
        </div>
      </div>
      {data.by_account.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs text-slate-500 uppercase tracking-wide">By account</div>
          {data.by_account.map((a) => (
            <div key={a.account_slug} className="flex items-center justify-between gap-2 py-1">
              <span
                className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  accountColor[a.account_slug] ?? "bg-slate-700 text-slate-300"
                }`}
              >
                {a.account_slug}
              </span>
              <div className="flex gap-4 text-xs">
                <span className="text-slate-400">Today: <span className="text-slate-200">{gbp(a.today)}</span></span>
                <span className="text-slate-400">Week: <span className="text-slate-200">{gbp(a.week)}</span></span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
