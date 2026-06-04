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

/**
 * Full-panel skeleton placeholder used by DeferredMount while a deferred
 * dashboard panel is off-screen / not yet mounted. Renders a glass-card
 * shell (title bar + a few shimmer rows) sized to a fixed minHeight so the
 * layout is reserved and there is NO content shift when the real widget
 * pops in. Purely presentational — fires zero queries.
 */
export function PanelSkeleton({
  minHeight = "200px",
  rows = 3,
}: {
  /** CSS height reserved for the panel (matches the real widget's height). */
  minHeight?: string;
  rows?: number;
}) {
  return (
    <div
      className="glass-card p-5 space-y-4"
      style={{ minHeight }}
      aria-hidden
      data-deferred-skeleton="true"
    >
      <div className="flex items-center justify-between">
        <SkeletonBlock className="h-5 w-40" />
        <SkeletonBlock className="h-5 w-16" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <SkeletonBlock key={i} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
