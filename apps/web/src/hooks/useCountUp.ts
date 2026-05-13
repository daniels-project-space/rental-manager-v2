import { useEffect, useRef, useState } from "react";

function easeOutQuad(t: number): number {
  return t * (2 - t);
}

/**
 * Animates from 0 to `target` over `durationMs` using rAF + easeOutQuad.
 * Returns current display value.
 */
export function useCountUp(target: number, durationMs = 600): number {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const prevTargetRef = useRef<number>(0);

  useEffect(() => {
    if (target === prevTargetRef.current) return;
    prevTargetRef.current = target;

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    startRef.current = null;

    const capturedTarget = target;
    function tick(now: number) {
      if (startRef.current === null) startRef.current = now;
      const elapsed = now - startRef.current;
      const progress = Math.min(elapsed / durationMs, 1);
      const eased = easeOutQuad(progress);
      setDisplay(capturedTarget * eased);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(capturedTarget);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs]);

  return display;
}
