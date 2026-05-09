export function SkeletonBlock({
  className = "",
}: {
  className?: string;
}) {
  return <div className={`skeleton ${className}`} />;
}

export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="glass-card p-5 space-y-3">
      <SkeletonBlock className="h-4 w-32" />
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonBlock key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}
