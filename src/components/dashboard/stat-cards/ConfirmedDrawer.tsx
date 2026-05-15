"use client";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import type { TooltipContentProps } from "recharts";
import type { ValueType, NameType } from "recharts/types/component/DefaultTooltipContent";

type DailyBucket = {
  date: string;
  day: number;
  done: number;
  active: number;
  upcoming: number;
  pending: number;
  revenue: number;
};

interface Props {
  data: {
    month_count: number;
    month_revenue: number;
    done_count: number;
    active_count: number;
    upcoming_count: number;
    pending_count: number;
    today_day: number | null;
    month_label: string;
    daily_breakdown: DailyBucket[];
  };
}

const COLORS = {
  done: "#22c55e",
  active: "#f59e0b",
  upcoming: "#a78bfa",
  pending: "#ec4899",
  revenue: "#6ea8fe",
} as const;

const SERIES: Array<{ key: keyof typeof COLORS; label: string; fill: string }> = [
  { key: "done",     label: "Done",     fill: "url(#cd-grad-done)" },
  { key: "active",   label: "Active",   fill: "url(#cd-grad-active)" },
  { key: "upcoming", label: "Upcoming", fill: "url(#cd-grad-upcoming)" },
  { key: "pending",  label: "Pending",  fill: "url(#cd-grad-pending)" },
];

const gbp = (n: number) => "£" + Math.round(n).toLocaleString("en-GB");

function renderTip(props: TooltipContentProps<ValueType, NameType>) {
  const { active, payload, label } = props;
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as DailyBucket | undefined;
  if (!row) return null;
  const total = row.done + row.active + row.upcoming + row.pending;
  return (
    <div
      style={{
        background: "rgba(15,17,26,0.96)",
        border: "1px solid rgba(255,255,255,0.10)",
        borderRadius: 6,
        padding: "8px 10px",
        fontSize: 11,
        color: "#e5e7eb",
        minWidth: 140,
      }}
    >
      <div className="text-[10px] text-slate-400 mb-1">Day {label}</div>
      {SERIES.map((s) => {
        const v = row[s.key] as number;
        if (!v) return null;
        return (
          <div key={s.key} className="flex items-center gap-2 leading-tight">
            <span style={{ width: 8, height: 8, background: COLORS[s.key], borderRadius: 2 }} />
            <span className="flex-1">{s.label}</span>
            <span className="tabular-nums text-slate-200">{v}</span>
          </div>
        );
      })}
      <div className="mt-1 pt-1 border-t border-slate-700/60 flex justify-between gap-3">
        <span className="text-slate-400">Total</span>
        <span className="tabular-nums text-slate-100">{total}</span>
      </div>
      {row.revenue > 0 && (
        <div className="flex justify-between gap-3">
          <span className="text-slate-400">Revenue</span>
          <span className="tabular-nums text-sky-300">{gbp(row.revenue)}</span>
        </div>
      )}
    </div>
  );
}

export default function ConfirmedDrawer({ data }: Props) {
  const daily = data.daily_breakdown ?? [];
  const hasAny = daily.some(
    (d) => d.done + d.active + d.upcoming + d.pending + d.revenue > 0,
  );

  const maxRevenue = Math.max(0, ...daily.map((d) => d.revenue));
  const monthName = new Date(data.month_label + "T00:00:00Z").toLocaleString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-slate-400">{monthName} · daily breakdown</span>
        <span className="text-slate-500">
          {data.month_count} rentals · <span className="text-sky-300">{gbp(data.month_revenue)}</span>
        </span>
      </div>

      {!hasAny ? (
        <div className="text-xs text-slate-500 italic py-6 text-center">
          No confirmed rentals this month.
        </div>
      ) : (
        <div className="-mx-1">
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart
              data={daily}
              margin={{ top: 6, right: 8, left: 0, bottom: 0 }}
              barCategoryGap={2}
            >
              <defs>
                <linearGradient id="cd-grad-done" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#4ade80" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#15803d" stopOpacity={0.85} />
                </linearGradient>
                <linearGradient id="cd-grad-active" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#fbbf24" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#b45309" stopOpacity={0.85} />
                </linearGradient>
                <linearGradient id="cd-grad-upcoming" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#c4b5fd" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#6d28d9" stopOpacity={0.85} />
                </linearGradient>
                <linearGradient id="cd-grad-pending" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f9a8d4" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#be185d" stopOpacity={0.85} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
              <XAxis
                dataKey="day"
                tick={{ fill: "#8b8fa3", fontSize: 9 }}
                axisLine={false}
                tickLine={false}
                interval={2}
              />
              <YAxis
                yAxisId="left"
                orientation="left"
                allowDecimals={false}
                tick={{ fill: "#8b8fa3", fontSize: 9 }}
                axisLine={false}
                tickLine={false}
                width={20}
              />
              {maxRevenue > 0 && (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tickFormatter={(v: number) => (v >= 1000 ? "£" + (v / 1000).toFixed(1) + "k" : "£" + v)}
                  tick={{ fill: "#6ea8fe", fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                />
              )}
              <Tooltip
                content={renderTip}
                cursor={{ fill: "rgba(255,255,255,0.04)" }}
              />
              {data.today_day !== null && (
                <ReferenceLine
                  yAxisId="left"
                  x={data.today_day}
                  stroke="rgba(255,255,255,0.25)"
                  strokeDasharray="2 3"
                />
              )}
              {SERIES.map((s) => (
                <Bar
                  key={s.key}
                  yAxisId="left"
                  dataKey={s.key}
                  stackId="confirmed"
                  fill={s.fill}
                  isAnimationActive={false}
                  radius={s.key === "pending" ? [3, 3, 0, 0] : 0}
                />
              ))}
              {maxRevenue > 0 && (
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="revenue"
                  stroke={COLORS.revenue}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400 pt-1 justify-center">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span
              style={{ width: 8, height: 8, background: COLORS[s.key], borderRadius: 2, display: "inline-block" }}
            />
            <span>
              {s.label}{" "}
              <span className="text-slate-200">
                {s.key === "done"
                  ? data.done_count
                  : s.key === "active"
                  ? data.active_count
                  : s.key === "upcoming"
                  ? data.upcoming_count
                  : data.pending_count}
              </span>
            </span>
          </span>
        ))}
        {maxRevenue > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span
              style={{ width: 10, height: 2, background: COLORS.revenue, display: "inline-block" }}
            />
            <span>Revenue</span>
          </span>
        )}
      </div>
    </div>
  );
}
