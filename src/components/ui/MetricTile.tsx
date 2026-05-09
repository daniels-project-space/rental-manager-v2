export function MetricTile({
  label,
  value,
  color = "#6ea8fe",
  sub,
}: {
  label: string;
  value: string | number;
  color?: string;
  sub?: string;
}) {
  return (
    <div className="glass-card p-4 stat-card-hover cursor-default flex flex-col gap-1">
      <span
        className="text-xs font-medium uppercase tracking-wider"
        style={{ color: "#8b8fa3" }}
      >
        {label}
      </span>
      <span
        className="text-3xl font-bold leading-tight"
        style={{ color }}
      >
        {value}
      </span>
      {sub && (
        <span className="text-xs" style={{ color: "#8b8fa3" }}>
          {sub}
        </span>
      )}
    </div>
  );
}
