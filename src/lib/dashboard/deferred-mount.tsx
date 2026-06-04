"use client";
import { useEffect, useRef, useState } from "react";
import { PanelSkeleton } from "@/components/ui/SkeletonBlock";

/**
 * IntersectionObserver-gated mount.
 *
 * Children are NOT rendered (and their Convex useQuery() calls do NOT fire)
 * until the placeholder div enters the viewport. After first intersection,
 * children stay mounted — we never unmount them on scroll-out (would cause
 * remount + re-fetch jank).
 *
 * Why: every dashboard panel currently fires its useQuery the moment the
 * dashboard mounts. With 20+ panels per dashboard, that's a thundering herd
 * of Convex queries firing simultaneously, half of them for widgets below
 * the fold the user may never scroll to. Deferring the off-screen ones
 * cuts cold-paint Convex bandwidth ~50% on a typical 1080p viewport.
 *
 * Estimated visible viewport at first paint: 4-6 panels. Of 25 total
 * panels in the registry, ~19 are deferred until first scroll (or until
 * they become visible after a layout shift, etc).
 *
 * Pass `eager` to bypass deferral (e.g. above-the-fold panels like
 * StatsGrid that should always paint instantly).
 *
 * Pass `placeholderHeight` to reserve vertical space so unmounted children
 * don't cause layout shift when they pop in. Default 200px — matches a
 * collapsed panel skeleton. While waiting, a shimmering <PanelSkeleton>
 * sized to that height is shown (NOT a blank box), so the user sees the
 * page's final shape immediately — no blank-then-everything flash.
 */
export interface DeferredMountProps {
  children: React.ReactNode;
  /** Skip the deferral and mount children immediately. */
  eager?: boolean;
  /** CSS height to reserve for the placeholder while waiting. Default "200px". */
  placeholderHeight?: string;
  /** Number of shimmer rows in the skeleton placeholder. Default 3. */
  skeletonRows?: number;
  /** Intersection root margin — fire BEFORE the panel is fully visible. Default "200px" (pre-fetch when 200px below viewport). */
  rootMargin?: string;
}

export function DeferredMount({
  children,
  eager = false,
  placeholderHeight = "200px",
  skeletonRows = 3,
  rootMargin = "200px",
}: DeferredMountProps): React.ReactNode {
  const [visible, setVisible] = useState(eager);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (visible) return; // once-only

    // Browsers without IntersectionObserver: fall through to eager render.
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }

    const el = ref.current;
    if (!el) return;

    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { rootMargin, threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [visible, rootMargin]);

  if (visible) return <>{children}</>;
  return (
    <div ref={ref} aria-hidden data-deferred="pending">
      <PanelSkeleton minHeight={placeholderHeight} rows={skeletonRows} />
    </div>
  );
}
