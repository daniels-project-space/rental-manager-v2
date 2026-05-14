export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`glass-card p-5 ${className}`} data-dashboard-card>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  badge,
  actions,
}: {
  title: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-[#e4e6eb]">{title}</h2>
        {badge}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
