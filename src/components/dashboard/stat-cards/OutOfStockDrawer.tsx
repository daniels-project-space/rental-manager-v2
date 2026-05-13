"use client";

interface OosItem {
  item_id: string;
  name: string;
  blocked_days_next_30: number;
}

interface Props {
  data: {
    count: number;
    items: OosItem[];
  };
}

export default function OutOfStockDrawer({ data }: Props) {
  return (
    <div className="text-sm text-slate-300 space-y-2">
      <div className="text-xs text-slate-400 mb-1">{data.count} item{data.count !== 1 ? "s" : ""} blocked</div>
      {data.items.length === 0 ? (
        <div className="text-xs text-slate-500 italic py-4 text-center">No out-of-stock items.</div>
      ) : (
        <div className="space-y-1">
          {data.items.map((item) => (
            <div
              key={item.item_id}
              className="flex items-center justify-between py-1.5 border-b border-slate-800"
            >
              <span className="text-xs text-slate-200 truncate mr-2">{item.name}</span>
              <span className="text-xs whitespace-nowrap text-amber-400 font-medium">
                {item.blocked_days_next_30}d blocked
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
